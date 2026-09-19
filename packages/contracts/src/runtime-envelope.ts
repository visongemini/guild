/**
 * Normalized runtime envelopes and permission identity (PC-EVENT-001, PC-PERM-001, PC-TRN-002).
 */

import {
  err,
  ok,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parseRunId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  type AdapterEpoch,
  type IdempotencyKey,
  type Result,
  type RunId,
  type SessionId,
  type TaskId,
  type ToolCallId,
  type WindowId,
} from "./ids.js";
import { type RunState } from "./run-events.js";

export const INGEST_MODES = Object.freeze(["live", "replay"] as const);
export type IngestMode = (typeof INGEST_MODES)[number];

export const ADAPTER_EPOCH_STATUSES = Object.freeze([
  "absent",
  "spawning",
  "alive",
  "stopping",
  "exited",
] as const);
export type AdapterEpochStatus = (typeof ADAPTER_EPOCH_STATUSES)[number];

export const RUNTIME_EVENT_KINDS = Object.freeze([
  "session_update",
  "tool_call",
  "permission_request",
  "permission_resolution",
  "terminal_success",
  "terminal_error",
  "terminal_cancelled",
] as const);
export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number];

export const PERMISSION_IDENTITY_FIELDS = Object.freeze([
  "taskId",
  "runId",
  "sessionId",
  "toolCallId",
  "adapterEpoch",
  "windowId",
] as const);

export type PermissionIdentity = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly toolCallId: ToolCallId;
  readonly adapterEpoch: AdapterEpoch;
  readonly windowId: WindowId;
};

export type RuntimeEnvelope = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly adapterEpoch: AdapterEpoch;
  readonly ingestMode: IngestMode;
  readonly receiveSequence: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly kind: RuntimeEventKind;
  readonly semanticPayloadDigest: string;
  readonly protocolMessageId: string | undefined;
  readonly toolCallId: ToolCallId | undefined;
  readonly windowId: WindowId | undefined;
};

export function parseIngestMode(value: unknown): Result<IngestMode> {
  if (value === "live" || value === "replay") {
    return ok(value);
  }
  return err("wrong_ingest_mode");
}

export function parseRuntimeEventKind(
  value: unknown,
): Result<RuntimeEventKind> {
  if (
    typeof value === "string" &&
    (RUNTIME_EVENT_KINDS as readonly string[]).includes(value)
  ) {
    return ok(value as RuntimeEventKind);
  }
  return err("illegal_event_kind");
}

/** First Guild-assigned receive sequence when none have been committed. */
export const FIRST_RECEIVE_SEQUENCE = 1;

export function parseReceiveSequence(value: unknown): Result<number> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < FIRST_RECEIVE_SEQUENCE
  ) {
    return err("receive_sequence_invalid");
  }
  return ok(value);
}

export function parseSemanticPayloadDigest(value: unknown): Result<string> {
  if (typeof value !== "string" || value.length === 0) {
    return err("invalid_semantic_payload_digest");
  }
  return ok(value);
}

export function parsePermissionIdentity(
  input: unknown,
): Result<PermissionIdentity> {
  if (input === null || typeof input !== "object") {
    return err("incomplete_identity");
  }
  const rec = input as Record<string, unknown>;
  const taskId = parseTaskId(rec["taskId"]);
  const runId = parseRunId(rec["runId"]);
  const sessionId = parseSessionId(rec["sessionId"]);
  const toolCallId = parseToolCallId(rec["toolCallId"]);
  const adapterEpoch = parseAdapterEpoch(rec["adapterEpoch"]);
  const windowId = parseWindowId(rec["windowId"]);
  if (
    !taskId.ok ||
    !runId.ok ||
    !sessionId.ok ||
    !toolCallId.ok ||
    !adapterEpoch.ok ||
    !windowId.ok
  ) {
    return err("incomplete_identity");
  }
  return ok({
    taskId: taskId.value,
    runId: runId.value,
    sessionId: sessionId.value,
    toolCallId: toolCallId.value,
    adapterEpoch: adapterEpoch.value,
    windowId: windowId.value,
  });
}

export function permissionIdentitiesEqual(
  left: PermissionIdentity,
  right: PermissionIdentity,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.toolCallId === right.toolCallId &&
    left.adapterEpoch === right.adapterEpoch &&
    left.windowId === right.windowId
  );
}

export function parseRuntimeEnvelope(input: unknown): Result<RuntimeEnvelope> {
  if (input === null || typeof input !== "object") {
    return err("invalid_envelope");
  }
  const rec = input as Record<string, unknown>;
  const taskId = parseTaskId(rec["taskId"]);
  const runId = parseRunId(rec["runId"]);
  const sessionId = parseSessionId(rec["sessionId"]);
  const adapterEpoch = parseAdapterEpoch(rec["adapterEpoch"]);
  const ingestMode = parseIngestMode(rec["ingestMode"]);
  const receiveSequence = parseReceiveSequence(rec["receiveSequence"]);
  const idempotencyKey = parseIdempotencyKey(rec["idempotencyKey"]);
  const kind = parseRuntimeEventKind(rec["kind"]);
  const semanticPayloadDigest = parseSemanticPayloadDigest(
    rec["semanticPayloadDigest"],
  );
  if (
    !taskId.ok ||
    !runId.ok ||
    !sessionId.ok ||
    !adapterEpoch.ok ||
    !ingestMode.ok ||
    !receiveSequence.ok ||
    !idempotencyKey.ok ||
    !kind.ok ||
    !semanticPayloadDigest.ok
  ) {
    return err(
      !semanticPayloadDigest.ok &&
        taskId.ok &&
        runId.ok &&
        sessionId.ok &&
        adapterEpoch.ok &&
        ingestMode.ok &&
        receiveSequence.ok &&
        idempotencyKey.ok &&
        kind.ok
        ? "invalid_semantic_payload_digest"
        : "invalid_envelope",
    );
  }
  let protocolMessageId: string | undefined;
  if (rec["protocolMessageId"] !== undefined) {
    if (
      typeof rec["protocolMessageId"] !== "string" ||
      rec["protocolMessageId"].length === 0
    ) {
      return err("invalid_protocol_message_id");
    }
    protocolMessageId = rec["protocolMessageId"];
  }
  let toolCallId: ToolCallId | undefined;
  if (rec["toolCallId"] !== undefined) {
    const parsed = parseToolCallId(rec["toolCallId"]);
    if (!parsed.ok) {
      return err("invalid_tool_call_id");
    }
    toolCallId = parsed.value;
  }
  let windowId: WindowId | undefined;
  if (rec["windowId"] !== undefined) {
    const parsed = parseWindowId(rec["windowId"]);
    if (!parsed.ok) {
      return err("invalid_window_id");
    }
    windowId = parsed.value;
  }
  return ok({
    taskId: taskId.value,
    runId: runId.value,
    sessionId: sessionId.value,
    adapterEpoch: adapterEpoch.value,
    ingestMode: ingestMode.value,
    receiveSequence: receiveSequence.value,
    idempotencyKey: idempotencyKey.value,
    kind: kind.value,
    semanticPayloadDigest: semanticPayloadDigest.value,
    protocolMessageId,
    toolCallId,
    windowId,
  });
}

export const LIVE_EVENT_KINDS_BY_RUN_STATE: {
  readonly [State in RunState]: readonly RuntimeEventKind[];
} = Object.freeze({
  queued: Object.freeze([]),
  starting: Object.freeze(["permission_request"] as const),
  running: Object.freeze([
    "session_update",
    "tool_call",
    "permission_request",
    "terminal_success",
    "terminal_error",
  ] as const),
  awaiting_permission: Object.freeze([
    "session_update",
    "tool_call",
    "permission_request",
    "permission_resolution",
    "terminal_success",
    "terminal_error",
  ] as const),
  completing: Object.freeze([]),
  cancel_requested: Object.freeze([
    "session_update",
    "tool_call",
    "permission_request",
    "terminal_success",
    "terminal_error",
    "terminal_cancelled",
  ] as const),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
  interrupted: Object.freeze([]),
});

export function liveEventKindAllowed(
  state: RunState,
  kind: RuntimeEventKind,
): boolean {
  return LIVE_EVENT_KINDS_BY_RUN_STATE[state].includes(kind);
}

export function kindRequiresToolCallId(kind: RuntimeEventKind): boolean {
  return (
    kind === "tool_call" ||
    kind === "permission_request" ||
    kind === "permission_resolution"
  );
}

export function kindRequiresWindowId(kind: RuntimeEventKind): boolean {
  return kind === "permission_request" || kind === "permission_resolution";
}

export function epochStatusIsExited(status: AdapterEpochStatus): boolean {
  return status === "exited" || status === "absent";
}
