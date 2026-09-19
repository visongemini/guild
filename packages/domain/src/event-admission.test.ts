import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeTurnEvent,
  parseAdapterEpoch,
  parseBarrierRequestId,
  parseIdempotencyKey,
  parseRunId,
  parseRuntimeEnvelope,
  parseSessionAttemptId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  PERMISSION_IDENTITY_FIELDS,
  TERMINAL_RUN_STATES,
  type AdapterEpoch,
  type IdempotencyKey,
  type PermissionIdentity,
  type Result,
  type RuntimeEnvelope,
  type RuntimeTurnEvent,
  type RuntimeTurnEventInput,
  type SessionAttemptId,
  type SessionId,
  type TaskId,
  type WindowId,
} from "@guild/contracts";
import {
  admitRuntimeEnvelope,
  admitRuntimeTurnEvent,
  envelopeFingerprint,
  FIRST_RECEIVE_SEQUENCE,
  NO_COMMITTED_RECEIVE_SEQUENCE,
  PERMISSION_SAFE_CANCEL_REGISTER_MODE,
  permissionIdentityFromEnvelope,
  REPLAY_STAGING_CONSTRAINTS,
  type AdmissionContext,
  type AdmissionResult,
  type RuntimeTurnAdmissionResult,
} from "./event-admission.js";
import * as domainRoot from "./index.js";
import {
  applyRunEvent,
  createQueuedRun,
  type RunRecord,
} from "./run-machine.js";
import {
  applySessionBindingEvent,
  createUnboundBinding,
  SESSION_BINDING_STATES,
  type SessionBindingEvent,
  type SessionBindingRecord,
} from "./session-binding.js";

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
const epoch1: AdapterEpoch = must(parseAdapterEpoch(1));
const epoch2: AdapterEpoch = must(parseAdapterEpoch(2));
const toolCallId = must(parseToolCallId("tool-1"));
const otherTool = must(parseToolCallId("tool-2"));
const windowId: WindowId = must(parseWindowId("win-1"));
const otherWindow: WindowId = must(parseWindowId("win-2"));
const barrierA = must(parseBarrierRequestId("barrier-a"));
const createAttempt: SessionAttemptId = must(parseSessionAttemptId("create-1"));
const restoreAttempt: SessionAttemptId = must(parseSessionAttemptId("restore-1"));

let seq = 0;
function nextKey(label: string): string {
  seq += 1;
  return `${label}-${seq}`;
}

function domainKey(label: string): IdempotencyKey {
  return must(parseIdempotencyKey(nextKey(label)));
}

function envelope(overrides: Record<string, unknown> = {}): RuntimeEnvelope {
  return must(
    parseRuntimeEnvelope({
      taskId: "task-a",
      runId: "run-1",
      sessionId: "sess-1",
      adapterEpoch: 1,
      ingestMode: "live",
      receiveSequence: FIRST_RECEIVE_SEQUENCE,
      idempotencyKey: nextKey("env"),
      kind: "session_update",
      semanticPayloadDigest: "sem-default",
      ...overrides,
    }),
  );
}

function turnEvent(overrides: Record<string, unknown> = {}): RuntimeTurnEvent {
  return must(
    createRuntimeTurnEvent({
      taskId: "task-a",
      runId: "run-1",
      adapterEpoch: 1,
      ingestMode: "live",
      receiveSequence: FIRST_RECEIVE_SEQUENCE,
      idempotencyKey: nextKey("turn"),
      payload: {
        type: "agent_text_chunk",
        sessionId: "sess-1",
        received: {
          wallClockIso: "2026-08-27T12:00:00.000Z",
          monotonicMs: 100,
        },
        messageId: "message-1",
        text: "hello",
      },
      ...overrides,
    } as unknown as RuntimeTurnEventInput),
  );
}

function identity(
  overrides: Partial<PermissionIdentity> = {},
): PermissionIdentity {
  return {
    taskId,
    runId,
    sessionId,
    toolCallId,
    adapterEpoch: epoch1,
    windowId,
    ...overrides,
  };
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  let record = createQueuedRun({ taskId, runId });
  const dispatched = applyRunEvent(record, {
    type: "scheduler_dispatch",
    sessionId,
    adapterEpoch: epoch1,
    idempotencyKey: domainKey("context-dispatch"),
  });
  if (!dispatched.ok) return assert.fail(dispatched.reason);
  record = dispatched.run;
  const accepted = applyRunEvent(record, {
    type: "prompt_accepted",
    sessionId,
    adapterEpoch: epoch1,
    idempotencyKey: domainKey("context-prompt"),
  });
  if (!accepted.ok) return assert.fail(accepted.reason);
  return { ...accepted.run, ...overrides };
}

function applyBinding(
  binding: SessionBindingRecord,
  event: SessionBindingEvent,
): SessionBindingRecord {
  const result = applySessionBindingEvent(binding, event);
  if (!result.ok) return assert.fail(result.reason);
  return result.binding;
}

function canonicalHealthyBinding(): SessionBindingRecord {
  return applyBinding(
    applyBinding(createUnboundBinding(taskId), {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: domainKey("context-session-start"),
    }),
    {
      type: "session_new_succeeded",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: createAttempt,
      idempotencyKey: domainKey("context-session-new"),
    },
  );
}

function healthyBinding(
  overrides: Partial<SessionBindingRecord> = {},
): SessionBindingRecord {
  return { ...canonicalHealthyBinding(), ...overrides };
}

function reconcilingBinding(
  overrides: Partial<SessionBindingRecord> = {},
): SessionBindingRecord {
  const restorePending = applyBinding(canonicalHealthyBinding(), {
    type: "transport_lost",
    sessionId,
    adapterEpoch: epoch1,
    attemptId: restoreAttempt,
    idempotencyKey: domainKey("context-transport-lost"),
  });
  const reconciling = applyBinding(restorePending, {
    type: "load_began",
    sessionId,
    adapterEpoch: epoch2,
    barrierRequestId: barrierA,
    attemptId: restoreAttempt,
    idempotencyKey: domainKey("context-load-began"),
  });
  return { ...reconciling, ...overrides };
}

function liveContext(
  overrides: Partial<AdmissionContext> = {},
): AdmissionContext {
  return {
    binding: healthyBinding(),
    currentEpoch: epoch1,
    epochStatus: "alive",
    committed: [],
    lastCommittedReceiveSequence: NO_COMMITTED_RECEIVE_SEQUENCE,
    run: runRecord(),
    authorizedWindowId: windowId,
    persistedOwningWindowId: windowId,
    pendingPermissionIdentities: [],
    ...overrides,
  };
}

function replayContext(
  overrides: Partial<AdmissionContext> = {},
): AdmissionContext {
  return {
    binding: reconcilingBinding(),
    currentEpoch: epoch2,
    epochStatus: "alive",
    committed: [],
    lastCommittedReceiveSequence: NO_COMMITTED_RECEIVE_SEQUENCE,
    run: undefined,
    authorizedWindowId: undefined,
    persistedOwningWindowId: undefined,
    pendingPermissionIdentities: [],
    ...overrides,
  };
}

function assertDenied(result: AdmissionResult, reason: string): void {
  assert.equal(result.ok, false, result.ok ? "expected deny" : result.reason);
  if (!result.ok) {
    assert.equal(result.reason, reason);
    assert.equal(result.audit, true);
  }
}

function assertLiveAdmitted(result: AdmissionResult, duplicate = false): void {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) {
    return;
  }
  assert.equal(result.duplicate, duplicate);
  assert.equal(result.ingestMode, "live");
  assert.equal(result.destination, "live");
  assert.equal("permissionRegisterMode" in result, false);
  assert.equal("constraints" in result, false);
  assert.equal("sideEffect" in result, false);
}

function assertPermissionSafeCancel(
  result: AdmissionResult,
  duplicate = false,
): void {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) {
    return;
  }
  assert.equal(result.duplicate, duplicate);
  assert.equal(result.ingestMode, "live");
  if (result.destination !== "permission_safe_cancel") {
    assert.fail(`expected permission_safe_cancel, got ${result.destination}`);
    return;
  }
  assert.notEqual(result.destination, "live");
  assert.equal(
    result.permissionRegisterMode,
    PERMISSION_SAFE_CANCEL_REGISTER_MODE,
  );
  assert.equal(result.permissionRegisterMode, "run_cancel_requested");
  assert.equal("constraints" in result, false);
  assert.equal("sideEffect" in result, false);
}

function assertReplayStaged(result: AdmissionResult, duplicate = false): void {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  if (!result.ok) {
    return;
  }
  assert.equal(result.duplicate, duplicate);
  assert.equal(result.ingestMode, "replay");
  assert.equal(result.destination, "staging");
  assert.deepEqual(result.constraints, REPLAY_STAGING_CONSTRAINTS);
  assert.equal(Object.isFrozen(REPLAY_STAGING_CONSTRAINTS), true);
  assert.equal(Object.isFrozen(result.constraints), true);
  assert.equal(result.constraints.mayCreateRun, false);
  assert.equal(result.constraints.mayTransitionRun, false);
  assert.equal(result.constraints.mayActivatePermission, false);
  assert.equal(result.constraints.mayResolvePermission, false);
  assert.equal(result.constraints.mayExecuteTool, false);
  assert.equal(result.constraints.mayRepeatSideEffect, false);
  assert.equal(result.constraints.mayAdvanceLiveTimers, false);
  assert.equal(result.constraints.mayAppendDirectly, false);
}

function assertCanonicalEvent(result: RuntimeTurnAdmissionResult): RuntimeTurnEvent {
  if (!result.ok) assert.fail(result.reason);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.event), true);
  assert.equal(Object.isFrozen(result.event.payload), true);
  assert.equal(Object.isFrozen(result.event.payload.received), true);
  assert.equal(Object.isFrozen(result.event.envelope), true);
  return result.event;
}

function assertFrozenSafeDenial(
  result: RuntimeTurnAdmissionResult,
  reason: string,
): void {
  assertDenied(result, reason);
  assert.equal(Object.isFrozen(result), true);
  assert.equal("event" in result, false);
  const mutable = result as unknown as {
    ok: boolean;
    destination?: string;
  };
  assert.throws(() => {
    mutable.ok = true;
  }, TypeError);
  assert.throws(() => {
    mutable.destination = "live";
  }, TypeError);
  assert.equal(result.ok, false);
  assert.equal("event" in result, false);
  assert.equal("destination" in result, false);
}

describe("event admission (PC-EVENT-001, PC-TRN-002, PC-PERM-001)", () => {
  it("exports only safe package-root admission and accepts exact live/replay events", () => {
    assert.equal(domainRoot.admitRuntimeTurnEvent, admitRuntimeTurnEvent);
    assert.equal("admitRuntimeEnvelope" in domainRoot, false);

    const liveAdmission = admitRuntimeTurnEvent(turnEvent(), liveContext());
    assertLiveAdmitted(liveAdmission);
    assert.equal(assertCanonicalEvent(liveAdmission).envelope.ingestMode, "live");

    const replayAdmission = admitRuntimeTurnEvent(
      turnEvent({ ingestMode: "replay", adapterEpoch: 2 }),
      replayContext(),
    );
    assertReplayStaged(replayAdmission);
    assert.equal(assertCanonicalEvent(replayAdmission).envelope.ingestMode, "replay");
  });

  it("keeps exported and returned replay constraints immutable across admissions", () => {
    const exported = REPLAY_STAGING_CONSTRAINTS as unknown as {
      mayExecuteTool: boolean;
    };
    assert.throws(() => {
      exported.mayExecuteTool = true;
    }, TypeError);
    assert.equal(REPLAY_STAGING_CONSTRAINTS.mayExecuteTool, false);

    const first = admitRuntimeTurnEvent(
      turnEvent({ ingestMode: "replay", adapterEpoch: 2 }),
      replayContext(),
    );
    assertReplayStaged(first);
    if (!first.ok || first.destination !== "staging") {
      assert.fail(first.ok ? first.destination : first.reason);
    }
    const returned = first.constraints as unknown as { mayExecuteTool: boolean };
    assert.throws(() => {
      returned.mayExecuteTool = true;
    }, TypeError);

    const later = admitRuntimeTurnEvent(
      turnEvent({ ingestMode: "replay", adapterEpoch: 2 }),
      replayContext(),
    );
    assertReplayStaged(later);
  });

  it("safe admission rejects wrong routing, ownership, and forged pairs", () => {
    for (const [event, reason] of [
      [turnEvent({ taskId: "task-b" }), "wrong_task"],
      [turnEvent({ runId: "run-2" }), "wrong_run"],
      [
        turnEvent({
          payload: {
            type: "agent_text_chunk",
            sessionId: "sess-2",
            received: {
              wallClockIso: "2026-08-27T12:00:00.000Z",
              monotonicMs: 100,
            },
            text: "wrong session",
          },
        }),
        "wrong_session",
      ],
      [turnEvent({ adapterEpoch: 2 }), "stale_epoch"],
    ] as const) {
      assertFrozenSafeDenial(admitRuntimeTurnEvent(event, liveContext()), reason);
    }

    const wrongWindow = turnEvent({
      persistedOwningWindowId: "win-2",
      payload: {
        type: "permission_request",
        sessionId: "sess-1",
        received: {
          wallClockIso: "2026-08-27T12:00:00.000Z",
          monotonicMs: 100,
        },
        callbackRequestId: "callback-1",
        toolCallId: "tool-1",
        title: "Read?",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    });
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(wrongWindow, liveContext()),
      "wrong_window",
    );

    const exact = turnEvent();
    const forged = {
      payload: exact.payload,
      envelope: { ...exact.envelope, kind: "tool_call" },
    } as unknown as RuntimeTurnEvent;
    const rejected = domainRoot.admitRuntimeTurnEvent(forged, liveContext());
    assertFrozenSafeDenial(rejected, "invalid_runtime_turn_event");
  });

  it("fail-closes forged persisted admission context before routing", () => {
    const validEvent = turnEvent();
    const forgedRun = {
      ...runRecord(),
      state: "completed" as const,
    };
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({ run: forgedRun }),
      ),
      "invalid_admission_context",
    );

    const forgedBinding = {
      ...healthyBinding(),
      applied: [],
    };
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({ binding: forgedBinding }),
      ),
      "invalid_admission_context",
    );

    const pendingA = identity();
    const admitted = applyRunEvent(runRecord(), {
      type: "permission_admitted",
      identity: pendingA,
      idempotencyKey: domainKey("context-admit"),
    });
    if (!admitted.ok) assert.fail(admitted.reason);
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({
          run: admitted.run,
          pendingPermissionIdentities: [identity({ windowId: otherWindow })],
        }),
      ),
      "invalid_admission_context",
    );

    const sparseCommitted = new Array<AdmissionContext["committed"][number]>(1);
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({ committed: sparseCommitted }),
      ),
      "invalid_admission_context",
    );

    let getterCalls = 0;
    const accessorContext = liveContext() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorContext, "run", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return runRecord();
      },
    });
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        accessorContext as unknown as AdmissionContext,
      ),
      "invalid_admission_context",
    );
    assert.equal(getterCalls, 0);

    const proxyContext = new Proxy(liveContext(), {
      ownKeys() {
        throw new Error("must be contained");
      },
    });
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(validEvent, proxyContext),
      "invalid_admission_context",
    );

    let transparentRootProxyTraps = 0;
    const transparentRootProxy = new Proxy(liveContext(), {
      get(target, property, receiver) {
        transparentRootProxyTraps += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        transparentRootProxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        transparentRootProxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
      ownKeys(target) {
        transparentRootProxyTraps += 1;
        return Reflect.ownKeys(target);
      },
    });
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(validEvent, transparentRootProxy),
      "invalid_admission_context",
    );
    assert.equal(transparentRootProxyTraps, 0);

    let committedArrayProxyTraps = 0;
    const committedArrayProxy = new Proxy([], {
      get() {
        committedArrayProxyTraps += 1;
        throw new Error("must not read committed array proxy");
      },
      ownKeys() {
        committedArrayProxyTraps += 1;
        throw new Error("must not inspect committed array proxy");
      },
    });
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({ committed: committedArrayProxy }),
      ),
      "invalid_admission_context",
    );
    assert.equal(committedArrayProxyTraps, 0);

    let committedArrayPrototypeReads = 0;
    const customPrototypeCommitted: AdmissionContext["committed"][number][] = [];
    Object.setPrototypeOf(customPrototypeCommitted, {
      get [Symbol.iterator]() {
        committedArrayPrototypeReads += 1;
        return Array.prototype[Symbol.iterator];
      },
    });
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({ committed: customPrototypeCommitted }),
      ),
      "invalid_admission_context",
    );
    assert.equal(committedArrayPrototypeReads, 0);

    let committedEntryProxyTraps = 0;
    const committedEntryProxy = new Proxy(
      { key: domainKey("proxy-committed"), fingerprint: "fingerprint" },
      {
        get() {
          committedEntryProxyTraps += 1;
          throw new Error("must not read committed entry proxy");
        },
        ownKeys() {
          committedEntryProxyTraps += 1;
          throw new Error("must not inspect committed entry proxy");
        },
      },
    );
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({ committed: [committedEntryProxy] }),
      ),
      "invalid_admission_context",
    );
    assert.equal(committedEntryProxyTraps, 0);

    let identityProxyTraps = 0;
    const identityProxy = new Proxy(pendingA, {
      get() {
        identityProxyTraps += 1;
        throw new Error("must not read permission identity proxy");
      },
      ownKeys() {
        identityProxyTraps += 1;
        throw new Error("must not inspect permission identity proxy");
      },
    });
    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        liveContext({
          run: admitted.run,
          pendingPermissionIdentities: [identityProxy],
        }),
      ),
      "invalid_admission_context",
    );
    assert.equal(identityProxyTraps, 0);

    assertFrozenSafeDenial(
      admitRuntimeTurnEvent(
        validEvent,
        { ...liveContext(), extra: true } as unknown as AdmissionContext,
      ),
      "invalid_admission_context",
    );
  });

  it("returns the canonical frozen event for TOCTOU-safe downstream consumption", () => {
    const original = turnEvent();
    for (const mutable of [
      structuredClone(original),
      JSON.parse(JSON.stringify(original)) as RuntimeTurnEvent,
    ]) {
      const admission = admitRuntimeTurnEvent(mutable, liveContext());
      assertLiveAdmitted(admission);
      const canonical = assertCanonicalEvent(admission);
      assert.notEqual(canonical, mutable);
      const digest = canonical.envelope.semanticPayloadDigest;
      const text = canonical.payload.type === "agent_text_chunk"
        ? canonical.payload.text
        : assert.fail("wrong payload type");

      const mutablePayload = mutable.payload as { text: string };
      const mutableEnvelope = mutable.envelope as unknown as {
        kind: string;
        semanticPayloadDigest: string;
      };
      mutablePayload.text = "mutated after admission";
      mutableEnvelope.kind = "tool_call";
      mutableEnvelope.semanticPayloadDigest = "mutated";

      assert.equal(canonical.payload.type, "agent_text_chunk");
      if (canonical.payload.type === "agent_text_chunk") {
        assert.equal(canonical.payload.text, text);
      }
      assert.equal(canonical.envelope.kind, "session_update");
      assert.equal(canonical.envelope.semanticPayloadDigest, digest);
    }
  });

  it("returns canonical events for duplicate and permission success", () => {
    const duplicateInput = structuredClone(turnEvent());
    const duplicateAdmission = admitRuntimeTurnEvent(
      duplicateInput,
      liveContext({
        committed: [{
          key: duplicateInput.envelope.idempotencyKey,
          fingerprint: envelopeFingerprint(duplicateInput.envelope),
        }],
      }),
    );
    assertLiveAdmitted(duplicateAdmission, true);
    assert.equal(
      assertCanonicalEvent(duplicateAdmission).envelope.idempotencyKey,
      duplicateInput.envelope.idempotencyKey,
    );

    const permissionInput = turnEvent({
      persistedOwningWindowId: "win-1",
      payload: {
        type: "permission_request",
        sessionId: "sess-1",
        received: {
          wallClockIso: "2026-08-27T12:00:00.000Z",
          monotonicMs: 100,
        },
        callbackRequestId: "callback-1",
        toolCallId: "tool-1",
        title: "Read?",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    });
    const permissionAdmission = admitRuntimeTurnEvent(permissionInput, liveContext());
    assertLiveAdmitted(permissionAdmission);
    const canonicalPermission = assertCanonicalEvent(permissionAdmission);
    assert.equal(canonicalPermission.payload.type, "permission_request");
    assert.equal(canonicalPermission.envelope.windowId, windowId);
  });

  it("admits a matching live envelope to the live destination", () => {
    const result = admitRuntimeEnvelope(envelope(), liveContext());
    assertLiveAdmitted(result);
    if (!result.ok) {
      return;
    }
    assert.equal(result.duplicate, false);
  });

  it("stages replay with every side-effect constraint denied", () => {
    const env = envelope({
      ingestMode: "replay",
      adapterEpoch: 2,
    });
    const result = admitRuntimeEnvelope(env, replayContext());
    assertReplayStaged(result);
    assert.deepEqual(
      { ...REPLAY_STAGING_CONSTRAINTS },
      {
        mayCreateRun: false,
        mayTransitionRun: false,
        mayActivatePermission: false,
        mayResolvePermission: false,
        mayExecuteTool: false,
        mayRepeatSideEffect: false,
        mayAdvanceLiveTimers: false,
        mayAppendDirectly: false,
      },
    );
  });

  it("denies wrong task, run, session, epoch, and ingest mode", () => {
    assertDenied(
      admitRuntimeEnvelope(envelope({ taskId: "task-b" }), liveContext()),
      "wrong_task",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          run: runRecord({ taskId: otherTask }),
        }),
      ),
      "wrong_task",
    );
    assertDenied(
      admitRuntimeEnvelope(envelope({ runId: "run-2" }), liveContext()),
      "wrong_run",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({ run: runRecord({ runId: otherRun }) }),
      ),
      "wrong_run",
    );
    assertDenied(
      admitRuntimeEnvelope(envelope({ sessionId: "sess-2" }), liveContext()),
      "wrong_session",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          run: runRecord({ sessionId: otherSession }),
        }),
      ),
      "wrong_session",
    );
    assertDenied(
      admitRuntimeEnvelope(envelope({ adapterEpoch: 2 }), liveContext()),
      "stale_epoch",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          binding: healthyBinding({ adapterEpoch: epoch2 }),
        }),
      ),
      "stale_epoch",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          run: runRecord({ adapterEpoch: epoch2 }),
        }),
      ),
      "stale_epoch",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({ ingestMode: "replay" }),
        liveContext(),
      ),
      "replay_not_reconciling",
    );
    assertDenied(
      admitRuntimeEnvelope(envelope(), replayContext()),
      "replay_barrier_open",
    );
  });

  it("denies terminal runs and unhealthy or malformed bindings", () => {
    for (const state of TERMINAL_RUN_STATES) {
      assertDenied(
        admitRuntimeEnvelope(
          envelope(),
          liveContext({ run: runRecord({ state }) }),
        ),
        "run_terminal",
      );
    }

    const unhealthy = SESSION_BINDING_STATES.filter(
      (state) => state !== "healthy" && state !== "replay_reconciling",
    );
    for (const state of unhealthy) {
      assertDenied(
        admitRuntimeEnvelope(
          envelope(),
          liveContext({ binding: healthyBinding({ state }) }),
        ),
        "binding_not_healthy",
      );
    }

    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          epochStatus: "exited",
        }),
      ),
      "exited_epoch",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          epochStatus: "absent",
        }),
      ),
      "exited_epoch",
    );

    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          binding: healthyBinding({ sessionId: undefined }),
        }),
      ),
      "binding_malformed",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          binding: healthyBinding({ retainedSessionId: undefined }),
        }),
      ),
      "binding_malformed",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          binding: healthyBinding({ retainedSessionId: otherSession }),
        }),
      ),
      "binding_malformed",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          binding: healthyBinding({ adapterEpoch: undefined }),
        }),
      ),
      "binding_malformed",
    );
    assertDenied(
      admitRuntimeEnvelope(envelope(), liveContext({ run: undefined })),
      "default_deny",
    );
  });

  it("requires replay barrier identity and rejects live traffic while a barrier is open", () => {
    const replayEnv = envelope({
      ingestMode: "replay",
      adapterEpoch: 2,
    });
    assertDenied(
      admitRuntimeEnvelope(
        replayEnv,
        replayContext({
          binding: reconcilingBinding({ replayBarrier: undefined }),
        }),
      ),
      "missing_barrier",
    );
    assertDenied(
      admitRuntimeEnvelope(
        replayEnv,
        replayContext({
          binding: reconcilingBinding({
            replayBarrier: {
              requestId: barrierA,
              sessionId: otherSession,
              adapterEpoch: epoch2,
              attemptId: restoreAttempt,
            },
          }),
        }),
      ),
      "wrong_session",
    );
    assertDenied(
      admitRuntimeEnvelope(
        replayEnv,
        replayContext({
          binding: reconcilingBinding({
            replayBarrier: {
              requestId: barrierA,
              sessionId,
              adapterEpoch: epoch1,
              attemptId: restoreAttempt,
            },
          }),
        }),
      ),
      "stale_epoch",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          ingestMode: "replay",
          adapterEpoch: 2,
          sessionId: "sess-2",
        }),
        replayContext(),
      ),
      "wrong_session",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({ ingestMode: "replay", adapterEpoch: 2, taskId: "task-b" }),
        replayContext(),
      ),
      "wrong_task",
    );

    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          binding: healthyBinding({
            replayBarrier: {
              requestId: barrierA,
              sessionId,
              adapterEpoch: epoch1,
              attemptId: restoreAttempt,
            },
          }),
        }),
      ),
      "replay_barrier_open",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope(),
        liveContext({
          binding: reconcilingBinding({
            adapterEpoch: epoch1,
            replayBarrier: {
              requestId: barrierA,
              sessionId,
              adapterEpoch: epoch1,
              attemptId: restoreAttempt,
            },
          }),
        }),
      ),
      "replay_barrier_open",
    );
  });

  it("admits a permission request only for the exact authorized window", () => {
    const request = envelope({
      kind: "permission_request",
      toolCallId: "tool-1",
      windowId: "win-1",
    });
    assertLiveAdmitted(admitRuntimeEnvelope(request, liveContext()));
    assertLiveAdmitted(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
          idempotencyKey: request.idempotencyKey,
          semanticPayloadDigest: request.semanticPayloadDigest,
        }),
        liveContext({
          committed: [
            {
              key: request.idempotencyKey,
              fingerprint: envelopeFingerprint(request),
            },
          ],
        }),
      ),
      true,
    );

    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
        }),
        liveContext({ authorizedWindowId: undefined }),
      ),
      "no_authorized_window",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
        }),
        liveContext({ authorizedWindowId: otherWindow }),
      ),
      "wrong_window",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-2",
        }),
        liveContext(),
      ),
      "wrong_window",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
        }),
        liveContext(),
      ),
      "missing_window_id",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
        }),
        liveContext({ persistedOwningWindowId: undefined }),
      ),
      "no_persisted_owning_window",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
        }),
        liveContext({ persistedOwningWindowId: otherWindow }),
      ),
      "wrong_window",
    );
    const committedRequest = envelope({
      kind: "permission_request",
      toolCallId: "tool-1",
      windowId: "win-1",
    });
    const committed = [
      {
        key: committedRequest.idempotencyKey,
        fingerprint: envelopeFingerprint(committedRequest),
      },
    ];
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
          idempotencyKey: committedRequest.idempotencyKey,
          semanticPayloadDigest: committedRequest.semanticPayloadDigest,
        }),
        liveContext({
          persistedOwningWindowId: undefined,
          committed,
        }),
      ),
      "no_persisted_owning_window",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
          idempotencyKey: committedRequest.idempotencyKey,
          semanticPayloadDigest: committedRequest.semanticPayloadDigest,
        }),
        liveContext({
          persistedOwningWindowId: otherWindow,
          committed,
        }),
      ),
      "wrong_window",
    );
  });

  it("admits a cancel-time permission request as permission_safe_cancel for the persisted owner", () => {
    const request = envelope({
      kind: "permission_request",
      toolCallId: "tool-1",
      windowId: "win-1",
    });
    const cancelContext = liveContext({
      run: runRecord({ state: "cancel_requested", cancelIntent: true }),
      authorizedWindowId: undefined,
      persistedOwningWindowId: windowId,
    });
    const first = admitRuntimeEnvelope(request, cancelContext);
    assertPermissionSafeCancel(first);
    if (first.ok && first.destination === "permission_safe_cancel") {
      assert.equal(first.duplicate, false);
      assert.equal(first.permissionRegisterMode, "run_cancel_requested");
    }

    const focusedElsewhere = admitRuntimeEnvelope(
      envelope({
        kind: "permission_request",
        toolCallId: "tool-1",
        windowId: "win-1",
      }),
      liveContext({
        run: runRecord({ state: "cancel_requested", cancelIntent: true }),
        authorizedWindowId: otherWindow,
        persistedOwningWindowId: windowId,
      }),
    );
    assertPermissionSafeCancel(focusedElsewhere);

    const redirectedToFocus = admitRuntimeEnvelope(
      envelope({
        kind: "permission_request",
        toolCallId: "tool-1",
        windowId: "win-2",
      }),
      liveContext({
        run: runRecord({ state: "cancel_requested", cancelIntent: true }),
        authorizedWindowId: otherWindow,
        persistedOwningWindowId: windowId,
      }),
    );
    assertDenied(redirectedToFocus, "wrong_window");

    const committed = [
      {
        key: request.idempotencyKey,
        fingerprint: envelopeFingerprint(request),
      },
    ];
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
          idempotencyKey: request.idempotencyKey,
          semanticPayloadDigest: request.semanticPayloadDigest,
        }),
        liveContext({
          run: runRecord({ state: "cancel_requested", cancelIntent: true }),
          authorizedWindowId: undefined,
          persistedOwningWindowId: undefined,
          committed,
        }),
      ),
      "no_persisted_owning_window",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_request",
          toolCallId: "tool-1",
          windowId: "win-1",
          idempotencyKey: request.idempotencyKey,
          semanticPayloadDigest: request.semanticPayloadDigest,
        }),
        liveContext({
          run: runRecord({ state: "cancel_requested", cancelIntent: true }),
          authorizedWindowId: undefined,
          persistedOwningWindowId: otherWindow,
          committed,
        }),
      ),
      "wrong_window",
    );

    const exactDuplicate = admitRuntimeEnvelope(
      envelope({
        kind: "permission_request",
        toolCallId: "tool-1",
        windowId: "win-1",
        idempotencyKey: request.idempotencyKey,
        semanticPayloadDigest: request.semanticPayloadDigest,
        receiveSequence: 9,
      }),
      liveContext({
        run: runRecord({ state: "cancel_requested", cancelIntent: true }),
        authorizedWindowId: undefined,
        persistedOwningWindowId: windowId,
        committed,
        lastCommittedReceiveSequence: 5,
      }),
    );
    assertPermissionSafeCancel(exactDuplicate, true);
  });

  it("admits a permission resolution only for the exact pending identity tuple", () => {
    assert.deepEqual([...PERMISSION_IDENTITY_FIELDS], [
      "taskId",
      "runId",
      "sessionId",
      "toolCallId",
      "adapterEpoch",
      "windowId",
    ]);
    const pending = identity();
    const context = liveContext({
      run: runRecord({ state: "awaiting_permission" }),
      pendingPermissionIdentities: [pending],
    });
    const matching = envelope({
      kind: "permission_resolution",
      toolCallId: "tool-1",
      windowId: "win-1",
    });
    assert.deepEqual(permissionIdentityFromEnvelope(matching), pending);
    assertLiveAdmitted(admitRuntimeEnvelope(matching, context));

    const mismatches: RuntimeEnvelope[] = [
      envelope({
        kind: "permission_resolution",
        toolCallId: "tool-2",
        windowId: "win-1",
      }),
      envelope({
        kind: "permission_resolution",
        toolCallId: "tool-1",
        windowId: "win-2",
      }),
    ];
    for (const env of mismatches) {
      assertDenied(
        admitRuntimeEnvelope(env, context),
        "permission_identity_mismatch",
      );
    }

    const pendingMismatches: PermissionIdentity[] = [
      identity({ taskId: otherTask }),
      identity({ runId: otherRun }),
      identity({ sessionId: otherSession }),
      identity({ toolCallId: otherTool }),
      identity({ adapterEpoch: epoch2 }),
      identity({ windowId: otherWindow }),
    ];
    for (const candidate of pendingMismatches) {
      assertDenied(
        admitRuntimeEnvelope(
          envelope({
            kind: "permission_resolution",
            toolCallId: "tool-1",
            windowId: "win-1",
          }),
          liveContext({
            run: runRecord({ state: "awaiting_permission" }),
            pendingPermissionIdentities: [candidate],
          }),
        ),
        "permission_identity_mismatch",
      );
    }

    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          kind: "permission_resolution",
          toolCallId: "tool-1",
          windowId: "win-1",
        }),
        liveContext({
          run: runRecord({ state: "awaiting_permission" }),
          pendingPermissionIdentities: [],
        }),
      ),
      "permission_identity_mismatch",
    );
    assert.equal(
      permissionIdentityFromEnvelope(envelope({ kind: "session_update" })),
      undefined,
    );
  });

  it("treats exact key-and-payload matches as duplicates and payload mismatches as collisions", () => {
    const liveEnv = envelope();
    const liveDup = admitRuntimeEnvelope(
      liveEnv,
      liveContext({
        committed: [
          {
            key: liveEnv.idempotencyKey,
            fingerprint: envelopeFingerprint(liveEnv),
          },
        ],
      }),
    );
    assertLiveAdmitted(liveDup, true);

    const liveCollision = admitRuntimeEnvelope(
      envelope({
        idempotencyKey: liveEnv.idempotencyKey,
        kind: "tool_call",
        toolCallId: "tool-1",
      }),
      liveContext({
        committed: [
          {
            key: liveEnv.idempotencyKey,
            fingerprint: envelopeFingerprint(liveEnv),
          },
        ],
      }),
    );
    assertDenied(liveCollision, "idempotency_collision");

    const replayEnv = envelope({
      ingestMode: "replay",
      adapterEpoch: 2,
    });
    const replayDup = admitRuntimeEnvelope(
      replayEnv,
      replayContext({
        committed: [
          {
            key: replayEnv.idempotencyKey,
            fingerprint: envelopeFingerprint(replayEnv),
          },
        ],
      }),
    );
    assertReplayStaged(replayDup, true);

    const replayCollision = admitRuntimeEnvelope(
      envelope({
        ingestMode: "replay",
        adapterEpoch: 2,
        idempotencyKey: replayEnv.idempotencyKey,
        kind: "tool_call",
        toolCallId: "tool-1",
      }),
      replayContext({
        committed: [
          {
            key: replayEnv.idempotencyKey,
            fingerprint: envelopeFingerprint(replayEnv),
          },
        ],
      }),
    );
    assertDenied(replayCollision, "idempotency_collision");
  });

  it("admits the first receive sequence and rejects gaps, stale values, and invalid context", () => {
    assert.equal(FIRST_RECEIVE_SEQUENCE, 1);
    assert.equal(NO_COMMITTED_RECEIVE_SEQUENCE, 0);

    assertLiveAdmitted(
      admitRuntimeEnvelope(
        envelope({ receiveSequence: FIRST_RECEIVE_SEQUENCE }),
        liveContext({
          lastCommittedReceiveSequence: NO_COMMITTED_RECEIVE_SEQUENCE,
        }),
      ),
    );
    assertLiveAdmitted(
      admitRuntimeEnvelope(
        envelope({ receiveSequence: 4 }),
        liveContext({ lastCommittedReceiveSequence: 3 }),
      ),
    );

    assertDenied(
      admitRuntimeEnvelope(
        envelope({ receiveSequence: 2 }),
        liveContext({
          lastCommittedReceiveSequence: NO_COMMITTED_RECEIVE_SEQUENCE,
        }),
      ),
      "out_of_order_receive_sequence",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({ receiveSequence: 6 }),
        liveContext({ lastCommittedReceiveSequence: 3 }),
      ),
      "out_of_order_receive_sequence",
    );

    assertDenied(
      admitRuntimeEnvelope(
        envelope({ receiveSequence: 3 }),
        liveContext({ lastCommittedReceiveSequence: 3 }),
      ),
      "stale_receive_sequence",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({ receiveSequence: 1 }),
        liveContext({ lastCommittedReceiveSequence: 3 }),
      ),
      "stale_receive_sequence",
    );

    for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assertDenied(
        admitRuntimeEnvelope(
          envelope({ receiveSequence: FIRST_RECEIVE_SEQUENCE }),
          liveContext({ lastCommittedReceiveSequence: invalid }),
        ),
        "receive_sequence_context_invalid",
      );
    }
  });

  it("admits chronological session and tool updates during cancel_requested without client-side side effects", () => {
    const context = liveContext({
      run: runRecord({ state: "cancel_requested", cancelIntent: true }),
    });
    const sessionUpdate = admitRuntimeEnvelope(
      envelope({ kind: "session_update" }),
      context,
    );
    assertLiveAdmitted(sessionUpdate);
    if (sessionUpdate.ok) {
      assert.equal(sessionUpdate.destination, "live");
      assert.equal(sessionUpdate.duplicate, false);
    }

    const toolUpdate = admitRuntimeEnvelope(
      envelope({ kind: "tool_call", toolCallId: "tool-1" }),
      context,
    );
    assertLiveAdmitted(toolUpdate);
    if (toolUpdate.ok) {
      assert.equal(toolUpdate.destination, "live");
      assert.equal(toolUpdate.duplicate, false);
    }
  });

  it("rejects a missing or invalid semantic payload digest during envelope parsing", () => {
    const valid = {
      taskId: "task-a",
      runId: "run-1",
      sessionId: "sess-1",
      adapterEpoch: 1,
      ingestMode: "live",
      receiveSequence: FIRST_RECEIVE_SEQUENCE,
      idempotencyKey: "digest-parse-1",
      kind: "session_update",
      semanticPayloadDigest: "sem-valid",
    };
    const parsed = parseRuntimeEnvelope(valid);
    assert.equal(parsed.ok, true);

    const missing = { ...valid } as Record<string, unknown>;
    delete missing["semanticPayloadDigest"];
    const missingResult = parseRuntimeEnvelope(missing);
    assert.equal(missingResult.ok, false);
    if (!missingResult.ok) {
      assert.equal(missingResult.reason, "invalid_semantic_payload_digest");
    }

    for (const invalid of ["", 1, null, undefined, [], {}]) {
      const result = parseRuntimeEnvelope({
        ...valid,
        semanticPayloadDigest: invalid,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid_semantic_payload_digest");
      }
    }
  });

  it("treats the same committed key and semantic digest as duplicate when receiveSequence or protocolMessageId change", () => {
    const digest = "sem-stable";
    const committedEnv = envelope({
      semanticPayloadDigest: digest,
      receiveSequence: FIRST_RECEIVE_SEQUENCE,
    });
    const context = liveContext({
      committed: [
        {
          key: committedEnv.idempotencyKey,
          fingerprint: envelopeFingerprint(committedEnv),
        },
      ],
      lastCommittedReceiveSequence: 5,
    });

    const retriedSequence = envelope({
      idempotencyKey: committedEnv.idempotencyKey,
      semanticPayloadDigest: digest,
      receiveSequence: 9,
    });
    assert.equal(retriedSequence.receiveSequence, 9);
    assert.notEqual(
      retriedSequence.receiveSequence,
      committedEnv.receiveSequence,
    );
    assertLiveAdmitted(admitRuntimeEnvelope(retriedSequence, context), true);

    const laterProtocolId = envelope({
      idempotencyKey: committedEnv.idempotencyKey,
      semanticPayloadDigest: digest,
      receiveSequence: 12,
      protocolMessageId: "proto-later",
    });
    assert.equal(committedEnv.protocolMessageId, undefined);
    assert.equal(laterProtocolId.protocolMessageId, "proto-later");
    assertLiveAdmitted(admitRuntimeEnvelope(laterProtocolId, context), true);
  });

  it("treats the same committed key with a different semantic digest as collision", () => {
    const committedEnv = envelope({ semanticPayloadDigest: "sem-a" });
    const collision = admitRuntimeEnvelope(
      envelope({
        idempotencyKey: committedEnv.idempotencyKey,
        semanticPayloadDigest: "sem-b",
        receiveSequence: FIRST_RECEIVE_SEQUENCE,
      }),
      liveContext({
        committed: [
          {
            key: committedEnv.idempotencyKey,
            fingerprint: envelopeFingerprint(committedEnv),
          },
        ],
      }),
    );
    assertDenied(collision, "idempotency_collision");
  });

  it("matches live and replay semantic fingerprints while still enforcing ingest, epoch, and barrier gates", () => {
    const digest = "sem-epoch-independent";
    const liveEnv = envelope({
      ingestMode: "live",
      adapterEpoch: 1,
      semanticPayloadDigest: digest,
    });
    const replayEnv = envelope({
      ingestMode: "replay",
      adapterEpoch: 2,
      semanticPayloadDigest: digest,
      idempotencyKey: liveEnv.idempotencyKey,
    });
    assert.equal(envelopeFingerprint(liveEnv), envelopeFingerprint(replayEnv));
    assert.notEqual(liveEnv.ingestMode, replayEnv.ingestMode);
    assert.notEqual(liveEnv.adapterEpoch, replayEnv.adapterEpoch);

    const committed = [
      {
        key: liveEnv.idempotencyKey,
        fingerprint: envelopeFingerprint(liveEnv),
      },
    ];
    const legalReplay = admitRuntimeEnvelope(
      replayEnv,
      replayContext({ committed }),
    );
    assertReplayStaged(legalReplay, true);

    const collidingReplay = envelope({
      ingestMode: "replay",
      adapterEpoch: 2,
      idempotencyKey: liveEnv.idempotencyKey,
      semanticPayloadDigest: "sem-other",
    });
    assert.notEqual(
      envelopeFingerprint(liveEnv),
      envelopeFingerprint(collidingReplay),
    );
    assertDenied(
      admitRuntimeEnvelope(collidingReplay, replayContext({ committed })),
      "idempotency_collision",
    );

    const staleEpoch = envelope({
      ingestMode: "live",
      adapterEpoch: 1,
      semanticPayloadDigest: digest,
      idempotencyKey: liveEnv.idempotencyKey,
    });
    assert.equal(envelopeFingerprint(staleEpoch), envelopeFingerprint(liveEnv));
    assertDenied(
      admitRuntimeEnvelope(
        staleEpoch,
        liveContext({
          currentEpoch: epoch2,
          binding: healthyBinding({ adapterEpoch: epoch2 }),
          run: runRecord({ adapterEpoch: epoch2 }),
          committed,
        }),
      ),
      "stale_epoch",
    );

    assertDenied(
      admitRuntimeEnvelope(replayEnv, liveContext({ committed })),
      "replay_not_reconciling",
    );

    assertDenied(
      admitRuntimeEnvelope(
        liveEnv,
        liveContext({
          binding: healthyBinding({
            replayBarrier: {
              requestId: barrierA,
              sessionId,
              adapterEpoch: epoch1,
              attemptId: restoreAttempt,
            },
          }),
          committed,
        }),
      ),
      "replay_barrier_open",
    );
  });

  it("still enforces receive-sequence first, gap, and stale rules for genuinely new events", () => {
    const digest = "sem-shared";
    assertLiveAdmitted(
      admitRuntimeEnvelope(
        envelope({
          semanticPayloadDigest: digest,
          receiveSequence: FIRST_RECEIVE_SEQUENCE,
        }),
        liveContext({
          lastCommittedReceiveSequence: NO_COMMITTED_RECEIVE_SEQUENCE,
        }),
      ),
    );

    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          semanticPayloadDigest: digest,
          receiveSequence: 3,
        }),
        liveContext({ lastCommittedReceiveSequence: FIRST_RECEIVE_SEQUENCE }),
      ),
      "out_of_order_receive_sequence",
    );
    assertDenied(
      admitRuntimeEnvelope(
        envelope({
          semanticPayloadDigest: digest,
          receiveSequence: FIRST_RECEIVE_SEQUENCE,
        }),
        liveContext({ lastCommittedReceiveSequence: 3 }),
      ),
      "stale_receive_sequence",
    );
    assertLiveAdmitted(
      admitRuntimeEnvelope(
        envelope({
          semanticPayloadDigest: digest,
          receiveSequence: 4,
        }),
        liveContext({ lastCommittedReceiveSequence: 3 }),
      ),
    );
  });
});
