import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexProjects, projectResolver, type CodexProjects } from "../src/sources/codexProjects.js";
import { regroupV2Projects } from "../src/target/regroupV2.js";
import { upgradeLegacyToV2 } from "../src/target/upgradeV2.js";
import { resolveTargetPaths } from "../src/target/config.js";
import { createTarget } from "./helpers.js";
import { canonicalPath, deterministicUuid } from "../src/core/util.js";

const roots: string[] = [], at = "2026-01-01T00:00:00.000Z";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
function temp() { const root = mkdtempSync(join(tmpdir(), "t3-project-grouping-")); roots.push(root); return root; }
function seed(db: Database.Database, table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row); db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
}
function catalog(): CodexProjects { return { projects: [{ id: "saved", title: "Research", roots: ["/synthetic/research"] }], assignments: new Map([[ids[0]!, "saved"]]), projectless: new Set([ids[1]!]), hints: new Map() }; }
async function fixture() {
  const root = temp(), legacy = createTarget(join(root, "v1"), 54), source = new Database(legacy.dbPath);
  for (const [index, id] of ids.entries()) {
    const projectId = `old-${index}`, cwd = `/synthetic/scratch-${index}`;
    seed(source, "projection_projects", { project_id: projectId, title: `scratch-${index}`, workspace_root: cwd, scripts_json: "[]", created_at: at, updated_at: at, deleted_at: null });
    seed(source, "orchestration_events", { event_id: `project-${index}`, aggregate_kind: "project", stream_id: projectId, stream_version: 0, event_type: "project.created", occurred_at: at, actor_kind: "client", payload_json: JSON.stringify({ projectId, title: `scratch-${index}`, workspaceRoot: cwd, defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }), metadata_json: "{}" });
    seed(source, "projection_threads", { thread_id: id, project_id: projectId, title: "Synthetic chat", created_at: at, updated_at: at, model_selection_json: '{"instanceId":"codex","model":"gpt-test"}', runtime_mode: "full-access", interaction_mode: "default" });
    seed(source, "projection_thread_messages", { thread_id: id, message_id: `u-${index}`, role: "user", text: "Synthetic input", is_streaming: 0, created_at: at, updated_at: at, attachments_json: "[]" });
    seed(source, "projection_turns", { thread_id: id, turn_id: `turn-${index}`, pending_message_id: `u-${index}`, state: "error", requested_at: at, started_at: at, completed_at: at, checkpoint_files_json: "[]" });
    seed(source, "projection_thread_activities", { activity_id: `failed-${index}`, thread_id: id, turn_id: `turn-${index}`, tone: "error", kind: "tool.failed", summary: "Synthetic failure", payload_json: '{"unknownField":[1,2,3]}', created_at: at, sequence: 0 });
    seed(source, "provider_session_runtime", { thread_id: id, provider_name: "codex", provider_instance_id: "codex", adapter_key: "codex", runtime_mode: "full-access", status: "stopped", last_seen_at: at, resume_cursor_json: JSON.stringify({ threadId: id }), runtime_payload_json: "{}" });
  }
  source.close();
  const paths = resolveTargetPaths({ t3Home: join(root, "v2"), dbPath: join(root, "v2", "userdata", "statev2.sqlite") }); mkdirSync(paths.stateDir, { recursive: true });
  const db = new Database(paths.dbPath), schema = JSON.parse(readFileSync(new URL("./fixtures/t3-v2-schema-56.json", import.meta.url), "utf8"));
  db.exec(schema.ddl.join(";\n")); for (const row of schema.migrations) seed(db, "effect_sql_migrations", row); db.close();
  await upgradeLegacyToV2(paths, { legacyDbPath: legacy.dbPath, dryRun: false });
  const target = new Database(paths.dbPath);
  seed(target, "scheduled_tasks", { task_id: "timer", title: "Keepalive", prompt: "Read the current queue", enabled: 1, schedule_json: '{"type":"interval","everyMs":600000}', project_id: "old-0", thread_id: ids[0], workspace_strategy_json: '{"type":"root"}', model_selection_json: '{"instanceId":"codex","model":"gpt-test"}', runtime_mode: "full-access", interaction_mode: "default", created_by: "agent", creation_source: "mcp", created_at: at, updated_at: at, next_run_at: "2026-01-01T00:10:00.000Z", last_run_status: "never", run_count: 0 });
  target.close(); return { root, legacy, paths };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("saved Codex project resolution", () => {
  it("reads titles, roots, explicit assignments, projectless membership and cloud grouping proxies", () => {
    const root = temp(); writeFileSync(join(root, ".codex-global-state.json"), JSON.stringify({ "local-projects": { saved: { name: "Research", rootPaths: ["/synthetic/research"] }, "g-p-example": { name: "Cloud group", rootPaths: ["/synthetic/cloud-proxy"] } }, "thread-project-assignments": { t: { projectKind: "local", projectId: "saved" } }, "projectless-thread-ids": ["personal"], "thread-workspace-root-hints": { h: "/synthetic/research" } }));
    const parsed = readCodexProjects(root); expect(parsed.projects.map(project => [project.title, project.kind])).toEqual([["Research", "local"], ["Cloud group", "chatgpt"]]); expect(parsed.assignments.get("t")).toBe("saved"); expect(parsed.projectless.has("personal")).toBe(true); expect(parsed.hints.get("h")).toBe("/synthetic/research");
  });
  it("honors explicit assignment before stale cwd and projectless membership", () => {
    const c = catalog(); c.projectless.add(ids[0]!); expect(projectResolver(c)(ids[0]!, "/synthetic/old-worktree")).toMatchObject({ project: { id: "saved" }, reason: "saved-assignment" });
  });
  it("honors projectless membership before directory inference", () => { expect(projectResolver(catalog())(ids[1]!, "/synthetic/research/subdir")).toEqual({ reason: "explicitly-projectless" }); });
  it("uses the most specific saved root and keeps path boundaries", () => {
    const c = catalog(); c.projects.push({ id: "nested", title: "Nested", roots: ["/synthetic/research/code"] });
    const resolve = projectResolver(c, () => undefined); expect(resolve("x", "/synthetic/research/code/src").project?.id).toBe("nested"); expect(resolve("x", "/synthetic/research-other").project).toBeUndefined();
  });
  it("uses saved hints before stale execution directories", () => { const c = catalog(); c.hints.set("x", "/synthetic/research"); expect(projectResolver(c)("x", "/synthetic/scratch").reason).toBe("saved-workspace-hint"); });
  it("groups Git worktrees through their shared repository directory", () => { const resolve = projectResolver(catalog(), path => path === "/synthetic/worktree" || path === "/synthetic/research" ? "/synthetic/research/.git" : undefined); expect(resolve("x", "/synthetic/worktree")).toMatchObject({ project: { id: "saved" }, reason: "shared-git-directory" }); });
  it("refuses unknown assignments, ambiguous repositories and malformed metadata", () => {
    const c = catalog(); c.assignments.set("x", "absent"); expect(() => projectResolver(c)("x", "/synthetic/research")).toThrow("outside");
    c.projects.push({ id: "same-repo", title: "Other", roots: ["/synthetic/other"] }); expect(() => projectResolver(c, () => "/same/.git")("unassigned", "/worktree")).toThrow("more than one");
    const root = temp(); writeFileSync(join(root, ".codex-global-state.json"), '{"local-projects":{"p":{"name":"P","rootPaths":[]}}}'); expect(() => readCodexProjects(root)).toThrow("Invalid saved");
  });
});

describe("native V2 project regrouping", () => {
  const options = { dryRun: false, unassignedWorkspace: "/synthetic/general" };
  it("previews grouping without changing either database", async () => {
    const { paths, legacy } = await fixture(), before = readFileSync(paths.dbPath), source = readFileSync(legacy.dbPath);
    const result = await regroupV2Projects(paths, catalog(), { ...options, dryRun: true }); expect(result).toMatchObject({ status: "dry-run", projectsBefore: 2, projectsAfter: 2, regroupedThreads: 2, regroupedSchedules: 1, retiredProjectHeaders: 2 }); expect(result.backup).toBeUndefined(); expect(readFileSync(paths.dbPath)).toEqual(before); expect(readFileSync(legacy.dbPath)).toEqual(source);
  });
  it("preserves full history, native bindings, timestamps and execution cwd while moving the bound timer", async () => {
    const { paths } = await fixture(), before = new Database(paths.dbPath, { readonly: true });
    const tables = ["orchestration_v2_projection_messages", "orchestration_v2_projection_turn_items", "orchestration_v2_projection_runs", "orchestration_v2_projection_provider_threads", "orchestration_v2_projection_context_handoffs"];
    const snapshots = tables.map(table => before.prepare(`SELECT * FROM ${table}`).all()); const oldTask = before.prepare("SELECT * FROM scheduled_tasks").get() as Record<string, unknown>; before.close();
    const result = await regroupV2Projects(paths, catalog(), options); expect(existsSync(result.backup!)).toBe(true); expect(result.status).toBe("regrouped");
    const after = new Database(paths.dbPath, { readonly: true }); for (const [index, table] of tables.entries()) expect(after.prepare(`SELECT * FROM ${table}`).all()).toEqual(snapshots[index]);
    const thread = after.prepare("SELECT project_id,payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(ids[0]) as { project_id: string; payload_json: string }; expect(JSON.parse(thread.payload_json)).toMatchObject({ worktreePath: "/synthetic/scratch-0", updatedAt: at });
    const task = after.prepare("SELECT * FROM scheduled_tasks").get() as Record<string, unknown>; expect(task.project_id).toBe(thread.project_id); expect({ ...task, project_id: oldTask.project_id }).toEqual(oldTask);
    expect((after.prepare("SELECT COUNT(*) n FROM projection_projects WHERE deleted_at IS NULL").get() as { n: number }).n).toBe(2);
    expect(after.prepare("SELECT default_model_selection_json FROM projection_projects WHERE deleted_at IS NULL").all()).toEqual([{ default_model_selection_json: null }, { default_model_selection_json: null }]);
    const cursor = after.prepare("SELECT last_sequence n FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections'").get();
    expect(cursor).toEqual(after.prepare("SELECT MAX(sequence) n FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'").get());
    const metadataEvents = after.prepare("SELECT payload_json FROM orchestration_events WHERE metadata_json LIKE '%metadataOnly%' AND event_type='thread.metadata-updated'").all() as { payload_json: string }[]; expect(metadataEvents).toHaveLength(2); expect(metadataEvents.map(event => JSON.parse(event.payload_json).worktreePath)).toEqual(["/synthetic/scratch-0", "/synthetic/scratch-1"]); after.close();
    expect(await regroupV2Projects(paths, catalog(), options)).toMatchObject({ status: "unchanged", events: 0, regroupedThreads: 0, regroupedSchedules: 0 });
  });
  it("preserves an explicit thread worktree independently of its old project root", async () => {
    const { paths } = await fixture(), db = new Database(paths.dbPath); const row = db.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(ids[0]) as { payload_json: string }; const payload = { ...JSON.parse(row.payload_json), worktreePath: "/synthetic/actual-worktree" }; db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?").run(JSON.stringify(payload), ids[0]); db.close();
    await regroupV2Projects(paths, catalog(), options); const after = new Database(paths.dbPath, { readonly: true }); expect(JSON.parse((after.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(ids[0]) as { payload_json: string }).payload_json).worktreePath).toBe("/synthetic/actual-worktree"); after.close();
  });
  it("keeps unrelated native projects by default and unbound schedules on their original workspace", async () => {
    const { paths } = await fixture(), db = new Database(paths.dbPath); const row = db.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(ids[1]) as { payload_json: string }; db.prepare("UPDATE orchestration_v2_projection_threads SET payload_json=? WHERE thread_id=?").run(JSON.stringify({ ...JSON.parse(row.payload_json), historyOrigin: null }), ids[1]); db.prepare("UPDATE scheduled_tasks SET thread_id=NULL").run(); db.close();
    const result = await regroupV2Projects(paths, catalog(), options); expect(result.regroupedThreads).toBe(1); expect(result.regroupedSchedules).toBe(0); expect(result.retiredProjectHeaders).toBe(0);
    const included = await regroupV2Projects(paths, catalog(), { ...options, includeNative: true }); expect(included.regroupedThreads).toBe(1); expect(included.retiredProjectHeaders).toBe(1);
  });
  it("preserves unrelated empty project headers and refuses duplicate saved roots", async () => {
    const { paths } = await fixture(), db = new Database(paths.dbPath);
    seed(db, "projection_projects", { project_id: "unrelated", title: "Existing empty project", workspace_root: "/synthetic/unrelated", scripts_json: "[]", created_at: at, updated_at: at, deleted_at: null }); db.close();
    const duplicate = catalog(); duplicate.projects.push({ id: "duplicate", title: "Different saved group", roots: ["/synthetic/research"] });
    await expect(regroupV2Projects(paths, duplicate, options)).rejects.toThrow("distinct saved groups");
    expect(await regroupV2Projects(paths, catalog(), options)).toMatchObject({ projectsAfter: 3, retiredProjectHeaders: 2 });
    const after = new Database(paths.dbPath, { readonly: true }); expect(after.prepare("SELECT deleted_at FROM projection_projects WHERE project_id='unrelated'").get()).toEqual({ deleted_at: null }); after.close();
  });
  it("retires empty headers only with the importer's exact project and creation-event identities", async () => {
    const { paths } = await fixture(), db = new Database(paths.dbPath);
    for (const suffix of ["owned", "lookalike"]) {
      const root = `/synthetic/${suffix}`, key = canonicalPath(root), projectId = deterministicUuid(`t3-import:project:${key}`);
      seed(db, "projection_projects", { project_id: projectId, title: suffix, workspace_root: root, scripts_json: "[]", created_at: at, updated_at: at, deleted_at: null });
      if (suffix === "owned") seed(db, "orchestration_events", { event_id: deterministicUuid(`t3-import:event:project:${key}:project.created`), aggregate_kind: "project", stream_id: projectId, stream_version: 0, event_type: "project.created", occurred_at: at, actor_kind: "client", payload_json: JSON.stringify({ projectId, title: suffix, workspaceRoot: root, defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }), metadata_json: "{}" });
    }
    db.close();
    expect(await regroupV2Projects(paths, catalog(), options)).toMatchObject({ projectsAfter: 3, retiredProjectHeaders: 3 });
    const after = new Database(paths.dbPath, { readonly: true }); expect(after.prepare("SELECT title FROM projection_projects WHERE deleted_at IS NULL ORDER BY title").all()).toEqual([{ title: "Other chats" }, { title: "Research" }, { title: "lookalike" }]); after.close();
  });
  it("refuses running providers, live targets, overlapping fallback roots and unknown schemas", async () => {
    const { paths } = await fixture(); await expect(regroupV2Projects(paths, catalog(), { ...options, unassignedWorkspace: "/synthetic/research" })).rejects.toThrow("separate");
    const db = new Database(paths.dbPath); db.prepare("UPDATE orchestration_v2_projection_runs SET status='running'").run(); db.close(); await expect(regroupV2Projects(paths, catalog(), options)).rejects.toThrow("active");
    const reset = new Database(paths.dbPath); reset.prepare("UPDATE orchestration_v2_projection_runs SET status='failed'").run(); reset.prepare("UPDATE effect_sql_migrations SET migration_id=57 WHERE migration_id=56").run(); reset.close(); await expect(regroupV2Projects(paths, catalog(), options)).rejects.toThrow("Unsupported V2");
    writeFileSync(paths.runtimeStatePath, JSON.stringify({ pid: process.pid })); await expect(regroupV2Projects(paths, catalog(), options)).rejects.toThrow("T3 is running");
  });
});
