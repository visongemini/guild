/**
 * Online / Local model sources (PC-MODEL-001, PC-ROUTE-002, D-058).
 *
 * A source is an Anthropic-compatible endpoint (a vendor such as DeepSeek, or llama.cpp / Ollama
 * on this machine) whose models appear in a Claude-engine task's picker. The renderer, the IPC
 * surface and the database hold NO secret: the API key lives in a user-designated env file that
 * only the main process reads, named here by `keyFile` (absolute path, or `null` for the default
 * file) and `keyVariable` (the variable inside it). `confirmedHost` is written by the main process
 * alone, after a native confirmation dialog; a request can never set it.
 */

import { isClaudeModelId } from "./engines.js";
import { boundedText, exactRecord } from "./request-record.js";

export const GUILD_MODEL_SOURCE_KINDS = Object.freeze(["online", "local"] as const);
export type ModelSourceKind = (typeof GUILD_MODEL_SOURCE_KINDS)[number];

export const GUILD_MODEL_SOURCE_LIMITS = Object.freeze({
  maxSources: 32,
  idLength: 64,
  labelLength: 80,
  baseUrlLength: 2_048,
  keyFileLength: 4_096,
  keyVariableLength: 64,
  maxModels: 64,
  modelIdLength: 128,
  modelLabelLength: 128,
  maxContextWindow: 100_000_000,
});

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const KEY_VARIABLE_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/u;

export type ModelSourceModel = Readonly<{
  /** Id the engine sends as the model (Claude-engine grammar). */
  id: string;
  label: string;
  contextWindow?: number;
  supportsImages?: boolean;
}>;

/** What the renderer sees of a source. Nothing in it is a secret. */
export type ModelSourceProjection = Readonly<{
  id: string;
  kind: ModelSourceKind;
  label: string;
  /** `https` for Online; `http` or `https` for Local. No credentials, query or fragment. */
  baseUrl: string;
  /** Absolute path of the env file holding the key; `null` means the default key file. */
  keyFile: string | null;
  /**
   * Name of the variable inside the key file (never its value). Always set for an Online source,
   * which sends the key to its vendor; `null` only for a Local source that needs no key.
   */
  keyVariable: string | null;
  models: readonly ModelSourceModel[];
  enabled: boolean;
  /**
   * Host (with port) the main process confirmed the key may be sent to, or `null` while the source
   * is unconfirmed. Cleared whenever the kind, base URL or key designation changes.
   */
  confirmedHost: string | null;
}>;

/** What a renderer may submit: a projection without `confirmedHost`. */
export type ModelSourceDraft = Omit<ModelSourceProjection, "confirmedHost">;

export function parseModelSourceId(value: unknown): string {
  if (typeof value !== "string" || !SOURCE_ID_PATTERN.test(value)) {
    throw new TypeError("invalid_model_source_id");
  }
  return value;
}

export function parseModelSourceKind(value: unknown): ModelSourceKind {
  if (typeof value !== "string" || !(GUILD_MODEL_SOURCE_KINDS as readonly string[]).includes(value)) {
    throw new TypeError("invalid_model_source_kind");
  }
  return value as ModelSourceKind;
}

export function parseModelSourceKeyVariable(value: unknown): string {
  if (typeof value !== "string" || !KEY_VARIABLE_PATTERN.test(value)) {
    throw new TypeError("invalid_model_source_key_variable");
  }
  return value;
}

/**
 * Heuristic: text that looks like an API key, bearer token or JWT. Source fields are names and
 * addresses, so anything that looks like a credential is refused rather than stored (no secret
 * ever lands in SQLite, IPC payloads or logs).
 */
export function looksLikeSecret(text: string): boolean {
  return (
    /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/u.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu.test(text) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./u.test(text)
  );
}

function plainText(value: unknown, maxLength: number, code: string): string {
  let text: string;
  try {
    text = boundedText(value, maxLength);
  } catch {
    throw new TypeError(code);
  }
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(text) || looksLikeSecret(text)) {
    throw new TypeError(code);
  }
  return text;
}

/**
 * Canonical form of a source's base URL: scheme, host and path without a trailing slash. Online
 * sources must use https; Local sources may use http or https. User info, query and fragment are
 * refused so a key can never ride along in the address.
 */
export function canonicalModelSourceBaseUrl(kind: ModelSourceKind, value: unknown): string {
  const text = plainText(value, GUILD_MODEL_SOURCE_LIMITS.baseUrlLength, "invalid_model_source_base_url");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError("invalid_model_source_base_url");
  }
  const schemeAllowed = parsed.protocol === "https:" || (kind === "local" && parsed.protocol === "http:");
  if (
    !schemeAllowed ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    isAnthropicHostname(parsed.hostname)
  ) {
    throw new TypeError("invalid_model_source_base_url");
  }
  const canonical = `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  // An `@` anywhere would read as user info to some parsers; the database refuses it as well.
  if (/[@?#]/u.test(canonical)) throw new TypeError("invalid_model_source_base_url");
  return canonical;
}

/** D-061: Claude is reached only by Claude Code itself, so no source may point at an Anthropic-operated host. */
function isAnthropicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return ["anthropic.com", "claude.ai", "claude.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Host (with a non-default port) of a canonical base URL: what a key is bound to. */
export function modelSourceHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export function parseModelSourceKeyFile(value: unknown): string {
  const text = plainText(value, GUILD_MODEL_SOURCE_LIMITS.keyFileLength, "invalid_model_source_key_file");
  const absolute = text.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(text);
  if (!absolute || text.split(/[\\/]/u).includes("..")) {
    throw new TypeError("invalid_model_source_key_file");
  }
  return text;
}

/** The model list of a source: 1 to 64 entries, Claude-grammar ids, unique, no credential-shaped text. */
export function parseModelSourceModels(value: unknown): readonly ModelSourceModel[] {
  const limits = GUILD_MODEL_SOURCE_LIMITS;
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxModels) {
    throw new TypeError("invalid_model_source_models");
  }
  const seen = new Set<string>();
  const models = (value as unknown[]).map((entry): ModelSourceModel => {
    const record = exactRecord(entry, ["id", "label"], ["contextWindow", "supportsImages"]);
    const id = plainText(record["id"], limits.modelIdLength, "invalid_model_source_model");
    if (!isClaudeModelId(id) || seen.has(id)) throw new TypeError("invalid_model_source_model");
    seen.add(id);
    const label = plainText(record["label"], limits.modelLabelLength, "invalid_model_source_model");
    const contextWindow = record["contextWindow"];
    if (
      contextWindow !== undefined &&
      (typeof contextWindow !== "number" ||
        !Number.isSafeInteger(contextWindow) ||
        contextWindow < 1 ||
        contextWindow > limits.maxContextWindow)
    ) {
      throw new TypeError("invalid_model_source_model");
    }
    const supportsImages = record["supportsImages"];
    if (supportsImages !== undefined && typeof supportsImages !== "boolean") {
      throw new TypeError("invalid_model_source_model");
    }
    return Object.freeze({
      id,
      label,
      ...(contextWindow === undefined ? {} : { contextWindow: contextWindow as number }),
      ...(supportsImages === undefined ? {} : { supportsImages: supportsImages as boolean }),
    });
  });
  return Object.freeze(models);
}

/**
 * Validates what a renderer submits for `upsertModelSource` (and what the store accepts). The
 * closed key set has no key value and no `confirmedHost`.
 */
export function parseModelSourceDraft(input: unknown): ModelSourceDraft {
  const record = exactRecord(input, [
    "id",
    "kind",
    "label",
    "baseUrl",
    "keyFile",
    "keyVariable",
    "models",
    "enabled",
  ]);
  const kind = parseModelSourceKind(record["kind"]);
  const keyFile = record["keyFile"] === null ? null : parseModelSourceKeyFile(record["keyFile"]);
  const keyVariable = record["keyVariable"] === null
    ? null
    : parseModelSourceKeyVariable(record["keyVariable"]);
  if (keyFile !== null && keyVariable === null) throw new TypeError("invalid_model_source_key_variable");
  // An Online source is a vendor's endpoint: a keyless one would send the conversation to a remote host unauthenticated
  // and unnoticed, so it must name the key it will send (`keyFile` stays optional: `null` is the default key file).
  if (kind === "online" && keyVariable === null) throw new TypeError("invalid_model_source_key_variable");
  if (typeof record["enabled"] !== "boolean") throw new TypeError("invalid_model_source_enabled");
  const label = plainText(record["label"], GUILD_MODEL_SOURCE_LIMITS.labelLength, "invalid_model_source_label").trim();
  if (label.length === 0) throw new TypeError("invalid_model_source_label");
  return Object.freeze({
    id: parseModelSourceId(record["id"]),
    kind,
    label,
    baseUrl: canonicalModelSourceBaseUrl(kind, record["baseUrl"]),
    keyFile,
    keyVariable,
    models: parseModelSourceModels(record["models"]),
    enabled: record["enabled"],
  });
}

export type ListModelSourcesRequest = Readonly<Record<string, never>>;
export type ListModelSourcesResponse = Readonly<{ sources: readonly ModelSourceProjection[] }>;
export type UpsertModelSourceRequest = ModelSourceDraft;
export type UpsertModelSourceResponse = Readonly<{
  source: ModelSourceProjection;
  /** True while the source's host is not confirmed; main then asks through a native dialog. */
  needsConfirmation: boolean;
}>;
export type DeleteModelSourceRequest = Readonly<{ id: string }>;
export type ConfirmModelSourceRequest = Readonly<{ id: string }>;
export type ConfirmModelSourceResponse = Readonly<{
  /** `cancelled` when the user dismissed the native dialog; the source stays unconfirmed. */
  status: "confirmed" | "cancelled";
  source: ModelSourceProjection;
}>;

export function parseModelSourceIdRequest(input: unknown): Readonly<{ id: string }> {
  const record = exactRecord(input, ["id"]);
  return Object.freeze({ id: parseModelSourceId(record["id"]) });
}
