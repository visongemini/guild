/**
 * SessionBinding machine, independent of every Run (PC-SESS-001, PC-TRN-002).
 * Restore never revives an interrupted Run. Replacement never mutates old Runs.
 * Failures and transport loss match the exact current operation provenance.
 * SessionAttemptIds are never reused; load provenance stays until terminal.
 */

import { isProxy } from "node:util/types";
import {
  parseAdapterEpoch,
  parseBarrierRequestId,
  parseIdempotencyKey,
  parseSessionAttemptId,
  parseSessionId,
  parseTaskId,
  type AdapterEpoch,
  type BarrierRequestId,
  type IdempotencyKey,
  type SessionAttemptId,
  type SessionId,
  type TaskId,
} from "@guild/contracts";
import {
  canonicalFingerprint,
  lookupFingerprintedKey,
} from "./idempotency.js";

export const SESSION_BINDING_STATES = Object.freeze([
  "unbound",
  "creating",
  "healthy",
  "restore_pending",
  "replay_reconciling",
  "broken",
  "replacement_pending",
] as const);

export type SessionBindingState = (typeof SESSION_BINDING_STATES)[number];

export const CONFLICT_FREE_VERDICT = "conflict_free" as const;
export type ReconciliationVerdict = typeof CONFLICT_FREE_VERDICT;

export type ReplayBarrier = {
  readonly requestId: BarrierRequestId;
  readonly sessionId: SessionId;
  readonly adapterEpoch: AdapterEpoch;
  readonly attemptId: SessionAttemptId;
};

export type AppliedBindingKey = {
  readonly key: IdempotencyKey;
  readonly fingerprint: string;
  readonly ok: boolean;
  readonly state: SessionBindingState;
  readonly reason: string | undefined;
};

export type SessionBindingRecord = {
  readonly taskId: TaskId;
  readonly state: SessionBindingState;
  readonly sessionId: SessionId | undefined;
  readonly adapterEpoch: AdapterEpoch | undefined;
  readonly replayBarrier: ReplayBarrier | undefined;
  readonly retainedSessionId: SessionId | undefined;
  readonly replacementAuthorized: boolean;
  readonly usedBarrierRequestIds: readonly BarrierRequestId[];
  readonly usedSessionAttemptIds: readonly SessionAttemptId[];
  readonly createAttemptId: SessionAttemptId | undefined;
  readonly restoreAttemptId: SessionAttemptId | undefined;
  readonly applied: readonly AppliedBindingKey[];
};

type Keyed = { readonly idempotencyKey: IdempotencyKey };

export type SessionBindingEvent =
  | ({
      readonly type: "start_session";
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({
      readonly type: "session_new_succeeded";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({
      readonly type: "creation_failed";
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({
      readonly type: "transport_lost";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({
      readonly type: "resume_succeeded";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({
      readonly type: "load_began";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
      readonly barrierRequestId: BarrierRequestId;
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({
      readonly type: "restore_failed";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({
      readonly type: "load_committed";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
      readonly barrierRequestId: BarrierRequestId;
      readonly attemptId: SessionAttemptId;
      readonly verdict: string;
    } & Keyed)
  | ({
      readonly type: "load_failed";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
      readonly barrierRequestId: BarrierRequestId;
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({ readonly type: "authorize_replacement" } & Keyed)
  | ({
      readonly type: "replacement_creation_begins";
      readonly attemptId: SessionAttemptId;
    } & Keyed)
  | ({ readonly type: "withdraw_replacement" } & Keyed);

export type SessionBindingResult =
  | {
      readonly ok: true;
      readonly binding: SessionBindingRecord;
      readonly changed: boolean;
      readonly idempotent: boolean;
    }
  | {
      readonly ok: false;
      readonly binding: SessionBindingRecord;
      readonly reason: string;
      readonly idempotent: boolean;
      readonly audit: true;
    };

export type RestorePath = "resume" | "load" | "broken";

export class SessionBindingValidationError extends TypeError {
  readonly code: "invalid_session_binding" | "invalid_session_binding_event";

  constructor(code: SessionBindingValidationError["code"]) {
    super(code);
    this.name = "SessionBindingValidationError";
    this.code = code;
  }
}

export function createUnboundBinding(taskId: TaskId): SessionBindingRecord {
  const parsedTaskId = parseTaskId(taskId);
  if (!parsedTaskId.ok) {
    throw new SessionBindingValidationError("invalid_session_binding");
  }
  return freezeBinding({
    taskId: parsedTaskId.value,
    state: "unbound",
    sessionId: undefined,
    adapterEpoch: undefined,
    replayBarrier: undefined,
    retainedSessionId: undefined,
    replacementAuthorized: false,
    usedBarrierRequestIds: [],
    usedSessionAttemptIds: [],
    createAttemptId: undefined,
    restoreAttemptId: undefined,
    applied: [],
  });
}

/** Canonical persisted boundary used by admission and persistence adapters. */
export function canonicalizeSessionBindingRecord(
  input: unknown,
): SessionBindingRecord {
  return canonicalizeBindingOrThrow(input);
}

/** Probe advertised capability; prefer resume, else proven load, else broken. */
export function selectRestorePath(capabilities: {
  readonly resumeAdvertised: boolean;
  readonly loadAdvertised: boolean;
}): RestorePath {
  if (capabilities.resumeAdvertised) {
    return "resume";
  }
  if (capabilities.loadAdvertised) {
    return "load";
  }
  return "broken";
}

export function applySessionBindingEvent(
  binding: SessionBindingRecord,
  event: SessionBindingEvent,
): SessionBindingResult {
  const safeBinding = canonicalizeBindingOrThrow(binding);
  const parsedEvent = canonicalizeEvent(event);
  if (!parsedEvent.ok) {
    return freezeResult({
      ok: false,
      binding: safeBinding,
      reason: "invalid_session_binding_event",
      idempotent: false,
      audit: true,
    });
  }
  const safeEvent = parsedEvent.event;
  const fingerprint = fingerprintCanonicalEvent(safeEvent);
  const lookup = lookupFingerprintedKey(
    safeBinding.applied,
    safeEvent.idempotencyKey,
    fingerprint,
  );
  if (lookup.kind === "collision") {
    return freezeResult({
      ok: false,
      binding: safeBinding,
      reason: "idempotency_collision",
      idempotent: false,
      audit: true,
    });
  }
  if (lookup.kind === "duplicate") {
    return freezeResult(replayApplied(safeBinding, lookup.entry));
  }
  return freezeResult(applyFresh(safeBinding, safeEvent, fingerprint));
}

export function sessionBindingEventFingerprint(
  event: SessionBindingEvent,
): string {
  const parsed = canonicalizeEvent(event);
  if (!parsed.ok) {
    throw new SessionBindingValidationError("invalid_session_binding_event");
  }
  return fingerprintCanonicalEvent(parsed.event);
}

function fingerprintCanonicalEvent(
  event: SessionBindingEvent,
): string {
  switch (event.type) {
    case "start_session":
    case "creation_failed":
    case "replacement_creation_begins":
      return canonicalFingerprint([event.type, event.attemptId]);
    case "session_new_succeeded":
    case "resume_succeeded":
    case "transport_lost":
    case "restore_failed":
      return canonicalFingerprint([
        event.type,
        event.sessionId,
        event.adapterEpoch,
        event.attemptId,
      ]);
    case "load_began":
    case "load_failed":
      return canonicalFingerprint([
        event.type,
        event.sessionId,
        event.adapterEpoch,
        event.barrierRequestId,
        event.attemptId,
      ]);
    case "load_committed":
      return canonicalFingerprint([
        event.type,
        event.sessionId,
        event.adapterEpoch,
        event.barrierRequestId,
        event.verdict,
        event.attemptId,
      ]);
    default:
      return canonicalFingerprint([event.type]);
  }
}

function applyFresh(
  binding: SessionBindingRecord,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult {
  switch (event.type) {
    case "start_session":
      if (binding.state !== "unbound") {
        return reject(binding, "illegal_transition", event, fingerprint);
      }
      return allocateCreateAttempt(
        binding,
        event.attemptId,
        {
          ...binding,
          state: "creating",
          sessionId: undefined,
          replayBarrier: undefined,
          createAttemptId: event.attemptId,
          restoreAttemptId: undefined,
        },
        event,
        fingerprint,
      );
    case "session_new_succeeded":
      return succeedCreate(binding, event, fingerprint);
    case "creation_failed":
      return failCreate(binding, event, fingerprint);
    case "transport_lost":
      return loseTransport(binding, event, fingerprint);
    case "resume_succeeded":
      return succeedResume(binding, event, fingerprint);
    case "load_began":
      return beginLoad(binding, event, fingerprint);
    case "restore_failed":
      return failRestore(binding, event, fingerprint);
    case "load_committed":
      return commitLoad(binding, event, fingerprint);
    case "load_failed":
      return failLoad(binding, event, fingerprint);
    case "authorize_replacement":
      return from(binding, "broken", fingerprint, event.idempotencyKey, {
        ...binding,
        state: "replacement_pending",
        replacementAuthorized: true,
      });
    case "replacement_creation_begins":
      if (binding.state !== "replacement_pending") {
        return reject(binding, "illegal_transition", event, fingerprint);
      }
      if (!binding.replacementAuthorized) {
        return reject(binding, "silent_replacement", event, fingerprint);
      }
      return allocateCreateAttempt(
        binding,
        event.attemptId,
        {
          ...binding,
          state: "creating",
          sessionId: undefined,
          replayBarrier: undefined,
          createAttemptId: event.attemptId,
          restoreAttemptId: undefined,
        },
        event,
        fingerprint,
      );
    case "withdraw_replacement":
      return from(
        binding,
        "replacement_pending",
        fingerprint,
        event.idempotencyKey,
        {
          ...binding,
          state: "broken",
          replacementAuthorized: false,
        },
      );
    default: {
      const _never: never = event;
      return reject(binding, "illegal_transition", event, fingerprint);
    }
  }
}

function succeedCreate(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "session_new_succeeded" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "creating") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const attemptReject = matchCreateAttempt(binding, event.attemptId, event, fingerprint);
  if (attemptReject !== undefined) {
    return attemptReject;
  }
  if (!epochAdvances(binding.adapterEpoch, event.adapterEpoch)) {
    return reject(binding, "epoch_not_advanced", event, fingerprint);
  }
  return accept(
    binding,
    {
      ...binding,
      state: "healthy",
      sessionId: event.sessionId,
      adapterEpoch: event.adapterEpoch,
      retainedSessionId: event.sessionId,
      replayBarrier: undefined,
      replacementAuthorized: false,
      createAttemptId: undefined,
      restoreAttemptId: undefined,
    },
    event,
    fingerprint,
    true,
  );
}

function failCreate(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "creation_failed" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "creating") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const attemptReject = matchCreateAttempt(binding, event.attemptId, event, fingerprint);
  if (attemptReject !== undefined) {
    return attemptReject;
  }
  return accept(
    binding,
    {
      ...binding,
      state: "broken",
      sessionId: binding.retainedSessionId,
      replayBarrier: undefined,
      createAttemptId: undefined,
      restoreAttemptId: undefined,
    },
    event,
    fingerprint,
    true,
  );
}

function loseTransport(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "transport_lost" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "healthy") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const provenance = matchCurrentSessionEpoch(
    binding,
    event.sessionId,
    event.adapterEpoch,
    event,
    fingerprint,
  );
  if (provenance !== undefined) {
    return provenance;
  }
  const reused = rejectIfAttemptUsed(binding, event.attemptId, event, fingerprint);
  if (reused !== undefined) {
    return reused;
  }
  return accept(
    binding,
    {
      ...binding,
      state: "restore_pending",
      replayBarrier: undefined,
      restoreAttemptId: event.attemptId,
      createAttemptId: undefined,
      usedSessionAttemptIds: rememberAttempt(binding, event.attemptId),
    },
    event,
    fingerprint,
    true,
  );
}

function succeedResume(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "resume_succeeded" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "restore_pending") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const attemptReject = matchRestoreAttempt(binding, event.attemptId, event, fingerprint);
  if (attemptReject !== undefined) {
    return attemptReject;
  }
  if (!sameRetainedSession(binding, event.sessionId)) {
    return reject(binding, "identity_mismatch", event, fingerprint);
  }
  if (!epochAdvances(binding.adapterEpoch, event.adapterEpoch)) {
    return reject(binding, "epoch_not_advanced", event, fingerprint);
  }
  return accept(
    binding,
    {
      ...binding,
      state: "healthy",
      adapterEpoch: event.adapterEpoch,
      replayBarrier: undefined,
      restoreAttemptId: undefined,
      createAttemptId: undefined,
    },
    event,
    fingerprint,
    true,
  );
}

function failRestore(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "restore_failed" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "restore_pending") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const attemptReject = matchRestoreAttempt(binding, event.attemptId, event, fingerprint);
  if (attemptReject !== undefined) {
    return attemptReject;
  }
  const provenance = matchCurrentSessionEpoch(
    binding,
    event.sessionId,
    event.adapterEpoch,
    event,
    fingerprint,
  );
  if (provenance !== undefined) {
    return provenance;
  }
  return accept(
    binding,
    {
      ...binding,
      state: "broken",
      replayBarrier: undefined,
      restoreAttemptId: undefined,
      createAttemptId: undefined,
    },
    event,
    fingerprint,
    true,
  );
}

function beginLoad(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "load_began" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "restore_pending") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const attemptReject = matchRestoreAttempt(
    binding,
    event.attemptId,
    event,
    fingerprint,
  );
  if (attemptReject !== undefined) {
    return attemptReject;
  }
  if (!sameRetainedSession(binding, event.sessionId)) {
    return reject(binding, "identity_mismatch", event, fingerprint);
  }
  if (!epochAdvances(binding.adapterEpoch, event.adapterEpoch)) {
    return reject(binding, "epoch_not_advanced", event, fingerprint);
  }
  if (binding.usedBarrierRequestIds.includes(event.barrierRequestId)) {
    return reject(binding, "barrier_reused", event, fingerprint);
  }
  return accept(
    binding,
    {
      ...binding,
      state: "replay_reconciling",
      adapterEpoch: event.adapterEpoch,
      replayBarrier: {
        requestId: event.barrierRequestId,
        sessionId: event.sessionId,
        adapterEpoch: event.adapterEpoch,
        attemptId: event.attemptId,
      },
      usedBarrierRequestIds: [
        ...binding.usedBarrierRequestIds,
        event.barrierRequestId,
      ],
      restoreAttemptId: event.attemptId,
      createAttemptId: undefined,
    },
    event,
    fingerprint,
    true,
  );
}

function commitLoad(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "load_committed" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "replay_reconciling") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const barrierReject = matchCurrentBarrier(
    binding,
    event.sessionId,
    event.adapterEpoch,
    event.barrierRequestId,
    event.attemptId,
    event,
    fingerprint,
  );
  if (barrierReject !== undefined) {
    return barrierReject;
  }
  if (event.verdict !== CONFLICT_FREE_VERDICT) {
    return reject(binding, "invalid_verdict", event, fingerprint);
  }
  return accept(
    binding,
    {
      ...binding,
      state: "healthy",
      replayBarrier: undefined,
      restoreAttemptId: undefined,
      createAttemptId: undefined,
    },
    event,
    fingerprint,
    true,
  );
}

function failLoad(
  binding: SessionBindingRecord,
  event: Extract<SessionBindingEvent, { type: "load_failed" }>,
  fingerprint: string,
): SessionBindingResult {
  if (binding.state !== "replay_reconciling") {
    return reject(binding, "illegal_transition", event, fingerprint);
  }
  const barrierReject = matchCurrentBarrier(
    binding,
    event.sessionId,
    event.adapterEpoch,
    event.barrierRequestId,
    event.attemptId,
    event,
    fingerprint,
  );
  if (barrierReject !== undefined) {
    return barrierReject;
  }
  return accept(
    binding,
    {
      ...binding,
      state: "broken",
      replayBarrier: undefined,
      restoreAttemptId: undefined,
      createAttemptId: undefined,
    },
    event,
    fingerprint,
    true,
  );
}

function allocateCreateAttempt(
  binding: SessionBindingRecord,
  attemptId: SessionAttemptId,
  next: SessionBindingRecord,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult {
  const reused = rejectIfAttemptUsed(binding, attemptId, event, fingerprint);
  if (reused !== undefined) {
    return reused;
  }
  return accept(
    binding,
    {
      ...next,
      usedSessionAttemptIds: rememberAttempt(binding, attemptId),
    },
    event,
    fingerprint,
    true,
  );
}

function rejectIfAttemptUsed(
  binding: SessionBindingRecord,
  attemptId: SessionAttemptId,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult | undefined {
  if (binding.usedSessionAttemptIds.includes(attemptId)) {
    return reject(binding, "attempt_reused", event, fingerprint);
  }
  return undefined;
}

function rememberAttempt(
  binding: SessionBindingRecord,
  attemptId: SessionAttemptId,
): readonly SessionAttemptId[] {
  return [...binding.usedSessionAttemptIds, attemptId];
}

function matchCreateAttempt(
  binding: SessionBindingRecord,
  attemptId: SessionAttemptId,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult | undefined {
  if (
    binding.createAttemptId === undefined ||
    attemptId !== binding.createAttemptId
  ) {
    return reject(binding, "attempt_mismatch", event, fingerprint);
  }
  return undefined;
}

function matchRestoreAttempt(
  binding: SessionBindingRecord,
  attemptId: SessionAttemptId,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult | undefined {
  if (
    binding.restoreAttemptId === undefined ||
    attemptId !== binding.restoreAttemptId
  ) {
    return reject(binding, "attempt_mismatch", event, fingerprint);
  }
  return undefined;
}

function matchCurrentSessionEpoch(
  binding: SessionBindingRecord,
  sessionId: SessionId,
  adapterEpoch: AdapterEpoch,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult | undefined {
  if (
    binding.sessionId === undefined ||
    binding.retainedSessionId === undefined ||
    sessionId !== binding.sessionId ||
    sessionId !== binding.retainedSessionId
  ) {
    return reject(binding, "wrong_session", event, fingerprint);
  }
  if (
    binding.adapterEpoch === undefined ||
    adapterEpoch !== binding.adapterEpoch
  ) {
    return reject(binding, "epoch_mismatch", event, fingerprint);
  }
  return undefined;
}

function matchCurrentBarrier(
  binding: SessionBindingRecord,
  sessionId: SessionId,
  adapterEpoch: AdapterEpoch,
  barrierRequestId: BarrierRequestId,
  attemptId: SessionAttemptId,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult | undefined {
  const barrier = binding.replayBarrier;
  if (barrier === undefined) {
    return reject(binding, "missing_barrier", event, fingerprint);
  }
  if (barrierRequestId !== barrier.requestId) {
    return reject(binding, "barrier_mismatch", event, fingerprint);
  }
  if (
    sessionId !== barrier.sessionId ||
    binding.sessionId === undefined ||
    binding.retainedSessionId === undefined ||
    sessionId !== binding.sessionId ||
    sessionId !== binding.retainedSessionId
  ) {
    return reject(binding, "wrong_session", event, fingerprint);
  }
  if (
    adapterEpoch !== barrier.adapterEpoch ||
    binding.adapterEpoch === undefined ||
    adapterEpoch !== binding.adapterEpoch
  ) {
    return reject(binding, "epoch_mismatch", event, fingerprint);
  }
  if (
    binding.restoreAttemptId === undefined ||
    attemptId !== binding.restoreAttemptId ||
    attemptId !== barrier.attemptId
  ) {
    return reject(binding, "attempt_mismatch", event, fingerprint);
  }
  return undefined;
}

function sameRetainedSession(
  binding: SessionBindingRecord,
  sessionId: SessionId,
): boolean {
  return (
    binding.sessionId !== undefined &&
    binding.retainedSessionId !== undefined &&
    binding.sessionId === binding.retainedSessionId &&
    sessionId === binding.sessionId
  );
}

function epochAdvances(
  previous: AdapterEpoch | undefined,
  next: AdapterEpoch,
): boolean {
  return previous === undefined || next > previous;
}

function from(
  binding: SessionBindingRecord,
  expected: SessionBindingState,
  fingerprint: string,
  key: IdempotencyKey,
  next: SessionBindingRecord,
): SessionBindingResult {
  if (binding.state !== expected) {
    return {
      ok: false,
      binding: remember(binding, key, fingerprint, {
        key,
        fingerprint,
        ok: false,
        state: binding.state,
        reason: "illegal_transition",
      }),
      reason: "illegal_transition",
      idempotent: false,
      audit: true,
    };
  }
  return {
    ok: true,
    binding: remember(next, key, fingerprint, {
      key,
      fingerprint,
      ok: true,
      state: next.state,
      reason: undefined,
    }),
    changed: true,
    idempotent: false,
  };
}

function replayApplied(
  binding: SessionBindingRecord,
  prior: AppliedBindingKey,
): SessionBindingResult {
  if (prior.ok) {
    return {
      ok: true,
      binding,
      changed: false,
      idempotent: true,
    };
  }
  return {
    ok: false,
    binding,
    reason: prior.reason ?? "illegal_transition",
    idempotent: true,
    audit: true,
  };
}

function accept(
  _previous: SessionBindingRecord,
  next: SessionBindingRecord,
  event: SessionBindingEvent,
  fingerprint: string,
  changed: boolean,
): SessionBindingResult {
  return {
    ok: true,
    binding: remember(next, event.idempotencyKey, fingerprint, {
      key: event.idempotencyKey,
      fingerprint,
      ok: true,
      state: next.state,
      reason: undefined,
    }),
    changed,
    idempotent: false,
  };
}

function reject(
  binding: SessionBindingRecord,
  reason: string,
  event: SessionBindingEvent,
  fingerprint: string,
): SessionBindingResult {
  return {
    ok: false,
    binding: remember(binding, event.idempotencyKey, fingerprint, {
      key: event.idempotencyKey,
      fingerprint,
      ok: false,
      state: binding.state,
      reason,
    }),
    reason,
    idempotent: false,
    audit: true,
  };
}

function remember(
  binding: SessionBindingRecord,
  key: IdempotencyKey,
  fingerprint: string,
  entry: AppliedBindingKey,
): SessionBindingRecord {
  return {
    ...binding,
    applied: [...binding.applied, { ...entry, key, fingerprint }],
  };
}

type CanonicalBindingResult =
  | { readonly ok: true; readonly binding: SessionBindingRecord }
  | { readonly ok: false };

type CanonicalEventResult =
  | { readonly ok: true; readonly event: SessionBindingEvent }
  | { readonly ok: false };

const BINDING_KEYS = Object.freeze([
  "taskId",
  "state",
  "sessionId",
  "adapterEpoch",
  "replayBarrier",
  "retainedSessionId",
  "replacementAuthorized",
  "usedBarrierRequestIds",
  "usedSessionAttemptIds",
  "createAttemptId",
  "restoreAttemptId",
  "applied",
] as const);

const EVENT_KEYS = Object.freeze([
  "type",
  "idempotencyKey",
  "attemptId",
  "sessionId",
  "adapterEpoch",
  "barrierRequestId",
  "verdict",
] as const);

function canonicalizeBindingOrThrow(input: unknown): SessionBindingRecord {
  const parsed = canonicalizeBinding(input);
  if (!parsed.ok) {
    throw new SessionBindingValidationError("invalid_session_binding");
  }
  return parsed.binding;
}

function canonicalizeBinding(input: unknown): CanonicalBindingResult {
  try {
    const rec = exactObject(input, BINDING_KEYS, [
      "taskId",
      "state",
      "replacementAuthorized",
      "usedBarrierRequestIds",
      "usedSessionAttemptIds",
      "applied",
    ]);
    if (rec === undefined) {
      return { ok: false };
    }
    const taskId = parseTaskId(rec["taskId"]);
    const state = rec["state"];
    if (
      !taskId.ok ||
      typeof state !== "string" ||
      !(SESSION_BINDING_STATES as readonly string[]).includes(state) ||
      typeof rec["replacementAuthorized"] !== "boolean"
    ) {
      return { ok: false };
    }
    const sessionId = optionalParsed(rec["sessionId"], parseSessionId);
    const retainedSessionId = optionalParsed(
      rec["retainedSessionId"],
      parseSessionId,
    );
    const adapterEpoch = optionalParsed(
      rec["adapterEpoch"],
      parseAdapterEpoch,
    );
    const createAttemptId = optionalParsed(
      rec["createAttemptId"],
      parseSessionAttemptId,
    );
    const restoreAttemptId = optionalParsed(
      rec["restoreAttemptId"],
      parseSessionAttemptId,
    );
    if (
      !sessionId.ok ||
      !retainedSessionId.ok ||
      !adapterEpoch.ok ||
      !createAttemptId.ok ||
      !restoreAttemptId.ok
    ) {
      return { ok: false };
    }
    const usedBarriers = canonicalIdArray(
      rec["usedBarrierRequestIds"],
      parseBarrierRequestId,
    );
    const usedAttempts = canonicalIdArray(
      rec["usedSessionAttemptIds"],
      parseSessionAttemptId,
    );
    const applied = canonicalAppliedLedger(rec["applied"]);
    const replayBarrier = canonicalReplayBarrier(rec["replayBarrier"]);
    if (
      !usedBarriers.ok ||
      !usedAttempts.ok ||
      !applied.ok ||
      !replayBarrier.ok
    ) {
      return { ok: false };
    }
    const binding: SessionBindingRecord = deepFreezeCopy({
      taskId: taskId.value,
      state: state as SessionBindingState,
      sessionId: sessionId.value,
      adapterEpoch: adapterEpoch.value,
      replayBarrier: replayBarrier.value,
      retainedSessionId: retainedSessionId.value,
      replacementAuthorized: rec["replacementAuthorized"],
      usedBarrierRequestIds: usedBarriers.value,
      usedSessionAttemptIds: usedAttempts.value,
      createAttemptId: createAttemptId.value,
      restoreAttemptId: restoreAttemptId.value,
      applied: applied.value,
    });
    return bindingIsReachable(binding)
      ? Object.freeze({ ok: true, binding })
      : Object.freeze({ ok: false });
  } catch (_cause: unknown) {
    return Object.freeze({ ok: false });
  }
}

function canonicalizeEvent(input: unknown): CanonicalEventResult {
  try {
    const base = exactObject(input, EVENT_KEYS, ["type", "idempotencyKey"]);
    if (base === undefined || typeof base["type"] !== "string") {
      return { ok: false };
    }
    const idempotencyKey = parseIdempotencyKey(base["idempotencyKey"]);
    if (!idempotencyKey.ok) {
      return { ok: false };
    }
    const type = base["type"];
    if (type === "authorize_replacement" || type === "withdraw_replacement") {
      if (!hasOnlyKeys(base, ["type", "idempotencyKey"])) {
        return { ok: false };
      }
      const event: SessionBindingEvent = deepFreezeCopy({
        type: type as "authorize_replacement" | "withdraw_replacement",
        idempotencyKey: idempotencyKey.value,
      });
      return Object.freeze({ ok: true, event });
    }
    if (
      type === "start_session" ||
      type === "creation_failed" ||
      type === "replacement_creation_begins"
    ) {
      if (!hasOnlyKeys(base, ["type", "idempotencyKey", "attemptId"])) {
        return { ok: false };
      }
      const attemptId = parseSessionAttemptId(base["attemptId"]);
      if (!attemptId.ok) {
        return { ok: false };
      }
      const event: SessionBindingEvent = deepFreezeCopy({
        type: type as
          | "start_session"
          | "creation_failed"
          | "replacement_creation_begins",
        attemptId: attemptId.value,
        idempotencyKey: idempotencyKey.value,
      });
      return Object.freeze({ ok: true, event });
    }
    const sessionId = parseSessionId(base["sessionId"]);
    const adapterEpoch = parseAdapterEpoch(base["adapterEpoch"]);
    const attemptId = parseSessionAttemptId(base["attemptId"]);
    if (!sessionId.ok || !adapterEpoch.ok || !attemptId.ok) {
      return { ok: false };
    }
    if (
      type === "session_new_succeeded" ||
      type === "resume_succeeded" ||
      type === "transport_lost" ||
      type === "restore_failed"
    ) {
      if (
        !hasOnlyKeys(base, [
          "type",
          "idempotencyKey",
          "sessionId",
          "adapterEpoch",
          "attemptId",
        ])
      ) {
        return { ok: false };
      }
      const event: SessionBindingEvent = deepFreezeCopy({
        type: type as
          | "session_new_succeeded"
          | "resume_succeeded"
          | "transport_lost"
          | "restore_failed",
        sessionId: sessionId.value,
        adapterEpoch: adapterEpoch.value,
        attemptId: attemptId.value,
        idempotencyKey: idempotencyKey.value,
      });
      return Object.freeze({ ok: true, event });
    }
    if (
      type === "load_began" ||
      type === "load_failed" ||
      type === "load_committed"
    ) {
      const allowed = [
        "type",
        "idempotencyKey",
        "sessionId",
        "adapterEpoch",
        "barrierRequestId",
        "attemptId",
        ...(type === "load_committed" ? ["verdict"] : []),
      ];
      if (!hasOnlyKeys(base, allowed)) {
        return { ok: false };
      }
      const barrierRequestId = parseBarrierRequestId(base["barrierRequestId"]);
      if (
        !barrierRequestId.ok ||
        (type === "load_committed" && typeof base["verdict"] !== "string")
      ) {
        return { ok: false };
      }
      if (type === "load_committed") {
        const event: SessionBindingEvent = deepFreezeCopy({
          type: "load_committed",
          sessionId: sessionId.value,
          adapterEpoch: adapterEpoch.value,
          barrierRequestId: barrierRequestId.value,
          attemptId: attemptId.value,
          verdict: base["verdict"] as string,
          idempotencyKey: idempotencyKey.value,
        });
        return Object.freeze({ ok: true, event });
      }
      const event: SessionBindingEvent = deepFreezeCopy({
        type: type as "load_began" | "load_failed",
        sessionId: sessionId.value,
        adapterEpoch: adapterEpoch.value,
        barrierRequestId: barrierRequestId.value,
        attemptId: attemptId.value,
        idempotencyKey: idempotencyKey.value,
      });
      return Object.freeze({ ok: true, event });
    }
    return Object.freeze({ ok: false });
  } catch (_cause: unknown) {
    return Object.freeze({ ok: false });
  }
}

function bindingIsReachable(binding: SessionBindingRecord): boolean {
  const {
    state,
    sessionId,
    adapterEpoch,
    replayBarrier,
    retainedSessionId,
    replacementAuthorized,
    createAttemptId,
    restoreAttemptId,
  } = binding;
  if (!bindingLedgerReachesSnapshot(binding)) {
    return false;
  }
  if (
    binding.applied.length > 0 &&
    binding.applied[binding.applied.length - 1]?.state !== state
  ) {
    return false;
  }
  if (
    (state === "unbound" &&
      (binding.usedBarrierRequestIds.length !== 0 ||
        binding.usedSessionAttemptIds.length !== 0)) ||
    (state !== "unbound" && binding.applied.length === 0)
  ) {
    return false;
  }
  if (
    (createAttemptId !== undefined &&
      !binding.usedSessionAttemptIds.includes(createAttemptId)) ||
    (restoreAttemptId !== undefined &&
      !binding.usedSessionAttemptIds.includes(restoreAttemptId))
  ) {
    return false;
  }
  if (
    state !== "replay_reconciling" &&
    replayBarrier !== undefined
  ) {
    return false;
  }
  if (
    state === "replay_reconciling" &&
    (replayBarrier === undefined ||
      replayBarrier.sessionId !== sessionId ||
      replayBarrier.sessionId !== retainedSessionId ||
      replayBarrier.adapterEpoch !== adapterEpoch ||
      replayBarrier.attemptId !== restoreAttemptId ||
      !binding.usedBarrierRequestIds.includes(replayBarrier.requestId))
  ) {
    return false;
  }
  if (
    state !== "creating" &&
    (sessionId !== retainedSessionId ||
      (sessionId === undefined) !== (adapterEpoch === undefined))
  ) {
    return false;
  }

  switch (state) {
    case "unbound":
      return (
        sessionId === undefined &&
        adapterEpoch === undefined &&
        retainedSessionId === undefined &&
        replayBarrier === undefined &&
        !replacementAuthorized &&
        createAttemptId === undefined &&
        restoreAttemptId === undefined
      );
    case "creating":
      return (
        sessionId === undefined &&
        (retainedSessionId === undefined) === (adapterEpoch === undefined) &&
        replayBarrier === undefined &&
        createAttemptId !== undefined &&
        restoreAttemptId === undefined
      );
    case "healthy":
      return (
        sessionId !== undefined &&
        adapterEpoch !== undefined &&
        replayBarrier === undefined &&
        !replacementAuthorized &&
        createAttemptId === undefined &&
        restoreAttemptId === undefined
      );
    case "restore_pending":
      return (
        sessionId !== undefined &&
        adapterEpoch !== undefined &&
        replayBarrier === undefined &&
        !replacementAuthorized &&
        createAttemptId === undefined &&
        restoreAttemptId !== undefined
      );
    case "replay_reconciling":
      return (
        sessionId !== undefined &&
        adapterEpoch !== undefined &&
        replayBarrier !== undefined &&
        !replacementAuthorized &&
        createAttemptId === undefined &&
        restoreAttemptId !== undefined
      );
    case "broken":
      return (
        replayBarrier === undefined &&
        createAttemptId === undefined &&
        restoreAttemptId === undefined
      );
    case "replacement_pending":
      return (
        replayBarrier === undefined &&
        replacementAuthorized &&
        createAttemptId === undefined &&
        restoreAttemptId === undefined
      );
  }
}

type BindingFingerprintPart = string | number | boolean | undefined;

function decodeBindingFingerprint(
  input: string,
): readonly BindingFingerprintPart[] | undefined {
  const parts: BindingFingerprintPart[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const marker = input[cursor];
    if (marker === "s" && input[cursor + 1] === ":") {
      const lengthStart = cursor + 2;
      const lengthEnd = input.indexOf(":", lengthStart);
      if (lengthEnd === -1) return undefined;
      const rawLength = input.slice(lengthStart, lengthEnd);
      if (!/^(0|[1-9][0-9]*)$/.test(rawLength)) return undefined;
      const valueLength = Number(rawLength);
      if (!Number.isSafeInteger(valueLength)) return undefined;
      const valueStart = lengthEnd + 1;
      const valueEnd = valueStart + valueLength;
      if (valueEnd > input.length) return undefined;
      parts.push(input.slice(valueStart, valueEnd));
      cursor = valueEnd;
    } else if (marker === "n" && input[cursor + 1] === ":") {
      const valueStart = cursor + 2;
      const valueEnd = input.indexOf("|", valueStart);
      const rawValue = input.slice(
        valueStart,
        valueEnd === -1 ? input.length : valueEnd,
      );
      const value = Number(rawValue);
      if (
        rawValue.length === 0 ||
        !Number.isSafeInteger(value) ||
        String(value) !== rawValue
      ) {
        return undefined;
      }
      parts.push(value);
      cursor = valueEnd === -1 ? input.length : valueEnd;
    } else if (marker === "t" || marker === "f" || marker === "u") {
      parts.push(marker === "t" ? true : marker === "f" ? false : undefined);
      cursor += 1;
    } else {
      return undefined;
    }
    if (cursor < input.length) {
      if (input[cursor] !== "|") return undefined;
      cursor += 1;
      if (cursor === input.length) return undefined;
    }
  }
  return parts;
}

function decodeBindingLedgerEvent(
  entry: AppliedBindingKey,
): SessionBindingEvent | undefined {
  const parts = decodeBindingFingerprint(entry.fingerprint);
  if (parts === undefined || typeof parts[0] !== "string") return undefined;
  const type = parts[0];
  let event: SessionBindingEvent | undefined;
  if (type === "authorize_replacement" || type === "withdraw_replacement") {
    if (parts.length === 1) {
      event = { type, idempotencyKey: entry.key };
    }
  } else if (
    type === "start_session" ||
    type === "creation_failed" ||
    type === "replacement_creation_begins"
  ) {
    const attemptId = parseSessionAttemptId(parts[1]);
    if (parts.length === 2 && attemptId.ok) {
      event = { type, attemptId: attemptId.value, idempotencyKey: entry.key };
    }
  } else if (
    type === "session_new_succeeded" ||
    type === "resume_succeeded" ||
    type === "transport_lost" ||
    type === "restore_failed"
  ) {
    const sessionId = parseSessionId(parts[1]);
    const adapterEpoch = parseAdapterEpoch(parts[2]);
    const attemptId = parseSessionAttemptId(parts[3]);
    if (
      parts.length === 4 &&
      sessionId.ok &&
      adapterEpoch.ok &&
      attemptId.ok
    ) {
      event = {
        type,
        sessionId: sessionId.value,
        adapterEpoch: adapterEpoch.value,
        attemptId: attemptId.value,
        idempotencyKey: entry.key,
      };
    }
  } else if (type === "load_began" || type === "load_failed") {
    const sessionId = parseSessionId(parts[1]);
    const adapterEpoch = parseAdapterEpoch(parts[2]);
    const barrierRequestId = parseBarrierRequestId(parts[3]);
    const attemptId = parseSessionAttemptId(parts[4]);
    if (
      parts.length === 5 &&
      sessionId.ok &&
      adapterEpoch.ok &&
      barrierRequestId.ok &&
      attemptId.ok
    ) {
      event = {
        type,
        sessionId: sessionId.value,
        adapterEpoch: adapterEpoch.value,
        barrierRequestId: barrierRequestId.value,
        attemptId: attemptId.value,
        idempotencyKey: entry.key,
      };
    }
  } else if (type === "load_committed") {
    const sessionId = parseSessionId(parts[1]);
    const adapterEpoch = parseAdapterEpoch(parts[2]);
    const barrierRequestId = parseBarrierRequestId(parts[3]);
    const verdict = parts[4];
    const attemptId = parseSessionAttemptId(parts[5]);
    if (
      parts.length === 6 &&
      sessionId.ok &&
      adapterEpoch.ok &&
      barrierRequestId.ok &&
      typeof verdict === "string" &&
      attemptId.ok
    ) {
      event = {
        type,
        sessionId: sessionId.value,
        adapterEpoch: adapterEpoch.value,
        barrierRequestId: barrierRequestId.value,
        verdict,
        attemptId: attemptId.value,
        idempotencyKey: entry.key,
      };
    }
  }
  return event !== undefined &&
    fingerprintCanonicalEvent(event) === entry.fingerprint
    ? deepFreezeCopy(event)
    : undefined;
}

function bindingLedgerReachesSnapshot(binding: SessionBindingRecord): boolean {
  let replayed: SessionBindingRecord = {
    taskId: binding.taskId,
    state: "unbound",
    sessionId: undefined,
    adapterEpoch: undefined,
    replayBarrier: undefined,
    retainedSessionId: undefined,
    replacementAuthorized: false,
    usedBarrierRequestIds: [],
    usedSessionAttemptIds: [],
    createAttemptId: undefined,
    restoreAttemptId: undefined,
    applied: [],
  };
  for (const entry of binding.applied) {
    const event = decodeBindingLedgerEvent(entry);
    if (event === undefined) return false;
    const result = applyFresh(replayed, event, entry.fingerprint);
    if (
      result.ok !== entry.ok ||
      result.binding.state !== entry.state ||
      (result.ok
        ? entry.reason !== undefined
        : result.reason !== entry.reason)
    ) {
      return false;
    }
    replayed = result.binding;
  }
  return bindingSnapshotsEqual(replayed, binding);
}

function bindingSnapshotsEqual(
  left: SessionBindingRecord,
  right: SessionBindingRecord,
): boolean {
  return left.taskId === right.taskId &&
    left.state === right.state &&
    left.sessionId === right.sessionId &&
    left.adapterEpoch === right.adapterEpoch &&
    replayBarriersEqual(left.replayBarrier, right.replayBarrier) &&
    left.retainedSessionId === right.retainedSessionId &&
    left.replacementAuthorized === right.replacementAuthorized &&
    sameOrderedValues(left.usedBarrierRequestIds, right.usedBarrierRequestIds) &&
    sameOrderedValues(left.usedSessionAttemptIds, right.usedSessionAttemptIds) &&
    left.createAttemptId === right.createAttemptId &&
    left.restoreAttemptId === right.restoreAttemptId &&
    sameAppliedLedger(left.applied, right.applied);
}

function replayBarriersEqual(
  left: ReplayBarrier | undefined,
  right: ReplayBarrier | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.adapterEpoch === right.adapterEpoch &&
    left.attemptId === right.attemptId;
}

function sameOrderedValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameAppliedLedger(
  left: readonly AppliedBindingKey[],
  right: readonly AppliedBindingKey[],
): boolean {
  return left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return other !== undefined &&
        entry.key === other.key &&
        entry.fingerprint === other.fingerprint &&
        entry.ok === other.ok &&
        entry.state === other.state &&
        entry.reason === other.reason;
    });
}

function canonicalReplayBarrier(
  input: unknown,
): { readonly ok: true; readonly value: ReplayBarrier | undefined } | { readonly ok: false } {
  if (input === undefined) {
    return { ok: true, value: undefined };
  }
  const rec = exactObject(
    input,
    ["requestId", "sessionId", "adapterEpoch", "attemptId"],
    ["requestId", "sessionId", "adapterEpoch", "attemptId"],
  );
  if (rec === undefined) {
    return { ok: false };
  }
  const requestId = parseBarrierRequestId(rec["requestId"]);
  const sessionId = parseSessionId(rec["sessionId"]);
  const adapterEpoch = parseAdapterEpoch(rec["adapterEpoch"]);
  const attemptId = parseSessionAttemptId(rec["attemptId"]);
  if (!requestId.ok || !sessionId.ok || !adapterEpoch.ok || !attemptId.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    value: deepFreezeCopy({
      requestId: requestId.value,
      sessionId: sessionId.value,
      adapterEpoch: adapterEpoch.value,
      attemptId: attemptId.value,
    }),
  };
}

function canonicalAppliedLedger(
  input: unknown,
): { readonly ok: true; readonly value: readonly AppliedBindingKey[] } | { readonly ok: false } {
  const inputEntries = denseDataArray(input);
  if (inputEntries === undefined) {
    return { ok: false };
  }
  const entries: AppliedBindingKey[] = [];
  for (const inputEntry of inputEntries) {
    const rec = exactObject(
      inputEntry,
      ["key", "fingerprint", "ok", "state", "reason"],
      ["key", "fingerprint", "ok", "state"],
    );
    if (rec === undefined) {
      return { ok: false };
    }
    const key = parseIdempotencyKey(rec["key"]);
    const fingerprint = rec["fingerprint"];
    const okValue = rec["ok"];
    const state = rec["state"];
    const reason = rec["reason"];
    if (
      !key.ok ||
      typeof fingerprint !== "string" ||
      fingerprint.length === 0 ||
      typeof okValue !== "boolean" ||
      typeof state !== "string" ||
      !(SESSION_BINDING_STATES as readonly string[]).includes(state) ||
      (okValue ? reason !== undefined : typeof reason !== "string" || reason.length === 0) ||
      entries.some((entry) => entry.key === key.value)
    ) {
      return { ok: false };
    }
    entries.push({
      key: key.value,
      fingerprint,
      ok: okValue,
      state: state as SessionBindingState,
      reason: reason as string | undefined,
    });
  }
  return { ok: true, value: Object.freeze(entries.map(deepFreezeCopy)) };
}

function canonicalIdArray<T>(
  input: unknown,
  parse: (value: unknown) => { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string },
): { readonly ok: true; readonly value: readonly T[] } | { readonly ok: false } {
  const inputValues = denseDataArray(input);
  if (inputValues === undefined) {
    return { ok: false };
  }
  const values: T[] = [];
  for (const inputValue of inputValues) {
    const parsed = parse(inputValue);
    if (!parsed.ok || values.includes(parsed.value)) {
      return { ok: false };
    }
    values.push(parsed.value);
  }
  return { ok: true, value: Object.freeze(values) };
}

function optionalParsed<T>(
  input: unknown,
  parse: (value: unknown) => { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string },
): { readonly ok: true; readonly value: T | undefined } | { readonly ok: false } {
  return input === undefined ? { ok: true, value: undefined } : parse(input);
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
  const keys = Reflect.ownKeys(rec);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(rec, key)) ||
    keys.some((key) => {
      if (typeof key !== "string") {
        return true;
      }
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

function hasOnlyKeys(
  rec: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Reflect.ownKeys(rec).every(
    (key) => typeof key === "string" && allowed.includes(key),
  );
}

function freezeBinding(binding: SessionBindingRecord): SessionBindingRecord {
  return canonicalizeBindingOrThrow(binding);
}

function freezeResult(result: SessionBindingResult): SessionBindingResult {
  const binding = freezeBinding(result.binding);
  return result.ok
    ? deepFreezeCopy({ ...result, binding })
    : deepFreezeCopy({ ...result, binding });
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
