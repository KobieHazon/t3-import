import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { canonicalConversation, canonicalThread, eventCount } from "../../test/helpers.js";
import type { CanonicalConversation, CanonicalTurn, SourceName, TargetPaths } from "../../src/core/types.js";
import { resolveTargetPaths } from "../../src/target/config.js";
import { importConversations } from "../../src/target/importer.js";
import { inspectConversationSync, syncConversations, targetId } from "../../src/target/sync.js";
import { replaceConversations } from "../../src/target/replace.js";
import { listImports } from "../../src/target/ledger.js";
import { validateTargetDatabase } from "../../src/target/schema.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = join(root, "artifacts/compatibility");
const refs = JSON.parse(readFileSync(join(root, "scripts/compatibility/references.json"), "utf8")) as Array<{ migration: number; commit: string }>;
const latestMigration = Math.max(...refs.map((ref) => ref.migration));
const selected = process.argv[2] ? refs.filter((ref) => ref.migration === Number(process.argv[2])) : refs;
assert(selected.length, "No matching reference");
mkdirSync(base, { recursive: true });
const runRoot = mkdtempSync(join(base, "run-"));
const results: unknown[] = [];

function reference(migration: number, action: string, home: string): any {
  const output = join(home, `${action}.json`);
  try {
    execFileSync(process.execPath, ["--import", "tsx", join(base, String(migration), "runner.mjs"), action, home, output], { cwd: root, stdio: "pipe", timeout: 60_000 });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`Migration ${migration} ${action} failed:\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, { cause: error });
  }
  return existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : undefined;
}

function nextTurn(index: number, status: CanonicalTurn["status"] = "completed"): CanonicalTurn {
  const start = `2026-01-${String(index).padStart(2, "0")}T00:00:00.000Z`;
  const end = start.replace("00.000Z", "03.000Z");
  return {
    id: `turn-${index}`, startedAt: start, completedAt: end, status,
    ...(status === "failed" ? { terminalError: "Synthetic provider failure" } : {}),
    user: { sourceId: `user-${index}`, role: "user", text: `Question ${index}`, timestamp: start, attachments: [] },
    assistant: [{ sourceId: `assistant-${index}`, role: "assistant", text: `Answer ${index}`, timestamp: end, attachments: [] }],
    activities: [], plans: [],
  };
}

function assertProjection(paths: TargetPaths, conversation: CanonicalConversation, threadId: string): void {
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    const thread = conversation.threads[0]!;
    const messages = db.prepare("SELECT text FROM projection_thread_messages WHERE thread_id=? ORDER BY created_at, message_id").all(threadId) as Array<{ text: string }>;
    assert.deepEqual(messages.map((row) => row.text), thread.turns.flatMap((turn) => [turn.user.text, ...turn.assistant.map((message) => message.text)]));
    const turns = db.prepare("SELECT state FROM projection_turns WHERE thread_id=? ORDER BY requested_at").all(threadId) as Array<{ state: string }>;
    assert.deepEqual(turns.map((row) => row.state), thread.turns.map((turn) => turn.status === "failed" ? "error" : turn.status));
    const row = db.prepare("SELECT title, deleted_at FROM projection_threads WHERE thread_id=?").get(threadId) as { title: string; deleted_at: string | null };
    assert.equal(row.title, thread.title);
    assert.equal(row.deleted_at, null);
    const latest = eventCount(paths.dbPath);
    const cursors = db.prepare("SELECT last_applied_sequence FROM projection_state WHERE projector <> 'projection.attachment-cleanup'").all() as Array<{ last_applied_sequence: number }>;
    assert(cursors.length >= 9);
    assert(cursors.every((cursor) => cursor.last_applied_sequence === latest), "One bootstrap must project every event");
    const plans = db.prepare("SELECT plan_markdown FROM projection_thread_proposed_plans WHERE thread_id=?").all(threadId) as Array<{ plan_markdown: string }>;
    assert.deepEqual(plans.map((row) => row.plan_markdown), ["# Synthetic plan"]);
    const activities = db.prepare("SELECT COUNT(*) count FROM projection_thread_activities WHERE thread_id=?").get(threadId) as { count: number };
    assert(activities.count > 0);
    const images = db.prepare("SELECT attachments_json FROM projection_thread_messages WHERE thread_id=? AND role='user' ORDER BY created_at LIMIT 1").get(threadId) as { attachments_json: string };
    const attachments = JSON.parse(images.attachments_json) as Array<{ id: string }>;
    assert.equal(attachments.length, 1);
    assert(existsSync(join(paths.attachmentsDir, `${attachments[0]!.id}.png`)), "Projected image must exist");
  } finally { db.close(); }
}

async function scenario(start: number, source: SourceName, upgrade: boolean): Promise<void> {
  const home = join(runRoot, `${start}-${source}${upgrade ? "-upgrade" : ""}`);
  mkdirSync(home);
  writeFileSync(join(home, ".compatibility-fixture"), "synthetic");
  process.env.T3_IMPORT_DATA_DIR = join(home, "ledger");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  reference(start, "migrate", home);
  const paths = resolveTargetPaths({ t3Home: home });
  const thread = canonicalThread(workspace);
  thread.source = source;
  if (source === "claude") {
    thread.sourceKey = `claude:${thread.sourceSessionId}:leaf-1`;
    thread.leafId = "leaf-1";
    thread.resumeCursor = { resume: thread.sourceSessionId, resumeSessionAt: "leaf-1" };
  }
  const imagePath = join(home, "image.png");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
  writeFileSync(imagePath, image);
  thread.turns[0]!.user.attachments.push({ sourceId: "image-1", name: "image.png", mimeType: "image/png", sizeBytes: image.length, path: imagePath });
  thread.turns[0]!.plans.push({ sourceId: "plan-1", markdown: "# Synthetic plan", timestamp: "2026-01-01T00:00:01.000Z" });
  thread.turns.push(nextTurn(2, "interrupted"), nextTurn(3, "failed"));
  thread.updatedAt = thread.turns.at(-1)!.completedAt!;
  const conversation = canonicalConversation(workspace, thread);
  const providerName = source === "codex" ? "codex" : "claudeAgent";
  const instanceId = `${providerName}-fixture`;
  writeFileSync(paths.settingsPath, JSON.stringify({ providerInstances: { [instanceId]: { driver: providerName, enabled: true } } }));
  const imported = await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true, providerInstance: instanceId });
  assert.equal(imported.status, "imported");
  assert.equal(imported.migration, start);
  const originalId = imported.results[0]!.threadId!;
  let projected = reference(start, "project", home);
  assertProjection(paths, conversation, originalId);
  assert.equal(projected.bindings[0].providerInstanceId, instanceId);
  assert.equal(projected.bindings[0].resumeCursor[source === "codex" ? "threadId" : "resume"], thread.sourceSessionId);
  assert.equal((await importConversations([{ conversation, resume: true }], paths, { dryRun: false, resume: true })).status, "already-imported");
  const migration = upgrade ? latestMigration : start;
  if (upgrade) {
    reference(latestMigration, "migrate", home);
    assert.equal(listImports(targetId(paths), source)[0]!.migration, start, "Upgrade must preserve old ledger records");
  }
  // Recover the existing stream without relying on its original external ledger.
  process.env.T3_IMPORT_DATA_DIR = join(home, "recovered-ledger");
  thread.turns.push(nextTurn(4));
  thread.title = "Synchronized title";
  conversation.summary.title = thread.title;
  thread.updatedAt = thread.turns.at(-1)!.completedAt!;
  conversation.fingerprint = "sync-4";
  const synced = await syncConversations([{ conversation }], paths, { dryRun: false });
  assert.equal(synced.status, "synced");
  assert.equal(synced.results[0]!.threadId, originalId);
  assert.equal(synced.migration, migration);
  assert.equal(listImports(targetId(paths), source)[0]!.migration, migration);
  projected = reference(migration, "project", home);
  assertProjection(paths, conversation, originalId);
  assert.equal((await syncConversations([{ conversation }], paths, { dryRun: false })).status, "up-to-date");
  const beforeConflict = eventCount(paths.dbPath);
  thread.turns[0]!.user.text = "Edited history";
  assert.equal((await inspectConversationSync(conversation, paths)).status, "history-diverged");
  assert.equal(eventCount(paths.dbPath), beforeConflict);
  conversation.fingerprint = "replacement";
  const replaced = await replaceConversations([{ conversation }], paths, { dryRun: false });
  assert.equal(replaced.status, "replaced");
  const replacementId = replaced.results[0]!.newThreadId!;
  projected = reference(migration, "project", home);
  assertProjection(paths, conversation, replacementId);
  assert.equal(projected.bindings.length, 1);
  assert.equal(projected.bindings[0].threadId, replacementId);
  assert.equal(projected.bindings[0].resumeCursor[source === "codex" ? "threadId" : "resume"], thread.sourceSessionId);
  assert.equal((await replaceConversations([{ conversation }], paths, { dryRun: false })).status, "already-current");
  const resumed = reference(migration, "resume", home);
  assert.equal(resumed.resumed.starts[0].threadId, replacementId);
  assert.equal(resumed.resumed.turns[0].threadId, replacementId);
  const continued = nextTurn(5);
  continued.id = "controlled-resume-turn";
  thread.turns.push(continued);
  thread.updatedAt = continued.completedAt!;
  conversation.fingerprint = "continued-through-t3";
  const beforeAdoption = eventCount(paths.dbPath);
  const adopted = await syncConversations([{ conversation }], paths, { dryRun: false });
  assert.equal(adopted.results[0]!.turnsAdopted, 1);
  assert.equal(adopted.results[0]!.turnsAdded, 0);
  assert.equal(eventCount(paths.dbPath), beforeAdoption);
  assertProjection(paths, conversation, replacementId);
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    assert.equal(validateTargetDatabase(db).migration, migration);
    const visible = db.prepare("SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL").all();
    assert.deepEqual(visible, [{ thread_id: replacementId }]);
  } finally { db.close(); }
  results.push({ start, migration, source, upgrade, status: "passed" });
  writeFileSync(join(runRoot, "results.json"), JSON.stringify(results, null, 2));
  console.log(`PASS ${source}: migration ${start}${upgrade ? ` → ${latestMigration}` : ""}`);
}

const originalLedger = process.env.T3_IMPORT_DATA_DIR;
try {
  for (const ref of selected) {
    for (const source of ["codex", "claude"] as const) {
      await scenario(ref.migration, source, false);
      if (ref.migration < latestMigration) await scenario(ref.migration, source, true);
    }
  }
  console.log(`${results.length} integration scenarios passed. Results: ${join(runRoot, "results.json")}`);
} finally {
  if (originalLedger === undefined) delete process.env.T3_IMPORT_DATA_DIR;
  else process.env.T3_IMPORT_DATA_DIR = originalLedger;
}
