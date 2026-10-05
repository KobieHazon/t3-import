import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalPath, isObject, pathContains } from "../core/util.js";
import { compatibilityError } from "../core/errors.js";

export interface SavedProject { id: string; title: string; roots: string[]; kind?: "local" | "chatgpt" }
export interface CodexProjects {
  projects: SavedProject[];
  assignments: Map<string, string>;
  projectless: Set<string>;
  hints: Map<string, string>;
}

/** Read desktop organization separately from each conversation's execution cwd. */
export function readCodexProjects(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): CodexProjects {
  let state: unknown;
  try { state = JSON.parse(readFileSync(join(home, ".codex-global-state.json"), "utf8")); }
  catch { throw compatibilityError("Cannot read Codex desktop project metadata. Supply the original desktop --codex-home."); }
  if (!isObject(state) || !isObject(state["local-projects"])) throw compatibilityError("Unsupported Codex desktop project metadata; expected local-projects.");
  const projects: SavedProject[] = [];
  for (const [id, value] of Object.entries(state["local-projects"])) {
    if (!isObject(value) || typeof value.name !== "string" || !value.name.trim() || !Array.isArray(value.rootPaths) || value.rootPaths.length === 0 || value.rootPaths.some(root => typeof root !== "string" || !root.trim())) throw compatibilityError(`Invalid saved local project '${id}'.`);
    // A cloud project's saved local proxy organizes readable imported chats;
    // this does not transfer its cloud files, Pages, or provider capabilities.
    projects.push({ id, title: value.name.trim(), roots: value.rootPaths.map(root => resolve(root as string)), kind: id.startsWith("g-p-") ? "chatgpt" : "local" });
  }
  if (!projects.length) throw compatibilityError("No saved Codex projects; refusing to guess a replacement organization.");
  const assignments = new Map<string, string>(), hints = new Map<string, string>();
  if (isObject(state["thread-project-assignments"])) for (const [id, value] of Object.entries(state["thread-project-assignments"])) {
    if (!isObject(value) || typeof value.projectId !== "string") throw compatibilityError(`Invalid project assignment for '${id}'.`);
    assignments.set(id, value.projectId);
  }
  if (isObject(state["thread-workspace-root-hints"])) for (const [id, value] of Object.entries(state["thread-workspace-root-hints"])) if (typeof value === "string" && value) hints.set(id, value);
  const projectless = state["projectless-thread-ids"] ?? [];
  if (!Array.isArray(projectless) || projectless.some(id => typeof id !== "string")) throw compatibilityError("Invalid projectless-thread-ids metadata.");
  return { projects, assignments, hints, projectless: new Set(projectless as string[]) };
}

export function gitCommonDirectory(cwd: string): string | undefined {
  try { return canonicalPath(execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { return undefined; }
}

export function projectResolver(catalog: CodexProjects, commonDirectory = gitCommonDirectory): (nativeId: string, cwd: string) => { project?: SavedProject; reason: string } {
  const cache = new Map<string, string | undefined>();
  const common = (cwd: string): string | undefined => {
    const key = canonicalPath(cwd);
    if (!cache.has(key)) cache.set(key, commonDirectory(cwd));
    return cache.get(key);
  };
  const byPath = (cwd: string): SavedProject | undefined => {
    const matches = catalog.projects.flatMap(project => project.roots.filter(root => pathContains(root, cwd)).map(root => ({ project, length: canonicalPath(root).length })));
    matches.sort((a, b) => b.length - a.length);
    if (matches[0] && matches[1] && matches[0].length === matches[1].length && matches[0].project.id !== matches[1].project.id) throw compatibilityError(`Ambiguous saved project root for '${cwd}'.`);
    return matches[0]?.project;
  };
  return (nativeId, cwd) => {
    const assigned = catalog.assignments.get(nativeId);
    if (assigned) {
      const project = catalog.projects.find(project => project.id === assigned);
      if (!project) throw compatibilityError(`Thread '${nativeId}' is assigned to a project outside the supported local catalog.`);
      return { project, reason: "saved-assignment" };
    }
    if (catalog.projectless.has(nativeId)) return { reason: "explicitly-projectless" };
    const hint = catalog.hints.get(nativeId), hinted = hint ? byPath(hint) : undefined;
    if (hinted) return { project: hinted, reason: "saved-workspace-hint" };
    const direct = byPath(cwd);
    if (direct) return { project: direct, reason: "saved-root" };
    const directory = common(cwd);
    if (directory) {
      const matches = catalog.projects.filter(project => project.roots.some(root => common(root) === directory));
      if (matches.length > 1) throw compatibilityError(`Git worktree '${cwd}' matches more than one saved project.`);
      if (matches[0]) return { project: matches[0], reason: "shared-git-directory" };
    }
    return { reason: "unassigned" };
  };
}
