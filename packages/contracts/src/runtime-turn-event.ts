/**
 * Validated turn payloads atomically paired with their derived admission envelopes.
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
  type Result,
} from "./ids.js";
import {
  parseIngestMode,
  parseReceiveSequence,
  parseRuntimeEnvelope,
  type RuntimeEnvelope,
  type RuntimeEventKind,
} from "./runtime-envelope.js";
import {
  freezeRuntimePayload,
  semanticRuntimePayloadDigest,
  type RuntimeTurnPayload,
} from "./runtime-payload.js";

const INPUT_KEYS = [
  "adapterEpoch",
  "idempotencyKey",
  "ingestMode",
  "payload",
  "persistedOwningWindowId",
  "receiveSequence",
  "runId",
  "taskId",
] as const;

const REQUIRED_INPUT_KEYS = [
  "adapterEpoch",
  "idempotencyKey",
  "ingestMode",
  "payload",
  "receiveSequence",
  "runId",
  "taskId",
] as const;

const EVENT_KEYS = ["envelope", "payload"] as const;

const ENVELOPE_KEYS = [
  "adapterEpoch",
  "idempotencyKey",
  "ingestMode",
  "kind",
  "protocolMessageId",
  "receiveSequence",
  "runId",
  "semanticPayloadDigest",
  "sessionId",
  "taskId",
  "toolCallId",
  "windowId",
] as const;

const REQUIRED_ENVELOPE_KEYS = [
  "adapterEpoch",
  "idempotencyKey",
  "ingestMode",
  "kind",
  "receiveSequence",
  "runId",
  "semanticPayloadDigest",
  "sessionId",
  "taskId",
] as const;

export type RuntimeTurnEventInput = {
  readonly taskId: unknown;
  readonly runId: unknown;
  readonly adapterEpoch: unknown;
  readonly ingestMode: unknown;
  readonly receiveSequence: unknown;
  readonly idempotencyKey: unknown;
  readonly payload: RuntimeTurnPayload;
  /** Authoritative persisted Run owner; valid only for permission requests. */
  readonly persistedOwningWindowId?: unknown;
};

export type RuntimeTurnEvent = {
  readonly payload: RuntimeTurnPayload;
  readonly envelope: RuntimeEnvelope;
};

/** Constructs a copied, deeply frozen turn event from authoritative inputs only. */
export function createRuntimeTurnEvent(
  input: RuntimeTurnEventInput,
): Result<RuntimeTurnEvent> {
  const inputRecord = exactRecord(input, INPUT_KEYS, REQUIRED_INPUT_KEYS);
  if (!inputRecord.ok) return err("invalid_runtime_turn_event_input");
  const rec = inputRecord.value;

  const taskId = parseTaskId(rec["taskId"]);
  const runId = parseRunId(rec["runId"]);
  const adapterEpoch = parseAdapterEpoch(rec["adapterEpoch"]);
  const ingestMode = parseIngestMode(rec["ingestMode"]);
  const receiveSequence = parseReceiveSequence(rec["receiveSequence"]);
  const idempotencyKey = parseIdempotencyKey(rec["idempotencyKey"]);
  if (
    !taskId.ok ||
    !runId.ok ||
    !adapterEpoch.ok ||
    !ingestMode.ok ||
    !receiveSequence.ok ||
    !idempotencyKey.ok
  ) {
    return err("invalid_runtime_turn_event_routing");
  }

  let payload: ReturnType<typeof freezeRuntimePayload>;
  try {
    payload = freezeRuntimePayload(rec["payload"]);
  } catch (_cause: unknown) {
    return err("invalid_runtime_turn_payload");
  }
  if (payload.type === "session_context") {
    return err("session_context_not_turn_event");
  }
  const sessionId = parseSessionId(payload.sessionId);
  if (!sessionId.ok) return err("invalid_runtime_turn_payload");

  const hasPersistedOwner = Object.hasOwn(rec, "persistedOwningWindowId");
  let windowId: RuntimeEnvelope["windowId"];
  if (payload.type === "permission_request") {
    if (!hasPersistedOwner) return err("permission_window_required");
    const parsed = parseWindowId(rec["persistedOwningWindowId"]);
    if (!parsed.ok) return err("invalid_permission_window");
    windowId = parsed.value;
  } else {
    if (hasPersistedOwner) return err("unexpected_permission_window");
    windowId = undefined;
  }

  let toolCallId: RuntimeEnvelope["toolCallId"];
  if (
    payload.type === "tool_call_create" ||
    payload.type === "tool_call_update" ||
    payload.type === "permission_request"
  ) {
    const parsed = parseToolCallId(payload.toolCallId);
    if (!parsed.ok) return err("invalid_runtime_turn_payload");
    toolCallId = parsed.value;
  } else {
    toolCallId = undefined;
  }

  const protocolMessageId =
    (payload.type === "agent_text_chunk" ||
      payload.type === "user_text_chunk" ||
      payload.type === "agent_thought_chunk") &&
    typeof payload.messageId === "string"
      ? payload.messageId
      : undefined;

  let semanticPayloadDigest: string;
  try {
    semanticPayloadDigest = semanticRuntimePayloadDigest(payload);
  } catch (_cause: unknown) {
    return err("invalid_runtime_turn_payload");
  }

  const envelope = Object.freeze({
    taskId: taskId.value,
    runId: runId.value,
    sessionId: sessionId.value,
    adapterEpoch: adapterEpoch.value,
    ingestMode: ingestMode.value,
    receiveSequence: receiveSequence.value,
    idempotencyKey: idempotencyKey.value,
    kind: derivedKind(payload),
    semanticPayloadDigest,
    protocolMessageId,
    toolCallId,
    windowId,
  });
  return ok(Object.freeze({ payload, envelope }));
}

/** Revalidates a paired event before a production admission boundary consumes it. */
export function parseRuntimeTurnEvent(input: unknown): Result<RuntimeTurnEvent> {
  const eventRecord = exactRecord(input, EVENT_KEYS, EVENT_KEYS);
  if (!eventRecord.ok) return err("invalid_runtime_turn_event");
  const envelopeRecord = exactRecord(
    eventRecord.value["envelope"],
    ENVELOPE_KEYS,
    REQUIRED_ENVELOPE_KEYS,
  );
  if (!envelopeRecord.ok) return err("invalid_runtime_turn_event");
  const parsedEnvelope = parseRuntimeEnvelope(envelopeRecord.value);
  if (!parsedEnvelope.ok) return err("invalid_runtime_turn_event");

  let payload: ReturnType<typeof freezeRuntimePayload>;
  try {
    payload = freezeRuntimePayload(eventRecord.value["payload"]);
  } catch (_cause: unknown) {
    return err("invalid_runtime_turn_event");
  }
  if (payload.type === "session_context") return err("invalid_runtime_turn_event");

  const reconstructed = createRuntimeTurnEvent({
    taskId: parsedEnvelope.value.taskId,
    runId: parsedEnvelope.value.runId,
    adapterEpoch: parsedEnvelope.value.adapterEpoch,
    ingestMode: parsedEnvelope.value.ingestMode,
    receiveSequence: parsedEnvelope.value.receiveSequence,
    idempotencyKey: parsedEnvelope.value.idempotencyKey,
    payload,
    ...(payload.type === "permission_request"
      ? { persistedOwningWindowId: parsedEnvelope.value.windowId }
      : {}),
  });
  if (!reconstructed.ok) return err("invalid_runtime_turn_event");
  if (!envelopesEqual(reconstructed.value.envelope, parsedEnvelope.value)) {
    return err("invalid_runtime_turn_event");
  }
  return reconstructed;
}

function derivedKind(payload: RuntimeTurnPayload): RuntimeEventKind {
  switch (payload.type) {
    case "agent_text_chunk":
    case "user_text_chunk":
    case "agent_thought_chunk":
    case "plan":
      return "session_update";
    case "tool_call_create":
    case "tool_call_update":
      return "tool_call";
    case "permission_request":
      return "permission_request";
    case "prompt_terminal":
      return payload.classification === "cancelled"
        ? "terminal_cancelled"
        : "terminal_success";
  }
}

function envelopesEqual(left: RuntimeEnvelope, right: RuntimeEnvelope): boolean {
  return ENVELOPE_KEYS.every((key) => left[key] === right[key]);
}

function exactRecord<
  const Allowed extends readonly string[],
  const Required extends readonly Allowed[number][],
>(
  input: unknown,
  allowed: Allowed,
  required: Required,
): Result<Record<Allowed[number], unknown>> {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return err("invalid_record");
    }
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      return err("invalid_record");
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.some(
        (key) => typeof key !== "string" || !(allowed as readonly string[]).includes(key),
      ) ||
      required.some((key) => !Object.hasOwn(input, key))
    ) {
      return err("invalid_record");
    }
    const copied: Record<string, unknown> = {};
    for (const key of allowed) {
      if (Object.hasOwn(input, key)) copied[key] = Reflect.get(input, key);
    }
    return ok(copied as Record<Allowed[number], unknown>);
  } catch (_cause: unknown) {
    return err("invalid_record");
  }
}
