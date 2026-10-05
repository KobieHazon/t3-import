import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TargetPaths } from "../core/types.js";
import { canonicalPath, deterministicUuid, sha256 } from "../core/util.js";
import { safetyError, compatibilityError } from "../core/errors.js";
import { assertT3Closed } from "./schema.js";
import { validateV2Database } from "./upgradeV2.js";
import { projectResolver, type CodexProjects } from "../sources/codexProjects.js";

type Row = Record<string, any>;
export interface RegroupOptions { dryRun: boolean; unassignedWorkspace: string; includeNative?: boolean }

/** Metadata-only correction. Native runs/history/bindings are never replaced. */
export async function regroupV2Projects(paths: TargetPaths, catalog: CodexProjects, options: RegroupOptions) {
  await assertT3Closed(paths);
  const db = new Database(paths.dbPath, { readonly: options.dryRun, fileMustExist: true });
  let transaction = false;
  try {
    validateV2Database(db);
    db.exec("BEGIN"); transaction = true;
    if (db.prepare("SELECT 1 FROM orchestration_v2_projection_runs WHERE status IN ('running','pending','queued') LIMIT 1").get()) throw safetyError("Native provider work is active; checkpoint it and close T3 before regrouping projects.");
    const projectQuery = "SELECT * FROM projection_projects WHERE deleted_at IS NULL ORDER BY project_id";
    const threadQuery = "SELECT * FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY thread_id";
    const scheduleQuery = "SELECT * FROM scheduled_tasks ORDER BY task_id";
    const projects = db.prepare(projectQuery).all() as Row[];
    const threads = db.prepare(threadQuery).all() as Row[];
    const targetProjects = catalog.projects.map(project => {
      const existing = projects.find(row => canonicalPath(row.workspace_root) === canonicalPath(project.roots[0]!));
      return { ...project, projectId: existing?.project_id ?? deterministicUuid(`t3-import:saved-project:${project.id}`), existing, workspace: project.roots[0]! };
    });
    if (new Set(targetProjects.map(project => project.projectId)).size !== targetProjects.length || new Set(targetProjects.map(project => canonicalPath(project.workspace))).size !== targetProjects.length) throw compatibilityError("Saved projects share a target workspace; refusing to merge distinct saved groups.");
    const fallbackRoot = resolve(options.unassignedWorkspace);
    if (targetProjects.some(project => canonicalPath(project.workspace) === canonicalPath(fallbackRoot))) throw compatibilityError("The unassigned workspace must be separate from saved project roots.");
    const fallbackExisting = projects.find(row => canonicalPath(row.workspace_root) === canonicalPath(fallbackRoot));
    const fallback = { id: "unassigned", title: "Other chats", roots: [fallbackRoot], workspace: fallbackRoot, projectId: fallbackExisting?.project_id ?? deterministicUuid(`t3-import:unassigned-project:${canonicalPath(fallbackRoot)}`), existing: fallbackExisting };
    const select = projectResolver(catalog);
    const moves: Array<{ row: Row; payload: Row; targetId: string; cwd: string; reason: string }> = [];
    const assignments = new Map<string, string>();
    for (const row of threads) {
      const payload = JSON.parse(row.payload_json) as Row;
      const bindingRow = payload.activeProviderThreadId ? db.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?").get(payload.activeProviderThreadId) as Row | undefined : undefined;
      const binding = bindingRow ? JSON.parse(bindingRow.payload_json) as Row : undefined;
      if (binding?.nativeThreadRef?.driver !== "codex" || (payload.historyOrigin !== "v1_import" && !options.includeNative)) continue;
      const oldProject = projects.find(project => project.project_id === row.project_id);
      if (!oldProject) throw compatibilityError(`Missing active project for '${row.thread_id}'.`);
      const cwd = payload.worktreePath ?? oldProject.workspace_root;
      const selected = select(binding.nativeThreadRef.nativeId, cwd);
      const target = selected.project ? targetProjects.find(project => project.id === selected.project!.id)! : fallback;
      assignments.set(row.thread_id, target.projectId);
      // Changing grouping must not change where a resumed provider executes.
      const worktreePath = payload.worktreePath ?? (canonicalPath(cwd) === canonicalPath(target.workspace) ? null : cwd);
      if (row.project_id !== target.projectId || payload.worktreePath !== worktreePath) moves.push({ row, targetId: target.projectId, cwd, reason: selected.reason, payload: { ...payload, projectId: target.projectId, worktreePath } });
    }
    const desired = [...targetProjects, ...(assignments.size && [...assignments.values()].includes(fallback.projectId) ? [fallback] : [])];
    const keep = new Set(desired.map(project => project.projectId));
    const schedules = db.prepare(scheduleQuery).all() as Row[];
    const snapshot = sha256(JSON.stringify([projects, threads, schedules]));
    const scheduleMoves = schedules.flatMap(task => {
      const target = task.thread_id ? assignments.get(task.thread_id) : undefined;
      return target && target !== task.project_id ? [{ id: task.task_id, projectId: target }] : [];
    });
    const oldGroups = new Set(moves.filter(move => move.row.project_id !== move.targetId).map(move => move.row.project_id));
    const importedHeader = (project: Row): boolean => {
      const key = canonicalPath(project.workspace_root);
      if (project.project_id !== deterministicUuid(`t3-import:project:${key}`)) return false;
      return Boolean(db.prepare("SELECT 1 FROM orchestration_events WHERE event_id=? AND stream_id=? AND aggregate_kind='project' AND event_type='project.created'").get(deterministicUuid(`t3-import:event:project:${key}:project.created`), project.project_id));
    };
    const deletions = projects.filter(project => (oldGroups.has(project.project_id) || importedHeader(project)) && !keep.has(project.project_id) && !threads.some(thread => (assignments.get(thread.thread_id) ?? thread.project_id) === project.project_id) && !schedules.some(task => task.project_id === project.project_id && !scheduleMoves.some(move => move.id === task.task_id)));
    const changes = desired.filter(project => !project.existing || project.existing.title !== project.title);
    const result = { status: options.dryRun ? "dry-run" : "unchanged", projectsBefore: projects.length, projectsAfter: projects.length + desired.filter(project => !project.existing).length - deletions.length,
      savedProjects: targetProjects.length, regroupedThreads: moves.length, regroupedSchedules: scheduleMoves.length, retiredProjectHeaders: deletions.length, events: 0, backup: undefined as string | undefined,
      projects: [...desired.map(project => ({ id: project.projectId, title: project.title, workspace: project.workspace, threads: threads.filter(thread => (assignments.get(thread.thread_id) ?? thread.project_id) === project.projectId).length })), ...projects.filter(project => !keep.has(project.project_id) && !deletions.includes(project)).map(project => ({ id: project.project_id, title: project.title, workspace: project.workspace_root, threads: threads.filter(thread => (assignments.get(thread.thread_id) ?? thread.project_id) === project.project_id).length }))],
      threads: moves.map(move => ({ id: move.row.thread_id, fromProjectId: move.row.project_id, toProjectId: move.targetId, workingDirectory: move.cwd, reason: move.reason })) };
    // Read planning is consistent; an actual write takes an exclusive transaction
    // after a verified backup. The app remains closed throughout.
    db.exec("ROLLBACK"); transaction = false;
    if (!changes.length && !moves.length && !deletions.length && !scheduleMoves.length) return result;
    if (!options.dryRun) {
      const dir = join(paths.stateDir, "t3-import-backups", `before-project-regroup-${randomUUID()}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 }); result.backup = join(dir, "statev2.sqlite");
      await db.backup(result.backup);
      const backup = new Database(result.backup, { readonly: true });
      try { if (backup.pragma("quick_check", { simple: true }) !== "ok") throw safetyError("Project regrouping backup integrity check failed."); } finally { backup.close(); }
      await assertT3Closed(paths);
      db.exec("BEGIN IMMEDIATE"); transaction = true;
      if (snapshot !== sha256(JSON.stringify([db.prepare(projectQuery).all(), db.prepare(threadQuery).all(), db.prepare(scheduleQuery).all()]))) throw safetyError("Project metadata changed during offline planning; retry with T3 closed.");
    }
    const now = new Date().toISOString();
    const append = (kind: string, id: string, type: string, payload: Row): void => {
      result.events++;
      if (options.dryRun) return;
      const version = (db.prepare("SELECT COALESCE(MAX(stream_version),-1)+1 n FROM orchestration_events WHERE aggregate_kind=? AND stream_id=?").get(kind, id) as Row).n;
      db.prepare("INSERT INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json,application_event_version) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,'server',?,?,?)")
        .run(`t3-import:projects:${randomUUID()}`, kind, id, version, type, now, JSON.stringify(payload), JSON.stringify({ importer: "t3-import:projects", metadataOnly: true }), kind === "thread" ? 2 : 1);
    };
    for (const project of changes) {
      if (project.existing) {
        append("project", project.projectId, "project.meta-updated", { projectId: project.projectId, title: project.title, updatedAt: now });
        if (!options.dryRun) db.prepare("UPDATE projection_projects SET title=?,updated_at=? WHERE project_id=?").run(project.title, now, project.projectId);
      } else {
        append("project", project.projectId, "project.created", { projectId: project.projectId, title: project.title, workspaceRoot: project.workspace, defaultModelSelection: null, scripts: [], createdAt: now, updatedAt: now });
        if (!options.dryRun) db.prepare("INSERT INTO projection_projects (project_id,title,workspace_root,default_model_selection_json,scripts_json,created_at,updated_at,deleted_at) VALUES (?,?,?,'null','[]',?,?,NULL)").run(project.projectId, project.title, project.workspace, now, now);
      }
    }
    for (const move of moves) {
      append("thread", move.row.thread_id, "thread.metadata-updated", move.payload);
      if (!options.dryRun) {
        const actual = db.prepare("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?").get(move.row.thread_id) as Row;
        if (sha256(actual.payload_json) !== sha256(move.row.payload_json)) throw safetyError("Thread metadata changed during offline planning; retry with T3 closed.");
        db.prepare("UPDATE orchestration_v2_projection_threads SET project_id=?,payload_json=? WHERE thread_id=?").run(move.targetId, JSON.stringify(move.payload), move.row.thread_id);
      }
    }
    if (!options.dryRun) for (const move of scheduleMoves) db.prepare("UPDATE scheduled_tasks SET project_id=? WHERE task_id=?").run(move.projectId, move.id);
    for (const project of deletions) {
      append("project", project.project_id, "project.deleted", { projectId: project.project_id, deletedAt: now });
      if (!options.dryRun) db.prepare("UPDATE projection_projects SET deleted_at=?,updated_at=? WHERE project_id=?").run(now, now, project.project_id);
    }
    if (transaction) {
      db.prepare("UPDATE orchestration_v2_projection_metadata SET last_sequence=?,updated_at=? WHERE projection_name='thread-projections'").run((db.prepare("SELECT MAX(sequence) n FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread'").get() as Row).n, now);
      db.exec("COMMIT"); transaction = false; result.status = "regrouped";
    }
    return result;
  } catch (error) { if (transaction) db.exec("ROLLBACK"); throw error; }
  finally { db.close(); }
}
