/**
 * Default-deny live admission and staging-only replay (PC-EVENT-001, PC-TRN-002, PC-PERM-001).
 */

import { isProxy } from "node:util/types";
import {
  ADAPTER_EPOCH_STATUSES,
  epochStatusIsExited,
  FIRST_RECEIVE_SEQUENCE,
  isTerminalRunState,
  kindRequiresToolCallId,
  kindRequiresWindowId,
  liveEventKindAllowed,
  permissionIdentitiesEqual,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parsePermissionIdentity,
  parseRuntimeTurnEvent,
  parseWindowId,
  type AdapterEpoch,
  type AdapterEpochStatus,
  type IdempotencyKey,
  type PermissionIdentity,
  type RuntimeEnvelope,
  type RuntimeTurnEvent,
  type WindowId,
} from "@guild/contracts";
import { canonicalFingerprint, lookupFingerprintedKey } from "./idempotency.js";
import {
  canonicalizeRunRecord,
  type RunRecord,
} from "./run-machine.js";
import {
  canonicalizeSessionBindingRecord,
  type SessionBindingRecord,
} from "./session-binding.js";

export const REPLAY_STAGING_CONSTRAINTS = Object.freeze({
  mayCreateRun: false,
  mayTransitionRun: false,
  mayActivatePermission: false,
  mayResolvePermission: false,
  mayExecuteTool: false,
  mayRepeatSideEffect: false,
  mayAdvanceLiveTimers: false,
  mayAppendDirectly: false,
} as const);

export type ReplayStagingConstraints = typeof REPLAY_STAGING_CONSTRAINTS;

/** No envelope has been committed in this admission scope. */
export const NO_COMMITTED_RECEIVE_SEQUENCE = 0;

export { FIRST_RECEIVE_SEQUENCE };

export type CommittedEnvelope = {
  readonly key: IdempotencyKey;
  readonly fingerprint: string;
};

export type AdmissionContext = {
  readonly binding: SessionBindingRecord;
  readonly currentEpoch: AdapterEpoch;
  readonly epochStatus: AdapterEpochStatus;
  readonly committed: readonly CommittedEnvelope[];
  readonly lastCommittedReceiveSequence: number;
  readonly run: RunRecord | undefined;
  readonly authorizedWindowId: WindowId | undefined;
  /**
   * Authoritative main-process persisted Run ownership.
   * Never current focus, a newly opened window, or an envelope self-claim.
   */
  readonly persistedOwningWindowId: WindowId | undefined;
  readonly pendingPermissionIdentities: readonly PermissionIdentity[];
};

/** Non-UI destination: may only feed registerPermissionRequest with run_cancel_requested. */
export const PERMISSION_SAFE_CANCEL_REGISTER_MODE = "run_cancel_requested" as const;

export type AdmissionResult =
  | {
      readonly ok: true;
      readonly duplicate: false;
      readonly ingestMode: "live";
      readonly destination: "live";
    }
  | {
      readonly ok: true;
      readonly duplicate: true;
      readonly ingestMode: "live";
      readonly destination: "live";
    }
  | {
      readonly ok: true;
      readonly duplicate: false;
      readonly ingestMode: "live";
      readonly destination: "permission_safe_cancel";
      readonly permissionRegisterMode: typeof PERMISSION_SAFE_CANCEL_REGISTER_MODE;
    }
  | {
      readonly ok: true;
      readonly duplicate: true;
      readonly ingestMode: "live";
      readonly destination: "permission_safe_cancel";
      readonly permissionRegisterMode: typeof PERMISSION_SAFE_CANCEL_REGISTER_MODE;
    }
  | {
      readonly ok: true;
      readonly duplicate: false;
      readonly ingestMode: "replay";
      readonly destination: "staging";
      readonly constraints: ReplayStagingConstraints;
    }
  | {
      readonly ok: true;
      readonly duplicate: true;
      readonly ingestMode: "replay";
      readonly destination: "staging";
      readonly constraints: ReplayStagingConstraints;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly audit: true;
    };

export type RuntimeTurnAdmissionResult =
  | (Extract<AdmissionResult, { readonly ok: true }> & {
      readonly event: RuntimeTurnEvent;
    })
  | Extract<AdmissionResult, { readonly ok: false }>;

/** Semantic fingerprint. Excludes only delivery metadata ingestMode and adapterEpoch. */
export function envelopeFingerprint(envelope: RuntimeEnvelope): string {
  return canonicalFingerprint([
    envelope.kind,
    envelope.taskId,
    envelope.runId,
    envelope.sessionId,
    envelope.semanticPayloadDigest,
    envelope.toolCallId,
    envelope.windowId,
  ]);
}

/** Production boundary: validates the payload/envelope pair before admission. */
export function admitRuntimeTurnEvent(
  event: RuntimeTurnEvent,
  context: AdmissionContext,
): RuntimeTurnAdmissionResult {
  const parsed = parseRuntimeTurnEvent(event);
  if (!parsed.ok) return deny("invalid_runtime_turn_event");
  const safeContext = canonicalizeAdmissionContext(context);
  if (safeContext === undefined) return deny("invalid_admission_context");
  const admission = admitRuntimeEnvelope(parsed.value.envelope, safeContext);
  if (admission.ok === false) return admission;
  return Object.freeze({ ...admission, event: parsed.value });
}

const ADMISSION_CONTEXT_KEYS = Object.freeze([
  "binding",
  "currentEpoch",
  "epochStatus",
  "committed",
  "lastCommittedReceiveSequence",
  "run",
  "authorizedWindowId",
  "persistedOwningWindowId",
  "pendingPermissionIdentities",
] as const);

function canonicalizeAdmissionContext(
  input: unknown,
): AdmissionContext | undefined {
  try {
    const record = exactDataRecord(input, ADMISSION_CONTEXT_KEYS);
    if (record === undefined) return undefined;
    const currentEpoch = parseAdapterEpoch(record["currentEpoch"]);
    const epochStatus = record["epochStatus"];
    const lastCommittedReceiveSequence =
      record["lastCommittedReceiveSequence"];
    if (
      !currentEpoch.ok ||
      typeof epochStatus !== "string" ||
      !(ADAPTER_EPOCH_STATUSES as readonly string[]).includes(epochStatus) ||
      typeof lastCommittedReceiveSequence !== "number" ||
      !Number.isSafeInteger(lastCommittedReceiveSequence) ||
      lastCommittedReceiveSequence < NO_COMMITTED_RECEIVE_SEQUENCE
    ) {
      return undefined;
    }
    const binding = canonicalizeSessionBindingRecord(record["binding"]);
    const run = record["run"] === undefined
      ? undefined
      : canonicalizeRunRecord(record["run"]);
    const authorizedWindowId = optionalWindowId(record["authorizedWindowId"]);
    const persistedOwningWindowId = optionalWindowId(
      record["persistedOwningWindowId"],
    );
    const committed = canonicalCommittedEnvelopes(record["committed"]);
    const pendingPermissionIdentities = canonicalPermissionIdentities(
      record["pendingPermissionIdentities"],
    );
    if (
      authorizedWindowId === null ||
      persistedOwningWindowId === null ||
      committed === undefined ||
      pendingPermissionIdentities === undefined ||
      (run === undefined
        ? pendingPermissionIdentities.length !== 0
        : !samePermissionIdentitySet(
            run.unresolvedPermissionIdentities,
            pendingPermissionIdentities,
          ))
    ) {
      return undefined;
    }
    return Object.freeze({
      binding,
      currentEpoch: currentEpoch.value,
      epochStatus: epochStatus as AdapterEpochStatus,
      committed,
      lastCommittedReceiveSequence,
      run,
      authorizedWindowId,
      persistedOwningWindowId,
      pendingPermissionIdentities,
    });
  } catch (_cause: unknown) {
    return undefined;
  }
}

function exactDataRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (
    input === null ||
    typeof input !== "object" ||
    isProxy(input) ||
    Array.isArray(input)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return undefined;
    }
  }
  return record;
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

function optionalWindowId(input: unknown): WindowId | undefined | null {
  if (input === undefined) return undefined;
  const parsed = parseWindowId(input);
  return parsed.ok ? parsed.value : null;
}

function canonicalCommittedEnvelopes(
  input: unknown,
): readonly CommittedEnvelope[] | undefined {
  const entries = denseDataArray(input);
  if (entries === undefined) return undefined;
  const canonical: CommittedEnvelope[] = [];
  const keys = new Set<IdempotencyKey>();
  for (const entry of entries) {
    const record = exactDataRecord(entry, ["key", "fingerprint"]);
    if (record === undefined) return undefined;
    const key = parseIdempotencyKey(record["key"]);
    const fingerprint = record["fingerprint"];
    if (
      !key.ok ||
      typeof fingerprint !== "string" ||
      fingerprint.length === 0 ||
      keys.has(key.value)
    ) {
      return undefined;
    }
    keys.add(key.value);
    canonical.push(Object.freeze({ key: key.value, fingerprint }));
  }
  return Object.freeze(canonical);
}

function canonicalPermissionIdentities(
  input: unknown,
): readonly PermissionIdentity[] | undefined {
  const entries = denseDataArray(input);
  if (entries === undefined) return undefined;
  const canonical: PermissionIdentity[] = [];
  for (const entry of entries) {
    const exact = exactDataRecord(entry, [
      "taskId",
      "runId",
      "sessionId",
      "toolCallId",
      "adapterEpoch",
      "windowId",
    ]);
    if (exact === undefined) return undefined;
    const parsed = parsePermissionIdentity(exact);
    if (
      !parsed.ok ||
      canonical.some((prior) =>
        permissionIdentitiesEqual(prior, parsed.value),
      )
    ) {
      return undefined;
    }
    canonical.push(Object.freeze({ ...parsed.value }));
  }
  return Object.freeze(canonical);
}

function samePermissionIdentitySet(
  left: readonly PermissionIdentity[],
  right: readonly PermissionIdentity[],
): boolean {
  return left.length === right.length &&
    left.every((identity) =>
      right.some((candidate) =>
        permissionIdentitiesEqual(identity, candidate),
      ),
    );
}

/** @internal Test-only raw-envelope boundary for adversarial admission fixtures. */
export function admitRuntimeEnvelope(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult {
  if (envelope.ingestMode === "replay") {
    return admitReplay(envelope, context);
  }
  return admitLive(envelope, context);
}

function deny(reason: string): Extract<AdmissionResult, { readonly ok: false }> {
  return Object.freeze({ ok: false, reason, audit: true });
}

function duplicateLive(): AdmissionResult {
  return {
    ok: true,
    duplicate: true,
    ingestMode: "live",
    destination: "live",
  };
}

function duplicateReplay(): AdmissionResult {
  return {
    ok: true,
    duplicate: true,
    ingestMode: "replay",
    destination: "staging",
    constraints: REPLAY_STAGING_CONSTRAINTS,
  };
}

function permissionSafeCancel(duplicate: boolean): AdmissionResult {
  return {
    ok: true,
    duplicate,
    ingestMode: "live",
    destination: "permission_safe_cancel",
    permissionRegisterMode: PERMISSION_SAFE_CANCEL_REGISTER_MODE,
  };
}

function isCancelRequestedPermission(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): boolean {
  return (
    envelope.kind === "permission_request" &&
    context.run !== undefined &&
    context.run.state === "cancel_requested"
  );
}

function committedOutcome(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult | undefined {
  const fingerprint = envelopeFingerprint(envelope);
  const lookup = lookupFingerprintedKey(
    context.committed,
    envelope.idempotencyKey,
    fingerprint,
  );
  if (lookup.kind === "collision") {
    return deny("idempotency_collision");
  }
  if (lookup.kind === "duplicate") {
    if (envelope.ingestMode === "replay") {
      return duplicateReplay();
    }
    if (isCancelRequestedPermission(envelope, context)) {
      return permissionSafeCancel(true);
    }
    return duplicateLive();
  }
  return undefined;
}

function currentEpochUsable(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult | undefined {
  if (epochStatusIsExited(context.epochStatus)) {
    return deny("exited_epoch");
  }
  if (envelope.adapterEpoch !== context.currentEpoch) {
    return deny("stale_epoch");
  }
  return undefined;
}

function bindingEpochMatches(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult | undefined {
  if (context.binding.adapterEpoch === undefined) {
    return deny("binding_malformed");
  }
  if (
    context.binding.adapterEpoch !== context.currentEpoch ||
    context.binding.adapterEpoch !== envelope.adapterEpoch
  ) {
    return deny("stale_epoch");
  }
  return undefined;
}

function admitReceiveSequence(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult | undefined {
  const last = context.lastCommittedReceiveSequence;
  if (!Number.isSafeInteger(last) || last < NO_COMMITTED_RECEIVE_SEQUENCE) {
    return deny("receive_sequence_context_invalid");
  }
  const expected = last + 1;
  if (expected <= last || expected < FIRST_RECEIVE_SEQUENCE) {
    return deny("receive_sequence_overflow");
  }
  if (envelope.receiveSequence === expected) {
    return undefined;
  }
  if (envelope.receiveSequence <= last) {
    return deny("stale_receive_sequence");
  }
  return deny("out_of_order_receive_sequence");
}

function bindingSessionsAligned(binding: SessionBindingRecord): boolean {
  return (
    binding.sessionId !== undefined &&
    binding.retainedSessionId !== undefined &&
    binding.sessionId === binding.retainedSessionId
  );
}

function admitLive(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult {
  if (envelope.ingestMode !== "live") {
    return deny("wrong_ingest_mode");
  }
  if (
    context.binding.replayBarrier !== undefined ||
    context.binding.state === "replay_reconciling"
  ) {
    return deny("replay_barrier_open");
  }
  const epochReject = currentEpochUsable(envelope, context);
  if (epochReject !== undefined) {
    return epochReject;
  }
  if (context.binding.state !== "healthy") {
    return deny("binding_not_healthy");
  }
  if (!bindingSessionsAligned(context.binding)) {
    return deny("binding_malformed");
  }
  const bindingEpochReject = bindingEpochMatches(envelope, context);
  if (bindingEpochReject !== undefined) {
    return bindingEpochReject;
  }
  if (envelope.taskId !== context.binding.taskId) {
    return deny("wrong_task");
  }
  const run = context.run;
  if (run === undefined) {
    return deny("default_deny");
  }
  if (envelope.taskId !== run.taskId) {
    return deny("wrong_task");
  }
  if (envelope.runId !== run.runId) {
    return deny("wrong_run");
  }
  if (
    envelope.sessionId !== run.sessionId ||
    envelope.sessionId !== context.binding.sessionId ||
    envelope.sessionId !== context.binding.retainedSessionId
  ) {
    return deny("wrong_session");
  }
  if (run.adapterEpoch !== envelope.adapterEpoch) {
    return deny("stale_epoch");
  }
  const ownershipReject = admitPermissionRequestOwnership(envelope, context);
  if (ownershipReject !== undefined) {
    return ownershipReject;
  }
  const committed = committedOutcome(envelope, context);
  if (committed !== undefined) {
    return committed;
  }
  if (isTerminalRunState(run.state)) {
    return deny("run_terminal");
  }
  if (!liveEventKindAllowed(run.state, envelope.kind)) {
    return deny("illegal_event_kind");
  }
  if (kindRequiresToolCallId(envelope.kind) && envelope.toolCallId === undefined) {
    return deny("missing_tool_call_id");
  }
  if (kindRequiresWindowId(envelope.kind) && envelope.windowId === undefined) {
    return deny("missing_window_id");
  }
  const permissionReject = admitPermissionIdentity(envelope, context);
  if (permissionReject !== undefined) {
    return permissionReject;
  }
  const sequenceReject = admitReceiveSequence(envelope, context);
  if (sequenceReject !== undefined) {
    return sequenceReject;
  }
  if (isCancelRequestedPermission(envelope, context)) {
    return permissionSafeCancel(false);
  }
  return {
    ok: true,
    duplicate: false,
    ingestMode: "live",
    destination: "live",
  };
}

function admitPermissionRequestOwnership(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult | undefined {
  if (envelope.kind !== "permission_request") {
    return undefined;
  }
  if (envelope.toolCallId === undefined) {
    return deny("missing_tool_call_id");
  }
  if (envelope.windowId === undefined) {
    return deny("missing_window_id");
  }
  if (isCancelRequestedPermission(envelope, context)) {
    if (context.persistedOwningWindowId === undefined) {
      return deny("no_persisted_owning_window");
    }
    if (envelope.windowId !== context.persistedOwningWindowId) {
      return deny("wrong_window");
    }
    return undefined;
  }
  if (context.authorizedWindowId === undefined) {
    return deny("no_authorized_window");
  }
  if (envelope.windowId !== context.authorizedWindowId) {
    return deny("wrong_window");
  }
  if (context.persistedOwningWindowId === undefined) {
    return deny("no_persisted_owning_window");
  }
  if (envelope.windowId !== context.persistedOwningWindowId) {
    return deny("wrong_window");
  }
  return undefined;
}

function admitPermissionIdentity(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult | undefined {
  if (envelope.kind !== "permission_resolution") {
    return undefined;
  }
  const identity = permissionIdentityFromEnvelope(envelope);
  if (identity === undefined) {
    return deny("incomplete_identity");
  }
  const exact = context.pendingPermissionIdentities.some((pending) =>
    permissionIdentitiesEqual(pending, identity),
  );
  if (exact) {
    return undefined;
  }
  return deny("permission_identity_mismatch");
}

export function permissionIdentityFromEnvelope(
  envelope: RuntimeEnvelope,
): PermissionIdentity | undefined {
  if (envelope.toolCallId === undefined || envelope.windowId === undefined) {
    return undefined;
  }
  return {
    taskId: envelope.taskId,
    runId: envelope.runId,
    sessionId: envelope.sessionId,
    toolCallId: envelope.toolCallId,
    adapterEpoch: envelope.adapterEpoch,
    windowId: envelope.windowId,
  };
}

function admitReplay(
  envelope: RuntimeEnvelope,
  context: AdmissionContext,
): AdmissionResult {
  if (envelope.ingestMode !== "replay") {
    return deny("wrong_ingest_mode");
  }
  if (context.binding.state !== "replay_reconciling") {
    return deny("replay_not_reconciling");
  }
  const barrier = context.binding.replayBarrier;
  if (barrier === undefined) {
    return deny("missing_barrier");
  }
  const epochReject = currentEpochUsable(envelope, context);
  if (epochReject !== undefined) {
    return epochReject;
  }
  if (!bindingSessionsAligned(context.binding)) {
    return deny("binding_malformed");
  }
  const bindingEpochReject = bindingEpochMatches(envelope, context);
  if (bindingEpochReject !== undefined) {
    return bindingEpochReject;
  }
  if (
    envelope.sessionId !== barrier.sessionId ||
    envelope.adapterEpoch !== barrier.adapterEpoch ||
    barrier.sessionId !== context.binding.sessionId ||
    barrier.adapterEpoch !== context.binding.adapterEpoch
  ) {
    return deny(
      envelope.sessionId !== barrier.sessionId
        ? "wrong_session"
        : "stale_epoch",
    );
  }
  if (envelope.taskId !== context.binding.taskId) {
    return deny("wrong_task");
  }
  if (
    envelope.sessionId !== context.binding.sessionId ||
    envelope.sessionId !== context.binding.retainedSessionId
  ) {
    return deny("wrong_session");
  }
  const committed = committedOutcome(envelope, context);
  if (committed !== undefined) {
    return committed;
  }
  const sequenceReject = admitReceiveSequence(envelope, context);
  if (sequenceReject !== undefined) {
    return sequenceReject;
  }
  return {
    ok: true,
    duplicate: false,
    ingestMode: "replay",
    destination: "staging",
    constraints: REPLAY_STAGING_CONSTRAINTS,
  };
}
