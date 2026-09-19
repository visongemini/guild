import { isAbsolute, relative, resolve } from "node:path";
import type {
  GuildLocale,
  TaskWorkbenchProjection,
} from "@guild/contracts";
import type { ConversationEntryRecord } from "@guild/persistence";

const EXPORTABLE_KINDS = new Set(["user", "assistant", "thought", "tool", "notice", "error"]);

export function allConversationEntries(
  list: (afterSequence: number, limit: number) => readonly ConversationEntryRecord[],
): readonly ConversationEntryRecord[] {
  const entries: ConversationEntryRecord[] = [];
  let afterSequence = 0;
  while (true) {
    const page = list(afterSequence, 500);
    entries.push(...page);
    if (page.length < 500) break;
    const next = page.at(-1)?.sequence;
    if (next === undefined || next <= afterSequence) throw new Error("conversation_pagination_stalled");
    afterSequence = next;
  }
  return Object.freeze(entries);
}

export function latestToolEntries(
  entries: readonly ConversationEntryRecord[],
): readonly ConversationEntryRecord[] {
  const latest = new Map<string, ConversationEntryRecord>();
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    const toolCallId = entry.metadata["toolCallId"];
    if (typeof toolCallId === "string" && toolCallId.length > 0) latest.set(toolCallId, entry);
  }
  return Object.freeze(entries.filter((entry) => {
    if (entry.kind !== "tool") return true;
    const toolCallId = entry.metadata["toolCallId"];
    return typeof toolCallId !== "string" || toolCallId.length === 0 || latest.get(toolCallId) === entry;
  }));
}

export function buildTaskWorkbench(
  workspacePath: string,
  entries: readonly ConversationEntryRecord[],
): TaskWorkbenchProjection {
  const files = new Map<string, { readonly path: string; readonly displayPath: string; readonly line?: number }>();
  const diffs = new Map<string, { readonly path: string; readonly displayPath: string; readonly oldText?: string; readonly newText: string }>();
  let terminalObserved = false;
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    const locations = Array.isArray(entry.metadata["locations"]) ? entry.metadata["locations"] : [];
    for (const raw of locations) {
      if (!isRecord(raw) || typeof raw["path"] !== "string") continue;
      const normalized = workspaceResource(workspacePath, raw["path"]);
      if (normalized === undefined) continue;
      const line = typeof raw["line"] === "number" && Number.isSafeInteger(raw["line"]) && raw["line"] > 0
        ? raw["line"]
        : undefined;
      files.set(normalized.path, Object.freeze({ ...normalized, ...(line === undefined ? {} : { line }) }));
    }
    const content = Array.isArray(entry.metadata["content"]) ? entry.metadata["content"] : [];
    for (const raw of content) {
      if (!isRecord(raw) || typeof raw["type"] !== "string") continue;
      if (raw["type"] === "terminal") {
        terminalObserved = true;
        continue;
      }
      if (raw["type"] !== "diff" || typeof raw["path"] !== "string" || typeof raw["newText"] !== "string") continue;
      const normalized = workspaceResource(workspacePath, raw["path"]);
      if (normalized === undefined) continue;
      const oldText = typeof raw["oldText"] === "string" ? raw["oldText"] : undefined;
      diffs.set(normalized.path, Object.freeze({
        ...normalized,
        ...(oldText === undefined ? {} : { oldText }),
        newText: raw["newText"],
      }));
      if (!files.has(normalized.path)) files.set(normalized.path, Object.freeze(normalized));
    }
  }
  return Object.freeze({
    files: Object.freeze([...files.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath))),
    diffs: Object.freeze([...diffs.values()]),
    terminalObserved,
  });
}

export function workspaceResource(
  workspacePath: string,
  candidatePath: string,
): { readonly path: string; readonly displayPath: string } | undefined {
  if (candidatePath.includes("\0") || candidatePath.trim().length === 0) return undefined;
  const absolute = resolve(workspacePath, candidatePath);
  const displayPath = relative(workspacePath, absolute);
  if (displayPath === "" || displayPath === ".." || displayPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(displayPath)) {
    return undefined;
  }
  return Object.freeze({ path: absolute, displayPath });
}

export function exportConversation(
  format: "markdown" | "json",
  input: {
    readonly title: string;
    readonly workspaceName: string;
    readonly createdAtMs: number;
    readonly entries: readonly ConversationEntryRecord[];
  },
): string {
  const entries = latestToolEntries(input.entries)
    .filter((entry) => EXPORTABLE_KINDS.has(entry.kind) && entry.metadata["hidden"] !== true);
  if (format === "json") {
    return `${JSON.stringify({
      format: "guild-conversation-v1",
      title: input.title,
      workspace: input.workspaceName,
      createdAt: new Date(input.createdAtMs).toISOString(),
      exportedAt: new Date().toISOString(),
      entries: entries.map((entry) => ({
        sequence: entry.sequence,
        kind: entry.kind,
        text: entry.text,
        status: entry.status,
        createdAt: new Date(entry.createdAtMs).toISOString(),
        ...(entry.kind === "tool" ? { metadata: entry.metadata } : {}),
      })),
    }, null, 2)}\n`;
  }
  const rows = [
    `# ${singleLine(input.title)}`,
    "",
    `- Workspace: ${singleLine(input.workspaceName)}`,
    `- Created: ${new Date(input.createdAtMs).toISOString()}`,
    `- Exported: ${new Date().toISOString()}`,
    "",
  ];
  for (const entry of entries) {
    rows.push(`## ${roleLabel(entry.kind)}`, "", entry.text, "");
  }
  return `${rows.join("\n").trimEnd()}\n`;
}

// D-046: visible message matches carry stable persisted sequence anchors.
export function conversationMatches(
  entries: readonly ConversationEntryRecord[], query: string, locale: GuildLocale,
): readonly { readonly sequence: number; readonly snippet: string }[] {
  const needle = query.trim().toLocaleLowerCase(locale);
  if (needle.length === 0) return [];
  const matches = [];
  for (const entry of entries) {
    if (entry.metadata["hidden"] === true || !["user", "assistant"].includes(entry.kind)) continue;
    const index = entry.text.toLocaleLowerCase(locale).indexOf(needle);
    if (index < 0) continue;
    const start = Math.max(0, index - 48);
    const end = Math.min(entry.text.length, index + needle.length + 72);
    matches.push({ sequence: entry.sequence,
      snippet: `${start > 0 ? "…" : ""}${entry.text.slice(start, end).replace(/\s+/gu, " ").trim()}${end < entry.text.length ? "…" : ""}` });
    if (matches.length >= 50) break;
  }
  return matches;
}

export function conversationSnippet(
  entries: readonly ConversationEntryRecord[], query: string, locale: GuildLocale,
): string | undefined {
  return conversationMatches(entries, query, locale)[0]?.snippet;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function roleLabel(kind: ConversationEntryRecord["kind"]): string {
  switch (kind) {
    case "user": return "User";
    case "assistant": return "Grok";
    case "thought": return "Thinking";
    case "tool": return "Tool";
    case "error": return "Error";
    default: return "Notice";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
