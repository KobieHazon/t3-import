import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { CanonicalActivity, CanonicalMessage, CanonicalThread, CanonicalTurn, SourceAttachment, SourceSummary } from "../core/types.js";
import { sourceError } from "../core/errors.js";
import { isObject, isoTimestamp, stringValue, truncate } from "../core/util.js";

const SYNTHETIC_PREFIXES = ["<recommended_plugins>", "<environment_context>", "<app-context>", "<permissions instructions>"];
const TOOL_TYPES: Record<string, string> = {
  commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call",
  dynamicToolCall: "dynamic_tool_call", collabAgentToolCall: "collab_agent_tool_call",
  webSearch: "web_search", imageView: "image_view", imageGeneration: "image_generation",
};

async function userContent(content: unknown, id: string, warnings: Set<string>): Promise<{ text: string; attachments: SourceAttachment[] }> {
  const texts: string[] = [];
  const attachments: SourceAttachment[] = [];
  for (const [index, value] of (Array.isArray(content) ? content : []).entries()) {
    if (!isObject(value)) continue;
    if (value.type === "text" && typeof value.text === "string") texts.push(value.text);
    else if (value.type === "localImage" && typeof value.path === "string") {
      const extension = extname(value.path).toLowerCase();
      const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[extension];
      if (!mimeType) { warnings.add(`Unsupported image type: ${extension || "unknown"}`); continue; }
      let info;
      try { info = await stat(value.path); }
      catch (error) {
        if (!isObject(error) || error.code !== "ENOENT") throw error;
        warnings.add(`Missing local image: ${value.path}`);
        texts.push(`[Missing image: ${basename(value.path)}]`);
        continue;
      }
      attachments.push({ sourceId: `${id}:image:${index}`, name: basename(value.path), mimeType, sizeBytes: info.size, path: value.path });
    } else if (value.type === "image" && typeof value.url === "string") {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(value.url);
      if (match) {
        const data = Buffer.from(match[2]!, "base64");
        attachments.push({ sourceId: `${id}:image:${index}`, name: `image-${index + 1}`, mimeType: match[1]!, sizeBytes: data.length, data });
      } else attachments.push({ sourceId: `${id}:image:${index}`, name: `image-${index + 1}`, mimeType: "image/unknown", sizeBytes: 0, remoteUrl: value.url });
    } else if (value.type === "mention" || value.type === "skill") {
      texts.push(`[${String(value.type)}: ${String(value.name ?? "")} (${String(value.path ?? "")})]`);
    } else {
      warnings.add(`Codex ${String(value.type)} input cannot be represented as a T3 attachment.`);
      texts.push(`[Codex ${String(value.type)} input]`);
    }
  }
  return { text: texts.join("\n\n").trim(), attachments };
}

/** Normalize public app-server items; never inspect Codex's private SQLite layout. */
export async function normalizeCodexHistory(thread: Record<string, unknown>, summary: SourceSummary, includeIncomplete = false): Promise<CanonicalThread> {
  if (!Array.isArray(thread.turns)) throw sourceError(`Codex thread ${summary.id} has no readable turns`);
  const warnings = new Set<string>();
  const turns: CanonicalTurn[] = [];
  let ignoredInProgressTurns = 0;
  const seenTurns = new Set<string>();
  for (const raw of thread.turns) {
    if (!isObject(raw) || typeof raw.id !== "string") throw sourceError("Invalid Codex history turn");
    if (seenTurns.has(raw.id)) throw sourceError("Duplicate Codex history turn id");
    seenTurns.add(raw.id);
    if (!["completed", "interrupted", "failed", "inProgress"].includes(String(raw.status))) throw sourceError(`Unknown Codex turn status: ${String(raw.status)}`);
    if (raw.status === "inProgress" && !includeIncomplete) { ignoredInProgressTurns++; continue; }
    const startedAt = isoTimestamp(raw.startedAt, summary.createdAt);
    const completedAt = raw.completedAt == null ? undefined : isoTimestamp(raw.completedAt, startedAt);
    const users: CanonicalMessage[] = [];
    const assistant: CanonicalMessage[] = [];
    const activities: CanonicalActivity[] = [];
    const plans: CanonicalTurn["plans"] = [];
    const entries = Array.isArray(raw.itemEntries) ? raw.itemEntries : Array.isArray(raw.items) ? raw.items.map((item) => ({ item })) : [];
    const seen = new Set<string>();
    let lastItemTime = new Date(startedAt).valueOf() - 1;
    for (const entry of entries) {
      if (!isObject(entry) || !isObject(entry.item)) throw sourceError("Invalid Codex history item");
      const item = entry.item;
      const id = stringValue(item.id);
      if (!id || seen.has(id)) throw sourceError("Missing or duplicate Codex history item id");
      seen.add(id);
      const recorded = isoTimestamp(entry.startedAtMs ?? entry.completedAtMs, startedAt);
      // Preserve API order when old producers omitted item timestamps.
      lastItemTime = Math.max(new Date(recorded).valueOf(), lastItemTime + 1);
      const timestamp = new Date(lastItemTime).toISOString();
      if (item.type === "userMessage") {
        const content = await userContent(item.content, id, warnings);
        if (SYNTHETIC_PREFIXES.some((prefix) => content.text.startsWith(prefix))) continue;
        if (content.text || content.attachments.length) users.push({ sourceId: id, role: "user", text: content.text || "[Image attachment]", timestamp, attachments: content.attachments });
      } else if (item.type === "agentMessage") {
        if (typeof item.text === "string" && item.text) assistant.push({ sourceId: id, role: "assistant", text: item.text, timestamp, attachments: [] });
      } else if (item.type === "plan") {
        if (typeof item.text === "string") plans.push({ sourceId: id, markdown: item.text, timestamp });
      } else if (item.type === "reasoning") {
        const detail = Array.isArray(item.summary) ? item.summary.filter((value) => typeof value === "string").join("\n") : "";
        if (detail) activities.push({ sourceId: id, timestamp, tone: "info", kind: "reasoning.summary", summary: "Reasoning", payload: { detail } });
      } else if (item.type === "contextCompaction") {
        activities.push({ sourceId: id, timestamp, tone: "info", kind: "context-compaction", summary: "Context compacted", payload: { state: "compacted" } });
      } else if (item.type !== "hookPrompt") {
        const itemType = TOOL_TYPES[String(item.type)] ?? "dynamic_tool_call";
        const failed = item.status === "failed" || item.success === false || item.error != null;
        const title = stringValue(item.tool) ?? stringValue(item.command) ?? stringValue(item.type) ?? "Codex activity";
        if (!TOOL_TYPES[String(item.type)]) warnings.add(`Codex ${String(item.type)} preserved as a generic activity.`);
        activities.push({ sourceId: id, timestamp, tone: failed ? "error" : "tool", kind: "tool.completed", summary: truncate(title, 120), payload: {
          itemType, status: failed ? "failed" : "completed", title: truncate(title, 120),
          ...(itemType === "collab_agent_tool_call" ? { agentId: id } : {}),
          data: { toolCallId: id, item },
        } });
      }
    }
    if (!users.length) {
      if (!assistant.length && !activities.length && !plans.length) continue;
      warnings.add(`Turn ${raw.id} has no recorded user input; a continuation placeholder was inserted.`);
      users.push({ sourceId: `${raw.id}:continuation`, role: "user", text: "[Codex continuation without a recorded user message]", timestamp: startedAt, attachments: [] });
    }
    const first = users[0]!;
    const error = isObject(raw.error) ? stringValue(raw.error.message) : stringValue(raw.error);
    turns.push({ id: raw.id, startedAt, ...(completedAt ? { completedAt } : {}), status: raw.status as CanonicalTurn["status"],
      ...(error ? { terminalError: error } : {}),
      user: { ...first, text: users.map((user) => user.text).join("\n\n"), attachments: users.flatMap((user) => user.attachments) },
      assistant, activities, plans });
  }
  if (!turns.length && !ignoredInProgressTurns) throw sourceError(`No importable Codex turns in ${summary.id}`);
  const git = isObject(thread.gitInfo) ? thread.gitInfo : {};
  return { source: "codex", sourceSessionId: summary.id, sourceKey: `codex:${summary.id}`, currentBranch: true,
    title: stringValue(thread.name) ?? summary.title, workspace: stringValue(thread.cwd) ?? summary.workspace,
    model: stringValue(thread.model) ?? "default", ...(stringValue(thread.reasoningEffort) ? { effort: String(thread.reasoningEffort) } : {}),
    ...(stringValue(git.branch) ? { gitBranch: String(git.branch) } : {}),
    createdAt: isoTimestamp(thread.createdAt, summary.createdAt), updatedAt: isoTimestamp(thread.updatedAt, summary.updatedAt),
    turns, ignoredInProgressTurns, resumeCursor: { threadId: summary.id }, warnings: [...warnings] };
}
