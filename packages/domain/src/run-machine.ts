/**
 * Authoritative Run state machine (PC-RUN-001, PC-RUN-002, PC-RUN-003).
 * Legal rows: docs/08-STATE-MACHINES.md section 1.
 */

import { isProxy } from "node:util/types";
import {
  isTerminalRunState,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parsePermissionIdentity,
  parseRunId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  permissionIdentitiesEqual,
  RUN_EFFECTS,
  RUN_STATES,
  type AdapterEpoch,
  type IdempotencyKey,
  type PermissionIdentity,
  type RunEffect,
  type RunEvent,
  type RunId,
  type RunState,
  type SessionId,
  type TaskId,
} from "@guild/contracts";
import {
  canonicalFingerprint,
  lookupFingerprintedKey,
} from "./idempotency.js";

export type RunRecord = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly state: RunState;
  readonly sessionId: SessionId | undefined;
  readonly adapterEpoch: AdapterEpoch | undefined;
  readonly cancelIntent: boolean;
  readonly promptAccepted: boolean;
  readonly unresolvedPermissionIdentities: readonly PermissionIdentity[];
  readonly applied: readonly AppliedRunKey[];
};

export type AppliedRunKey = {
  readonly key: IdempotencyKey;
  readonly fingerprint: string;
  readonly ok: boolean;
  readonly state: RunState;
  readonly reason: string | undefined;
  readonly recordedEffects: readonly RunEffect[];
};

export type RunApplyResult =
  | {
      readonly ok: true;
      readonly run: RunRecord;
      readonly changed: boolean;
      readonly effects: readonly RunEffect[];
      readonly idempotent: boolean;
    }
  | {
      readonly ok: false;
      readonly run: RunRecord;
      readonly reason: string;
      readonly idempotent: boolean;
      readonly audit: true;
    };

export type LegalRunTransition = {
  readonly from: RunState;
  readonly type: RunEvent["type"];
  readonly to: RunState;
  readonly effects: readonly RunEffect[];
};

type TransitionRow = LegalRunTransition & {
  readonly markPromptAccepted?: true;
  readonly markCancelIntent?: true;
};

function freezeTransitionRows(
  rows: readonly TransitionRow[],
): readonly TransitionRow[] {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        ...row,
        effects: Object.freeze([...row.effects]),
      }),
    ),
  );
}

const TRANSITIONS: readonly TransitionRow[] = freezeTransitionRows([
  {
    from: "queued",
    type: "scheduler_dispatch",
    to: "starting",
    effects: ["record_dispatch"],
  },
  {
    from: "queued",
    type: "user_cancel",
    to: "cancelled",
    effects: ["persist_cancel_intent", "record_local_not_dispatched_proof"],
    markCancelIntent: true,
  },
  {
    from: "starting",
    type: "prompt_accepted",
    to: "running",
    effects: ["persist_prompt_correlation"],
    markPromptAccepted: true,
  },
  {
    from: "starting",
    type: "user_cancel",
    to: "cancel_requested",
    effects: ["persist_cancel_intent"],
    markCancelIntent: true,
  },
  {
    from: "starting",
    type: "launch_failure",
    to: "failed",
    effects: ["persist_diagnostic"],
  },
  {
    from: "starting",
    type: "process_lost_after_prompt",
    to: "interrupted",
    effects: ["persist_process_reason_close_epoch"],
  },
  {
    from: "running",
    type: "permission_admitted",
    to: "awaiting_permission",
    effects: ["persist_permission_request"],
  },
  {
    from: "awaiting_permission",
    type: "permission_admitted",
    to: "awaiting_permission",
    effects: ["persist_permission_request"],
  },
  {
    from: "awaiting_permission",
    type: "permission_resolved_continue",
    to: "running",
    effects: ["persist_exactly_once_resolution"],
  },
  {
    from: "awaiting_permission",
    type: "permission_denial",
    to: "running",
    effects: ["persist_exactly_once_resolution"],
  },
  {
    from: "awaiting_permission",
    type: "permission_cancelled",
    to: "running",
    effects: ["persist_exactly_once_resolution"],
  },
  {
    from: "awaiting_permission",
    type: "permission_expired",
    to: "running",
    effects: ["persist_exactly_once_resolution"],
  },
  {
    from: "awaiting_permission",
    type: "permission_orphaned",
    to: "running",
    effects: ["persist_exactly_once_resolution"],
  },
  {
    from: "running",
    type: "successful_terminal_response",
    to: "completing",
    effects: ["stage_terminal_response"],
  },
  {
    from: "awaiting_permission",
    type: "successful_terminal_response",
    to: "completing",
    effects: ["stage_terminal_response"],
  },
  {
    from: "running",
    type: "protocol_terminal_error",
    to: "failed",
    effects: ["persist_explicit_error_close_permissions"],
  },
  {
    from: "awaiting_permission",
    type: "protocol_terminal_error",
    to: "failed",
    effects: ["persist_explicit_error_close_permissions"],
  },
  {
    from: "running",
    type: "user_cancel",
    to: "cancel_requested",
    effects: ["persist_cancel_intent"],
    markCancelIntent: true,
  },
  {
    from: "awaiting_permission",
    type: "user_cancel",
    to: "cancel_requested",
    effects: ["persist_cancel_intent"],
    markCancelIntent: true,
  },
  {
    from: "completing",
    type: "final_commit_succeeded",
    to: "completed",
    effects: ["commit_final_output"],
  },
  {
    from: "completing",
    type: "final_commit_failed",
    to: "failed",
    effects: ["persist_recoverable_failure"],
  },
  {
    from: "completing",
    type: "cancel_wins_before_commit",
    to: "cancel_requested",
    effects: ["persist_cancel_intent_discard_completion"],
    markCancelIntent: true,
  },
  {
    from: "cancel_requested",
    type: "runtime_confirms_cancellation",
    to: "cancelled",
    effects: ["close_permissions_commit_cancellation"],
  },
  {
    from: "cancel_requested",
    type: "process_exit_confirms_cancellation",
    to: "cancelled",
    effects: ["record_proof_close_epoch"],
  },
  {
    from: "cancel_requested",
    type: "successful_terminal_response",
    to: "completing",
    effects: ["stage_truthful_result"],
  },
  {
    from: "cancel_requested",
    type: "protocol_terminal_error",
    to: "failed",
    effects: ["preserve_cancel_intent_and_terminal_reason"],
  },
  {
    from: "running",
    type: "ownership_lost_before_completion",
    to: "interrupted",
    effects: ["persist_reason_expire_permissions_close_epoch"],
  },
  {
    from: "awaiting_permission",
    type: "ownership_lost_before_completion",
    to: "interrupted",
    effects: ["persist_reason_expire_permissions_close_epoch"],
  },
  {
    from: "completing",
    type: "ownership_lost_before_completion",
    to: "interrupted",
    effects: ["persist_reason_expire_permissions_close_epoch"],
  },
  {
    from: "running",
    type: "application_quit",
    to: "interrupted",
    effects: ["persist_reason_expire_permissions_close_epoch"],
  },
  {
    from: "awaiting_permission",
    type: "application_quit",
    to: "interrupted",
    effects: ["persist_reason_expire_permissions_close_epoch"],
  },
  {
    from: "completing",
    type: "application_quit",
    to: "interrupted",
    effects: ["persist_reason_expire_permissions_close_epoch"],
  },
]);

export const LEGAL_RUN_TRANSITIONS: readonly LegalRunTransition[] =
  Object.freeze(
    TRANSITIONS.map((row) =>
      Object.freeze({
        from: row.from,
        type: row.type,
        to: row.to,
        effects: Object.freeze([...row.effects]),
      }),
    ),
  );

export const LEGAL_RUN_TRANSITION_COUNT = LEGAL_RUN_TRANSITIONS.length;

export const UNIVERSAL_RUN_NOOPS = Object.freeze([
  "renderer_reload",
  "os_suspend",
  "os_resume",
  "transient_silence",
] as const);

const RUN_RECORD_KEYS = Object.freeze([
  "taskId",
  "runId",
  "state",
  "sessionId",
  "adapterEpoch",
  "cancelIntent",
  "promptAccepted",
  "unresolvedPermissionIdentities",
  "applied",
] as const);

const REQUIRED_RUN_RECORD_KEYS = Object.freeze([
  "taskId",
  "runId",
  "state",
  "cancelIntent",
  "promptAccepted",
  "unresolvedPermissionIdentities",
  "applied",
] as const);

const APPLIED_RUN_KEY_KEYS = Object.freeze([
  "key",
  "fingerprint",
  "ok",
  "state",
  "reason",
  "recordedEffects",
] as const);

const REQUIRED_APPLIED_RUN_KEY_KEYS = Object.freeze([
  "key",
  "fingerprint",
  "ok",
  "state",
  "recordedEffects",
] as const);

const PERMISSION_IDENTITY_KEYS = Object.freeze([
  "taskId",
  "runId",
  "sessionId",
  "toolCallId",
  "adapterEpoch",
  "windowId",
] as const);

export function createQueuedRun(input: {
  readonly taskId: TaskId;
  readonly runId: RunId;
}): RunRecord {
  const taskId = parseTaskId(input.taskId);
  const runId = parseRunId(input.runId);
  if (!taskId.ok || !runId.ok) {
    throw new TypeError("invalid_run_identity");
  }
  return freezeRunRecord({
    taskId: taskId.value,
    runId: runId.value,
    state: "queued",
    sessionId: undefined,
    adapterEpoch: undefined,
    cancelIntent: false,
    promptAccepted: false,
    unresolvedPermissionIdentities: [],
    applied: [],
  });
}

/** Canonical persisted boundary used by admission and persistence adapters. */
export function canonicalizeRunRecord(input: unknown): RunRecord {
  return freezeRunRecord(input as RunRecord);
}

export function applyRunEvent(run: RunRecord, event: RunEvent): RunApplyResult {
  const safeRun = freezeRunRecord(run);
  const safeEvent = freezeRunEvent(event);
  const key = eventKey(safeEvent);
  const fingerprint = fingerprintRunEvent(safeEvent);
  if (key !== undefined) {
    const lookup = lookupFingerprintedKey(safeRun.applied, key, fingerprint);
    if (lookup.kind === "collision") {
      return Object.freeze({
        ok: false,
        run: safeRun,
        reason: "idempotency_collision",
        idempotent: false,
        audit: true,
      });
    }
    if (lookup.kind === "duplicate") {
      return replayApplied(safeRun, lookup.entry);
    }
  }
  if (safeEvent.type === "stale_identity_event") {
    return reject(safeRun, "stale_identity", key, fingerprint);
  }
  if (identityMismatch(safeRun, safeEvent)) {
    return reject(safeRun, "identity_mismatch", key, fingerprint);
  }
  if (
    isPermissionAdmitEvent(safeEvent) &&
    isDuplicatePermissionAdmit(safeRun, safeEvent.identity)
  ) {
    return accept(safeRun, safeRun, [], key, fingerprint, false);
  }
  const held = noStateChange(safeRun, safeEvent);
  if (held !== undefined) {
    return accept(safeRun, safeRun, held, key, fingerprint, false);
  }
  const row = TRANSITIONS.find(
    (candidate) =>
      candidate.from === safeRun.state && candidate.type === safeEvent.type,
  );
  if (row === undefined) {
    const reason = isTerminalRunState(safeRun.state)
      ? "terminal_absorbing"
      : "illegal_transition";
    return reject(safeRun, reason, key, fingerprint);
  }
  if (
    isPermissionResolutionEvent(safeEvent) &&
    !hasUnresolvedIdentity(safeRun, safeEvent.identity)
  ) {
    return reject(safeRun, "no_unresolved_permission", key, fingerprint);
  }
  const next = applyRow(safeRun, safeEvent, row);
  if (identityMutatedAfterPrompt(safeRun, next)) {
    return reject(safeRun, "identity_frozen", key, fingerprint);
  }
  return accept(safeRun, next, row.effects, key, fingerprint, true);
}

export function runEventFingerprint(event: RunEvent): string {
  return fingerprintRunEvent(freezeRunEvent(event));
}

function fingerprintRunEvent(event: RunEvent): string {
  switch (event.type) {
    case "scheduler_dispatch":
      return canonicalFingerprint([
        event.type,
        event.sessionId,
        event.adapterEpoch,
      ]);
    case "prompt_accepted":
      return canonicalFingerprint([
        event.type,
        event.sessionId,
        event.adapterEpoch,
      ]);
    case "live_update":
      return canonicalFingerprint([event.type, event.channel]);
    case "permission_admitted":
    case "permission_resolved_continue":
    case "permission_denial":
    case "permission_cancelled":
    case "permission_expired":
    case "permission_orphaned":
      return permissionEventFingerprint(event.type, event.identity);
    default:
      return canonicalFingerprint([event.type]);
  }
}

function eventKey(event: RunEvent): IdempotencyKey | undefined {
  if ("idempotencyKey" in event) {
    return event.idempotencyKey;
  }
  return undefined;
}

function replayApplied(run: RunRecord, prior: AppliedRunKey): RunApplyResult {
  if (prior.ok) {
    return Object.freeze({
      ok: true,
      run,
      changed: false,
      effects: Object.freeze([]) as readonly RunEffect[],
      idempotent: true,
    });
  }
  return Object.freeze({
    ok: false,
    run,
    reason: prior.reason ?? "illegal_transition",
    idempotent: true,
    audit: true,
  });
}

function noStateChange(
  run: RunRecord,
  event: RunEvent,
): readonly RunEffect[] | undefined {
  switch (event.type) {
    case "renderer_reload":
    case "os_suspend":
    case "os_resume":
    case "transient_silence":
      return [];
    case "cancel_notification_written":
      return run.state === "cancel_requested" ? [] : undefined;
    case "application_quit":
      return run.state === "queued" ? [] : undefined;
    case "live_update":
      return run.state === "cancel_requested"
        ? ["persist_chronological_output"]
        : undefined;
    case "permission_admitted":
      return run.state === "cancel_requested"
        ? ["persist_permission_request", "return_exact_safe_permission_response"]
        : undefined;
    default:
      return undefined;
  }
}

function identityMismatch(run: RunRecord, event: RunEvent): boolean {
  if (event.type === "prompt_accepted" || event.type === "scheduler_dispatch") {
    if (run.sessionId === undefined && run.adapterEpoch === undefined) {
      return false;
    }
    return (
      run.sessionId !== event.sessionId ||
      run.adapterEpoch !== event.adapterEpoch
    );
  }
  if (isPermissionRunEvent(event)) {
    return (
      event.identity.taskId !== run.taskId ||
      event.identity.runId !== run.runId ||
      run.sessionId === undefined ||
      run.adapterEpoch === undefined ||
      event.identity.sessionId !== run.sessionId ||
      event.identity.adapterEpoch !== run.adapterEpoch
    );
  }
  return false;
}

function identityMutatedAfterPrompt(previous: RunRecord, next: RunRecord): boolean {
  if (!previous.promptAccepted) {
    return false;
  }
  return (
    next.taskId !== previous.taskId ||
    next.sessionId !== previous.sessionId ||
    next.adapterEpoch !== previous.adapterEpoch
  );
}

function isPermissionAdmitEvent(
  event: RunEvent,
): event is Extract<
  RunEvent,
  { type: "permission_admitted" }
> {
  return event.type === "permission_admitted";
}

function isPermissionResolutionEvent(
  event: RunEvent,
): event is Extract<
  RunEvent,
  {
    type:
      | "permission_resolved_continue"
      | "permission_denial"
      | "permission_cancelled"
      | "permission_expired"
      | "permission_orphaned";
  }
> {
  return (
    event.type === "permission_resolved_continue" ||
    event.type === "permission_denial" ||
    event.type === "permission_cancelled" ||
    event.type === "permission_expired" ||
    event.type === "permission_orphaned"
  );
}

function isPermissionRunEvent(
  event: RunEvent,
): event is Extract<RunEvent, { identity: PermissionIdentity }> {
  return isPermissionAdmitEvent(event) || isPermissionResolutionEvent(event);
}

function permissionIdentityParts(
  identity: PermissionIdentity,
): readonly (string | number)[] {
  return [
    identity.taskId,
    identity.runId,
    identity.sessionId,
    identity.toolCallId,
    identity.adapterEpoch,
    identity.windowId,
  ];
}

function permissionEventFingerprint(
  type:
    | "permission_admitted"
    | "permission_resolved_continue"
    | "permission_denial"
    | "permission_cancelled"
    | "permission_expired"
    | "permission_orphaned",
  identity: PermissionIdentity,
): string {
  return canonicalFingerprint([type, ...permissionIdentityParts(identity)]);
}

function hasUnresolvedIdentity(
  run: RunRecord,
  identity: PermissionIdentity,
): boolean {
  return run.unresolvedPermissionIdentities.some((item) =>
    permissionIdentitiesEqual(item, identity),
  );
}

function withUnresolvedIdentity(
  identities: readonly PermissionIdentity[],
  identity: PermissionIdentity,
): readonly PermissionIdentity[] {
  if (identities.some((item) => permissionIdentitiesEqual(item, identity))) {
    return identities;
  }
  return [...identities, identity];
}

function withoutUnresolvedIdentity(
  identities: readonly PermissionIdentity[],
  identity: PermissionIdentity,
): readonly PermissionIdentity[] {
  return identities.filter((item) => !permissionIdentitiesEqual(item, identity));
}

function isDuplicatePermissionAdmit(
  run: RunRecord,
  identity: PermissionIdentity,
): boolean {
  if (hasUnresolvedIdentity(run, identity)) {
    return true;
  }
  if (isTerminalRunState(run.state)) {
    return false;
  }
  const admittedFingerprint = permissionEventFingerprint(
    "permission_admitted",
    identity,
  );
  return run.applied.some(
    (entry) =>
      entry.ok &&
      entry.fingerprint === admittedFingerprint,
  );
}

function clearsUnresolvedIdentities(state: RunState): boolean {
  return (
    state === "completing" ||
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "interrupted"
  );
}

function applyRow(
  run: RunRecord,
  event: RunEvent,
  row: TransitionRow,
): RunRecord {
  let unresolvedPermissionIdentities = run.unresolvedPermissionIdentities;
  if (clearsUnresolvedIdentities(row.to)) {
    unresolvedPermissionIdentities = [];
  } else if (isPermissionAdmitEvent(event)) {
    unresolvedPermissionIdentities = withUnresolvedIdentity(
      unresolvedPermissionIdentities,
      event.identity,
    );
  } else if (isPermissionResolutionEvent(event)) {
    unresolvedPermissionIdentities = withoutUnresolvedIdentity(
      unresolvedPermissionIdentities,
      event.identity,
    );
  }
  const state = isPermissionResolutionEvent(event)
    ? unresolvedPermissionIdentities.length === 0
      ? "running"
      : "awaiting_permission"
    : row.to;
  return {
    taskId: run.taskId,
    runId: run.runId,
    state,
    sessionId:
      event.type === "scheduler_dispatch" ? event.sessionId : run.sessionId,
    adapterEpoch:
      event.type === "scheduler_dispatch"
        ? event.adapterEpoch
        : run.adapterEpoch,
    cancelIntent: run.cancelIntent || row.markCancelIntent === true,
    promptAccepted: run.promptAccepted || row.markPromptAccepted === true,
    unresolvedPermissionIdentities,
    applied: run.applied,
  };
}

function accept(
  _previous: RunRecord,
  next: RunRecord,
  effects: readonly RunEffect[],
  key: IdempotencyKey | undefined,
  fingerprint: string,
  changed: boolean,
): RunApplyResult {
  const resultEffects = freezeEffects(effects);
  const run = remember(next, key, fingerprint, {
    key: key as IdempotencyKey,
    fingerprint,
    ok: true,
    state: next.state,
    reason: undefined,
    recordedEffects: freezeEffects(effects),
  });
  return Object.freeze({
    ok: true,
    run,
    changed,
    effects: resultEffects,
    idempotent: false,
  });
}

function reject(
  run: RunRecord,
  reason: string,
  key: IdempotencyKey | undefined,
  fingerprint: string,
): RunApplyResult {
  const next = remember(run, key, fingerprint, {
    key: key as IdempotencyKey,
    fingerprint,
    ok: false,
    state: run.state,
    reason,
    recordedEffects: Object.freeze([]) as readonly RunEffect[],
  });
  return Object.freeze({
    ok: false,
    run: next,
    reason,
    idempotent: false,
    audit: true,
  });
}

function remember(
  run: RunRecord,
  key: IdempotencyKey | undefined,
  fingerprint: string,
  entry: AppliedRunKey,
): RunRecord {
  if (key === undefined) {
    return freezeRunRecord(run);
  }
  return freezeRunRecord({
    ...run,
    applied: [...run.applied, { ...entry, fingerprint }],
  });
}

function freezeEffects(effects: readonly RunEffect[]): readonly RunEffect[] {
  const safeEffects = denseDataArray(effects);
  if (
    safeEffects === undefined ||
    safeEffects.some(
      (effect) =>
        typeof effect !== "string" ||
        !(RUN_EFFECTS as readonly string[]).includes(effect),
    )
  ) {
    throw new TypeError("invalid_run_effects");
  }
  return Object.freeze([...safeEffects]) as readonly RunEffect[];
}

function freezePermissionIdentity(identity: unknown): PermissionIdentity {
  const record = exactDataObject(
    identity,
    PERMISSION_IDENTITY_KEYS,
    PERMISSION_IDENTITY_KEYS,
  );
  if (record === undefined) {
    throw new TypeError("invalid_permission_identity");
  }
  const parsed = parsePermissionIdentity(record);
  if (!parsed.ok) {
    throw new TypeError("invalid_permission_identity");
  }
  return Object.freeze({ ...parsed.value });
}

function freezeAppliedRunKey(input: unknown): AppliedRunKey {
  const record = exactDataObject(
    input,
    APPLIED_RUN_KEY_KEYS,
    REQUIRED_APPLIED_RUN_KEY_KEYS,
  );
  if (record === undefined) {
    throw new TypeError("invalid_run_ledger_entry");
  }
  const key = parseIdempotencyKey(record["key"]);
  const state = record["state"];
  const fingerprint = record["fingerprint"];
  const ok = record["ok"];
  const reason = record["reason"];
  if (
    !key.ok ||
    typeof fingerprint !== "string" ||
    fingerprint.length === 0 ||
    typeof ok !== "boolean" ||
    typeof state !== "string" ||
    !(RUN_STATES as readonly string[]).includes(state) ||
    (ok ? reason !== undefined : typeof reason !== "string" || reason.length === 0)
  ) {
    throw new TypeError("invalid_run_ledger_entry");
  }
  const recordedEffects = freezeEffects(
    record["recordedEffects"] as readonly RunEffect[],
  );
  if (!ok && recordedEffects.length !== 0) {
    throw new TypeError("invalid_run_ledger_entry");
  }
  return Object.freeze({
    key: key.value,
    fingerprint,
    ok,
    state: state as RunState,
    reason: reason as string | undefined,
    recordedEffects,
  });
}

function freezeRunRecord(input: unknown): RunRecord {
  const record = exactDataObject(
    input,
    RUN_RECORD_KEYS,
    REQUIRED_RUN_RECORD_KEYS,
  );
  if (record === undefined) {
    throw new TypeError("invalid_run_record");
  }
  const taskId = parseTaskId(record["taskId"]);
  const runId = parseRunId(record["runId"]);
  const state = record["state"];
  const sessionIdInput = record["sessionId"];
  const adapterEpochInput = record["adapterEpoch"];
  const unresolvedInput = denseDataArray(
    record["unresolvedPermissionIdentities"],
  );
  const appliedInput = denseDataArray(record["applied"]);
  const sessionId =
    sessionIdInput === undefined ? undefined : parseSessionId(sessionIdInput);
  const adapterEpoch =
    adapterEpochInput === undefined
      ? undefined
      : parseAdapterEpoch(adapterEpochInput);
  if (
    !taskId.ok ||
    !runId.ok ||
    typeof state !== "string" ||
    !(RUN_STATES as readonly string[]).includes(state) ||
    (sessionId !== undefined && !sessionId.ok) ||
    (adapterEpoch !== undefined && !adapterEpoch.ok) ||
    (sessionId === undefined) !== (adapterEpoch === undefined) ||
    typeof record["cancelIntent"] !== "boolean" ||
    typeof record["promptAccepted"] !== "boolean" ||
    unresolvedInput === undefined ||
    appliedInput === undefined
  ) {
    throw new TypeError("invalid_run_record");
  }
  const safeSessionId = sessionId?.value;
  const safeAdapterEpoch = adapterEpoch?.value;
  if (
    record["promptAccepted"] &&
    (safeSessionId === undefined || safeAdapterEpoch === undefined)
  ) {
    throw new TypeError("invalid_run_record");
  }
  const identities = Object.freeze(
    unresolvedInput.map((identity) => {
      const safeIdentity = freezePermissionIdentity(identity);
      if (
        safeIdentity.taskId !== taskId.value ||
        safeIdentity.runId !== runId.value ||
        safeSessionId === undefined ||
        safeAdapterEpoch === undefined ||
        safeIdentity.sessionId !== safeSessionId ||
        safeIdentity.adapterEpoch !== safeAdapterEpoch
      ) {
        throw new TypeError("invalid_run_record");
      }
      return safeIdentity;
    }),
  );
  if (
    identities.some((identity, index) =>
      identities
        .slice(0, index)
        .some((prior) => permissionIdentitiesEqual(prior, identity)),
    )
  ) {
    throw new TypeError("invalid_run_record");
  }
  const applied = Object.freeze(appliedInput.map(freezeAppliedRunKey));
  if (new Set(applied.map((entry) => entry.key)).size !== applied.length) {
    throw new TypeError("invalid_run_record");
  }
  const safeState = state as RunState;
  const cancelIntent = record["cancelIntent"];
  const promptAccepted = record["promptAccepted"];
  if (
    !runLedgerReachesSnapshot({
      taskId: taskId.value,
      runId: runId.value,
      state: safeState,
      sessionId: safeSessionId,
      adapterEpoch: safeAdapterEpoch,
      cancelIntent,
      promptAccepted,
      unresolvedPermissionIdentities: identities,
      applied,
    }) ||
    !runRecordRelationshipsAreReachable({
      state: safeState,
      sessionId: safeSessionId,
      adapterEpoch: safeAdapterEpoch,
      cancelIntent,
      promptAccepted,
      unresolvedPermissionCount: identities.length,
    })
  ) {
    throw new TypeError("invalid_run_record");
  }
  return Object.freeze({
    taskId: taskId.value,
    runId: runId.value,
    state: safeState,
    sessionId: safeSessionId,
    adapterEpoch: safeAdapterEpoch,
    cancelIntent,
    promptAccepted,
    unresolvedPermissionIdentities: identities,
    applied,
  });
}

function exactDataObject(
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
  const record = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      return descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true;
    })
  ) {
    return undefined;
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

type LedgerFingerprintPart = string | number | boolean | undefined;

function decodeLedgerFingerprint(
  input: string,
): readonly LedgerFingerprintPart[] | undefined {
  const parts: LedgerFingerprintPart[] = [];
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

type LedgerEventEvidence = {
  readonly type: RunEvent["type"];
  readonly sessionId?: SessionId;
  readonly adapterEpoch?: AdapterEpoch;
  readonly identity?: PermissionIdentity;
  readonly channel?: "session" | "tool";
};

const KEYED_RUN_EVENT_TYPES = Object.freeze([
  "scheduler_dispatch",
  "user_cancel",
  "prompt_accepted",
  "launch_failure",
  "process_lost_after_prompt",
  "permission_admitted",
  "permission_resolved_continue",
  "successful_terminal_response",
  "protocol_terminal_error",
  "final_commit_succeeded",
  "final_commit_failed",
  "cancel_wins_before_commit",
  "runtime_confirms_cancellation",
  "process_exit_confirms_cancellation",
  "ownership_lost_before_completion",
  "application_quit",
  "permission_denial",
  "permission_cancelled",
  "permission_expired",
  "permission_orphaned",
  "cancel_notification_written",
  "live_update",
] as const satisfies readonly RunEvent["type"][]);

function decodeLedgerEvent(
  fingerprint: string,
): LedgerEventEvidence | undefined {
  const parts = decodeLedgerFingerprint(fingerprint);
  if (parts === undefined || typeof parts[0] !== "string") return undefined;
  const type = parts[0];
  if (!(KEYED_RUN_EVENT_TYPES as readonly string[]).includes(type)) {
    return undefined;
  }
  const safeType = type as RunEvent["type"];
  if (type === "scheduler_dispatch" || type === "prompt_accepted") {
    const sessionId = parseSessionId(parts[1]);
    const adapterEpoch = parseAdapterEpoch(parts[2]);
    if (!sessionId.ok || !adapterEpoch.ok || parts.length !== 3) {
      return undefined;
    }
    return {
      type: safeType,
      sessionId: sessionId.value,
      adapterEpoch: adapterEpoch.value,
    };
  }
  if (type === "live_update") {
    return parts.length === 2 &&
      (parts[1] === "session" || parts[1] === "tool")
      ? { type: safeType, channel: parts[1] }
      : undefined;
  }
  if (
    type === "permission_admitted" ||
    type === "permission_resolved_continue" ||
    type === "permission_denial" ||
    type === "permission_cancelled" ||
    type === "permission_expired" ||
    type === "permission_orphaned"
  ) {
    const taskId = parseTaskId(parts[1]);
    const runId = parseRunId(parts[2]);
    const sessionId = parseSessionId(parts[3]);
    const toolCallId = parseToolCallId(parts[4]);
    const adapterEpoch = parseAdapterEpoch(parts[5]);
    const windowId = parseWindowId(parts[6]);
    if (
      parts.length !== 7 ||
      !taskId.ok ||
      !runId.ok ||
      !sessionId.ok ||
      !toolCallId.ok ||
      !adapterEpoch.ok ||
      !windowId.ok
    ) {
      return undefined;
    }
    return {
      type: safeType,
      identity: {
        taskId: taskId.value,
        runId: runId.value,
        sessionId: sessionId.value,
        toolCallId: toolCallId.value,
        adapterEpoch: adapterEpoch.value,
        windowId: windowId.value,
      },
    };
  }
  return parts.length === 1 ? { type: safeType } : undefined;
}

function sameEffects(
  actual: readonly RunEffect[],
  expected: readonly RunEffect[],
): boolean {
  return actual.length === expected.length &&
    actual.every((effect, index) => effect === expected[index]);
}

function runLedgerReachesSnapshot(input: {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly state: RunState;
  readonly sessionId: SessionId | undefined;
  readonly adapterEpoch: AdapterEpoch | undefined;
  readonly cancelIntent: boolean;
  readonly promptAccepted: boolean;
  readonly unresolvedPermissionIdentities: readonly PermissionIdentity[];
  readonly applied: readonly AppliedRunKey[];
}): boolean {
  let state: RunState = "queued";
  let sessionId: SessionId | undefined;
  let adapterEpoch: AdapterEpoch | undefined;
  let cancelIntent = false;
  let promptAccepted = false;
  let unresolvedPermissionIdentities: PermissionIdentity[] = [];
  const successfulFingerprints = new Set<string>();

  for (const entry of input.applied) {
    const event = decodeLedgerEvent(entry.fingerprint);
    if (event === undefined) return false;
    if (!entry.ok) {
      const expectedReason = ledgerFailureReason({
        taskId: input.taskId,
        runId: input.runId,
        state,
        sessionId,
        adapterEpoch,
        unresolvedPermissionIdentities,
        successfulFingerprints,
        event,
        fingerprint: entry.fingerprint,
      });
      if (
        expectedReason === undefined ||
        entry.reason !== expectedReason ||
        entry.state !== state ||
        entry.recordedEffects.length !== 0
      ) {
        return false;
      }
      continue;
    }
    if (
      ledgerIdentityMismatch(
        input.taskId,
        input.runId,
        sessionId,
        adapterEpoch,
        event,
      )
    ) {
      return false;
    }
    if (
      ledgerIsDuplicatePermissionAdmit(
        state,
        unresolvedPermissionIdentities,
        successfulFingerprints,
        event,
        entry.fingerprint,
      )
    ) {
      if (entry.recordedEffects.length !== 0 || entry.state !== state) {
        return false;
      }
      successfulFingerprints.add(entry.fingerprint);
      continue;
    }
    const heldEffects = ledgerNoStateEffects(state, event);
    if (heldEffects !== undefined) {
      if (
        !sameEffects(entry.recordedEffects, heldEffects) ||
        entry.state !== state
      ) {
        return false;
      }
      successfulFingerprints.add(entry.fingerprint);
      continue;
    }

    const row = TRANSITIONS.find(
      (candidate) =>
        candidate.from === state && candidate.type === event.type,
    );
    if (row === undefined || !sameEffects(entry.recordedEffects, row.effects)) {
      return false;
    }
    if (
      isPermissionResolutionType(event.type) &&
      (event.identity === undefined ||
        !hasLedgerIdentity(unresolvedPermissionIdentities, event.identity))
    ) {
      return false;
    }
    if (event.type === "scheduler_dispatch") {
      if (event.sessionId === undefined || event.adapterEpoch === undefined) {
        return false;
      }
      sessionId = event.sessionId;
      adapterEpoch = event.adapterEpoch;
    }
    if (row.markCancelIntent === true) cancelIntent = true;
    if (row.markPromptAccepted === true) promptAccepted = true;
    if (event.type === "permission_admitted") {
      if (event.identity === undefined) return false;
      unresolvedPermissionIdentities = [
        ...unresolvedPermissionIdentities,
        event.identity,
      ];
    } else if (isPermissionResolutionType(event.type)) {
      if (event.identity === undefined) return false;
      unresolvedPermissionIdentities = unresolvedPermissionIdentities.filter(
        (identity) => !permissionIdentitiesEqual(identity, event.identity!),
      );
    }
    let nextState = row.to;
    if (isPermissionResolutionType(event.type)) {
      nextState = unresolvedPermissionIdentities.length === 0
        ? "running"
        : "awaiting_permission";
    }
    if (clearsUnresolvedIdentities(nextState)) {
      unresolvedPermissionIdentities = [];
    }
    if (entry.state !== nextState) return false;
    state = nextState;
    successfulFingerprints.add(entry.fingerprint);
  }

  return state === input.state &&
    sessionId === input.sessionId &&
    adapterEpoch === input.adapterEpoch &&
    cancelIntent === input.cancelIntent &&
    promptAccepted === input.promptAccepted &&
    samePermissionIdentitySet(
      unresolvedPermissionIdentities,
      input.unresolvedPermissionIdentities,
    );
}

function ledgerIdentityMismatch(
  taskId: TaskId,
  runId: RunId,
  sessionId: SessionId | undefined,
  adapterEpoch: AdapterEpoch | undefined,
  event: LedgerEventEvidence,
): boolean {
  if (
    event.type === "scheduler_dispatch" ||
    event.type === "prompt_accepted"
  ) {
    if (sessionId === undefined && adapterEpoch === undefined) return false;
    return event.sessionId !== sessionId || event.adapterEpoch !== adapterEpoch;
  }
  if (event.identity !== undefined) {
    return event.identity.taskId !== taskId ||
      event.identity.runId !== runId ||
      sessionId === undefined ||
      adapterEpoch === undefined ||
      event.identity.sessionId !== sessionId ||
      event.identity.adapterEpoch !== adapterEpoch;
  }
  return false;
}

function hasLedgerIdentity(
  identities: readonly PermissionIdentity[],
  identity: PermissionIdentity,
): boolean {
  return identities.some((candidate) =>
    permissionIdentitiesEqual(candidate, identity),
  );
}

function samePermissionIdentitySet(
  left: readonly PermissionIdentity[],
  right: readonly PermissionIdentity[],
): boolean {
  return left.length === right.length &&
    left.every((identity) => hasLedgerIdentity(right, identity));
}

function ledgerIsDuplicatePermissionAdmit(
  state: RunState,
  unresolved: readonly PermissionIdentity[],
  successfulFingerprints: ReadonlySet<string>,
  event: LedgerEventEvidence,
  fingerprint: string,
): boolean {
  if (event.type !== "permission_admitted" || event.identity === undefined) {
    return false;
  }
  if (hasLedgerIdentity(unresolved, event.identity)) return true;
  return !isTerminalRunState(state) &&
    successfulFingerprints.has(fingerprint);
}

function ledgerNoStateEffects(
  state: RunState,
  event: LedgerEventEvidence,
): readonly RunEffect[] | undefined {
  if (event.type === "cancel_notification_written") {
    return state === "cancel_requested" ? [] : undefined;
  }
  if (event.type === "application_quit") {
    return state === "queued" ? [] : undefined;
  }
  if (event.type === "live_update") {
    return state === "cancel_requested"
      ? ["persist_chronological_output"]
      : undefined;
  }
  if (event.type === "permission_admitted") {
    return state === "cancel_requested"
      ? ["persist_permission_request", "return_exact_safe_permission_response"]
      : undefined;
  }
  return undefined;
}

function ledgerFailureReason(input: {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly state: RunState;
  readonly sessionId: SessionId | undefined;
  readonly adapterEpoch: AdapterEpoch | undefined;
  readonly unresolvedPermissionIdentities: readonly PermissionIdentity[];
  readonly successfulFingerprints: ReadonlySet<string>;
  readonly event: LedgerEventEvidence;
  readonly fingerprint: string;
}): string | undefined {
  if (
    ledgerIdentityMismatch(
      input.taskId,
      input.runId,
      input.sessionId,
      input.adapterEpoch,
      input.event,
    )
  ) {
    return "identity_mismatch";
  }
  if (
    ledgerIsDuplicatePermissionAdmit(
      input.state,
      input.unresolvedPermissionIdentities,
      input.successfulFingerprints,
      input.event,
      input.fingerprint,
    ) ||
    ledgerNoStateEffects(input.state, input.event) !== undefined
  ) {
    return undefined;
  }
  const row = TRANSITIONS.find(
    (candidate) =>
      candidate.from === input.state && candidate.type === input.event.type,
  );
  if (row === undefined) {
    return isTerminalRunState(input.state)
      ? "terminal_absorbing"
      : "illegal_transition";
  }
  if (
    isPermissionResolutionType(input.event.type) &&
    (input.event.identity === undefined ||
      !hasLedgerIdentity(
        input.unresolvedPermissionIdentities,
        input.event.identity,
      ))
  ) {
    return "no_unresolved_permission";
  }
  return undefined;
}

function isPermissionResolutionType(
  type: RunEvent["type"],
): type is
  | "permission_resolved_continue"
  | "permission_denial"
  | "permission_cancelled"
  | "permission_expired"
  | "permission_orphaned" {
  return type === "permission_resolved_continue" ||
    type === "permission_denial" ||
    type === "permission_cancelled" ||
    type === "permission_expired" ||
    type === "permission_orphaned";
}

function runRecordRelationshipsAreReachable(input: {
  readonly state: RunState;
  readonly sessionId: SessionId | undefined;
  readonly adapterEpoch: AdapterEpoch | undefined;
  readonly cancelIntent: boolean;
  readonly promptAccepted: boolean;
  readonly unresolvedPermissionCount: number;
}): boolean {
  const ownsTransport =
    input.sessionId !== undefined && input.adapterEpoch !== undefined;
  const hasUnresolvedPermission = input.unresolvedPermissionCount > 0;

  if (input.state === "queued") {
    return (
      !ownsTransport &&
      !input.cancelIntent &&
      !input.promptAccepted &&
      !hasUnresolvedPermission
    );
  }
  if (!ownsTransport) {
    return (
      input.state === "cancelled" &&
      input.cancelIntent &&
      !input.promptAccepted &&
      !hasUnresolvedPermission
    );
  }
  if (
    (input.state === "starting" ||
      input.state === "running" ||
      input.state === "awaiting_permission") &&
    input.cancelIntent
  ) {
    return false;
  }
  if (input.state === "cancelled" && !input.cancelIntent) {
    return false;
  }
  if (
    input.state === "starting" &&
    input.promptAccepted
  ) {
    return false;
  }
  if (
    (input.state === "running" ||
      input.state === "awaiting_permission" ||
      input.state === "completing" ||
      input.state === "completed") &&
    !input.promptAccepted
  ) {
    return false;
  }
  if (input.state === "awaiting_permission") {
    return hasUnresolvedPermission;
  }
  if (input.state === "cancel_requested") {
    return input.cancelIntent &&
      (!hasUnresolvedPermission || input.promptAccepted);
  }
  return !hasUnresolvedPermission;
}

function freezeRunEvent(input: RunEvent): RunEvent {
  if (!isRecord(input) || typeof input["type"] !== "string") {
    throw new TypeError("invalid_run_event");
  }
  const record = input as unknown as Record<string, unknown>;
  const type = record["type"] as RunEvent["type"];
  switch (type) {
    case "scheduler_dispatch":
    case "prompt_accepted": {
      const sessionId = parseSessionId(record["sessionId"]);
      const adapterEpoch = parseAdapterEpoch(record["adapterEpoch"]);
      const idempotencyKey = parseIdempotencyKey(record["idempotencyKey"]);
      if (!sessionId.ok || !adapterEpoch.ok || !idempotencyKey.ok) {
        throw new TypeError("invalid_run_event");
      }
      return Object.freeze({
        type,
        sessionId: sessionId.value,
        adapterEpoch: adapterEpoch.value,
        idempotencyKey: idempotencyKey.value,
      });
    }
    case "permission_admitted":
    case "permission_resolved_continue":
    case "permission_denial":
    case "permission_cancelled":
    case "permission_expired":
    case "permission_orphaned": {
      const idempotencyKey = parseIdempotencyKey(record["idempotencyKey"]);
      if (!idempotencyKey.ok) {
        throw new TypeError("invalid_run_event");
      }
      return Object.freeze({
        type,
        identity: freezePermissionIdentity(record["identity"]),
        idempotencyKey: idempotencyKey.value,
      });
    }
    case "live_update": {
      const idempotencyKey = parseIdempotencyKey(record["idempotencyKey"]);
      const channel = record["channel"];
      if (
        !idempotencyKey.ok ||
        (channel !== "session" && channel !== "tool")
      ) {
        throw new TypeError("invalid_run_event");
      }
      return Object.freeze({ type, channel, idempotencyKey: idempotencyKey.value });
    }
    case "user_cancel":
    case "launch_failure":
    case "process_lost_after_prompt":
    case "successful_terminal_response":
    case "protocol_terminal_error":
    case "final_commit_succeeded":
    case "final_commit_failed":
    case "cancel_wins_before_commit":
    case "runtime_confirms_cancellation":
    case "process_exit_confirms_cancellation":
    case "ownership_lost_before_completion":
    case "application_quit":
    case "cancel_notification_written": {
      const idempotencyKey = parseIdempotencyKey(record["idempotencyKey"]);
      if (!idempotencyKey.ok) {
        throw new TypeError("invalid_run_event");
      }
      return Object.freeze({ type, idempotencyKey: idempotencyKey.value });
    }
    case "renderer_reload":
    case "os_suspend":
    case "os_resume":
    case "transient_silence":
    case "stale_identity_event":
      return Object.freeze({ type });
    default:
      throw new TypeError("invalid_run_event");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
