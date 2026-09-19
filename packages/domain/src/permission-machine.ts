/** Exact ACP permission registration, resolution, and response outbox. */

import { isProxy } from "node:util/types";
import {
  freezeRuntimePayload,
  nextPermissionOutboxVersion,
  parseIdempotencyKey,
  parsePermissionDeliveryAttemptId,
  parsePermissionIdentity,
  parsePermissionOutboxCommandId,
  parsePermissionOutboxVersion,
  permissionIdentitiesEqual,
  semanticRuntimePayloadDigest,
  type AcpPermissionOptionKind,
  type IdempotencyKey,
  type JsonRpcCallbackId,
  type PermissionDeliveryAttemptId,
  type PermissionIdentity,
  type PermissionOutboxCommandId,
  type PermissionOutboxVersion,
  type RuntimePermissionOption,
  type RuntimePermissionRequestPayload,
} from "@guild/contracts";
import { canonicalFingerprint, lookupFingerprintedKey } from "./idempotency.js";

export const PERMISSION_STATES = Object.freeze([
  "pending",
  "resolving",
  "selected_allow",
  "selected_rejection",
  "cancelled",
  "expired",
  "orphaned",
  "delivery_uncertain",
] as const);
export type PermissionState = (typeof PERMISSION_STATES)[number];

export const TERMINAL_PERMISSION_STATES = Object.freeze([
  "selected_allow",
  "selected_rejection",
  "cancelled",
  "expired",
  "orphaned",
  "delivery_uncertain",
] as const);

export type PermissionOrphanCause =
  | "window_closed"
  | "window_reloaded"
  | "run_terminalized"
  | "session_changed"
  | "epoch_exited"
  | "transport_cannot_reply"
  | "run_cancel_requested";

export const PERMISSION_REGISTER_MODES = Object.freeze([
  "pending",
  "run_cancel_requested",
] as const);
export type PermissionRegisterMode = (typeof PERMISSION_REGISTER_MODES)[number];

export const PERMISSION_SIDE_EFFECTS = Object.freeze([
  "none",
  "request_one_upstream_write",
] as const);
export type PermissionSideEffect = (typeof PERMISSION_SIDE_EFFECTS)[number];

export const PERMISSION_OUTBOX_LIFECYCLES = Object.freeze([
  "pending",
  "in_flight",
  "completed",
  "delivery_uncertain",
] as const);
export type PermissionOutboxLifecycle =
  (typeof PERMISSION_OUTBOX_LIFECYCLES)[number];

export type PermissionResolution =
  | { readonly outcome: "selected"; readonly option: RuntimePermissionOption }
  | { readonly outcome: "cancelled" };

export type PermissionResolutionInput =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

export type PermissionResponseCause =
  | "explicit_user"
  | "deadline"
  | "orphan"
  | "run_cancel_requested";

export type PermissionOutboxCommand = {
  readonly kind: "permission_response";
  readonly target: {
    readonly adapterEpoch: PermissionIdentity["adapterEpoch"];
    readonly callbackRequestId: JsonRpcCallbackId;
  };
  readonly outcome: PermissionResolution;
  readonly cause: PermissionResponseCause;
};

export type PermissionOutbox = {
  readonly commandId: PermissionOutboxCommandId;
  readonly version: PermissionOutboxVersion;
  readonly command: PermissionOutboxCommand;
  readonly lifecycle: PermissionOutboxLifecycle;
  readonly deliveryAttemptId: PermissionDeliveryAttemptId | undefined;
};

/**
 * Immutable proof of the first durable permission decision. Persistence owns
 * the compare-and-set that changes this field from NULL to one exact value.
 */
export type PermissionDecisionCommit = {
  readonly cause: PermissionResponseCause;
  readonly outcome: PermissionResolution;
  readonly orphanCause: PermissionOrphanCause | undefined;
  readonly commandId: PermissionOutboxCommandId | undefined;
  readonly outboxVersion: PermissionOutboxVersion | undefined;
};

export type PermissionRecord = {
  readonly identity: PermissionIdentity;
  readonly request: RuntimePermissionRequestPayload;
  readonly registrationKey: IdempotencyKey;
  readonly registrationFingerprint: string;
  readonly registrationMode: PermissionRegisterMode;
  readonly state: PermissionState;
  readonly resolution: PermissionResolution | undefined;
  readonly decisionCommit: PermissionDecisionCommit | undefined;
  readonly orphanCause: PermissionOrphanCause | undefined;
  readonly outbox: PermissionOutbox | undefined;
};

export type PermissionRegisterInput = {
  readonly identity: PermissionIdentity;
  readonly request: RuntimePermissionRequestPayload;
  readonly idempotencyKey: IdempotencyKey;
  readonly mode?: PermissionRegisterMode;
  readonly transportCanReceive?: boolean;
  readonly commandId?: PermissionOutboxCommandId;
};

export type PermissionEvent =
  | {
      readonly type: "resolve";
      readonly identity: PermissionIdentity;
      readonly callbackRequestId: JsonRpcCallbackId;
      readonly outcome: PermissionResolutionInput;
      readonly commandId: PermissionOutboxCommandId;
    }
  | {
      readonly type: "deadline_passed";
      readonly identity: PermissionIdentity;
      readonly transportCanReceive: boolean;
      readonly commandId?: PermissionOutboxCommandId;
    }
  | {
      readonly type: "orphan";
      readonly identity: PermissionIdentity;
      readonly cause: PermissionOrphanCause;
      readonly transportCanReceive: boolean;
      readonly commandId?: PermissionOutboxCommandId;
    }
  | {
      readonly type: "request_outbox_delivery";
      readonly identity: PermissionIdentity;
      readonly commandId: PermissionOutboxCommandId;
      readonly version: PermissionOutboxVersion;
      readonly deliveryAttemptId: PermissionDeliveryAttemptId;
    }
  | {
      readonly type: "response_frame_flush_completed";
      readonly identity: PermissionIdentity;
      readonly commandId: PermissionOutboxCommandId;
      readonly version: PermissionOutboxVersion;
      readonly deliveryAttemptId: PermissionDeliveryAttemptId;
    };

export type PermissionApplyResult =
  | {
      readonly ok: true;
      readonly record: PermissionRecord;
      readonly records: readonly PermissionRecord[];
      readonly duplicate: boolean;
      readonly sideEffect: PermissionSideEffect;
    }
  | {
      readonly ok: false;
      readonly record: PermissionRecord | undefined;
      readonly records: readonly PermissionRecord[];
      readonly reason: string;
    };

type RecordApply =
  | {
      readonly ok: true;
      readonly record: PermissionRecord;
      readonly duplicate: boolean;
      readonly sideEffect: PermissionSideEffect;
    }
  | { readonly ok: false; readonly reason: string };

export function isTerminalPermissionState(state: PermissionState): boolean {
  return (TERMINAL_PERMISSION_STATES as readonly string[]).includes(state);
}

export function permissionRegistrationFingerprint(
  identity: PermissionIdentity,
  request: RuntimePermissionRequestPayload,
  mode: PermissionRegisterMode,
): string {
  return canonicalFingerprint([
    identity.taskId,
    identity.runId,
    identity.sessionId,
    identity.toolCallId,
    identity.adapterEpoch,
    identity.windowId,
    semanticRuntimePayloadDigest(request),
    mode,
  ]);
}

export function registerPermissionRequest(
  records: readonly PermissionRecord[],
  input: PermissionRegisterInput,
): PermissionApplyResult {
  let validatedRecords: CanonicalRecordsResult;
  try {
    validatedRecords = canonicalizeRecords(records);
  } catch (_cause: unknown) {
    return failed(Object.freeze([]), undefined, "invalid_permission_record");
  }
  if (!validatedRecords.ok) {
    return failed(Object.freeze([]), undefined, validatedRecords.reason);
  }
  const safeRecords = validatedRecords.records;
  const validatedInput = canonicalizeRegisterInput(input);
  if (!validatedInput.ok) {
    return failed(safeRecords, undefined, validatedInput.reason);
  }
  const {
    identity,
    request,
    registrationKey,
    mode,
    transportCanReceive,
    commandId,
  } = validatedInput.input;

  const fingerprint = permissionRegistrationFingerprint(identity, request, mode);
  const integrity = registrationIntegrity(safeRecords);
  if (!integrity.ok) {
    return failed(safeRecords, undefined, integrity.reason);
  }
  const entries = safeRecords.map((record) => ({
    key: record.registrationKey,
    fingerprint: record.registrationFingerprint,
    record,
  }));
  const byKey = lookupFingerprintedKey(
    entries,
    registrationKey,
    fingerprint,
  );
  if (byKey.kind === "collision") {
    return failed(safeRecords, byKey.entry.record, "idempotency_collision");
  }
  if (byKey.kind === "duplicate") {
    return succeeded(safeRecords, byKey.entry.record, true, "none");
  }

  const sameIdentity = safeRecords.filter((record) =>
    permissionIdentitiesEqual(record.identity, identity),
  );
  if (sameIdentity.length > 1) {
    return failed(safeRecords, undefined, "ambiguous_identity");
  }
  const existing = sameIdentity[0];
  if (existing !== undefined) {
    if (existing.registrationFingerprint !== fingerprint) {
      return failed(safeRecords, existing, "registration_collision");
    }
    return succeeded(safeRecords, existing, true, "none");
  }

  if (
    mode === "run_cancel_requested" &&
    transportCanReceive &&
    commandId === undefined
  ) {
    return failed(safeRecords, undefined, "missing_command_id");
  }
  const created = createRecord(
    identity,
    request,
    registrationKey,
    fingerprint,
    mode,
    transportCanReceive,
    commandId,
  );
  if (!created.ok) {
    return failed(safeRecords, undefined, created.reason);
  }
  const next = Object.freeze([...safeRecords, created.record]);
  return succeeded(next, created.record, false, "none");
}

export function applyPermissionEvent(
  records: readonly PermissionRecord[],
  event: PermissionEvent,
): PermissionApplyResult {
  let validatedRecords: CanonicalRecordsResult;
  try {
    validatedRecords = canonicalizeRecords(records);
  } catch (_cause: unknown) {
    return failed(Object.freeze([]), undefined, "invalid_permission_record");
  }
  if (!validatedRecords.ok) {
    return failed(Object.freeze([]), undefined, validatedRecords.reason);
  }
  const safeRecords = validatedRecords.records;
  const parsedEvent = canonicalizeEvent(event);
  if (!parsedEvent.ok) {
    return failed(safeRecords, undefined, parsedEvent.reason);
  }
  const safeEvent = parsedEvent.event;
  const routed = route(safeRecords, safeEvent.identity);
  if (!routed.ok) {
    return failed(safeRecords, undefined, routed.reason);
  }
  const applied = applyToRecord(routed.record, safeEvent);
  if (!applied.ok) {
    return failed(safeRecords, routed.record, applied.reason);
  }
  const next = Object.freeze(
    safeRecords.map((record) =>
      permissionIdentitiesEqual(record.identity, applied.record.identity)
        ? applied.record
        : record,
    ),
  );
  return succeeded(next, applied.record, applied.duplicate, applied.sideEffect);
}

function validateRequest(
  input: unknown,
  identity: PermissionIdentity,
):
  | { readonly ok: true; readonly request: RuntimePermissionRequestPayload }
  | { readonly ok: false; readonly reason: string } {
  try {
    if (input !== null && typeof input === "object" && isProxy(input)) {
      return { ok: false, reason: "invalid_permission_request" };
    }
    const payload = freezeRuntimePayload(input);
    if (payload.type !== "permission_request") {
      return { ok: false, reason: "invalid_permission_request" };
    }
    if (payload.sessionId !== identity.sessionId) {
      return { ok: false, reason: "request_session_mismatch" };
    }
    if (payload.toolCallId !== identity.toolCallId) {
      return { ok: false, reason: "request_tool_mismatch" };
    }
    return { ok: true, request: payload };
  } catch (_cause: unknown) {
    return { ok: false, reason: "invalid_permission_request" };
  }
}

function createRecord(
  identity: PermissionIdentity,
  request: RuntimePermissionRequestPayload,
  registrationKey: IdempotencyKey,
  registrationFingerprint: string,
  registrationMode: PermissionRegisterMode,
  transportCanReceive: boolean,
  commandId: PermissionOutboxCommandId | undefined,
):
  | { readonly ok: true; readonly record: PermissionRecord }
  | { readonly ok: false; readonly reason: string } {
  if (registrationMode === "pending") {
    return {
      ok: true,
      record: freezeRecord({
        identity,
        request,
        registrationKey,
        registrationFingerprint,
        registrationMode,
        state: "pending",
        resolution: undefined,
        decisionCommit: undefined,
        orphanCause: undefined,
        outbox: undefined,
      }),
    };
  }

  const resolution = automaticResolution(request.options);
  let outbox: PermissionOutbox | undefined;
  if (transportCanReceive) {
    const created = createPendingOutbox(
      undefined,
      commandId as PermissionOutboxCommandId,
      responseCommand(
        identity,
        request.callbackRequestId,
        resolution,
        "run_cancel_requested",
      ),
    );
    if (!created.ok) {
      return created;
    }
    outbox = created.value;
  }
  return {
    ok: true,
    record: freezeRecord({
      identity,
      request,
      registrationKey,
      registrationFingerprint,
      registrationMode,
      state: "orphaned",
      resolution,
      decisionCommit: createDecisionCommit(
        "run_cancel_requested",
        resolution,
        "run_cancel_requested",
        outbox,
      ),
      orphanCause: "run_cancel_requested",
      outbox,
    }),
  };
}

function applyToRecord(
  record: PermissionRecord,
  event: PermissionEvent,
): RecordApply {
  switch (event.type) {
    case "resolve":
      return resolve(
        record,
        event.callbackRequestId,
        event.outcome,
        event.commandId,
      );
    case "deadline_passed":
      return automaticTerminal(
        record,
        "expired",
        undefined,
        event.transportCanReceive,
        event.commandId,
      );
    case "orphan":
      return automaticTerminal(
        record,
        "orphaned",
        event.cause,
        event.transportCanReceive,
        event.commandId,
      );
    case "request_outbox_delivery":
      return claim(
        record,
        event.commandId,
        event.version,
        event.deliveryAttemptId,
      );
    case "response_frame_flush_completed":
      return acknowledge(
        record,
        event.commandId,
        event.version,
        event.deliveryAttemptId,
      );
  }
}

function resolve(
  record: PermissionRecord,
  callbackRequestId: JsonRpcCallbackId,
  input: PermissionResolutionInput,
  commandId: PermissionOutboxCommandId,
): RecordApply {
  if (!callbackIdsEqual(record.request.callbackRequestId, callbackRequestId)) {
    return rejected("callback_id_mismatch");
  }
  const resolution = exactResolution(record.request.options, input);
  if (!resolution.ok) {
    return resolution;
  }
  if (record.state !== "pending") {
    return resolutionsEqual(record.resolution, resolution.value)
      ? duplicate(record)
      : rejected("not_pending");
  }
  const outbox = createPendingOutbox(
    record.outbox,
    commandId,
    responseCommand(
      record.identity,
      callbackRequestId,
      resolution.value,
      "explicit_user",
    ),
  );
  if (!outbox.ok) {
    return outbox;
  }
  return changed({
    ...record,
    state: "resolving",
    resolution: resolution.value,
    decisionCommit: createDecisionCommit(
      "explicit_user",
      resolution.value,
      undefined,
      outbox.value,
    ),
    outbox: outbox.value,
  });
}

function automaticTerminal(
  record: PermissionRecord,
  state: "expired" | "orphaned",
  orphanCause: PermissionOrphanCause | undefined,
  transportCanReceive: boolean,
  commandId: PermissionOutboxCommandId | undefined,
): RecordApply {
  const permanentLoss = state === "orphaned" && isPermanentLoss(orphanCause);
  if (
    record.state === "delivery_uncertain" ||
    record.outbox?.lifecycle === "delivery_uncertain"
  ) {
    return duplicate(record);
  }
  if (
    record.outbox?.lifecycle === "pending" &&
    permanentLoss &&
    !transportCanReceive
  ) {
    return changed({
      ...record,
      state: record.state === "resolving" ? "orphaned" : record.state,
      orphanCause:
        record.state === "resolving" ? orphanCause : record.orphanCause,
      outbox: undefined,
    });
  }
  if (
    record.state === "resolving" &&
    record.outbox?.lifecycle === "pending"
  ) {
    // The exact user response is already durable. A later UI/deadline signal
    // cannot silently replace it while the owning transport can still write.
    return duplicate(record);
  }
  if (record.outbox?.lifecycle === "in_flight") {
    if (permanentLoss) {
      return changed({
        ...record,
        state: "delivery_uncertain",
        orphanCause,
        outbox: {
          ...record.outbox,
          lifecycle: "delivery_uncertain",
        },
      });
    }
    return duplicate(record);
  }
  if (record.state === state && record.orphanCause === orphanCause) {
    return duplicate(record);
  }
  if (isTerminalPermissionState(record.state)) {
    return rejected("not_pending");
  }

  const resolution = automaticResolution(record.request.options);
  if (!transportCanReceive) {
    const cause: PermissionResponseCause =
      state === "expired"
        ? "deadline"
        : orphanCause === "run_cancel_requested"
          ? "run_cancel_requested"
          : "orphan";
    return changed({
      ...record,
      state,
      resolution,
      decisionCommit: createDecisionCommit(
        cause,
        resolution,
        cause === "orphan" || cause === "run_cancel_requested"
          ? orphanCause
          : undefined,
        undefined,
      ),
      orphanCause,
      outbox: undefined,
    });
  }
  if (commandId === undefined) {
    return rejected("missing_command_id");
  }
  const cause: PermissionResponseCause =
    state === "expired"
      ? "deadline"
      : orphanCause === "run_cancel_requested"
        ? "run_cancel_requested"
        : "orphan";
  const outbox = createPendingOutbox(
    record.outbox,
    commandId,
    responseCommand(
      record.identity,
      record.request.callbackRequestId,
      resolution,
      cause,
    ),
  );
  if (!outbox.ok) {
    return outbox;
  }
  return changed({
    ...record,
    state,
    resolution,
    decisionCommit: createDecisionCommit(
      cause,
      resolution,
      cause === "orphan" || cause === "run_cancel_requested"
        ? orphanCause
        : undefined,
      outbox.value,
    ),
    orphanCause,
    outbox: outbox.value,
  });
}

function claim(
  record: PermissionRecord,
  commandId: PermissionOutboxCommandId,
  version: PermissionOutboxVersion,
  deliveryAttemptId: PermissionDeliveryAttemptId,
): RecordApply {
  const outbox = record.outbox;
  if (outbox === undefined) {
    return rejected("write_not_in_progress");
  }
  if (
    outbox.commandId !== commandId ||
    outbox.version !== version ||
    outbox.command.target.adapterEpoch !== record.identity.adapterEpoch
  ) {
    return rejected("outbox_cas_mismatch");
  }
  if (outbox.lifecycle === "pending") {
    return Object.freeze({
      ok: true,
      record: freezeRecord({
        ...record,
        outbox: {
          ...outbox,
          lifecycle: "in_flight",
          deliveryAttemptId,
        },
      }),
      duplicate: false,
      sideEffect: "request_one_upstream_write",
    });
  }
  if (
    outbox.deliveryAttemptId === deliveryAttemptId &&
    (outbox.lifecycle === "in_flight" || outbox.lifecycle === "completed")
  ) {
    return duplicate(record);
  }
  return rejected(
    outbox.lifecycle === "delivery_uncertain"
      ? "delivery_uncertain"
      : "already_in_flight",
  );
}

function acknowledge(
  record: PermissionRecord,
  commandId: PermissionOutboxCommandId,
  version: PermissionOutboxVersion,
  deliveryAttemptId: PermissionDeliveryAttemptId,
): RecordApply {
  const outbox = record.outbox;
  if (outbox === undefined) {
    return rejected("write_not_in_progress");
  }
  if (
    outbox.commandId !== commandId ||
    outbox.version !== version
  ) {
    return rejected("outbox_cas_mismatch");
  }
  if (outbox.lifecycle === "pending") {
    return rejected("write_not_in_progress");
  }
  if (outbox.deliveryAttemptId !== deliveryAttemptId) {
    return rejected("outbox_cas_mismatch");
  }
  if (outbox.lifecycle === "completed") {
    return duplicate(record);
  }
  const nextState = terminalStateForCommand(outbox.command);
  const nextOrphanCause =
    outbox.command.cause === "run_cancel_requested"
      ? "run_cancel_requested"
      : outbox.command.cause === "orphan"
        ? record.decisionCommit?.orphanCause
        : undefined;
  return changed({
    ...record,
    state: nextState,
    orphanCause: nextOrphanCause,
    outbox: { ...outbox, lifecycle: "completed" },
  });
}

function exactResolution(
  options: readonly RuntimePermissionOption[],
  input: PermissionResolutionInput,
):
  | { readonly ok: true; readonly value: PermissionResolution }
  | { readonly ok: false; readonly reason: string } {
  if (input.outcome === "cancelled") {
    return Object.freeze({
      ok: true,
      value: Object.freeze({ outcome: "cancelled" }),
    });
  }
  const option = options.find(
    (candidate) => candidate.optionId === input.optionId,
  );
  return option === undefined
    ? Object.freeze({ ok: false, reason: "option_not_advertised" })
    : Object.freeze({
        ok: true,
        value: Object.freeze({ outcome: "selected", option }),
      });
}

function automaticResolution(
  options: readonly RuntimePermissionOption[],
): PermissionResolution {
  const option = options.find((candidate) => candidate.kind === "reject_once");
  return option === undefined
    ? Object.freeze({ outcome: "cancelled" })
    : Object.freeze({ outcome: "selected", option });
}

function responseCommand(
  identity: PermissionIdentity,
  callbackRequestId: JsonRpcCallbackId,
  outcome: PermissionResolution,
  cause: PermissionResponseCause,
): PermissionOutboxCommand {
  return deepFreezeCopy({
    kind: "permission_response",
    target: { adapterEpoch: identity.adapterEpoch, callbackRequestId },
    outcome,
    cause,
  });
}

function createPendingOutbox(
  previous: PermissionOutbox | undefined,
  commandId: PermissionOutboxCommandId,
  command: PermissionOutboxCommand,
):
  | { readonly ok: true; readonly value: PermissionOutbox }
  | { readonly ok: false; readonly reason: string } {
  const version = nextPermissionOutboxVersion(previous?.version);
  if (!version.ok) {
    return version;
  }
  const value: PermissionOutbox = deepFreezeCopy({
    commandId,
    version: version.value,
    command,
    lifecycle: "pending",
    deliveryAttemptId: undefined,
  });
  return Object.freeze({
    ok: true,
    value,
  });
}

function createDecisionCommit(
  cause: PermissionResponseCause,
  outcome: PermissionResolution,
  orphanCause: PermissionOrphanCause | undefined,
  outbox: PermissionOutbox | undefined,
): PermissionDecisionCommit {
  return deepFreezeCopy({
    cause,
    outcome,
    orphanCause,
    commandId: outbox?.commandId,
    outboxVersion: outbox?.version,
  });
}

function route(
  records: readonly PermissionRecord[],
  identity: PermissionIdentity,
):
  | { readonly ok: true; readonly record: PermissionRecord }
  | { readonly ok: false; readonly reason: string } {
  const exact = records.filter((record) =>
    permissionIdentitiesEqual(record.identity, identity),
  );
  if (exact.length > 1) {
    return { ok: false, reason: "ambiguous_identity" };
  }
  if (exact[0] !== undefined) {
    return { ok: true, record: exact[0] };
  }
  const sameWithoutWindow = records.some(
    (record) =>
      record.identity.taskId === identity.taskId &&
      record.identity.runId === identity.runId &&
      record.identity.sessionId === identity.sessionId &&
      record.identity.toolCallId === identity.toolCallId &&
      record.identity.adapterEpoch === identity.adapterEpoch,
  );
  return {
    ok: false,
    reason: sameWithoutWindow ? "wrong_window" : "identity_mismatch",
  };
}

function registrationIntegrity(
  records: readonly PermissionRecord[],
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) {
      continue;
    }
    if (
      record.registrationFingerprint !==
      permissionRegistrationFingerprint(
        record.identity,
        record.request,
        record.registrationMode,
      )
    ) {
      return { ok: false, reason: "registration_integrity_failure" };
    }
    for (let otherIndex = index + 1; otherIndex < records.length; otherIndex += 1) {
      const other = records[otherIndex];
      if (
        other !== undefined &&
        (permissionIdentitiesEqual(record.identity, other.identity) ||
          record.registrationKey === other.registrationKey)
      ) {
        return { ok: false, reason: "ambiguous_identity" };
      }
    }
  }
  return { ok: true };
}

function callbackIdsEqual(
  left: JsonRpcCallbackId,
  right: JsonRpcCallbackId,
): boolean {
  return left === right && typeof left === typeof right;
}

function resolutionsEqual(
  left: PermissionResolution | undefined,
  right: PermissionResolution,
): boolean {
  if (left === undefined || left.outcome !== right.outcome) {
    return false;
  }
  return (
    left.outcome === "cancelled" ||
    (right.outcome === "selected" &&
      left.option.optionId === right.option.optionId &&
      left.option.name === right.option.name &&
      left.option.kind === right.option.kind)
  );
}

function terminalState(outcome: PermissionResolution): PermissionState {
  if (outcome.outcome === "cancelled") {
    return "cancelled";
  }
  return isAllow(outcome.option.kind)
    ? "selected_allow"
    : "selected_rejection";
}

function terminalStateForCommand(
  command: PermissionOutboxCommand,
): PermissionState {
  switch (command.cause) {
    case "explicit_user":
      return terminalState(command.outcome);
    case "deadline":
      return "expired";
    case "orphan":
    case "run_cancel_requested":
      return "orphaned";
  }
}

function isAllow(kind: AcpPermissionOptionKind): boolean {
  return kind === "allow_once" || kind === "allow_always";
}

function isPermanentLoss(cause: PermissionOrphanCause | undefined): boolean {
  return (
    cause === "run_terminalized" ||
    cause === "session_changed" ||
    cause === "epoch_exited" ||
    cause === "transport_cannot_reply"
  );
}

function duplicate(record: PermissionRecord): RecordApply {
  return Object.freeze({
    ok: true,
    record,
    duplicate: true,
    sideEffect: "none",
  });
}

function changed(record: PermissionRecord): RecordApply {
  return Object.freeze({
    ok: true,
    record: freezeRecord(record),
    duplicate: false,
    sideEffect: "none",
  });
}

function rejected(reason: string): RecordApply & { readonly ok: false } {
  return Object.freeze({ ok: false, reason });
}

function succeeded(
  records: readonly PermissionRecord[],
  record: PermissionRecord,
  duplicateValue: boolean,
  sideEffect: PermissionSideEffect,
): PermissionApplyResult {
  const safeRecord = freezeRecord(record);
  const safeRecords = Object.freeze(
    records.map((candidate) =>
      candidate === record ? safeRecord : freezeRecord(candidate),
    ),
  );
  return Object.freeze({
    ok: true,
    record: safeRecord,
    records: safeRecords,
    duplicate: duplicateValue,
    sideEffect,
  });
}

function failed(
  records: readonly PermissionRecord[],
  record: PermissionRecord | undefined,
  reason: string,
): PermissionApplyResult {
  const safeRecord = record === undefined ? undefined : freezeRecord(record);
  const safeRecords = Object.freeze(
    records.map((candidate) =>
      candidate === record ? safeRecord as PermissionRecord : freezeRecord(candidate),
    ),
  );
  return Object.freeze({
    ok: false,
    record: safeRecord,
    records: safeRecords,
    reason,
  });
}

type CanonicalRecordsResult =
  | { readonly ok: true; readonly records: readonly PermissionRecord[] }
  | { readonly ok: false; readonly reason: string };

type CanonicalEventResult =
  | { readonly ok: true; readonly event: PermissionEvent }
  | { readonly ok: false; readonly reason: string };

type CanonicalRegisterInputResult =
  | {
      readonly ok: true;
      readonly input: {
        readonly identity: PermissionIdentity;
        readonly request: RuntimePermissionRequestPayload;
        readonly registrationKey: IdempotencyKey;
        readonly mode: PermissionRegisterMode;
        readonly transportCanReceive: boolean;
        readonly commandId: PermissionOutboxCommandId | undefined;
      };
    }
  | { readonly ok: false; readonly reason: string };

type CanonicalRecordResult =
  | { readonly ok: true; readonly record: PermissionRecord }
  | { readonly ok: false };

type CanonicalOutboxResult =
  | { readonly ok: true; readonly outbox: PermissionOutbox }
  | { readonly ok: false };

type CanonicalResolutionResult =
  | { readonly ok: true; readonly resolution: PermissionResolution }
  | { readonly ok: false };

const RECORD_KEYS = Object.freeze([
  "identity",
  "request",
  "registrationKey",
  "registrationFingerprint",
  "registrationMode",
  "state",
  "resolution",
  "decisionCommit",
  "orphanCause",
  "outbox",
] as const);

const DECISION_COMMIT_KEYS = Object.freeze([
  "cause",
  "outcome",
  "orphanCause",
  "commandId",
  "outboxVersion",
] as const);

const REGISTER_INPUT_KEYS = Object.freeze([
  "identity",
  "request",
  "idempotencyKey",
  "mode",
  "transportCanReceive",
  "commandId",
] as const);

const IDENTITY_KEYS = Object.freeze([
  "taskId",
  "runId",
  "sessionId",
  "toolCallId",
  "adapterEpoch",
  "windowId",
] as const);

const OUTBOX_KEYS = Object.freeze([
  "commandId",
  "version",
  "command",
  "lifecycle",
  "deliveryAttemptId",
] as const);

const COMMAND_KEYS = Object.freeze([
  "kind",
  "target",
  "outcome",
  "cause",
] as const);

const ORPHAN_CAUSES = Object.freeze([
  "window_closed",
  "window_reloaded",
  "run_terminalized",
  "session_changed",
  "epoch_exited",
  "transport_cannot_reply",
  "run_cancel_requested",
] as const);

const RESPONSE_CAUSES = Object.freeze([
  "explicit_user",
  "deadline",
  "orphan",
  "run_cancel_requested",
] as const);

function canonicalizeRegisterInput(input: unknown): CanonicalRegisterInputResult {
  try {
    const rec = exactObject(input, REGISTER_INPUT_KEYS, [
      "identity",
      "request",
      "idempotencyKey",
    ]);
    if (rec === undefined) {
      return { ok: false, reason: "invalid_permission_register_input" };
    }
    const identity = canonicalizeIdentity(rec["identity"]);
    if (!identity.ok) {
      return { ok: false, reason: "invalid_permission_register_input" };
    }
    const request = validateRequest(rec["request"], identity.identity);
    const registrationKey = parseIdempotencyKey(rec["idempotencyKey"]);
    const mode = rec["mode"] ?? "pending";
    const transportCanReceive = rec["transportCanReceive"] ?? true;
    const commandId = canonicalOptionalCommandId(rec["commandId"]);
    if (
      !request.ok ||
      !registrationKey.ok ||
      typeof mode !== "string" ||
      !(PERMISSION_REGISTER_MODES as readonly string[]).includes(mode) ||
      typeof transportCanReceive !== "boolean" ||
      !commandId.ok
    ) {
      return { ok: false, reason: "invalid_permission_register_input" };
    }
    return Object.freeze({
      ok: true,
      input: deepFreezeCopy({
        identity: identity.identity,
        request: request.request,
        registrationKey: registrationKey.value,
        mode: mode as PermissionRegisterMode,
        transportCanReceive,
        commandId: commandId.value,
      }),
    });
  } catch (_cause: unknown) {
    return Object.freeze({
      ok: false,
      reason: "invalid_permission_register_input",
    });
  }
}

function canonicalizeIdentity(
  input: unknown,
):
  | { readonly ok: true; readonly identity: PermissionIdentity }
  | { readonly ok: false } {
  const rec = exactObject(input, IDENTITY_KEYS, IDENTITY_KEYS);
  if (rec === undefined) {
    return Object.freeze({ ok: false });
  }
  const parsed = parsePermissionIdentity(rec);
  return parsed.ok
    ? Object.freeze({ ok: true, identity: deepFreezeCopy(parsed.value) })
    : Object.freeze({ ok: false });
}

function canonicalizeEvent(input: unknown): CanonicalEventResult {
  try {
    const base = exactObject(
      input,
      [
        "type",
        "identity",
        "callbackRequestId",
        "outcome",
        "commandId",
        "transportCanReceive",
        "cause",
        "version",
        "deliveryAttemptId",
      ],
      ["type", "identity"],
    );
    if (base === undefined || typeof base["type"] !== "string") {
      return { ok: false, reason: "invalid_permission_event" };
    }
    const identity = canonicalizeIdentity(base["identity"]);
    if (!identity.ok) {
      return { ok: false, reason: "invalid_permission_event" };
    }
    const canonicalIdentity = identity.identity;
    switch (base["type"]) {
      case "resolve": {
        if (
          !hasExactly(base, [
            "type",
            "identity",
            "callbackRequestId",
            "outcome",
            "commandId",
          ])
        ) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const callbackRequestId = canonicalCallbackId(
          base["callbackRequestId"],
        );
        const outcome = canonicalizeResolutionInput(base["outcome"]);
        const commandId = parsePermissionOutboxCommandId(base["commandId"]);
        if (callbackRequestId === undefined || !outcome.ok || !commandId.ok) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const event: PermissionEvent = deepFreezeCopy({
          type: "resolve",
          identity: canonicalIdentity,
          callbackRequestId,
          outcome: outcome.outcome,
          commandId: commandId.value,
        });
        return Object.freeze({ ok: true, event });
      }
      case "deadline_passed": {
        if (
          !hasExactly(base, [
            "type",
            "identity",
            "transportCanReceive",
            "commandId",
          ]) ||
          typeof base["transportCanReceive"] !== "boolean"
        ) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const commandId = canonicalOptionalCommandId(base["commandId"]);
        if (!commandId.ok) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const event: PermissionEvent = deepFreezeCopy({
          type: "deadline_passed",
          identity: canonicalIdentity,
          transportCanReceive: base["transportCanReceive"],
          ...(commandId.value === undefined
            ? {}
            : { commandId: commandId.value }),
        });
        return Object.freeze({ ok: true, event });
      }
      case "orphan": {
        if (
          !hasExactly(base, [
            "type",
            "identity",
            "cause",
            "transportCanReceive",
            "commandId",
          ]) ||
          typeof base["cause"] !== "string" ||
          !(ORPHAN_CAUSES as readonly string[]).includes(base["cause"]) ||
          typeof base["transportCanReceive"] !== "boolean"
        ) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const commandId = canonicalOptionalCommandId(base["commandId"]);
        if (!commandId.ok) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const event: PermissionEvent = deepFreezeCopy({
          type: "orphan",
          identity: canonicalIdentity,
          cause: base["cause"] as PermissionOrphanCause,
          transportCanReceive: base["transportCanReceive"],
          ...(commandId.value === undefined
            ? {}
            : { commandId: commandId.value }),
        });
        return Object.freeze({ ok: true, event });
      }
      case "request_outbox_delivery":
      case "response_frame_flush_completed": {
        if (
          !hasExactly(base, [
            "type",
            "identity",
            "commandId",
            "version",
            "deliveryAttemptId",
          ])
        ) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const commandId = parsePermissionOutboxCommandId(base["commandId"]);
        const version = parsePermissionOutboxVersion(base["version"]);
        const deliveryAttemptId = parsePermissionDeliveryAttemptId(
          base["deliveryAttemptId"],
        );
        if (!commandId.ok || !version.ok || !deliveryAttemptId.ok) {
          return { ok: false, reason: "invalid_permission_event" };
        }
        const event: PermissionEvent = deepFreezeCopy({
          type: base["type"],
          identity: canonicalIdentity,
          commandId: commandId.value,
          version: version.value,
          deliveryAttemptId: deliveryAttemptId.value,
        });
        return Object.freeze({ ok: true, event });
      }
      default:
        return { ok: false, reason: "invalid_permission_event" };
    }
  } catch (_cause: unknown) {
    return Object.freeze({ ok: false, reason: "invalid_permission_event" });
  }
}

function canonicalizeResolutionInput(
  input: unknown,
):
  | { readonly ok: true; readonly outcome: PermissionResolutionInput }
  | { readonly ok: false } {
  const rec = exactObject(input, ["outcome", "optionId"], ["outcome"]);
  if (rec === undefined) {
    return { ok: false };
  }
  if (rec["outcome"] === "cancelled") {
    return Object.hasOwn(rec, "optionId") && rec["optionId"] !== undefined
      ? { ok: false }
      : Object.freeze({
          ok: true,
          outcome: Object.freeze({ outcome: "cancelled" }),
        });
  }
  if (
    rec["outcome"] !== "selected" ||
    typeof rec["optionId"] !== "string" ||
    rec["optionId"].length === 0
  ) {
    return { ok: false };
  }
  return Object.freeze({
    ok: true,
    outcome: Object.freeze({
      outcome: "selected",
      optionId: rec["optionId"],
    }),
  });
}

function canonicalCallbackId(value: unknown): JsonRpcCallbackId | undefined {
  if (value === null || typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function canonicalOptionalCommandId(
  value: unknown,
):
  | { readonly ok: true; readonly value: PermissionOutboxCommandId | undefined }
  | { readonly ok: false } {
  if (value === undefined) {
    return Object.freeze({ ok: true, value: undefined });
  }
  const parsed = parsePermissionOutboxCommandId(value);
  return parsed.ok
    ? Object.freeze({ ok: true, value: parsed.value })
    : Object.freeze({ ok: false });
}

function canonicalizeRecords(input: unknown): CanonicalRecordsResult {
  const inputs = denseDataArray(input);
  if (inputs === undefined) {
    return { ok: false, reason: "invalid_permission_record" };
  }
  const records: PermissionRecord[] = [];
  for (const inputRecord of inputs) {
    const parsed = canonicalizeRecord(inputRecord);
    if (!parsed.ok) {
      return { ok: false, reason: "invalid_permission_record" };
    }
    if (
      records.some(
        (record) =>
          permissionIdentitiesEqual(record.identity, parsed.record.identity) ||
          record.registrationKey === parsed.record.registrationKey,
      )
    ) {
      return { ok: false, reason: "ambiguous_identity" };
    }
    records.push(parsed.record);
  }
  return Object.freeze({ ok: true, records: Object.freeze(records) });
}

/** Canonical persisted boundary used by main-process persistence adapters. */
export function canonicalizePermissionRecord(input: unknown): PermissionRecord {
  const parsed = canonicalizeRecord(input);
  if (!parsed.ok) {
    throw new TypeError("invalid_permission_record");
  }
  return parsed.record;
}

function canonicalizeRecord(input: unknown): CanonicalRecordResult {
  const rec = exactObject(input, RECORD_KEYS, [
    "identity",
    "request",
    "registrationKey",
    "registrationFingerprint",
    "registrationMode",
    "state",
  ]);
  if (rec === undefined) {
    return { ok: false };
  }
  const parsedIdentity = canonicalizeIdentity(rec["identity"]);
  if (!parsedIdentity.ok) {
    return { ok: false };
  }
  const identity = parsedIdentity.identity;
  const parsedRequest = validateRequest(rec["request"], identity);
  if (!parsedRequest.ok) {
    return { ok: false };
  }
  const request = parsedRequest.request;
  const registrationKey = parseIdempotencyKey(rec["registrationKey"]);
  if (!registrationKey.ok) {
    return { ok: false };
  }
  const registrationMode = rec["registrationMode"];
  if (
    typeof registrationMode !== "string" ||
    !(PERMISSION_REGISTER_MODES as readonly string[]).includes(registrationMode)
  ) {
    return { ok: false };
  }
  const state = rec["state"];
  if (
    typeof state !== "string" ||
    !(PERMISSION_STATES as readonly string[]).includes(state)
  ) {
    return { ok: false };
  }
  const registrationFingerprint = rec["registrationFingerprint"];
  if (
    typeof registrationFingerprint !== "string" ||
    registrationFingerprint !==
      permissionRegistrationFingerprint(
        identity,
        request,
        registrationMode as PermissionRegisterMode,
      )
  ) {
    return { ok: false };
  }

  const resolutionValue = rec["resolution"];
  const parsedResolution =
    resolutionValue === undefined
      ? undefined
      : canonicalizeResolution(resolutionValue, request.options);
  if (parsedResolution !== undefined && !parsedResolution.ok) {
    return { ok: false };
  }
  const resolution = parsedResolution?.resolution;
  const decisionCommitValue = rec["decisionCommit"];
  const parsedDecisionCommit =
    decisionCommitValue === undefined
      ? undefined
      : canonicalizeDecisionCommit(
          decisionCommitValue,
          request.options,
        );
  if (parsedDecisionCommit !== undefined && !parsedDecisionCommit.ok) {
    return { ok: false };
  }
  const decisionCommit = parsedDecisionCommit?.commit;
  const orphanCauseValue = rec["orphanCause"];
  if (
    orphanCauseValue !== undefined &&
    (typeof orphanCauseValue !== "string" ||
      !(ORPHAN_CAUSES as readonly string[]).includes(orphanCauseValue))
  ) {
    return { ok: false };
  }
  const orphanCause = orphanCauseValue as PermissionOrphanCause | undefined;
  const outboxValue = rec["outbox"];
  const parsedOutbox =
    outboxValue === undefined
      ? undefined
      : canonicalizeOutbox(outboxValue, identity, request);
  if (parsedOutbox !== undefined && !parsedOutbox.ok) {
    return { ok: false };
  }
  const outbox = parsedOutbox?.outbox;

  const record: PermissionRecord = deepFreezeCopy({
    identity,
    request,
    registrationKey: registrationKey.value,
    registrationFingerprint,
    registrationMode: registrationMode as PermissionRegisterMode,
    state: state as PermissionState,
    resolution,
    decisionCommit,
    orphanCause,
    outbox,
  });
  return recordIsReachable(record)
    ? Object.freeze({ ok: true, record })
    : Object.freeze({ ok: false });
}

function canonicalizeDecisionCommit(
  input: unknown,
  options: readonly RuntimePermissionOption[],
):
  | { readonly ok: true; readonly commit: PermissionDecisionCommit }
  | { readonly ok: false } {
  const rec = exactObject(
    input,
    DECISION_COMMIT_KEYS,
    ["cause", "outcome"],
  );
  if (rec === undefined) return { ok: false };
  const cause = rec["cause"];
  if (
    typeof cause !== "string" ||
    !(RESPONSE_CAUSES as readonly string[]).includes(cause)
  ) {
    return { ok: false };
  }
  const outcome = canonicalizeResolution(rec["outcome"], options);
  if (!outcome.ok) return { ok: false };

  const orphanCauseValue = rec["orphanCause"];
  if (
    orphanCauseValue !== undefined &&
    (typeof orphanCauseValue !== "string" ||
      !(ORPHAN_CAUSES as readonly string[]).includes(orphanCauseValue))
  ) {
    return { ok: false };
  }
  const orphanCause = orphanCauseValue as PermissionOrphanCause | undefined;
  if (
    (cause === "orphan" &&
      (orphanCause === undefined || orphanCause === "run_cancel_requested")) ||
    (cause === "run_cancel_requested" &&
      orphanCause !== "run_cancel_requested") ||
    ((cause === "explicit_user" || cause === "deadline") &&
      orphanCause !== undefined)
  ) {
    return { ok: false };
  }

  const commandIdValue = rec["commandId"];
  const commandId =
    commandIdValue === undefined
      ? undefined
      : parsePermissionOutboxCommandId(commandIdValue);
  const outboxVersionValue = rec["outboxVersion"];
  const outboxVersion =
    outboxVersionValue === undefined
      ? undefined
      : parsePermissionOutboxVersion(outboxVersionValue);
  if (
    (commandId !== undefined && !commandId.ok) ||
    (outboxVersion !== undefined && !outboxVersion.ok) ||
    (commandId === undefined) !== (outboxVersion === undefined) ||
    (cause === "explicit_user" && commandId === undefined)
  ) {
    return { ok: false };
  }
  const initialVersion = nextPermissionOutboxVersion(undefined);
  if (
    outboxVersion !== undefined &&
    (!initialVersion.ok || outboxVersion.value !== initialVersion.value)
  ) {
    return { ok: false };
  }
  return Object.freeze({
    ok: true,
    commit: deepFreezeCopy({
      cause: cause as PermissionResponseCause,
      outcome: outcome.resolution,
      orphanCause,
      commandId: commandId?.value,
      outboxVersion: outboxVersion?.value,
    }),
  });
}

function canonicalizeResolution(
  input: unknown,
  options: readonly RuntimePermissionOption[],
): CanonicalResolutionResult {
  const rec = exactObject(input, ["outcome", "option"], ["outcome"]);
  if (rec === undefined) {
    return { ok: false };
  }
  if (rec["outcome"] === "cancelled") {
    if (Object.hasOwn(rec, "option") && rec["option"] !== undefined) {
      return { ok: false };
    }
    return Object.freeze({
      ok: true,
      resolution: Object.freeze({ outcome: "cancelled" }),
    });
  }
  if (rec["outcome"] !== "selected") {
    return { ok: false };
  }
  const option = exactObject(
    rec["option"],
    ["optionId", "name", "kind"],
    ["optionId", "name", "kind"],
  );
  if (option === undefined) {
    return { ok: false };
  }
  const advertised = options.find(
    (candidate) =>
      candidate.optionId === option["optionId"] &&
      candidate.name === option["name"] &&
      candidate.kind === option["kind"],
  );
  if (advertised === undefined) {
    return { ok: false };
  }
  return Object.freeze({
    ok: true,
    resolution: Object.freeze({ outcome: "selected", option: advertised }),
  });
}

function canonicalizeOutbox(
  input: unknown,
  identity: PermissionIdentity,
  request: RuntimePermissionRequestPayload,
): CanonicalOutboxResult {
  const rec = exactObject(input, OUTBOX_KEYS, [
    "commandId",
    "version",
    "command",
    "lifecycle",
  ]);
  if (rec === undefined) {
    return { ok: false };
  }
  const commandId = parsePermissionOutboxCommandId(rec["commandId"]);
  const version = parsePermissionOutboxVersion(rec["version"]);
  const lifecycle = rec["lifecycle"];
  if (
    !commandId.ok ||
    !version.ok ||
    typeof lifecycle !== "string" ||
    !(PERMISSION_OUTBOX_LIFECYCLES as readonly string[]).includes(lifecycle)
  ) {
    return { ok: false };
  }
  const deliveryAttemptValue = rec["deliveryAttemptId"];
  const deliveryAttempt =
    deliveryAttemptValue === undefined
      ? undefined
      : parsePermissionDeliveryAttemptId(deliveryAttemptValue);
  if (deliveryAttempt !== undefined && !deliveryAttempt.ok) {
    return { ok: false };
  }
  if (
    (lifecycle === "pending" && deliveryAttempt !== undefined) ||
    (lifecycle !== "pending" && deliveryAttempt === undefined)
  ) {
    return { ok: false };
  }

  const commandRec = exactObject(rec["command"], COMMAND_KEYS, COMMAND_KEYS);
  if (commandRec === undefined || commandRec["kind"] !== "permission_response") {
    return { ok: false };
  }
  const target = exactObject(
    commandRec["target"],
    ["adapterEpoch", "callbackRequestId"],
    ["adapterEpoch", "callbackRequestId"],
  );
  if (
    target === undefined ||
    target["adapterEpoch"] !== identity.adapterEpoch ||
    !callbackIdsEqual(
      target["callbackRequestId"] as JsonRpcCallbackId,
      request.callbackRequestId,
    )
  ) {
    return { ok: false };
  }
  const outcome = canonicalizeResolution(commandRec["outcome"], request.options);
  const cause = commandRec["cause"];
  if (
    !outcome.ok ||
    typeof cause !== "string" ||
    !(RESPONSE_CAUSES as readonly string[]).includes(cause)
  ) {
    return { ok: false };
  }
  const outbox: PermissionOutbox = deepFreezeCopy({
    commandId: commandId.value,
    version: version.value,
    command: {
      kind: "permission_response",
      target: {
        adapterEpoch: identity.adapterEpoch,
        callbackRequestId: request.callbackRequestId,
      },
      outcome: outcome.resolution,
      cause: cause as PermissionResponseCause,
    },
    lifecycle: lifecycle as PermissionOutboxLifecycle,
    deliveryAttemptId: deliveryAttempt?.value,
  });
  return Object.freeze({
    ok: true,
    outbox,
  });
}

function recordIsReachable(record: PermissionRecord): boolean {
  const {
    registrationMode,
    state,
    resolution,
    decisionCommit,
    orphanCause,
    outbox,
  } = record;
  if (
    (resolution === undefined) !== (decisionCommit === undefined) ||
    (resolution !== undefined &&
      decisionCommit !== undefined &&
      !resolutionsEqual(resolution, decisionCommit.outcome)) ||
    !decisionCommitMatchesRecord(record)
  ) {
    return false;
  }
  if (
    outbox !== undefined &&
    (resolution === undefined ||
      !resolutionsEqual(resolution, outbox.command.outcome))
  ) {
    return false;
  }
  if (
    registrationMode === "run_cancel_requested" &&
    state !== "orphaned" &&
    state !== "delivery_uncertain"
  ) {
    return false;
  }
  if (outbox !== undefined && !outboxIsReachable(record, outbox)) {
    return false;
  }

  switch (state) {
    case "pending":
      return (
        registrationMode === "pending" &&
        resolution === undefined &&
        decisionCommit === undefined &&
        orphanCause === undefined &&
        outbox === undefined
      );
    case "resolving":
      return (
        registrationMode === "pending" &&
        resolution !== undefined &&
        orphanCause === undefined &&
        outbox !== undefined &&
        outbox.command.cause === "explicit_user" &&
        (outbox.lifecycle === "pending" || outbox.lifecycle === "in_flight")
      );
    case "selected_allow":
    case "selected_rejection":
    case "cancelled":
      return (
        registrationMode === "pending" &&
        resolution !== undefined &&
        orphanCause === undefined &&
        outbox !== undefined &&
        outbox.lifecycle === "completed" &&
        outbox.command.cause === "explicit_user" &&
        terminalState(outbox.command.outcome) === state
      );
    case "expired":
      return (
        registrationMode === "pending" &&
        resolution !== undefined &&
        orphanCause === undefined &&
        (outbox === undefined
          ? resolutionsEqual(
              resolution,
              automaticResolution(record.request.options),
            )
          : outbox.command.cause === "deadline" &&
            outbox.lifecycle !== "delivery_uncertain")
      );
    case "orphaned":
      return orphanedRecordIsReachable(record);
    case "delivery_uncertain":
      return (
        resolution !== undefined &&
        isPermanentLoss(orphanCause) &&
        outbox?.lifecycle === "delivery_uncertain"
      );
  }
}

function decisionCommitMatchesRecord(record: PermissionRecord): boolean {
  const { decisionCommit, outbox, state, orphanCause, registrationMode } = record;
  if (decisionCommit === undefined) return state === "pending";
  if (outbox !== undefined) {
    if (
      decisionCommit.commandId !== outbox.commandId ||
      decisionCommit.outboxVersion !== outbox.version ||
      decisionCommit.cause !== outbox.command.cause ||
      !resolutionsEqual(decisionCommit.outcome, outbox.command.outcome)
    ) {
      return false;
    }
  }
  if (
    decisionCommit.cause === "explicit_user" &&
    (decisionCommit.commandId === undefined ||
      decisionCommit.outboxVersion === undefined)
  ) {
    return false;
  }
  if (
    registrationMode === "run_cancel_requested" &&
    (decisionCommit.cause !== "run_cancel_requested" ||
      decisionCommit.orphanCause !== "run_cancel_requested")
  ) {
    return false;
  }
  if (
    state === "resolving" ||
    state === "selected_allow" ||
    state === "selected_rejection" ||
    state === "cancelled"
  ) {
    return decisionCommit.cause === "explicit_user";
  }
  if (state === "expired") {
    return decisionCommit.cause === "deadline";
  }
  if (state === "orphaned") {
    if (decisionCommit.cause === "explicit_user") {
      return isPermanentLoss(orphanCause);
    }
    return (
      (decisionCommit.cause === "orphan" ||
        decisionCommit.cause === "run_cancel_requested") &&
      orphanCause === decisionCommit.orphanCause
    );
  }
  return state === "delivery_uncertain";
}

function outboxIsReachable(
  record: PermissionRecord,
  outbox: PermissionOutbox,
): boolean {
  const { cause, outcome } = outbox.command;
  if (
    cause !== "explicit_user" &&
    !resolutionsEqual(
      outcome,
      automaticResolution(record.request.options),
    )
  ) {
    return false;
  }
  if (
    record.registrationMode === "run_cancel_requested" &&
    cause !== "run_cancel_requested"
  ) {
    return false;
  }
  if (outbox.lifecycle === "delivery_uncertain") {
    return record.state === "delivery_uncertain";
  }
  if (outbox.lifecycle === "completed") {
    return terminalStateForCommand(outbox.command) === record.state;
  }
  switch (cause) {
    case "explicit_user":
      return record.state === "resolving" && record.orphanCause === undefined;
    case "deadline":
      return record.state === "expired" && record.orphanCause === undefined;
    case "orphan":
      return record.state === "orphaned" && record.orphanCause !== undefined;
    case "run_cancel_requested":
      return (
        record.state === "orphaned" &&
        record.orphanCause === "run_cancel_requested"
      );
  }
}

function orphanedRecordIsReachable(record: PermissionRecord): boolean {
  const { registrationMode, resolution, orphanCause, outbox } = record;
  if (resolution === undefined || orphanCause === undefined) {
    return false;
  }
  if (registrationMode === "run_cancel_requested") {
    return (
      orphanCause === "run_cancel_requested" &&
      resolutionsEqual(
        resolution,
        automaticResolution(record.request.options),
      ) &&
      (outbox === undefined ||
        outbox.command.cause === "run_cancel_requested")
    );
  }
  if (outbox !== undefined) {
    return (
      outbox.command.cause === "orphan" ||
      (outbox.command.cause === "run_cancel_requested" &&
        orphanCause === "run_cancel_requested")
    );
  }
  return (
    isPermanentLoss(orphanCause) ||
    resolutionsEqual(
      resolution,
      automaticResolution(record.request.options),
    )
  );
}

function exactObject(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> | undefined {
  if (
    input === null ||
    typeof input !== "object" ||
    isProxy(input) ||
    Array.isArray(input)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const rec = input as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(rec);
  if (ownKeys.some((key) => typeof key !== "string")) {
    return undefined;
  }
  const keys = ownKeys as string[];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(rec, key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(rec, key);
      return (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      );
    })
  ) {
    return undefined;
  }
  return rec;
}

function denseDataArray(input: unknown): readonly unknown[] | undefined {
  if (
    !Array.isArray(input) ||
    isProxy(input) ||
    Object.getPrototypeOf(input) !== Array.prototype
  ) {
    return undefined;
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== input.length + 1 ||
    keys.some((key) => {
      if (key === "length") return false;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
        return true;
      }
      const index = Number(key);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return index >= input.length ||
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true;
    })
  ) {
    return undefined;
  }
  return input;
}

function hasExactly(
  rec: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Reflect.ownKeys(rec).every(
    (key) => typeof key === "string" && allowed.includes(key),
  );
}

function freezeRecord(record: PermissionRecord): PermissionRecord {
  const parsed = canonicalizeRecord(record);
  if (!parsed.ok) {
    throw new Error("permission_machine_internal_invariant");
  }
  return parsed.record;
}

function deepFreezeCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreezeCopy(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = deepFreezeCopy(child);
    }
    return Object.freeze(copy) as T;
  }
  return value;
}
