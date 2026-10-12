import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";

/**
 * Compat layer for plain Anthropic-compatible backends (docs/20 section 3.4).
 * Claude Code sends API features such backends reject; this makes the request digestible.
 * Pure: the input body is never mutated.
 */
export interface CompatStats {
  readonly systemMessages: number;
  readonly toolAdditions: number;
  readonly deferredDropped: number;
  readonly mergedMessages: number;
  readonly emptyFilled: number;
}

export interface CompatResult {
  readonly body: JsonObject;
  readonly stats: CompatStats;
}

const EMPTY_TEXT = "(empty)";
const DROPPED_TOP_LEVEL_FIELDS = ["context_management", "output_config"] as const;
const KEPT_TOOL_FIELDS = ["name", "description", "input_schema"] as const;

type MutableStats = { -readonly [K in keyof CompatStats]: CompatStats[K] };

function textBlock(text: string): JsonObject {
  return { type: "text", text };
}

function isBlockOfType(block: JsonValue, type: string): boolean {
  return isJsonObject(block) && block.type === type;
}

function slimTool(tool: JsonObject): JsonObject {
  const slim: JsonObject = {};
  for (const field of KEPT_TOOL_FIELDS) {
    const value = tool[field];
    if (value !== undefined) slim[field] = value;
  }
  if (typeof tool.type === "string" && tool.type !== "custom") slim.type = tool.type;
  return slim;
}

function systemText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isJsonObject(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function reminderBlock(queued: readonly string[]): JsonObject | undefined {
  const texts = queued.filter((text) => text.length > 0);
  if (texts.length === 0) return undefined;
  return textBlock(`<system-reminder>\n${texts.join("\n\n")}\n</system-reminder>`);
}

function toBlocks(content: JsonValue | undefined): JsonValue[] {
  if (typeof content === "string") return content.length > 0 ? [textBlock(content)] : [];
  return Array.isArray(content) ? [...content] : [];
}

/** Stable partition: tool_result blocks first, everything else after, original order kept. */
function toolResultsFirst(blocks: readonly JsonValue[]): JsonValue[] {
  const results = blocks.filter((block) => isBlockOfType(block, "tool_result"));
  const rest = blocks.filter((block) => !isBlockOfType(block, "tool_result"));
  return [...results, ...rest];
}

function isEmptyContent(content: JsonValue | undefined): boolean {
  if (content === undefined || content === null) return true;
  if (typeof content === "string") return content.length === 0;
  return Array.isArray(content) && content.length === 0;
}

export function applyCompat(body: JsonObject): CompatResult {
  const stats: MutableStats = {
    systemMessages: 0,
    toolAdditions: 0,
    deferredDropped: 0,
    mergedMessages: 0,
    emptyFilled: 0,
  };

  const originalTools = Array.isArray(body.tools) ? body.tools.filter(isJsonObject) : [];
  const knownToolNames = new Set<string>();
  for (const tool of originalTools) {
    if (tool.defer_loading !== true && typeof tool.name === "string") knownToolNames.add(tool.name);
  }
  const addedTools: JsonObject[] = [];

  const collectAddition = (block: JsonObject): void => {
    const definition = isJsonObject(block.tool) ? block.tool.definition : undefined;
    if (!isJsonObject(definition) || typeof definition.name !== "string") return;
    if (knownToolNames.has(definition.name)) return;
    knownToolNames.add(definition.name);
    addedTools.push(slimTool(definition));
    stats.toolAdditions += 1;
  };

  const stripAdditions = (content: JsonValue[]): JsonValue[] => {
    const kept: JsonValue[] = [];
    for (const block of content) {
      if (isJsonObject(block) && block.type === "tool_addition") {
        collectAddition(block);
        continue;
      }
      kept.push(block);
    }
    return kept;
  };

  const rawMessages: JsonValue[] = Array.isArray(body.messages) ? body.messages : [];
  const queued: string[] = [];
  const staged: JsonValue[] = [];

  for (const message of rawMessages) {
    if (!isJsonObject(message)) {
      staged.push(message);
      continue;
    }
    if (message.role === "system") {
      stats.systemMessages += 1;
      if (Array.isArray(message.content)) stripAdditions(message.content);
      queued.push(systemText(message.content));
      continue;
    }
    let content: JsonValue | undefined = message.content;
    if (Array.isArray(content)) content = stripAdditions(content);
    if (message.role === "user" && queued.length > 0) {
      const reminder = reminderBlock(queued);
      queued.length = 0;
      if (reminder !== undefined) {
        // The reminder goes after the tool_result blocks: backends require tool_result
        // immediately after the tool_use turn.
        const blocks = toBlocks(content);
        const results = blocks.filter((block) => isBlockOfType(block, "tool_result"));
        const rest = blocks.filter((block) => !isBlockOfType(block, "tool_result"));
        content = [...results, reminder, ...rest];
      }
    }
    staged.push({ ...message, content: content ?? null });
  }
  const trailing = reminderBlock(queued);
  if (trailing !== undefined) staged.push({ role: "user", content: [trailing] });

  const merged: JsonValue[] = [];
  for (const message of staged) {
    const previous = merged[merged.length - 1];
    if (
      isJsonObject(message) &&
      isJsonObject(previous) &&
      typeof message.role === "string" &&
      previous.role === message.role
    ) {
      const combined = [...toBlocks(previous.content), ...toBlocks(message.content)];
      merged[merged.length - 1] = { ...previous, content: combined };
      stats.mergedMessages += 1;
      continue;
    }
    merged.push(message);
  }

  const messages = merged.map((message): JsonValue => {
    if (!isJsonObject(message)) return message;
    let content: JsonValue | undefined = message.content;
    if (message.role === "user" && Array.isArray(content)) content = toolResultsFirst(content);
    if (isEmptyContent(content)) {
      stats.emptyFilled += 1;
      content = [textBlock(EMPTY_TEXT)];
    }
    return { ...message, content: content ?? null };
  });

  const result: JsonObject = { ...body };
  if (Array.isArray(body.messages)) result.messages = messages;

  const keptTools: JsonObject[] = [];
  for (const tool of originalTools) {
    if (tool.defer_loading === true) {
      stats.deferredDropped += 1;
      continue;
    }
    keptTools.push(slimTool(tool));
  }
  const tools = [...keptTools, ...addedTools];
  if (tools.length > 0) result.tools = tools;
  else delete result.tools;

  for (const field of DROPPED_TOP_LEVEL_FIELDS) delete result[field];
  return { body: result, stats };
}
