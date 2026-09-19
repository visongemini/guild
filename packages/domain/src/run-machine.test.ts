import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  freezeRuntimePayload,
  isTerminalRunState,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parsePermissionOutboxCommandId,
  parseRunId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  permissionIdentitiesEqual,
  RUN_EFFECTS,
  RUN_STATES,
  TERMINAL_RUN_STATES,
  type AdapterEpoch,
  type IdempotencyKey,
  type PermissionIdentity,
  type Result,
  type RunEffect,
  type RunEvent,
  type RunState,
  type SessionId,
  type TaskId,
} from "@guild/contracts";
import * as runMachine from "./run-machine.js";
import {
  applyRunEvent,
  canonicalizeRunRecord,
  createQueuedRun,
  LEGAL_RUN_TRANSITION_COUNT,
  LEGAL_RUN_TRANSITIONS,
  runEventFingerprint,
  UNIVERSAL_RUN_NOOPS,
  type AppliedRunKey,
  type LegalRunTransition,
  type RunApplyResult,
  type RunRecord,
} from "./run-machine.js";
import {
  registerPermissionRequest,
} from "./permission-machine.js";

function must<T>(result: Result<T>): T {
  if (!result.ok) {
    assert.fail(result.reason);
  }
  return result.value;
}

const taskId: TaskId = must(parseTaskId("task-a"));
const otherTask: TaskId = must(parseTaskId("task-b"));
const runId = must(parseRunId("run-1"));
const otherRun = must(parseRunId("run-2"));
const sessionId: SessionId = must(parseSessionId("sess-1"));
const otherSession: SessionId = must(parseSessionId("sess-2"));
const epoch: AdapterEpoch = must(parseAdapterEpoch(1));
const otherEpoch: AdapterEpoch = must(parseAdapterEpoch(2));
const toolCallA = must(parseToolCallId("tool-1"));
const toolCallB = must(parseToolCallId("tool-2"));
const windowA = must(parseWindowId("win-1"));
const windowB = must(parseWindowId("win-2"));

function permIdentity(
  overrides: Partial<PermissionIdentity> = {},
): PermissionIdentity {
  return {
    taskId,
    runId,
    sessionId,
    toolCallId: toolCallA,
    adapterEpoch: epoch,
    windowId: windowA,
    ...overrides,
  };
}

const identityA = permIdentity();
const identityB = permIdentity({ toolCallId: toolCallB, windowId: windowB });

function permissionRequest(exactIdentity: PermissionIdentity = identityA) {
  const payload = freezeRuntimePayload({
    type: "permission_request",
    sessionId: exactIdentity.sessionId,
    received: { wallClockIso: "2026-08-27T12:00:00.000Z", monotonicMs: 100 },
    callbackRequestId: "callback-1",
    toolCallId: exactIdentity.toolCallId,
    title: "Permission",
    options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
  });
  if (payload.type !== "permission_request") assert.fail("wrong payload");
  return payload;
}

let seq = 0;
function key(label: string): IdempotencyKey {
  seq += 1;
  return must(parseIdempotencyKey(`${label}-${seq}`));
}

function makeEvent(
  type: RunEvent["type"],
  idempotencyKey: IdempotencyKey,
  overrides: {
    readonly sessionId?: SessionId;
    readonly adapterEpoch?: AdapterEpoch;
    readonly channel?: "session" | "tool";
    readonly identity?: PermissionIdentity;
  } = {},
): RunEvent {
  switch (type) {
    case "scheduler_dispatch":
    case "prompt_accepted":
      return {
        type,
        sessionId: overrides.sessionId ?? sessionId,
        adapterEpoch: overrides.adapterEpoch ?? epoch,
        idempotencyKey,
      };
    case "live_update":
      return {
        type,
        channel: overrides.channel ?? "session",
        idempotencyKey,
      };
    case "permission_admitted":
    case "permission_resolved_continue":
    case "permission_denial":
    case "permission_cancelled":
    case "permission_expired":
    case "permission_orphaned":
      return {
        type,
        identity: overrides.identity ?? identityA,
        idempotencyKey,
      };
    case "renderer_reload":
    case "os_suspend":
    case "os_resume":
    case "transient_silence":
    case "stale_identity_event":
      return { type };
    default:
      return { type, idempotencyKey } as RunEvent;
  }
}

function rowEvent(
  row: { readonly from: RunState; readonly type: RunEvent["type"] },
  label: string,
): RunEvent {
  const identity =
    row.from === "awaiting_permission" && row.type === "permission_admitted"
      ? identityB
      : undefined;
  return makeEvent(
    row.type,
    key(label),
    identity === undefined ? {} : { identity },
  );
}

function assertAccepted(result: RunApplyResult): asserts result is Extract<
  RunApplyResult,
  { ok: true }
> {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
}

function assertTypeError(action: () => void): void {
  assert.throws(action, TypeError);
}

function assertUnresolved(
  run: RunRecord,
  expected: readonly PermissionIdentity[],
): void {
  assert.equal(run.unresolvedPermissionIdentities.length, expected.length);
  for (const identity of expected) {
    assert.equal(
      run.unresolvedPermissionIdentities.some((item) =>
        permissionIdentitiesEqual(item, identity),
      ),
      true,
    );
  }
}

function runInState(state: RunState): RunRecord {
  let run = createQueuedRun({ taskId, runId });
  if (state === "queued") {
    return run;
  }
  const dispatched = applyRunEvent(
    run,
    makeEvent("scheduler_dispatch", key("setup-dispatch")),
  );
  assertAccepted(dispatched);
  run = dispatched.run;
  if (state === "starting") {
    return run;
  }
  if (state === "failed") {
    const failed = applyRunEvent(run, makeEvent("launch_failure", key("setup-fail")));
    assertAccepted(failed);
    return failed.run;
  }
  if (state === "interrupted") {
    const lost = applyRunEvent(
      run,
      makeEvent("process_lost_after_prompt", key("setup-interrupt")),
    );
    assertAccepted(lost);
    return lost.run;
  }
  const accepted = applyRunEvent(
    run,
    makeEvent("prompt_accepted", key("setup-prompt")),
  );
  assertAccepted(accepted);
  run = accepted.run;
  if (state === "running") {
    return run;
  }
  if (state === "awaiting_permission") {
    const waiting = applyRunEvent(
      run,
      makeEvent("permission_admitted", key("setup-perm")),
    );
    assertAccepted(waiting);
    return waiting.run;
  }
  if (state === "completing") {
    const completing = applyRunEvent(
      run,
      makeEvent("successful_terminal_response", key("setup-term")),
    );
    assertAccepted(completing);
    return completing.run;
  }
  if (state === "completed") {
    const completing = applyRunEvent(
      run,
      makeEvent("successful_terminal_response", key("setup-term")),
    );
    assertAccepted(completing);
    const completed = applyRunEvent(
      completing.run,
      makeEvent("final_commit_succeeded", key("setup-commit")),
    );
    assertAccepted(completed);
    return completed.run;
  }
  if (state === "cancel_requested") {
    const cancel = applyRunEvent(run, makeEvent("user_cancel", key("setup-cancel")));
    assertAccepted(cancel);
    return cancel.run;
  }
  if (state === "cancelled") {
    const cancel = applyRunEvent(run, makeEvent("user_cancel", key("setup-cancel")));
    assertAccepted(cancel);
    const cancelled = applyRunEvent(
      cancel.run,
      makeEvent("runtime_confirms_cancellation", key("setup-confirm")),
    );
    assertAccepted(cancelled);
    return cancelled.run;
  }
  throw new Error(`unhandled state ${state}`);
}

const ALL_EVENT_TYPES: readonly RunEvent["type"][] = [
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
  "renderer_reload",
  "os_suspend",
  "os_resume",
  "transient_silence",
  "application_quit",
  "permission_denial",
  "permission_cancelled",
  "permission_expired",
  "permission_orphaned",
  "cancel_notification_written",
  "live_update",
  "stale_identity_event",
];

type ExpectedRunTransition = {
  readonly from: RunState;
  readonly type: RunEvent["type"];
  readonly to: RunState;
  readonly effects: readonly RunEffect[];
};

/** Independent of LEGAL_RUN_TRANSITIONS exports (PC-RUN-001, PC-RUN-002). */
const INDEPENDENT_CHANGED_RUN_TRANSITIONS: readonly ExpectedRunTransition[] = [
  {
    from: "queued",
    type: "user_cancel",
    to: "cancelled",
    effects: ["persist_cancel_intent", "record_local_not_dispatched_proof"],
  },
  {
    from: "starting",
    type: "user_cancel",
    to: "cancel_requested",
    effects: ["persist_cancel_intent"],
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
];

/**
 * Complete test-local oracle for the 32 legal Run rows (PC-RUN-001, PC-RUN-002).
 * Derived from docs/08-STATE-MACHINES.md §1 and the accepted first-slice
 * Run contract, not from LEGAL_RUN_TRANSITIONS. Permission rows are exercised
 * with exact six-field identities supplied by fixtures; concurrent remaining
 * identities are covered separately and are not derived from implementation
 * exports.
 */
const EXPECTED_LEGAL_RUN_TRANSITIONS: readonly ExpectedRunTransition[] = [
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
  },
  {
    from: "starting",
    type: "prompt_accepted",
    to: "running",
    effects: ["persist_prompt_correlation"],
  },
  {
    from: "starting",
    type: "user_cancel",
    to: "cancel_requested",
    effects: ["persist_cancel_intent"],
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
  },
  {
    from: "awaiting_permission",
    type: "user_cancel",
    to: "cancel_requested",
    effects: ["persist_cancel_intent"],
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
];

function expectedUnresolvedAfterLegalRow(
  row: ExpectedRunTransition,
): readonly PermissionIdentity[] {
  if (
    row.type === "permission_admitted"
  ) {
    return row.from === "awaiting_permission"
      ? [identityA, identityB]
      : [identityA];
  }
  if (
    row.type === "permission_resolved_continue" ||
    row.type === "permission_denial" ||
    row.type === "permission_cancelled" ||
    row.type === "permission_expired" ||
    row.type === "permission_orphaned"
  ) {
    return [];
  }
  if (
    row.to === "completing" ||
    row.to === "completed" ||
    row.to === "failed" ||
    row.to === "cancelled" ||
    row.to === "interrupted"
  ) {
    return [];
  }
  return row.from === "awaiting_permission" ? [identityA] : [];
}

function runTransitionKey(row: ExpectedRunTransition): string {
  return `${row.from}\0${row.type}\0${row.to}\0${row.effects.join("\0")}`;
}

const UNLISTED_PAIRS: readonly {
  readonly from: RunState;
  readonly type: RunEvent["type"];
}[] = [
  { from: "queued", type: "prompt_accepted" },
  { from: "queued", type: "successful_terminal_response" },
  { from: "queued", type: "permission_denial" },
  { from: "queued", type: "cancel_notification_written" },
  { from: "starting", type: "final_commit_succeeded" },
  { from: "starting", type: "application_quit" },
  { from: "starting", type: "permission_admitted" },
  { from: "starting", type: "permission_resolved_continue" },
  { from: "running", type: "final_commit_succeeded" },
  { from: "running", type: "cancel_notification_written" },
  { from: "running", type: "runtime_confirms_cancellation" },
  { from: "running", type: "permission_denial" },
  { from: "awaiting_permission", type: "scheduler_dispatch" },
  { from: "awaiting_permission", type: "cancel_notification_written" },
  { from: "completing", type: "prompt_accepted" },
  { from: "completing", type: "user_cancel" },
  { from: "completing", type: "permission_denial" },
  { from: "cancel_requested", type: "application_quit" },
  { from: "cancel_requested", type: "user_cancel" },
  { from: "cancel_requested", type: "permission_denial" },
  { from: "cancel_requested", type: "final_commit_succeeded" },
];

describe("run machine (PC-RUN-001, PC-RUN-002, PC-RUN-003, PC-PERM-001)", () => {
  it("exports every legal table row and does not export identity rebind", () => {
    assert.equal(LEGAL_RUN_TRANSITION_COUNT, LEGAL_RUN_TRANSITIONS.length);
    assert.equal(LEGAL_RUN_TRANSITIONS.length, 32);
    assert.equal("rebindRunIdentity" in runMachine, false);
  });

  it("recursively freezes exported transition tables without sharing static effects", () => {
    assert.equal(Object.isFrozen(LEGAL_RUN_TRANSITIONS), true);
    assert.equal(Object.isFrozen(UNIVERSAL_RUN_NOOPS), true);
    const row = LEGAL_RUN_TRANSITIONS.find(
      (candidate) =>
        candidate.from === "queued" &&
        candidate.type === "scheduler_dispatch",
    );
    assert.ok(row);
    assert.equal(Object.isFrozen(row), true);
    assert.equal(Object.isFrozen(row.effects), true);

    assertTypeError(() =>
      (LEGAL_RUN_TRANSITIONS as unknown as LegalRunTransition[]).push(row),
    );
    assertTypeError(() =>
      (row.effects as unknown as RunEffect[]).push("persist_diagnostic"),
    );
    assertTypeError(() => {
      (row as unknown as { to: RunState }).to = "failed";
    });
    assertTypeError(() =>
      (UNIVERSAL_RUN_NOOPS as unknown as string[]).push("user_cancel"),
    );

    const result = applyRunEvent(
      createQueuedRun({ taskId, runId }),
      makeEvent("scheduler_dispatch", key("frozen-table")),
    );
    assertAccepted(result);
    assert.equal(result.run.state, "starting");
    assert.deepEqual([...result.effects], ["record_dispatch"]);
    assert.notEqual(result.effects, row.effects);
    assert.notEqual(
      result.run.applied.at(-1)?.recordedEffects,
      result.effects,
    );
  });

  it("deep-freezes defensive Run snapshots, identities, ledgers, effects, and results", () => {
    const queued = createQueuedRun({ taskId, runId });
    assert.equal(Object.isFrozen(queued), true);
    assert.equal(Object.isFrozen(queued.unresolvedPermissionIdentities), true);
    assert.equal(Object.isFrozen(queued.applied), true);
    assertTypeError(() => {
      (queued as unknown as { state: RunState }).state = "failed";
    });
    assertTypeError(() =>
      (queued.applied as unknown as AppliedRunKey[]).push({} as AppliedRunKey),
    );

    const callerRun = structuredClone(runInState("running")) as RunRecord;
    const callerIdentity = { ...identityA };
    const callerEvent: RunEvent = {
      type: "permission_admitted",
      identity: callerIdentity,
      idempotencyKey: key("snapshot-admit"),
    };
    const admitted = applyRunEvent(callerRun, callerEvent);
    assertAccepted(admitted);
    const admittedIdentity = admitted.run.unresolvedPermissionIdentities[0];
    const appliedEntry = admitted.run.applied.at(-1);
    assert.ok(admittedIdentity);
    assert.ok(appliedEntry);
    assert.notEqual(admitted.run, callerRun);
    assert.notEqual(admittedIdentity, callerIdentity);
    assert.equal(Object.isFrozen(admitted), true);
    assert.equal(Object.isFrozen(admitted.effects), true);
    assert.equal(Object.isFrozen(admitted.run), true);
    assert.equal(Object.isFrozen(admitted.run.unresolvedPermissionIdentities), true);
    assert.equal(Object.isFrozen(admittedIdentity), true);
    assert.equal(Object.isFrozen(admitted.run.applied), true);
    assert.equal(Object.isFrozen(appliedEntry), true);
    assert.equal(Object.isFrozen(appliedEntry.recordedEffects), true);
    assert.notEqual(admitted.effects, appliedEntry.recordedEffects);

    (callerIdentity as unknown as { windowId: typeof windowB }).windowId = windowB;
    (callerRun as unknown as { state: RunState }).state = "failed";
    const callerFirstEntry = callerRun.applied[0];
    assert.ok(callerFirstEntry);
    (callerFirstEntry as unknown as { fingerprint: string }).fingerprint = "poison";
    assert.equal(admittedIdentity.windowId, windowA);
    assert.equal(admitted.run.state, "awaiting_permission");
    assert.notEqual(admitted.run.applied[0]?.fingerprint, "poison");

    assertTypeError(() => {
      (admitted as unknown as { changed: boolean }).changed = false;
    });
    assertTypeError(() =>
      (admitted.effects as unknown as RunEffect[]).push("persist_diagnostic"),
    );
    assertTypeError(() => {
      (admitted.run as unknown as { state: RunState }).state = "failed";
    });
    assertTypeError(() =>
      (admitted.run.unresolvedPermissionIdentities as unknown as PermissionIdentity[])
        .push(identityB),
    );
    assertTypeError(() => {
      (admittedIdentity as unknown as { windowId: typeof windowB }).windowId = windowB;
    });
    assertTypeError(() => {
      (appliedEntry as unknown as { fingerprint: string }).fingerprint = "poison";
    });
    assertTypeError(() =>
      (appliedEntry.recordedEffects as unknown as RunEffect[])
        .push("persist_diagnostic"),
    );

    const resolved = applyRunEvent(
      admitted.run,
      makeEvent("permission_resolved_continue", key("snapshot-resolve"), {
        identity: identityA,
      }),
    );
    assertAccepted(resolved);
    assert.equal(resolved.run.state, "running");
    assertUnresolved(resolved.run, []);
  });

  it("fails closed on forged branded identities or poisoned ledgers", () => {
    const queued = createQueuedRun({ taskId, runId });
    const dispatch = makeEvent("scheduler_dispatch", key("invalid-input"));
    assertTypeError(() =>
      applyRunEvent(
        { ...queued, taskId: "" as TaskId },
        dispatch,
      ),
    );
    assertTypeError(() =>
      applyRunEvent(
        {
          ...queued,
          applied: [
            {
              key: key("poison-ledger"),
              fingerprint: "fingerprint",
              ok: true,
              state: "queued",
              reason: undefined,
              recordedEffects: ["not_a_run_effect" as RunEffect],
            },
          ],
        },
        dispatch,
      ),
    );
    assertTypeError(() =>
      applyRunEvent(
        runInState("running"),
        {
          type: "permission_admitted",
          identity: { ...identityA, toolCallId: "" as typeof toolCallA },
          idempotencyKey: key("poison-identity"),
        },
      ),
    );
    const awaiting = runInState("awaiting_permission");
    assertTypeError(() =>
      applyRunEvent(
        {
          ...awaiting,
          unresolvedPermissionIdentities: [identityA, { ...identityA }],
        },
        makeEvent("permission_denial", key("duplicate-unresolved"), {
          identity: identityA,
        }),
      ),
    );

    const sparseEffects = new Array<RunEffect>(1);
    assertTypeError(() =>
      applyRunEvent(
        {
          ...queued,
          applied: [
            {
              key: key("sparse-effects"),
              fingerprint: runEventFingerprint(
                makeEvent("application_quit", key("sparse-fingerprint")),
              ),
              ok: true,
              state: "queued",
              reason: undefined,
              recordedEffects: sparseEffects,
            },
          ],
        },
        dispatch,
      ),
    );
    const sparseIdentities = new Array<PermissionIdentity>(1);
    assertTypeError(() =>
      applyRunEvent(
        {
          ...queued,
          unresolvedPermissionIdentities: sparseIdentities,
        },
        dispatch,
      ),
    );
    const sparseApplied = new Array<AppliedRunKey>(1);
    assertTypeError(() =>
      applyRunEvent(
        { ...queued, applied: sparseApplied },
        dispatch,
      ),
    );
  });

  it("accepts only exact data snapshots without executing getters or proxies", () => {
    const running = runInState("running");
    assertTypeError(() =>
      canonicalizeRunRecord({ ...running, unexpected: true }),
    );

    let rootGetterCalls = 0;
    const rootAccessor = { ...running } as Record<string, unknown>;
    Object.defineProperty(rootAccessor, "state", {
      enumerable: true,
      get() {
        rootGetterCalls += 1;
        return "running";
      },
    });
    assertTypeError(() => canonicalizeRunRecord(rootAccessor));
    assert.equal(rootGetterCalls, 0);

    let proxyReads = 0;
    const proxy = new Proxy(
      { ...running },
      {
        get(target, property, receiver) {
          proxyReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    assertTypeError(() => canonicalizeRunRecord(proxy));
    assert.equal(proxyReads, 0);

    const awaiting = runInState("awaiting_permission");
    let identityGetterCalls = 0;
    const identityAccessor = { ...identityA } as Record<string, unknown>;
    Object.defineProperty(identityAccessor, "toolCallId", {
      enumerable: true,
      get() {
        identityGetterCalls += 1;
        return toolCallA;
      },
    });
    assertTypeError(() =>
      canonicalizeRunRecord({
        ...awaiting,
        unresolvedPermissionIdentities: [identityAccessor],
      }),
    );
    assert.equal(identityGetterCalls, 0);

    const firstLedgerEntry = running.applied[0];
    assert.ok(firstLedgerEntry);
    assertTypeError(() =>
      canonicalizeRunRecord({
        ...running,
        applied: [{ ...firstLedgerEntry, unexpected: true }],
      }),
    );

    let ledgerGetterCalls = 0;
    const ledgerAccessor = { ...firstLedgerEntry } as Record<string, unknown>;
    Object.defineProperty(ledgerAccessor, "state", {
      enumerable: true,
      get() {
        ledgerGetterCalls += 1;
        return firstLedgerEntry.state;
      },
    });
    assertTypeError(() =>
      canonicalizeRunRecord({ ...running, applied: [ledgerAccessor] }),
    );
    assert.equal(ledgerGetterCalls, 0);

    let arrayGetterCalls = 0;
    const appliedAccessor = [...running.applied];
    Object.defineProperty(appliedAccessor, 0, {
      enumerable: true,
      get() {
        arrayGetterCalls += 1;
        return firstLedgerEntry;
      },
    });
    assertTypeError(() =>
      canonicalizeRunRecord({ ...running, applied: appliedAccessor }),
    );
    assert.equal(arrayGetterCalls, 0);

    let arrayPrototypeGetterCalls = 0;
    const customPrototypeApplied = [...running.applied];
    Object.setPrototypeOf(customPrototypeApplied, {
      get map() {
        arrayPrototypeGetterCalls += 1;
        return Array.prototype.map;
      },
      get some() {
        arrayPrototypeGetterCalls += 1;
        return Array.prototype.some;
      },
    });
    assertTypeError(() =>
      canonicalizeRunRecord({
        ...running,
        applied: customPrototypeApplied,
      }),
    );
    assert.equal(arrayPrototypeGetterCalls, 0);
  });

  it("requires a legal persisted ledger history before replay or terminal authority", () => {
    const starting = runInState("starting");
    assertTypeError(() =>
      applyRunEvent(
        {
          ...starting,
          state: "running",
          promptAccepted: true,
        },
        makeEvent("successful_terminal_response", key("forged-running")),
      ),
    );

    const running = runInState("running");
    assertTypeError(() =>
      applyRunEvent(
        { ...running, state: "completing" },
        makeEvent("final_commit_succeeded", key("forged-completing")),
      ),
    );

    assertTypeError(() =>
      applyRunEvent(
        {
          ...starting,
          state: "cancel_requested",
          cancelIntent: true,
        },
        makeEvent(
          "process_exit_confirms_cancellation",
          key("forged-cancellation-proof"),
        ),
      ),
    );

    const replayKey = key("forged-replay");
    const replayEvent = makeEvent("scheduler_dispatch", replayKey);
    const forgedReplayLedger: AppliedRunKey = {
      key: replayKey,
      fingerprint: runEventFingerprint(replayEvent),
      ok: true,
      state: "starting",
      reason: undefined,
      recordedEffects: ["record_dispatch"],
    };
    assertTypeError(() =>
      applyRunEvent(
        {
          ...createQueuedRun({ taskId, runId }),
          applied: [forgedReplayLedger],
        },
        replayEvent,
      ),
    );

    const terminalKey = key("forged-failed-terminal");
    const terminalEvent = makeEvent(
      "successful_terminal_response",
      terminalKey,
    );
    assertTypeError(() =>
      applyRunEvent(
        {
          ...running,
          applied: [
            ...running.applied,
            {
              key: terminalKey,
              fingerprint: runEventFingerprint(terminalEvent),
              ok: false,
              state: "running",
              reason: "forged_rejection",
              recordedEffects: [],
            },
          ],
        },
        terminalEvent,
      ),
    );

    const admitKey = key("forged-identity-admit");
    const admitA = makeEvent("permission_admitted", admitKey, {
      identity: identityA,
    });
    assertTypeError(() =>
      applyRunEvent(
        {
          ...running,
          state: "awaiting_permission",
          unresolvedPermissionIdentities: [identityB],
          applied: [
            ...running.applied,
            {
              key: admitKey,
              fingerprint: runEventFingerprint(admitA),
              ok: true,
              state: "awaiting_permission",
              reason: undefined,
              recordedEffects: ["persist_permission_request"],
            },
          ],
        },
        makeEvent("permission_denial", key("forged-identity-resolve"), {
          identity: identityB,
        }),
      ),
    );
  });

  it("freezes failure replay results and preserves the ledger after mutation attempts", () => {
    const illegalKey = key("frozen-failure");
    const illegalEvent = makeEvent("prompt_accepted", illegalKey);
    const first = applyRunEvent(
      createQueuedRun({ taskId, runId }),
      illegalEvent,
    );
    assert.equal(first.ok, false);
    if (first.ok) return;
    const failureEntry = first.run.applied.at(-1);
    assert.ok(failureEntry);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.run), true);
    assert.equal(Object.isFrozen(first.run.applied), true);
    assert.equal(Object.isFrozen(failureEntry), true);
    assert.equal(Object.isFrozen(failureEntry.recordedEffects), true);
    assertTypeError(() => {
      (first as unknown as { reason: string }).reason = "poison";
    });
    assertTypeError(() =>
      (first.run.applied as unknown as AppliedRunKey[]).pop(),
    );
    assertTypeError(() =>
      (failureEntry.recordedEffects as unknown as RunEffect[])
        .push("persist_diagnostic"),
    );

    const replay = applyRunEvent(first.run, illegalEvent);
    assert.equal(replay.ok, false);
    if (replay.ok) return;
    assert.equal(replay.idempotent, true);
    assert.equal(replay.reason, "illegal_transition");
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.run), true);
    assertTypeError(() => {
      (replay as unknown as { idempotent: boolean }).idempotent = false;
    });

    const dispatch = applyRunEvent(
      replay.run,
      makeEvent("scheduler_dispatch", key("after-failure-replay")),
    );
    assertAccepted(dispatch);
    assert.equal(dispatch.run.state, "starting");

    const successReplay = applyRunEvent(
      dispatch.run,
      makeEvent(
        "scheduler_dispatch",
        dispatch.run.applied.at(-1)?.key ?? key("unreachable"),
      ),
    );
    assertAccepted(successReplay);
    assert.equal(successReplay.idempotent, true);
    assert.equal(Object.isFrozen(successReplay), true);
    assert.equal(Object.isFrozen(successReplay.effects), true);
    assertTypeError(() =>
      (successReplay.effects as unknown as RunEffect[])
        .push("persist_diagnostic"),
    );
  });

  it("applies independently expected changed Run transitions", () => {
    for (const expected of INDEPENDENT_CHANGED_RUN_TRANSITIONS) {
      const run = runInState(expected.from);
      const result = applyRunEvent(
        run,
        rowEvent(expected, `ind-${expected.from}-${expected.type}`),
      );
      assertAccepted(result);
      assert.equal(
        result.run.state,
        expected.to,
        `${expected.from} + ${expected.type}`,
      );
      assert.deepEqual(
        [...result.effects],
        [...expected.effects],
        `${expected.from} + ${expected.type}`,
      );
      assertUnresolved(
        result.run,
        expectedUnresolvedAfterLegalRow(expected),
      );
      const exported = LEGAL_RUN_TRANSITIONS.find(
        (row) => row.from === expected.from && row.type === expected.type,
      );
      assert.ok(exported, `${expected.from} + ${expected.type} missing from export`);
      assert.equal(exported?.to, expected.to);
      assert.deepEqual([...(exported?.effects ?? [])], [...expected.effects]);
    }
  });

  it("applies every legal Run row with the required effects", () => {
    assert.equal(EXPECTED_LEGAL_RUN_TRANSITIONS.length, 32);
    const expectedKeys = EXPECTED_LEGAL_RUN_TRANSITIONS.map(runTransitionKey);
    const exportedKeys = LEGAL_RUN_TRANSITIONS.map(runTransitionKey);
    assert.equal(new Set(expectedKeys).size, expectedKeys.length);
    assert.equal(new Set(exportedKeys).size, exportedKeys.length);
    assert.deepEqual([...exportedKeys].sort(), [...expectedKeys].sort());

    for (const row of EXPECTED_LEGAL_RUN_TRANSITIONS) {
      const run = runInState(row.from);
      const result = applyRunEvent(
        run,
        rowEvent(row, `legal-${row.from}-${row.type}`),
      );
      assertAccepted(result);
      assert.equal(result.run.state, row.to, `${row.from} + ${row.type}`);
      assert.deepEqual([...result.effects], [...row.effects], `${row.from} + ${row.type}`);
      assert.equal(result.changed, true);
      assert.equal(result.idempotent, false);
      assert.equal(result.run.taskId, run.taskId);
      assert.equal(result.run.runId, run.runId);
      assertUnresolved(result.run, expectedUnresolvedAfterLegalRow(row));
    }
  });

  it("rejects representative unlisted pairs without mutation", () => {
    for (const pair of UNLISTED_PAIRS) {
      const run = runInState(pair.from);
      const snapshot = structuredClone(run);
      const result = applyRunEvent(
        run,
        makeEvent(pair.type, key(`unlisted-${pair.from}-${pair.type}`)),
      );
      assert.equal(result.ok, false, `${pair.from} + ${pair.type}`);
      if (result.ok) {
        continue;
      }
      assert.equal(result.audit, true);
      assert.equal(result.run.state, pair.from);
      assert.equal(result.run.cancelIntent, snapshot.cancelIntent);
      assert.equal(result.run.promptAccepted, snapshot.promptAccepted);
      assert.equal(result.run.sessionId, snapshot.sessionId);
      assert.equal(result.run.adapterEpoch, snapshot.adapterEpoch);
      assert.deepEqual(
        result.run.unresolvedPermissionIdentities,
        snapshot.unresolvedPermissionIdentities,
      );
    }
  });

  it("treats the four terminal states as absorbing", () => {
    assert.deepEqual([...TERMINAL_RUN_STATES], [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    for (const state of TERMINAL_RUN_STATES) {
      assert.equal(isTerminalRunState(state), true);
      const run = runInState(state);
      for (const type of ALL_EVENT_TYPES) {
        const before = runInState(state);
        const result = applyRunEvent(before, makeEvent(type, key(`term-${state}-${type}`)));
        if ((UNIVERSAL_RUN_NOOPS as readonly string[]).includes(type)) {
          assertAccepted(result);
          assert.equal(result.run.state, state);
          assert.equal(result.changed, false);
          assert.deepEqual([...result.effects], []);
          continue;
        }
        assert.equal(result.ok, false, `${state} + ${type}`);
        if (result.ok) {
          continue;
        }
        assert.equal(result.reason, type === "stale_identity_event" ? "stale_identity" : "terminal_absorbing");
        assert.equal(result.run.state, state);
        assert.equal(result.audit, true);
      }
    }
    for (const state of RUN_STATES) {
      assert.equal(
        isTerminalRunState(state),
        (TERMINAL_RUN_STATES as readonly string[]).includes(state),
      );
    }
  });

  it("covers queued and starting cancellation, notification without proof, and races", () => {
    const queued = runInState("queued");
    const queuedCancel = applyRunEvent(queued, makeEvent("user_cancel", key("q-cancel")));
    assertAccepted(queuedCancel);
    assert.equal(queuedCancel.run.state, "cancelled");
    assert.equal(queuedCancel.run.cancelIntent, true);
    assert.equal(queuedCancel.run.promptAccepted, false);
    assert.deepEqual(
      [...queuedCancel.effects],
      ["persist_cancel_intent", "record_local_not_dispatched_proof"],
    );
    assert.equal(queuedCancel.effects.includes("return_exact_safe_permission_response"), false);
    assertUnresolved(queuedCancel.run, []);
    assert.equal(
      (RUN_EFFECTS as readonly string[]).includes("cancel_notification_written"),
      false,
    );

    const lateDispatch = applyRunEvent(
      queuedCancel.run,
      makeEvent("scheduler_dispatch", key("q-late-dispatch")),
    );
    assert.equal(lateDispatch.ok, false);
    if (!lateDispatch.ok) {
      assert.equal(lateDispatch.reason, "terminal_absorbing");
      assert.equal(lateDispatch.run.state, "cancelled");
      assert.equal(lateDispatch.run.cancelIntent, true);
    }

    const starting = runInState("starting");
    const startingCancel = applyRunEvent(
      starting,
      makeEvent("user_cancel", key("s-cancel")),
    );
    assertAccepted(startingCancel);
    assert.equal(startingCancel.run.state, "cancel_requested");

    const forced = applyRunEvent(
      startingCancel.run,
      makeEvent("process_exit_confirms_cancellation", key("forced")),
    );
    assertAccepted(forced);
    assert.equal(forced.run.state, "cancelled");
    assert.deepEqual([...forced.effects], ["record_proof_close_epoch"]);

    const liveCancel = runInState("cancel_requested");
    const notify = applyRunEvent(
      liveCancel,
      makeEvent("cancel_notification_written", key("notify")),
    );
    assertAccepted(notify);
    assert.equal(notify.run.state, "cancel_requested");
    assert.equal(notify.run.cancelIntent, true);

    const completionWins = applyRunEvent(
      liveCancel,
      makeEvent("successful_terminal_response", key("race-win")),
    );
    assertAccepted(completionWins);
    assert.equal(completionWins.run.state, "completing");
    assert.equal(completionWins.run.cancelIntent, true);
    assert.deepEqual([...completionWins.effects], ["stage_truthful_result"]);

    const completing = runInState("completing");
    const cancelWins = applyRunEvent(
      completing,
      makeEvent("cancel_wins_before_commit", key("cancel-wins")),
    );
    assertAccepted(cancelWins);
    assert.equal(cancelWins.run.state, "cancel_requested");
    assert.deepEqual(
      [...cancelWins.effects],
      ["persist_cancel_intent_discard_completion"],
    );
  });

  it("rejects key-payload collisions and replays true duplicates with zero effects", () => {
    const run = runInState("queued");
    const dispatchKey = key("dup-dispatch");
    const first = applyRunEvent(
      run,
      makeEvent("scheduler_dispatch", dispatchKey, { sessionId }),
    );
    assertAccepted(first);
    assert.equal(first.run.state, "starting");
    const duplicate = applyRunEvent(
      first.run,
      makeEvent("scheduler_dispatch", dispatchKey, { sessionId }),
    );
    assertAccepted(duplicate);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.changed, false);
    assert.deepEqual([...duplicate.effects], []);
    assert.equal(duplicate.run.state, "starting");
    assert.equal(duplicate.run.applied.length, first.run.applied.length);

    const collision = applyRunEvent(
      first.run,
      makeEvent("scheduler_dispatch", dispatchKey, { sessionId: otherSession }),
    );
    assert.equal(collision.ok, false);
    if (!collision.ok) {
      assert.equal(collision.reason, "idempotency_collision");
      assert.equal(collision.audit, true);
      assert.equal(collision.idempotent, false);
      assert.equal(collision.run.state, "starting");
      assert.equal(collision.run.sessionId, sessionId);
      assert.equal(collision.run.applied.length, first.run.applied.length);
    }

    const typeCollision = applyRunEvent(
      first.run,
      makeEvent("user_cancel", dispatchKey),
    );
    assert.equal(typeCollision.ok, false);
    if (!typeCollision.ok) {
      assert.equal(typeCollision.reason, "idempotency_collision");
      assert.equal(typeCollision.run.state, "starting");
    }
  });

  it("interrupts live work on application quit and leaves queued as a no-op", () => {
    const queued = applyRunEvent(
      runInState("queued"),
      makeEvent("application_quit", key("quit-q")),
    );
    assertAccepted(queued);
    assert.equal(queued.run.state, "queued");
    assert.equal(queued.changed, false);
    assert.deepEqual([...queued.effects], []);

    for (const state of ["running", "awaiting_permission", "completing"] as const) {
      const result = applyRunEvent(
        runInState(state),
        makeEvent("application_quit", key(`quit-${state}`)),
      );
      assertAccepted(result);
      assert.equal(result.run.state, "interrupted");
      assert.deepEqual(
        [...result.effects],
        ["persist_reason_expire_permissions_close_epoch"],
      );
    }
  });

  it("persists chronological session and tool updates during cancellation without side effects", () => {
    const run = runInState("cancel_requested");
    assert.equal(run.cancelIntent, true);
    for (const channel of ["session", "tool"] as const) {
      const updateKey = key(`live-${channel}`);
      const first = applyRunEvent(
        run,
        makeEvent("live_update", updateKey, { channel }),
      );
      assertAccepted(first);
      assert.equal(first.run.state, "cancel_requested");
      assert.equal(first.run.cancelIntent, true);
      assert.deepEqual([...first.effects], ["persist_chronological_output"]);
      const replay = applyRunEvent(
        first.run,
        makeEvent("live_update", updateKey, { channel }),
      );
      assertAccepted(replay);
      assert.equal(replay.idempotent, true);
      assert.deepEqual([...replay.effects], []);
      assert.equal(replay.run.state, "cancel_requested");
      assert.equal(replay.run.cancelIntent, true);
    }
    const channelCollisionKey = key("live-collision");
    const sessionUpdate = applyRunEvent(
      run,
      makeEvent("live_update", channelCollisionKey, { channel: "session" }),
    );
    assertAccepted(sessionUpdate);
    const toolCollision = applyRunEvent(
      sessionUpdate.run,
      makeEvent("live_update", channelCollisionKey, { channel: "tool" }),
    );
    assert.equal(toolCollision.ok, false);
    if (!toolCollision.ok) {
      assert.equal(toolCollision.reason, "idempotency_collision");
      assert.equal(toolCollision.run.state, "cancel_requested");
    }
  });

  it("persists a cancel-time permission request and requests one exact safe response", () => {
    const run = runInState("cancel_requested");
    for (const type of ["permission_admitted"] as const) {
      const permKey = key(`cancel-perm-${type}`);
      const first = applyRunEvent(run, makeEvent(type, permKey));
      assertAccepted(first);
      assert.equal(first.run.state, "cancel_requested");
      assert.equal(first.run.cancelIntent, true);
      assert.deepEqual(
        [...first.effects],
        ["persist_permission_request", "return_exact_safe_permission_response"],
      );
      assert.equal(first.effects.includes("persist_exactly_once_resolution"), false);
      assertUnresolved(first.run, []);
      const replay = applyRunEvent(first.run, makeEvent(type, permKey));
      assertAccepted(replay);
      assert.equal(replay.idempotent, true);
      assert.deepEqual([...replay.effects], []);
      assert.equal(replay.run.state, "cancel_requested");
      assertUnresolved(replay.run, []);
      const repeatedIdentity = applyRunEvent(
        first.run,
        makeEvent(type, key(`cancel-perm-${type}-again`), { identity: identityA }),
      );
      assertAccepted(repeatedIdentity);
      assert.equal(repeatedIdentity.changed, false);
      assert.equal(repeatedIdentity.idempotent, false);
      assert.deepEqual([...repeatedIdentity.effects], []);
      assert.equal(repeatedIdentity.run.state, "cancel_requested");
      assertUnresolved(repeatedIdentity.run, []);
    }
  });

  it("keeps task/session/epoch identity stable after prompt acceptance", () => {
    const running = runInState("running");
    assert.equal(running.promptAccepted, true);
    assert.equal(running.sessionId, sessionId);
    assert.equal(running.adapterEpoch, epoch);
    const later = applyRunEvent(running, makeEvent("user_cancel", key("id-cancel")));
    assertAccepted(later);
    assert.equal(later.run.taskId, taskId);
    assert.equal(later.run.sessionId, sessionId);
    assert.equal(later.run.adapterEpoch, epoch);
    const mismatch = applyRunEvent(
      runInState("starting"),
      makeEvent("prompt_accepted", key("bad-prompt"), {
        sessionId: otherSession,
      }),
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.reason, "identity_mismatch");
      assert.equal(mismatch.run.state, "starting");
    }
  });

  it("tracks concurrent permissions and reverse resolution order", () => {
    const running = runInState("running");
    const first = applyRunEvent(
      running,
      makeEvent("permission_admitted", key("perm-a"), { identity: identityA }),
    );
    assertAccepted(first);
    assert.equal(first.run.state, "awaiting_permission");
    assertUnresolved(first.run, [identityA]);

    const second = applyRunEvent(
      first.run,
      makeEvent("permission_admitted", key("perm-b"), { identity: identityB }),
    );
    assertAccepted(second);
    assert.equal(second.run.state, "awaiting_permission");
    assertUnresolved(second.run, [identityA, identityB]);

    const resolveB = applyRunEvent(
      second.run,
      makeEvent("permission_resolved_continue", key("resolve-b"), {
        identity: identityB,
      }),
    );
    assertAccepted(resolveB);
    assert.equal(resolveB.run.state, "awaiting_permission");
    assertUnresolved(resolveB.run, [identityA]);
    assert.deepEqual(
      [...resolveB.effects],
      ["persist_exactly_once_resolution"],
    );

    const resolveA = applyRunEvent(
      resolveB.run,
      makeEvent("permission_resolved_continue", key("resolve-a"), {
        identity: identityA,
      }),
    );
    assertAccepted(resolveA);
    assert.equal(resolveA.run.state, "running");
    assertUnresolved(resolveA.run, []);

    const admittedA = applyRunEvent(
      runInState("running"),
      makeEvent("permission_admitted", key("order-a"), { identity: identityA }),
    );
    assertAccepted(admittedA);
    assertUnresolved(admittedA.run, [identityA]);
    const admittedB = applyRunEvent(
      admittedA.run,
      makeEvent("permission_admitted", key("order-b"), { identity: identityB }),
    );
    assertAccepted(admittedB);
    assertUnresolved(admittedB.run, [identityA, identityB]);
    const firstResolved = applyRunEvent(
      admittedB.run,
      makeEvent("permission_resolved_continue", key("order-a-first"), {
        identity: identityA,
      }),
    );
    assertAccepted(firstResolved);
    assert.equal(firstResolved.run.state, "awaiting_permission");
    assertUnresolved(firstResolved.run, [identityB]);
    const lastResolved = applyRunEvent(
      firstResolved.run,
      makeEvent("permission_resolved_continue", key("order-b-last"), {
        identity: identityB,
      }),
    );
    assertAccepted(lastResolved);
    assert.equal(lastResolved.run.state, "running");
    assertUnresolved(lastResolved.run, []);

    const deniedOne = applyRunEvent(
      admittedB.run,
      makeEvent("permission_denial", key("deny-b"), { identity: identityB }),
    );
    assertAccepted(deniedOne);
    assert.equal(deniedOne.run.state, "awaiting_permission");
    assertUnresolved(deniedOne.run, [identityA]);
    const expiredLast = applyRunEvent(
      deniedOne.run,
      makeEvent("permission_expired", key("expire-a"), { identity: identityA }),
    );
    assertAccepted(expiredLast);
    assert.equal(expiredLast.run.state, "running");
    assertUnresolved(expiredLast.run, []);
  });

  it("produces a durable safe-cancel permission intent during cancel_requested", () => {
    const run = runInState("cancel_requested");
    const permKey = key("cancel-perm-machine");
    const runResult = applyRunEvent(
      run,
      makeEvent("permission_admitted", permKey),
    );
    assertAccepted(runResult);
    assert.equal(runResult.run.state, "cancel_requested");
    assert.equal(runResult.run.cancelIntent, true);
    assert.deepEqual(
      [...runResult.effects],
      ["persist_permission_request", "return_exact_safe_permission_response"],
    );
    assertUnresolved(runResult.run, []);

    const cancelCommandId = must(parsePermissionOutboxCommandId("cancel-cmd-1"));
    const registered = registerPermissionRequest([], {
      identity: {
        taskId,
        runId,
        sessionId,
        toolCallId: must(parseToolCallId("tool-1")),
        adapterEpoch: epoch,
        windowId: must(parseWindowId("win-1")),
      },
      request: permissionRequest(identityA),
      idempotencyKey: permKey,
      mode: "run_cancel_requested",
      transportCanReceive: false,
      commandId: cancelCommandId,
    });
    assert.equal(registered.ok, true);
    if (!registered.ok) {
      return;
    }
    assert.equal(registered.duplicate, false);
    assert.equal(registered.record.state, "orphaned");
    assert.equal(registered.record.orphanCause, "run_cancel_requested");
    assert.equal(registered.record.outbox, undefined);
    assert.equal(registered.sideEffect, "none");
    assert.equal(registered.records.length, 1);
    assertUnresolved(runResult.run, []);
  });

  it("accepts a repeated exact identity under a new event key as a semantic duplicate", () => {
    const firstKey = key("dup-id-a");
    const first = applyRunEvent(
      runInState("running"),
      makeEvent("permission_admitted", firstKey, { identity: identityA }),
    );
    assertAccepted(first);
    assert.equal(first.run.state, "awaiting_permission");
    assertUnresolved(first.run, [identityA]);
    assert.deepEqual([...first.effects], ["persist_permission_request"]);

    const repeat = applyRunEvent(
      first.run,
      makeEvent("permission_admitted", key("dup-id-a-again"), {
        identity: identityA,
      }),
    );
    assertAccepted(repeat);
    assert.equal(repeat.changed, false);
    assert.equal(repeat.idempotent, false);
    assert.deepEqual([...repeat.effects], []);
    assert.equal(repeat.run.state, "awaiting_permission");
    assertUnresolved(repeat.run, [identityA]);

    const replay = applyRunEvent(
      first.run,
      makeEvent("permission_admitted", firstKey, { identity: identityA }),
    );
    assertAccepted(replay);
    assert.equal(replay.idempotent, true);
    assert.deepEqual([...replay.effects], []);
    assertUnresolved(replay.run, [identityA]);

    const collision = applyRunEvent(
      first.run,
      makeEvent("permission_admitted", firstKey, { identity: identityB }),
    );
    assert.equal(collision.ok, false);
    if (!collision.ok) {
      assert.equal(collision.reason, "idempotency_collision");
      assert.equal(collision.audit, true);
    }
    assert.equal(collision.run.state, "awaiting_permission");
    assertUnresolved(collision.run, [identityA]);
  });

  it("resolves only the exact unresolved identity and rejects unknown or mismatched tuples", () => {
    const waiting = runInState("awaiting_permission");
    assertUnresolved(waiting, [identityA]);

    const wrongWindow = applyRunEvent(
      waiting,
      makeEvent("permission_resolved_continue", key("unknown-window"), {
        identity: permIdentity({ windowId: windowB }),
      }),
    );
    assert.equal(wrongWindow.ok, false);
    if (!wrongWindow.ok) {
      assert.equal(wrongWindow.reason, "no_unresolved_permission");
      assert.equal(wrongWindow.audit, true);
    }
    assert.equal(wrongWindow.run.state, "awaiting_permission");
    assertUnresolved(wrongWindow.run, [identityA]);

    const wrongTool = applyRunEvent(
      waiting,
      makeEvent("permission_denial", key("unknown-tool"), {
        identity: permIdentity({ toolCallId: toolCallB }),
      }),
    );
    assert.equal(wrongTool.ok, false);
    if (!wrongTool.ok) {
      assert.equal(wrongTool.reason, "no_unresolved_permission");
    }
    assertUnresolved(wrongTool.run, [identityA]);

    const mismatched = [
      permIdentity({ taskId: otherTask }),
      permIdentity({ runId: otherRun }),
      permIdentity({ sessionId: otherSession }),
      permIdentity({ adapterEpoch: otherEpoch }),
    ];
    for (const identity of mismatched) {
      const result = applyRunEvent(
        waiting,
        makeEvent("permission_expired", key("mismatch"), { identity }),
      );
      assert.equal(result.ok, false, JSON.stringify(identity));
      if (!result.ok) {
        assert.equal(result.reason, "identity_mismatch");
        assert.equal(result.audit, true);
      }
      assert.equal(result.run.state, "awaiting_permission");
      assertUnresolved(result.run, [identityA]);
    }

    const exact = applyRunEvent(
      waiting,
      makeEvent("permission_resolved_continue", key("exact-a"), {
        identity: identityA,
      }),
    );
    assertAccepted(exact);
    assert.equal(exact.run.state, "running");
    assertUnresolved(exact.run, []);
    assert.deepEqual([...exact.effects], ["persist_exactly_once_resolution"]);
  });

  it("clears every unresolved identity on completing and terminal paths", () => {
    function withTwoIdentities(): RunRecord {
      const first = applyRunEvent(
        runInState("running"),
        makeEvent("permission_admitted", key("clear-a"), { identity: identityA }),
      );
      assertAccepted(first);
      const second = applyRunEvent(
        first.run,
        makeEvent("permission_admitted", key("clear-b"), { identity: identityB }),
      );
      assertAccepted(second);
      assertUnresolved(second.run, [identityA, identityB]);
      return second.run;
    }

    const completing = applyRunEvent(
      withTwoIdentities(),
      makeEvent("successful_terminal_response", key("clear-term")),
    );
    assertAccepted(completing);
    assert.equal(completing.run.state, "completing");
    assertUnresolved(completing.run, []);

    const failed = applyRunEvent(
      withTwoIdentities(),
      makeEvent("protocol_terminal_error", key("clear-fail")),
    );
    assertAccepted(failed);
    assert.equal(failed.run.state, "failed");
    assertUnresolved(failed.run, []);

    const interrupted = applyRunEvent(
      withTwoIdentities(),
      makeEvent("ownership_lost_before_completion", key("clear-int")),
    );
    assertAccepted(interrupted);
    assert.equal(interrupted.run.state, "interrupted");
    assertUnresolved(interrupted.run, []);

    const cancelRequested = applyRunEvent(
      withTwoIdentities(),
      makeEvent("user_cancel", key("clear-cancel")),
    );
    assertAccepted(cancelRequested);
    assert.equal(cancelRequested.run.state, "cancel_requested");
    assertUnresolved(cancelRequested.run, [identityA, identityB]);

    const cancelled = applyRunEvent(
      cancelRequested.run,
      makeEvent("runtime_confirms_cancellation", key("clear-confirm")),
    );
    assertAccepted(cancelled);
    assert.equal(cancelled.run.state, "cancelled");
    assertUnresolved(cancelled.run, []);

    const raceComplete = applyRunEvent(
      cancelRequested.run,
      makeEvent("successful_terminal_response", key("clear-race")),
    );
    assertAccepted(raceComplete);
    assert.equal(raceComplete.run.state, "completing");
    assertUnresolved(raceComplete.run, []);
  });

  it("registers one exact identity once across permission and run machines", () => {
    const running = runInState("running");
    const firstKey = key("cross-reg-1");
    const secondKey = key("cross-reg-2");

    const firstReg = registerPermissionRequest([], {
      identity: identityA,
      request: permissionRequest(identityA),
      idempotencyKey: firstKey,
    });
    assert.equal(firstReg.ok, true);
    if (!firstReg.ok) {
      return;
    }
    assert.equal(firstReg.duplicate, false);
    assert.equal(firstReg.record.state, "pending");
    assert.equal(firstReg.records.length, 1);
    assert.equal(
      permissionIdentitiesEqual(firstReg.record.identity, identityA),
      true,
    );

    const firstRun = applyRunEvent(
      running,
      makeEvent("permission_admitted", firstKey, { identity: identityA }),
    );
    assertAccepted(firstRun);
    assert.equal(firstRun.run.state, "awaiting_permission");
    assertUnresolved(firstRun.run, [identityA]);
    assert.deepEqual([...firstRun.effects], ["persist_permission_request"]);

    const secondReg = registerPermissionRequest(firstReg.records, {
      identity: identityA,
      request: permissionRequest(identityA),
      idempotencyKey: secondKey,
    });
    assert.equal(secondReg.ok, true);
    if (!secondReg.ok) {
      return;
    }
    assert.equal(secondReg.duplicate, true);
    assert.equal(secondReg.records.length, 1);
    assert.equal(secondReg.record.state, "pending");
    assert.equal(
      permissionIdentitiesEqual(secondReg.record.identity, identityA),
      true,
    );

    const secondRun = applyRunEvent(
      firstRun.run,
      makeEvent("permission_admitted", secondKey, { identity: identityA }),
    );
    assertAccepted(secondRun);
    assert.equal(secondRun.changed, false);
    assert.equal(secondRun.idempotent, false);
    assert.deepEqual([...secondRun.effects], []);
    assert.equal(secondRun.run.state, "awaiting_permission");
    assertUnresolved(secondRun.run, [identityA]);
    assert.equal(secondReg.records.length, 1);

    const resolved = applyRunEvent(
      secondRun.run,
      makeEvent("permission_resolved_continue", key("cross-resolve"), {
        identity: identityA,
      }),
    );
    assertAccepted(resolved);
    assert.equal(resolved.run.state, "running");
    assertUnresolved(resolved.run, []);
    assert.deepEqual([...resolved.effects], ["persist_exactly_once_resolution"]);
    assert.equal(secondReg.records.length, 1);
  });

  it("rejects stale identity events without a transition", () => {
    const running = runInState("running");
    const result = applyRunEvent(running, { type: "stale_identity_event" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "stale_identity");
      assert.equal(result.audit, true);
      assert.equal(result.run.state, "running");
    }
  });

  it("treats redelivery of a resolved identity under a new key as a semantic no-op for every exact resolution", () => {
    const resolutionTypes = [
      "permission_resolved_continue",
      "permission_denial",
      "permission_cancelled",
      "permission_expired",
      "permission_orphaned",
    ] as const;

    for (const resolutionType of resolutionTypes) {
      // Admit → resolve → redeliver same identity under new key
      const running = runInState("running");
      const admitted = applyRunEvent(
        running,
        makeEvent("permission_admitted", key(`resolved-${resolutionType}-admit`), {
          identity: identityA,
        }),
      );
      assertAccepted(admitted);
      assert.equal(admitted.run.state, "awaiting_permission");
      assertUnresolved(admitted.run, [identityA]);

      const resolved = applyRunEvent(
        admitted.run,
        makeEvent(resolutionType, key(`resolved-${resolutionType}-resolve`), {
          identity: identityA,
        }),
      );
      assertAccepted(resolved);
      assert.equal(resolved.run.state, "running");
      assertUnresolved(resolved.run, []);

      // Redeliver the same identity under a brand-new key
      const redelivered = applyRunEvent(
        resolved.run,
        makeEvent("permission_admitted", key(`resolved-${resolutionType}-redeliver`), {
          identity: identityA,
        }),
      );
      assertAccepted(redelivered);
      assert.equal(
        redelivered.run.state,
        "running",
        `${resolutionType}: should stay running`,
      );
      assert.equal(redelivered.changed, false);
      assert.deepEqual([...redelivered.effects], []);
      assertUnresolved(redelivered.run, []);
    }
  });

  it("still opens a new permission request for a different identity after prior resolution", () => {
    const running = runInState("running");

    // Admit and resolve identityA
    const admitted = applyRunEvent(
      running,
      makeEvent("permission_admitted", key("diff-admit-a"), {
        identity: identityA,
      }),
    );
    assertAccepted(admitted);
    const resolved = applyRunEvent(
      admitted.run,
      makeEvent("permission_resolved_continue", key("diff-resolve-a"), {
        identity: identityA,
      }),
    );
    assertAccepted(resolved);
    assert.equal(resolved.run.state, "running");
    assertUnresolved(resolved.run, []);

    // identityB is genuinely new → should open a new request
    const newPermission = applyRunEvent(
      resolved.run,
      makeEvent("permission_admitted", key("diff-admit-b"), {
        identity: identityB,
      }),
    );
    assertAccepted(newPermission);
    assert.equal(newPermission.run.state, "awaiting_permission");
    assert.equal(newPermission.changed, true);
    assert.deepEqual([...newPermission.effects], ["persist_permission_request"]);
    assertUnresolved(newPermission.run, [identityB]);
  });

  it("still rejects a terminal Run even with prior resolved permission history", () => {
    const running = runInState("running");

    // Admit, resolve, then terminate
    const admitted = applyRunEvent(
      running,
      makeEvent("permission_admitted", key("term-hist-admit"), {
        identity: identityA,
      }),
    );
    assertAccepted(admitted);
    const resolved = applyRunEvent(
      admitted.run,
      makeEvent("permission_resolved_continue", key("term-hist-resolve"), {
        identity: identityA,
      }),
    );
    assertAccepted(resolved);

    const completed = applyRunEvent(
      resolved.run,
      makeEvent("successful_terminal_response", key("term-hist-complete")),
    );
    assertAccepted(completed);
    const final = applyRunEvent(
      completed.run,
      makeEvent("final_commit_succeeded", key("term-hist-commit")),
    );
    assertAccepted(final);
    assert.equal(final.run.state, "completed");

    // Redeliver same identity → terminal absorbing
    const redelivered = applyRunEvent(
      final.run,
      makeEvent("permission_admitted", key("term-hist-redeliver"), {
        identity: identityA,
      }),
    );
    assert.equal(redelivered.ok, false);
    if (!redelivered.ok) {
      assert.equal(redelivered.reason, "terminal_absorbing");
      assert.equal(redelivered.audit, true);
      assert.equal(redelivered.run.state, "completed");
    }

    // Also verify for failed terminal state
    const failedRun = runInState("running");
    const failAdmit = applyRunEvent(
      failedRun,
      makeEvent("permission_admitted", key("term-fail-admit"), {
        identity: identityA,
      }),
    );
    assertAccepted(failAdmit);
    const failResolve = applyRunEvent(
      failAdmit.run,
      makeEvent("permission_denial", key("term-fail-deny"), {
        identity: identityA,
      }),
    );
    assertAccepted(failResolve);
    const failed = applyRunEvent(
      failResolve.run,
      makeEvent("protocol_terminal_error", key("term-fail-error")),
    );
    assertAccepted(failed);
    assert.equal(failed.run.state, "failed");

    const failRedeliver = applyRunEvent(
      failed.run,
      makeEvent("permission_admitted", key("term-fail-redeliver"), {
        identity: identityA,
      }),
    );
    assert.equal(failRedeliver.ok, false);
    if (!failRedeliver.ok) {
      assert.equal(failRedeliver.reason, "terminal_absorbing");
      assert.equal(failRedeliver.run.state, "failed");
    }
  });

  it("agrees between PermissionMachine duplicate and Run duplicate on resolved redelivery", () => {
    const running = runInState("running");
    const admitKey = key("agree-admit");
    const resolveKey = key("agree-resolve");

    // Register in PermissionMachine
    const reg1 = registerPermissionRequest([], {
      identity: identityA,
      request: permissionRequest(identityA),
      idempotencyKey: admitKey,
    });
    assert.equal(reg1.ok, true);
    if (!reg1.ok) return;
    assert.equal(reg1.duplicate, false);

    // Admit in RunMachine
    const admitted = applyRunEvent(
      running,
      makeEvent("permission_admitted", admitKey, { identity: identityA }),
    );
    assertAccepted(admitted);
    assert.equal(admitted.run.state, "awaiting_permission");

    // Resolve
    const resolved = applyRunEvent(
      admitted.run,
      makeEvent("permission_resolved_continue", resolveKey, {
        identity: identityA,
      }),
    );
    assertAccepted(resolved);
    assert.equal(resolved.run.state, "running");

    // Redeliver same identity with new key to both machines
    const redeliverKey = key("agree-redeliver");

    // PermissionMachine: duplicate registration
    const reg2 = registerPermissionRequest(reg1.records, {
      identity: identityA,
      request: permissionRequest(identityA),
      idempotencyKey: redeliverKey,
    });
    assert.equal(reg2.ok, true);
    if (!reg2.ok) return;
    assert.equal(reg2.duplicate, true);
    assert.equal(reg2.records.length, 1);

    // RunMachine: semantic no-op
    const runRedeliver = applyRunEvent(
      resolved.run,
      makeEvent("permission_admitted", redeliverKey, { identity: identityA }),
    );
    assertAccepted(runRedeliver);
    assert.equal(runRedeliver.run.state, "running");
    assert.equal(runRedeliver.changed, false);
    assert.deepEqual([...runRedeliver.effects], []);
    assertUnresolved(runRedeliver.run, []);
  });
});
