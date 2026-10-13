/**
 * PC-ENG-004: what the Gemini CLI (`@google/gemini-cli` 0.63.x in its `--acp` mode) does differently from plain ACP v1
 * and from the Claude and Codex adapters (docs/21 sections 7 and 8.4). It has no config options (models and modes are
 * session state changed with `session/set_model` and `session/set_mode`), it narrates a mode change as chat text,
 * it replays internal context as user messages when a session is loaded, its model `auto` can route to the Pro model,
 * and it reports token usage only in the prompt result. Everything here works on untrusted `unknown` input and never
 * throws.
 */

/** JSON-RPC "internal error": the CLI reports most failures with it and names the cause in `data.details`. */
export const GEMINI_INTERNAL_ERROR_CODE = -32603;

/** The CLI's own model choice. It can pick the Pro model by itself, so Guild never offers it and never leaves a task on it. */
export const GEMINI_AUTO_MODEL_ID = "auto";

/** Id of the select option Guild presents for the session's models, and of the one for its modes. */
export const GEMINI_MODEL_OPTION_ID = "model";
export const GEMINI_MODE_OPTION_ID = "mode";

const CUSTOMTOOLS_SUFFIX = "-customtools";
const MODE_UPDATE_PREFIX = "[MODE_UPDATE]";
const REPLAYED_CONTEXT_PREFIX = "<session_context>";
const REPLAYED_FUNCTION_RESPONSE_PREFIX = "[Function Response:";
const MAX_DETAIL_LENGTH = 512;

/**
 * Chat frames the CLI invents: `[MODE_UPDATE] yolo` as an agent message after a mode change (instead of a
 * `current_mode_update`), and, when a session is loaded, the synthetic `<session_context>` user message it starts every
 * history with and a `[Function Response: <tool>]` user message after every replayed tool call. None of them was typed by
 * the user or answered by the model, so none belongs in the conversation.
 */
export function isGeminiInternalChunk(
  discriminator: "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk",
  text: string,
): boolean {
  if (discriminator === "agent_message_chunk") return text.startsWith(MODE_UPDATE_PREFIX);
  if (discriminator === "user_message_chunk") {
    return text.startsWith(REPLAYED_CONTEXT_PREFIX) || text.startsWith(REPLAYED_FUNCTION_RESPONSE_PREFIX);
  }
  return false;
}

const SESSION_GONE = /^(?:no previous sessions found for this project|invalid session identifier)/iu;

/**
 * `session/load` of a session the CLI does not have answers `-32603` "Internal error" with `data.details` "No previous
 * sessions found for this project." (the project has none) or "Invalid session identifier ..." (it has others). Only
 * those causes mean "this session is gone"; any other internal error keeps the session for the next try.
 */
export function isGeminiSessionNotFound(response: Readonly<{ code: number; data?: unknown }>): boolean {
  if (response.code !== GEMINI_INTERNAL_ERROR_CODE) return false;
  const data = response.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const details = (data as { readonly details?: unknown }).details;
  return typeof details === "string" && SESSION_GONE.test(details.trim().slice(0, MAX_DETAIL_LENGTH));
}

/**
 * The CLI lists the Pro model as `gemini-3.1-pro-preview` in one session and as `gemini-3.1-pro-preview-customtools`
 * (still named `gemini-3.1-pro-preview`) in the next, depending on what it enabled for that session. A task that stored
 * one spelling would otherwise lose its model after a restart, so the entry whose name is the id without the suffix
 * is known by the shorter id; the CLI accepts it either way.
 */
export function canonicalGeminiModelId(modelId: string, name: string | undefined): string {
  if (!modelId.endsWith(CUSTOMTOOLS_SUFFIX)) return modelId;
  const base = modelId.slice(0, -CUSTOMTOOLS_SUFFIX.length);
  return base.length > 0 && name === base ? base : modelId;
}

/** The same alias for the session's current model, which carries no name: only when the list knows the shorter id. */
export function canonicalGeminiCurrentModelId(modelId: string, listedIds: ReadonlySet<string>): string {
  if (!modelId.endsWith(CUSTOMTOOLS_SUFFIX)) return modelId;
  const base = modelId.slice(0, -CUSTOMTOOLS_SUFFIX.length);
  return listedIds.has(base) ? base : modelId;
}

/**
 * The model a new Gemini task starts on, from the ids the session lists: the cheapest tier first (`flash-lite`, then
 * `flash`, then anything else), the CLI's own order within a tier. Guild shows no prices, so the tier is a reading of
 * the id and nothing more. `auto` is never chosen. Undefined when the list has no usable id.
 */
export function cheapestGeminiModelId(modelIds: readonly string[]): string | undefined {
  const tierOf = (id: string): number => /flash-lite/iu.test(id) ? 0 : /flash/iu.test(id) ? 1 : 2;
  let best: string | undefined;
  for (const id of modelIds) {
    if (id === GEMINI_AUTO_MODEL_ID) continue;
    if (best === undefined || tierOf(id) < tierOf(best)) best = id;
  }
  return best;
}

export type GeminiQuota = Readonly<{ inputTokens: number; outputTokens: number }>;

/**
 * The token counts of a prompt result: `_meta.quota.token_count.{input_tokens, output_tokens}`, summed over every
 * request the turn made (a tool turn is at least two). It under-reports (thinking tokens are not in it) and nothing is
 * reported for a cancelled or failed turn, so it is a hint, never a bill.
 */
export function decodeGeminiQuota(meta: unknown): GeminiQuota | undefined {
  const quota = plainRecord(plainRecord(meta)?.["quota"]);
  const counts = plainRecord(quota?.["token_count"]);
  const inputTokens = count(counts?.["input_tokens"]);
  const outputTokens = count(counts?.["output_tokens"]);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return Object.freeze({ inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 });
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
