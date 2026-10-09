/**
 * Reusable layer for the official runtime's `_x.ai/*` extension methods and notifications (F1b).
 *
 * Extensions are not advertised in ACP capabilities, and a bare `x.ai/...` method returns
 * -32601; on the wire every extension starts with an underscore. This module provides
 *
 *  1. `parseXaiNotification`: an allowlist parser. Only the notifications named in
 *     `XAI_NOTIFICATION_PARSERS` become a typed, bounded `XaiSignal`; every other `_x.ai/*`
 *     notification (including `_x.ai/mcp/servers_updated`, which carries MCP settings and
 *     secrets in plain text) is dropped at the first line and never stored, logged or copied.
 *     A signal keeps enum-like identifiers and counts only: never prompt text, hook names,
 *     tool arguments, usage payloads or signatures.
 *  2. `XAI_EXTENSION_METHOD_PATTERN` / `isMethodNotFound`: what `AcpV1Adapter.sendExtensionRequest`
 *     uses to validate an outbound extension method and to treat -32601 as "unsupported".
 *
 * To support another notification (for example `_x.ai/session/interjection` for Steer or
 * `_x.ai/rewind/*` replies), add its signal type to contracts/xai-signals.ts, one entry to
 * `XAI_NOTIFICATION_PARSERS` that picks the bounded fields it needs, and a test. Never forward
 * `params` wholesale.
 */

import {
  XAI_SESSION_NOTIFICATION_SUBTYPES,
  type XaiSessionActivity,
  type XaiSignal,
  type XaiSignalEnvelope,
} from "@guild/contracts";
import { decodeModelState } from "./acp-v1-codec.js";
import { JsonRpcRemoteError } from "./json-rpc-peer.js";

/** `_x.ai/` followed by up to four lowercase path segments. Bare `x.ai/...` is never valid. */
export const XAI_EXTENSION_METHOD_PATTERN =
  /^_x\.ai\/[a-z][a-z0-9_-]{0,47}(?:\/[a-z][a-z0-9_-]{0,47}){0,3}$/u;

export const XAI_METHOD_NOT_FOUND = -32601;

export type XaiExtensionOutcome<Result> =
  | Readonly<{ status: "ok"; result: Result }>
  /** The runtime answered -32601: this extension is not available in the installed binary. */
  | Readonly<{ status: "unsupported" }>;

export function isMethodNotFound(cause: unknown): boolean {
  return cause instanceof JsonRpcRemoteError && cause.response.code === XAI_METHOD_NOT_FOUND;
}

const MAX_IDENTIFIER_LENGTH = 64;
const MAX_COUNT = 1_000_000;
const MAX_ELAPSED_MS = 86_400_000;
const MAX_SESSIONS = 32;
const MAX_RUNS = 64;

type Params = Readonly<Record<string, unknown>>;
type NotificationParser = (params: Params, sessionId: string | null) => XaiSignal | undefined;

function isRecord(value: unknown): value is Params {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Replaces anything outside a safe identifier alphabet and bounds the length; empty -> undefined. */
function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, MAX_IDENTIFIER_LENGTH);
  return /^[A-Za-z0-9]/u.test(cleaned) ? cleaned : undefined;
}

function count(value: unknown, maximum = MAX_COUNT): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.trunc(value), maximum);
}

function sessionIdOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function activityOf(value: unknown): XaiSessionActivity {
  return value === "working" || value === "idle" ? value : "other";
}

const SESSION_NOTIFICATION_PARSERS: Readonly<Record<
  (typeof XAI_SESSION_NOTIFICATION_SUBTYPES)[number],
  (update: Params) => XaiSignal | undefined
>> = Object.freeze({
  hook_run_started: (update) => {
    const event = identifier(update["event_name"]);
    const hooks = count(update["count"]);
    if (event === undefined || hooks === undefined) return undefined;
    const toolName = identifier(update["tool_name"]);
    return Object.freeze({
      kind: "hook_run_started" as const,
      event,
      count: hooks,
      ...(toolName === undefined ? {} : { toolName }),
    });
  },
  hook_execution: (update) => {
    const event = identifier(update["event_name"]);
    if (event === undefined) return undefined;
    const runs = Array.isArray(update["runs"]) ? update["runs"].slice(0, MAX_RUNS) : [];
    let failed = 0;
    let maxElapsedMs = 0;
    for (const run of runs) {
      const status = isRecord(run) && isRecord(run["status"]) ? run["status"] : undefined;
      if (status === undefined) continue;
      if (status["status"] !== "success") failed += 1;
      maxElapsedMs = Math.max(maxElapsedMs, count(status["elapsed_ms"], MAX_ELAPSED_MS) ?? 0);
    }
    return Object.freeze({ kind: "hook_execution" as const, event, runs: runs.length, failed, maxElapsedMs });
  },
  tool_call_delta_chunk: (update) => {
    const toolName = identifier(update["name"]);
    return toolName === undefined ? undefined : Object.freeze({ kind: "tool_call_delta_chunk" as const, toolName });
  },
  pending_interaction: (update) => {
    const interaction = identifier(update["kind"]);
    return interaction === undefined ? undefined : Object.freeze({ kind: "pending_interaction" as const, interaction });
  },
  interaction_resolved: () => Object.freeze({ kind: "interaction_resolved" as const }),
  retry_state: (update) => {
    const attempt = count(update["attempt"]);
    const maxRetries = count(update["max_retries"]);
    if (attempt === undefined || maxRetries === undefined) return undefined;
    const errorType = identifier(update["error_type"]);
    return Object.freeze({
      kind: "retry_state" as const,
      active: update["type"] === undefined || update["type"] === "retrying",
      attempt,
      maxRetries,
      ...(errorType === undefined ? {} : { errorType }),
    });
  },
  response_completed: () => Object.freeze({ kind: "response_completed" as const }),
  turn_completed: (update) => {
    const stopReason = identifier(update["stop_reason"]);
    return Object.freeze({ kind: "turn_completed" as const, ...(stopReason === undefined ? {} : { stopReason }) });
  },
  model_changed: (update) => {
    const modelId = identifier(update["model_id"]);
    if (modelId === undefined) return undefined;
    const reasoningEffort = identifier(update["reasoning_effort"]);
    return Object.freeze({
      kind: "model_changed" as const,
      modelId,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
  },
});

/** Extension notification method -> bounded parser. The only way a `_x.ai` payload reaches Guild. */
export const XAI_NOTIFICATION_PARSERS: Readonly<Record<string, NotificationParser>> = Object.freeze({
  "_x.ai/queue/changed": (params) => {
    const entries = Array.isArray(params["entries"]) ? params["entries"] : [];
    let firstPosition: number | undefined;
    for (const entry of entries.slice(0, MAX_SESSIONS)) {
      const position = isRecord(entry) ? count(entry["position"]) : undefined;
      if (position !== undefined && (firstPosition === undefined || position < firstPosition)) {
        firstPosition = position;
      }
    }
    return Object.freeze({
      kind: "queue_changed" as const,
      queued: Math.min(entries.length, MAX_COUNT),
      ...(firstPosition === undefined || entries.length === 0 ? {} : { firstPosition }),
      running: typeof params["runningPromptId"] === "string",
    });
  },
  "_x.ai/sessions/changed": (params) => {
    const upserted = Array.isArray(params["upserted"]) ? params["upserted"].slice(0, MAX_SESSIONS) : [];
    const sessions = upserted.flatMap((entry) => {
      const sessionId = isRecord(entry) ? sessionIdOf(entry["sessionId"]) : null;
      return sessionId === null || !isRecord(entry)
        ? []
        : [Object.freeze({ sessionId, activity: activityOf(entry["activity"]) })];
    });
    return Object.freeze({ kind: "sessions_changed" as const, sessions: Object.freeze(sessions) });
  },
  "_x.ai/session_notification": (params) => {
    const update = isRecord(params["update"]) ? params["update"] : undefined;
    const subtype = update?.["sessionUpdate"];
    if (update === undefined || typeof subtype !== "string") return undefined;
    if (!Object.hasOwn(SESSION_NOTIFICATION_PARSERS, subtype)) return undefined;
    return SESSION_NOTIFICATION_PARSERS[subtype as keyof typeof SESSION_NOTIFICATION_PARSERS](update);
  },
  "_x.ai/session/prompt_complete": (params) => {
    const stopReason = identifier(params["stopReason"]);
    return Object.freeze({ kind: "prompt_complete" as const, ...(stopReason === undefined ? {} : { stopReason }) });
  },
  "_x.ai/session/setup": (params) => {
    const phase = identifier(params["phase"]);
    return phase === undefined ? undefined : Object.freeze({ kind: "session_setup" as const, phase });
  },
  "_x.ai/mcp/init_progress": (params) => {
    const connected = count(params["connected"]);
    const total = count(params["total"]);
    return connected === undefined || total === undefined
      ? undefined
      : Object.freeze({ kind: "mcp_init_progress" as const, connected, total });
  },
  "_x.ai/models/update": (params) => {
    const catalog = decodeModelState(params, "$params");
    return catalog === undefined ? undefined : Object.freeze({ kind: "models_update" as const, catalog });
  },
});

/** Top-level notifications whose session id is not in `params.sessionId`. */
const SESSION_LESS_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "_x.ai/sessions/changed",
  "_x.ai/models/update",
]);

/**
 * Turns one `_x.ai/*` notification into a typed signal, or returns `undefined` for everything
 * that is not on the allowlist or does not decode. Never throws and never retains `params`.
 */
export function parseXaiNotification(
  method: string,
  params: unknown,
  receivedMonotonicMs: number,
): XaiSignalEnvelope | undefined {
  if (!Object.hasOwn(XAI_NOTIFICATION_PARSERS, method)) return undefined;
  if (!isRecord(params)) return undefined;
  try {
    const sessionId = SESSION_LESS_NOTIFICATIONS.has(method) ? null : sessionIdOf(params["sessionId"]);
    const signal = XAI_NOTIFICATION_PARSERS[method]!(params, sessionId);
    if (signal === undefined) return undefined;
    return Object.freeze({ sessionId, signal, receivedMonotonicMs });
  } catch {
    return undefined;
  }
}
