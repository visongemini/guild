/**
 * Guild 3.0 engines (PC-ENG-001, PC-MODEL-001, D-057).
 *
 * A task runs on exactly one engine for its whole life: the official `grok agent stdio`
 * ("grok") or the user-installed Claude ACP adapter ("claude"). This leaf module holds only the
 * engine and picker-group vocabulary and the per-engine identifier grammar for Claude; the Grok
 * grammar and the catalog live in `grok-models.ts`, which builds on this module.
 */

export const GUILD_ENGINES = Object.freeze(["grok", "claude"] as const);
export type GuildEngine = (typeof GUILD_ENGINES)[number];

/** Engine of every task that existed before Guild 3.0 and of a new task that names none. */
export const GUILD_DEFAULT_ENGINE: GuildEngine = "grok";

export function parseGuildEngine(value: unknown): GuildEngine {
  if (typeof value !== "string" || !(GUILD_ENGINES as readonly string[]).includes(value)) {
    throw new TypeError("invalid_engine");
  }
  return value as GuildEngine;
}

/**
 * Picker groups. `grok` belongs to the Grok engine; `claude` (subscription), `online` (vendor
 * endpoints) and `local` (llama.cpp / Ollama) are all selectable inside a Claude-engine task.
 */
export const GUILD_MODEL_GROUPS = Object.freeze(["grok", "claude", "online", "local"] as const);
export type ModelGroup = (typeof GUILD_MODEL_GROUPS)[number];

export function parseModelGroup(value: unknown): ModelGroup {
  if (typeof value !== "string" || !(GUILD_MODEL_GROUPS as readonly string[]).includes(value)) {
    throw new TypeError("invalid_model_group");
  }
  return value as ModelGroup;
}

const MODEL_GROUPS_OF_ENGINE: Readonly<Record<GuildEngine, readonly ModelGroup[]>> = Object.freeze({
  grok: Object.freeze(["grok"] as const),
  claude: Object.freeze(["claude", "online", "local"] as const),
});

/** The groups a catalog of `engine` may carry; the first one is the default for an unlabelled model. */
export function modelGroupsOfEngine(engine: GuildEngine): readonly ModelGroup[] {
  return MODEL_GROUPS_OF_ENGINE[engine];
}

export const GUILD_CLAUDE_IDENTIFIER_LIMITS = Object.freeze({
  modelIdLength: 128,
  /** Native Claude models plus up to 64 models per configured Online / Local source. */
  maxModels: 256,
});

/**
 * A Claude-engine model id is data, never an enum: `default`, `opus`, `sonnet`, `haiku`, `fable`,
 * `claude-opus-5-5`, `claude-fable-5-1[1m]`, `deepseek-v4-flash`, `local-27b-model`. It starts with
 * a letter or digit and continues with letters, digits and `. _ : [ ] -`: no slash, no space, safe in
 * argv, SQL text, JSON-RPC and URLs.
 */
const CLAUDE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/u;

export function isClaudeModelId(id: string): boolean {
  return CLAUDE_MODEL_ID_PATTERN.test(id);
}

export function parseGuildClaudeModel(value: unknown): string {
  if (typeof value !== "string" || !isClaudeModelId(value)) {
    throw new TypeError("invalid_claude_model");
  }
  return value;
}

/** Same shape as a Grok effort id (`default`, `low`, `medium`, `high`, `xhigh`, `max`). */
const CLAUDE_EFFORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export function parseGuildClaudeReasoningEffort(value: unknown): string {
  if (typeof value !== "string" || !CLAUDE_EFFORT_ID_PATTERN.test(value)) {
    throw new TypeError("invalid_claude_reasoning_effort");
  }
  return value;
}

/** Permission modes the Claude adapter offers through its `mode` config option. */
export const GUILD_CLAUDE_PERMISSION_MODES = Object.freeze([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
] as const);
export type GuildClaudePermissionMode = (typeof GUILD_CLAUDE_PERMISSION_MODES)[number];

export function parseGuildClaudePermissionMode(value: unknown): GuildClaudePermissionMode {
  if (
    typeof value !== "string" ||
    !(GUILD_CLAUDE_PERMISSION_MODES as readonly string[]).includes(value)
  ) {
    throw new TypeError("invalid_claude_permission_mode");
  }
  return value as GuildClaudePermissionMode;
}
