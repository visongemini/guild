import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseAdapterEpoch,
  parseBarrierRequestId,
  parseIdempotencyKey,
  parseRunId,
  parseSessionAttemptId,
  parseSessionId,
  parseTaskId,
  type AdapterEpoch,
  type BarrierRequestId,
  type IdempotencyKey,
  type Result,
  type SessionAttemptId,
  type SessionId,
  type TaskId,
} from "@guild/contracts";
import { applyRunEvent, createQueuedRun } from "./run-machine.js";
import {
  applySessionBindingEvent,
  canonicalizeSessionBindingRecord,
  CONFLICT_FREE_VERDICT,
  createUnboundBinding,
  SessionBindingValidationError,
  SESSION_BINDING_STATES,
  selectRestorePath,
  sessionBindingEventFingerprint,
  type SessionBindingEvent,
  type SessionBindingRecord,
  type SessionBindingResult,
} from "./session-binding.js";

function must<T>(result: Result<T>): T {
  if (!result.ok) {
    assert.fail(result.reason);
  }
  return result.value;
}

const taskId: TaskId = must(parseTaskId("task-a"));
const sessionId: SessionId = must(parseSessionId("sess-1"));
const otherSession: SessionId = must(parseSessionId("sess-2"));
const epoch1: AdapterEpoch = must(parseAdapterEpoch(1));
const epoch2: AdapterEpoch = must(parseAdapterEpoch(2));
const epoch3: AdapterEpoch = must(parseAdapterEpoch(3));
const barrierA: BarrierRequestId = must(parseBarrierRequestId("barrier-a"));
const barrierB: BarrierRequestId = must(parseBarrierRequestId("barrier-b"));
const createAttempt: SessionAttemptId = must(parseSessionAttemptId("create-1"));
const restoreAttempt1: SessionAttemptId = must(parseSessionAttemptId("restore-1"));
const restoreAttempt2: SessionAttemptId = must(parseSessionAttemptId("restore-2"));
const replaceAttempt: SessionAttemptId = must(parseSessionAttemptId("replace-1"));
const replaceAttempt2: SessionAttemptId = must(parseSessionAttemptId("replace-2"));

let seq = 0;
function key(label: string): IdempotencyKey {
  seq += 1;
  return must(parseIdempotencyKey(`${label}-${seq}`));
}

function assertOk(
  result: SessionBindingResult,
): asserts result is Extract<SessionBindingResult, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
}

function apply(
  binding: SessionBindingRecord,
  event: SessionBindingEvent,
): SessionBindingRecord {
  const result = applySessionBindingEvent(binding, event);
  assertOk(result);
  return result.binding;
}

function healthy(epoch: AdapterEpoch = epoch1): SessionBindingRecord {
  return apply(
    apply(createUnboundBinding(taskId), {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: key("start"),
    }),
    {
      type: "session_new_succeeded",
      sessionId,
      adapterEpoch: epoch,
      attemptId: createAttempt,
      idempotencyKey: key("new"),
    },
  );
}

function restorePending(): SessionBindingRecord {
  return apply(healthy(), {
    type: "transport_lost",
    sessionId,
    adapterEpoch: epoch1,
    attemptId: restoreAttempt1,
    idempotencyKey: key("lost"),
  });
}

function reconciling(): SessionBindingRecord {
  return apply(restorePending(), {
    type: "load_began",
    sessionId,
    adapterEpoch: epoch2,
    barrierRequestId: barrierA,
    attemptId: restoreAttempt1,
    idempotencyKey: key("load"),
  });
}

function domainSnapshot(binding: SessionBindingRecord) {
  return {
    state: binding.state,
    sessionId: binding.sessionId,
    adapterEpoch: binding.adapterEpoch,
    replayBarrier: binding.replayBarrier,
    retainedSessionId: binding.retainedSessionId,
    replacementAuthorized: binding.replacementAuthorized,
    usedBarrierRequestIds: binding.usedBarrierRequestIds,
    usedSessionAttemptIds: binding.usedSessionAttemptIds,
    createAttemptId: binding.createAttemptId,
    restoreAttemptId: binding.restoreAttemptId,
  };
}

describe("session binding (PC-SESS-001, PC-TRN-002)", () => {
  it("runtime-freezes states, bindings, results, replay data, and ledgers", () => {
    assert.equal(Object.isFrozen(SESSION_BINDING_STATES), true);
    assert.throws(() => {
      (SESSION_BINDING_STATES as unknown as string[]).push("forged");
    }, TypeError);

    const unbound = createUnboundBinding(taskId);
    assert.equal(Object.isFrozen(unbound), true);
    assert.equal(Object.isFrozen(unbound.usedBarrierRequestIds), true);
    assert.equal(Object.isFrozen(unbound.usedSessionAttemptIds), true);
    assert.equal(Object.isFrozen(unbound.applied), true);

    const callerBinding = structuredClone(unbound);
    const event = {
      type: "start_session" as const,
      attemptId: createAttempt,
      idempotencyKey: key("frozen-start"),
    };
    const first = applySessionBindingEvent(callerBinding, event);
    assertOk(first);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.binding), true);
    assert.equal(Object.isFrozen(first.binding.applied), true);
    assert.equal(Object.isFrozen(first.binding.applied[0]), true);
    assert.equal(Object.isFrozen(first.binding.usedSessionAttemptIds), true);
    (callerBinding as unknown as { state: string }).state = "healthy";
    (event as unknown as { attemptId: string }).attemptId = "mutated";
    assert.equal(first.binding.state, "creating");
    assert.equal(first.binding.createAttemptId, createAttempt);

    const replay = applySessionBindingEvent(first.binding, {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: event.idempotencyKey,
    });
    assertOk(replay);
    assert.equal(replay.idempotent, true);
    assert.equal(Object.isFrozen(replay), true);
    assert.equal(Object.isFrozen(replay.binding), true);

    const failure = applySessionBindingEvent(unbound, {
      type: "creation_failed",
      attemptId: createAttempt,
      idempotencyKey: key("frozen-failure"),
    });
    assert.equal(failure.ok, false);
    assert.equal(Object.isFrozen(failure), true);
    assert.equal(Object.isFrozen(failure.binding), true);
    assert.equal(Object.isFrozen(failure.binding.applied), true);
    assert.throws(() => {
      (failure.binding as unknown as { state: string }).state = "healthy";
    }, TypeError);
  });

  it("accepts canonical JSON round-trips and returns a fresh frozen snapshot", () => {
    const original = restorePending();
    const roundTrip = JSON.parse(JSON.stringify(original)) as SessionBindingRecord;
    const result = applySessionBindingEvent(roundTrip, {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("json-resume"),
    });
    assertOk(result);
    assert.equal(result.binding.state, "healthy");
    assert.equal(Object.isFrozen(result.binding), true);
    assert.notEqual(result.binding, roundTrip);
    assert.notEqual(result.binding.applied, roundTrip.applied);
  });

  it("follows the legal restore and replacement path", () => {
    assert.equal(selectRestorePath({ resumeAdvertised: true, loadAdvertised: true }), "resume");
    assert.equal(selectRestorePath({ resumeAdvertised: false, loadAdvertised: true }), "load");
    assert.equal(selectRestorePath({ resumeAdvertised: false, loadAdvertised: false }), "broken");

    const unbound = createUnboundBinding(taskId);
    assert.equal(unbound.state, "unbound");
    assert.equal(unbound.replayBarrier, undefined);

    const creating = apply(unbound, {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: key("start"),
    });
    assert.equal(creating.state, "creating");
    assert.equal(creating.sessionId, undefined);
    assert.equal(creating.createAttemptId, createAttempt);
    assert.deepEqual([...creating.usedSessionAttemptIds], [createAttempt]);

    const bound = apply(creating, {
      type: "session_new_succeeded",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: createAttempt,
      idempotencyKey: key("new"),
    });
    assert.equal(bound.state, "healthy");
    assert.equal(bound.sessionId, sessionId);
    assert.equal(bound.replayBarrier, undefined);
    assert.equal(bound.createAttemptId, undefined);

    const pending = apply(bound, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt1,
      idempotencyKey: key("lost"),
    });
    assert.equal(pending.state, "restore_pending");
    assert.equal(pending.sessionId, sessionId);
    assert.equal(pending.restoreAttemptId, restoreAttempt1);
    assert.equal(pending.usedSessionAttemptIds.includes(restoreAttempt1), true);

    const resumed = apply(pending, {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("resume"),
    });
    assert.equal(resumed.state, "healthy");
    assert.equal(resumed.adapterEpoch, epoch2);
    assert.equal(resumed.replayBarrier, undefined);
  });

  it("commits load only with an identity-bound conflict-free barrier", () => {
    const loaded = reconciling();
    assert.equal(loaded.state, "replay_reconciling");
    assert.equal(loaded.replayBarrier?.requestId, barrierA);
    assert.equal(loaded.replayBarrier?.sessionId, sessionId);
    assert.equal(loaded.replayBarrier?.adapterEpoch, epoch2);
    assert.equal(loaded.replayBarrier?.attemptId, restoreAttempt1);

    const committed = apply(loaded, {
      type: "load_committed",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      verdict: CONFLICT_FREE_VERDICT,
      idempotencyKey: key("commit"),
    });
    assert.equal(committed.state, "healthy");
    assert.equal(committed.replayBarrier, undefined);
    assert.equal(committed.sessionId, sessionId);
    assert.equal(committed.adapterEpoch, epoch2);
  });

  it("fails closed on wrong or missing barrier, session, epoch, request id, or verdict", () => {
    const loaded = reconciling();
    const cases: readonly SessionBindingEvent[] = [
      {
        type: "load_committed",
        sessionId,
        adapterEpoch: epoch2,
        barrierRequestId: barrierB,
        attemptId: restoreAttempt1,
        verdict: CONFLICT_FREE_VERDICT,
        idempotencyKey: key("wrong-barrier"),
      },
      {
        type: "load_committed",
        sessionId: otherSession,
        adapterEpoch: epoch2,
        barrierRequestId: barrierA,
        attemptId: restoreAttempt1,
        verdict: CONFLICT_FREE_VERDICT,
        idempotencyKey: key("wrong-session"),
      },
      {
        type: "load_committed",
        sessionId,
        adapterEpoch: epoch3,
        barrierRequestId: barrierA,
        attemptId: restoreAttempt1,
        verdict: CONFLICT_FREE_VERDICT,
        idempotencyKey: key("wrong-epoch"),
      },
      {
        type: "load_committed",
        sessionId,
        adapterEpoch: epoch2,
        barrierRequestId: barrierA,
        attemptId: restoreAttempt1,
        verdict: "conflict",
        idempotencyKey: key("bad-verdict"),
      },
      {
        type: "load_committed",
        sessionId,
        adapterEpoch: epoch2,
        barrierRequestId: barrierA,
        attemptId: restoreAttempt1,
        verdict: "",
        idempotencyKey: key("empty-verdict"),
      },
    ];
    const reasons = [
      "barrier_mismatch",
      "wrong_session",
      "epoch_mismatch",
      "invalid_verdict",
      "invalid_verdict",
    ];
    for (let i = 0; i < cases.length; i += 1) {
      const event = cases[i];
      assert.ok(event);
      const result = applySessionBindingEvent(loaded, event);
      assert.equal(result.ok, false, reasons[i]);
      if (!result.ok) {
        assert.equal(result.reason, reasons[i]);
        assert.equal(result.audit, true);
        assert.equal(result.binding.state, "replay_reconciling");
        assert.equal(result.binding.replayBarrier?.requestId, barrierA);
      }
    }

    assert.throws(
      () =>
        applySessionBindingEvent(
          { ...loaded, replayBarrier: undefined },
          {
            type: "load_committed",
            sessionId,
            adapterEpoch: epoch2,
            barrierRequestId: barrierA,
            attemptId: restoreAttempt1,
            verdict: CONFLICT_FREE_VERDICT,
            idempotencyKey: key("missing"),
          },
        ),
      (cause: unknown) =>
        cause instanceof SessionBindingValidationError &&
        cause.code === "invalid_session_binding",
    );
  });

  it("marks the binding broken on restore or load failure", () => {
    const restoreFail = apply(restorePending(), {
      type: "restore_failed",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt1,
      idempotencyKey: key("restore-fail"),
    });
    assert.equal(restoreFail.state, "broken");
    assert.equal(restoreFail.sessionId, sessionId);

    const loadFail = apply(reconciling(), {
      type: "load_failed",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      idempotencyKey: key("load-fail"),
    });
    assert.equal(loadFail.state, "broken");
    assert.equal(loadFail.replayBarrier, undefined);
    assert.equal(loadFail.sessionId, sessionId);
  });

  it("requires explicit replacement consent and never mutates an old Run", () => {
    const run = createQueuedRun({
      taskId,
      runId: must(parseRunId("run-old")),
    });
    const started = applyRunEvent(run, {
      type: "scheduler_dispatch",
      sessionId,
      adapterEpoch: epoch1,
      idempotencyKey: key("run-dispatch"),
    });
    assert.equal(started.ok, true);
    const frozen = started.ok ? started.run : run;

    const broken = apply(restorePending(), {
      type: "restore_failed",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt1,
      idempotencyKey: key("broken"),
    });
    const silent = applySessionBindingEvent(broken, {
      type: "replacement_creation_begins",
      attemptId: replaceAttempt,
      idempotencyKey: key("silent"),
    });
    assert.equal(silent.ok, false);
    if (!silent.ok) {
      assert.equal(silent.reason, "illegal_transition");
    }

    const authorized = apply(broken, {
      type: "authorize_replacement",
      idempotencyKey: key("auth"),
    });
    assert.equal(authorized.state, "replacement_pending");
    const creating = apply(authorized, {
      type: "replacement_creation_begins",
      attemptId: replaceAttempt,
      idempotencyKey: key("replace"),
    });
    assert.equal(creating.state, "creating");
    assert.equal(creating.retainedSessionId, sessionId);
    assert.equal(creating.createAttemptId, replaceAttempt);
    const replaced = apply(creating, {
      type: "session_new_succeeded",
      sessionId: otherSession,
      adapterEpoch: epoch2,
      attemptId: replaceAttempt,
      idempotencyKey: key("new-sess"),
    });
    assert.equal(replaced.state, "healthy");
    assert.equal(replaced.sessionId, otherSession);
    assert.equal(frozen.sessionId, sessionId);
    assert.equal(frozen.state, "starting");
    assert.equal(frozen.runId, must(parseRunId("run-old")));

    const withdrawn = apply(
      apply(broken, {
        type: "authorize_replacement",
        idempotencyKey: key("auth2"),
      }),
      {
        type: "withdraw_replacement",
        idempotencyKey: key("withdraw"),
      },
    );
    assert.equal(withdrawn.state, "broken");
    assert.equal(withdrawn.sessionId, sessionId);
  });

  it("rejects resume/load that reuse or decrease the prior adapter epoch", () => {
    const pending = restorePending();
    const reuse = applySessionBindingEvent(pending, {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt1,
      idempotencyKey: key("resume-reuse"),
    });
    assert.equal(reuse.ok, false);
    if (!reuse.ok) {
      assert.equal(reuse.reason, "epoch_not_advanced");
      assert.equal(reuse.binding.state, "restore_pending");
      assert.equal(reuse.binding.adapterEpoch, epoch1);
    }

    const loadReuse = applySessionBindingEvent(pending, {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch1,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      idempotencyKey: key("load-reuse"),
    });
    assert.equal(loadReuse.ok, false);
    if (!loadReuse.ok) {
      assert.equal(loadReuse.reason, "epoch_not_advanced");
    }

    const resumed = apply(pending, {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("resume-ok"),
    });
    const pendingAgain = apply(resumed, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt2,
      idempotencyKey: key("lost2"),
    });
    const decrease = applySessionBindingEvent(pendingAgain, {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt2,
      idempotencyKey: key("resume-down"),
    });
    assert.equal(decrease.ok, false);
    if (!decrease.ok) {
      assert.equal(decrease.reason, "epoch_not_advanced");
      assert.equal(decrease.binding.adapterEpoch, epoch2);
    }
  });

  it("rejects a reused barrier request id after a prior load", () => {
    const committed = apply(reconciling(), {
      type: "load_committed",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      verdict: CONFLICT_FREE_VERDICT,
      idempotencyKey: key("commit"),
    });
    const pending = apply(committed, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt2,
      idempotencyKey: key("lost-again"),
    });
    const reused = applySessionBindingEvent(pending, {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt2,
      idempotencyKey: key("reuse-barrier"),
    });
    assert.equal(reused.ok, false);
    if (!reused.ok) {
      assert.equal(reused.reason, "barrier_reused");
      assert.equal(reused.binding.state, "restore_pending");
    }
    const next = apply(pending, {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt2,
      idempotencyKey: key("new-barrier"),
    });
    assert.equal(next.state, "replay_reconciling");
    assert.equal(next.replayBarrier?.requestId, barrierB);
  });

  it("rejects illegal recoveries and healthy session mutation", () => {
    const broken = apply(restorePending(), {
      type: "restore_failed",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt1,
      idempotencyKey: key("broken"),
    });
    const toHealthy = applySessionBindingEvent(broken, {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("broken-healthy"),
    });
    assert.equal(toHealthy.ok, false);
    if (!toHealthy.ok) {
      assert.equal(toHealthy.reason, "illegal_transition");
    }

    const healthyBinding = healthy();
    const rebind = applySessionBindingEvent(healthyBinding, {
      type: "session_new_succeeded",
      sessionId: otherSession,
      adapterEpoch: epoch2,
      attemptId: createAttempt,
      idempotencyKey: key("rebind"),
    });
    assert.equal(rebind.ok, false);
    if (!rebind.ok) {
      assert.equal(rebind.reason, "illegal_transition");
      assert.equal(rebind.binding.sessionId, sessionId);
    }

    const mismatch = applySessionBindingEvent(restorePending(), {
      type: "resume_succeeded",
      sessionId: otherSession,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("resume-mismatch"),
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) {
      assert.equal(mismatch.reason, "identity_mismatch");
    }
  });

  it("applies keyed idempotency with collision rejection and zero repeated mutation", () => {
    const unbound = createUnboundBinding(taskId);
    const startKey = key("start-dup");
    const first = applySessionBindingEvent(unbound, {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: startKey,
    });
    assertOk(first);
    assert.equal(first.changed, true);
    const duplicate = applySessionBindingEvent(first.binding, {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: startKey,
    });
    assertOk(duplicate);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.binding.state, "creating");
    assert.equal(duplicate.binding.applied.length, first.binding.applied.length);

    const collision = applySessionBindingEvent(first.binding, {
      type: "creation_failed",
      attemptId: createAttempt,
      idempotencyKey: startKey,
    });
    assert.equal(collision.ok, false);
    if (!collision.ok) {
      assert.equal(collision.reason, "idempotency_collision");
      assert.equal(collision.binding.state, "creating");
      assert.equal(collision.audit, true);
    }

    const payloadKey = key("new-payload");
    const created = applySessionBindingEvent(first.binding, {
      type: "session_new_succeeded",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: createAttempt,
      idempotencyKey: payloadKey,
    });
    assertOk(created);
    const payloadCollision = applySessionBindingEvent(created.binding, {
      type: "session_new_succeeded",
      sessionId: otherSession,
      adapterEpoch: epoch1,
      attemptId: createAttempt,
      idempotencyKey: payloadKey,
    });
    assert.equal(payloadCollision.ok, false);
    if (!payloadCollision.ok) {
      assert.equal(payloadCollision.reason, "idempotency_collision");
      assert.equal(payloadCollision.binding.sessionId, sessionId);
    }
  });

  it("rejects delayed epoch-1 transport loss against a healthy epoch-2 binding", () => {
    const pending = restorePending();
    const resumed = apply(pending, {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("resume-epoch2"),
    });
    assert.equal(resumed.state, "healthy");
    assert.equal(resumed.adapterEpoch, epoch2);
    const snapshot = {
      state: resumed.state,
      sessionId: resumed.sessionId,
      adapterEpoch: resumed.adapterEpoch,
      replayBarrier: resumed.replayBarrier,
      restoreAttemptId: resumed.restoreAttemptId,
      createAttemptId: resumed.createAttemptId,
    };
    const delayed = applySessionBindingEvent(resumed, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt1,
      idempotencyKey: key("delayed-loss-epoch1"),
    });
    assert.equal(delayed.ok, false);
    if (!delayed.ok) {
      assert.equal(delayed.reason, "epoch_mismatch");
      assert.equal(delayed.audit, true);
      assert.equal(delayed.binding.state, snapshot.state);
      assert.equal(delayed.binding.sessionId, snapshot.sessionId);
      assert.equal(delayed.binding.adapterEpoch, snapshot.adapterEpoch);
      assert.equal(delayed.binding.replayBarrier, snapshot.replayBarrier);
      assert.equal(delayed.binding.restoreAttemptId, snapshot.restoreAttemptId);
      assert.equal(delayed.binding.createAttemptId, snapshot.createAttemptId);
    }
  });

  it("rejects a delayed load failure from barrier A/epoch 2 during barrier B/epoch 3 reconciliation", () => {
    const firstLoad = reconciling();
    const committed = apply(firstLoad, {
      type: "load_committed",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      verdict: CONFLICT_FREE_VERDICT,
      idempotencyKey: key("commit-a"),
    });
    const pending = apply(committed, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt2,
      idempotencyKey: key("lost-after-a"),
    });
    const secondLoad = apply(pending, {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt2,
      idempotencyKey: key("load-b"),
    });
    assert.equal(secondLoad.state, "replay_reconciling");
    assert.equal(secondLoad.replayBarrier?.requestId, barrierB);
    assert.equal(secondLoad.replayBarrier?.attemptId, restoreAttempt2);
    assert.equal(secondLoad.adapterEpoch, epoch3);
    const delayed = applySessionBindingEvent(secondLoad, {
      type: "load_failed",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      idempotencyKey: key("delayed-fail-a"),
    });
    assert.equal(delayed.ok, false);
    if (!delayed.ok) {
      assert.equal(delayed.reason, "barrier_mismatch");
      assert.equal(delayed.binding.state, "replay_reconciling");
      assert.equal(delayed.binding.replayBarrier?.requestId, barrierB);
      assert.equal(delayed.binding.adapterEpoch, epoch3);
    }
  });

  it("binds create and resume failures to the exact active attempt", () => {
    const creating = apply(createUnboundBinding(taskId), {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: key("start-attempt"),
    });
    const foreignCreateFail = applySessionBindingEvent(creating, {
      type: "creation_failed",
      attemptId: replaceAttempt,
      idempotencyKey: key("foreign-create-fail"),
    });
    assert.equal(foreignCreateFail.ok, false);
    if (!foreignCreateFail.ok) {
      assert.equal(foreignCreateFail.reason, "attempt_mismatch");
      assert.equal(foreignCreateFail.binding.state, "creating");
    }

    const pending = restorePending();
    const foreignRestoreFail = applySessionBindingEvent(pending, {
      type: "restore_failed",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt2,
      idempotencyKey: key("foreign-restore-fail"),
    });
    assert.equal(foreignRestoreFail.ok, false);
    if (!foreignRestoreFail.ok) {
      assert.equal(foreignRestoreFail.reason, "attempt_mismatch");
      assert.equal(foreignRestoreFail.binding.state, "restore_pending");
    }

    const replacementCreating = apply(
      apply(
        apply(restorePending(), {
          type: "restore_failed",
          sessionId,
          adapterEpoch: epoch1,
          attemptId: restoreAttempt1,
          idempotencyKey: key("break-for-replace"),
        }),
        {
          type: "authorize_replacement",
          idempotencyKey: key("auth-replace"),
        },
      ),
      {
        type: "replacement_creation_begins",
        attemptId: replaceAttempt,
        idempotencyKey: key("begin-replace"),
      },
    );
    assert.equal(replacementCreating.state, "creating");
    const staleCreateFail = applySessionBindingEvent(replacementCreating, {
      type: "creation_failed",
      attemptId: createAttempt,
      idempotencyKey: key("stale-create-fail"),
    });
    assert.equal(staleCreateFail.ok, false);
    if (!staleCreateFail.ok) {
      assert.equal(staleCreateFail.reason, "attempt_mismatch");
      assert.equal(staleCreateFail.binding.state, "creating");
      assert.equal(staleCreateFail.binding.createAttemptId, replaceAttempt);
    }
  });

  it("includes provenance fields in semantic idempotency fingerprints", () => {
    const bound = healthy();
    const lossKey = key("loss-fingerprint");
    const first = applySessionBindingEvent(bound, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch1,
      attemptId: restoreAttempt1,
      idempotencyKey: lossKey,
    });
    assertOk(first);
    const collidingEpoch = applySessionBindingEvent(first.binding, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: lossKey,
    });
    assert.equal(collidingEpoch.ok, false);
    if (!collidingEpoch.ok) {
      assert.equal(collidingEpoch.reason, "idempotency_collision");
      assert.equal(collidingEpoch.binding.state, "restore_pending");
    }
  });

  it("rejects delayed load_began from completed restore A while restore B is active", () => {
    const completedA = apply(reconciling(), {
      type: "load_committed",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      verdict: CONFLICT_FREE_VERDICT,
      idempotencyKey: key("complete-a"),
    });
    assert.equal(completedA.state, "healthy");
    assert.equal(completedA.restoreAttemptId, undefined);

    const restoreB = apply(completedA, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt2,
      idempotencyKey: key("active-b"),
    });
    assert.equal(restoreB.state, "restore_pending");
    assert.equal(restoreB.restoreAttemptId, restoreAttempt2);
    const snapshot = domainSnapshot(restoreB);

    const delayedFromA = applySessionBindingEvent(restoreB, {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      idempotencyKey: key("delayed-load-a"),
    });
    assert.equal(delayedFromA.ok, false);
    if (!delayedFromA.ok) {
      assert.equal(delayedFromA.reason, "attempt_mismatch");
      assert.equal(delayedFromA.audit, true);
      assert.deepEqual(domainSnapshot(delayedFromA.binding), snapshot);
    }
  });

  it("rejects load when restore_pending has no active attempt", () => {
    const malformed: SessionBindingRecord = {
      ...restorePending(),
      restoreAttemptId: undefined,
    };
    assert.equal(malformed.state, "restore_pending");
    assert.equal(malformed.restoreAttemptId, undefined);
    assert.throws(
      () =>
        applySessionBindingEvent(malformed, {
          type: "load_began",
          sessionId,
          adapterEpoch: epoch2,
          barrierRequestId: barrierA,
          attemptId: restoreAttempt1,
          idempotencyKey: key("malformed-load"),
        }),
      (cause: unknown) =>
        cause instanceof SessionBindingValidationError &&
        cause.code === "invalid_session_binding",
    );
  });

  it("accepts restore B load begin, commit, and failure only with exact attempt+session+epoch+barrier", () => {
    const completedA = apply(reconciling(), {
      type: "load_committed",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      verdict: CONFLICT_FREE_VERDICT,
      idempotencyKey: key("complete-a-for-b"),
    });
    const pendingB = apply(completedA, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt2,
      idempotencyKey: key("lost-for-b"),
    });

    const loadB = apply(pendingB, {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt2,
      idempotencyKey: key("load-b-exact"),
    });
    assert.equal(loadB.state, "replay_reconciling");
    assert.equal(loadB.restoreAttemptId, restoreAttempt2);
    assert.equal(loadB.sessionId, sessionId);
    assert.equal(loadB.adapterEpoch, epoch3);
    assert.deepEqual(loadB.replayBarrier, {
      requestId: barrierB,
      sessionId,
      adapterEpoch: epoch3,
      attemptId: restoreAttempt2,
    });

    const wrongAttemptCommit = applySessionBindingEvent(loadB, {
      type: "load_committed",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt1,
      verdict: CONFLICT_FREE_VERDICT,
      idempotencyKey: key("commit-b-wrong-attempt"),
    });
    assert.equal(wrongAttemptCommit.ok, false);
    if (!wrongAttemptCommit.ok) {
      assert.equal(wrongAttemptCommit.reason, "attempt_mismatch");
      assert.equal(wrongAttemptCommit.binding.state, "replay_reconciling");
      assert.equal(wrongAttemptCommit.binding.restoreAttemptId, restoreAttempt2);
      assert.equal(wrongAttemptCommit.binding.replayBarrier?.requestId, barrierB);
      assert.equal(wrongAttemptCommit.binding.adapterEpoch, epoch3);
    }

    const committedB = apply(loadB, {
      type: "load_committed",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt2,
      verdict: CONFLICT_FREE_VERDICT,
      idempotencyKey: key("commit-b-exact"),
    });
    assert.equal(committedB.state, "healthy");
    assert.equal(committedB.replayBarrier, undefined);
    assert.equal(committedB.restoreAttemptId, undefined);
    assert.equal(committedB.sessionId, sessionId);
    assert.equal(committedB.adapterEpoch, epoch3);

    const loadBFail = apply(pendingB, {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt2,
      idempotencyKey: key("load-b-fail-path"),
    });
    const wrongAttemptFail = applySessionBindingEvent(loadBFail, {
      type: "load_failed",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt1,
      idempotencyKey: key("fail-b-wrong-attempt"),
    });
    assert.equal(wrongAttemptFail.ok, false);
    if (!wrongAttemptFail.ok) {
      assert.equal(wrongAttemptFail.reason, "attempt_mismatch");
      assert.equal(wrongAttemptFail.binding.state, "replay_reconciling");
      assert.equal(wrongAttemptFail.binding.restoreAttemptId, restoreAttempt2);
    }

    const failedB = apply(loadBFail, {
      type: "load_failed",
      sessionId,
      adapterEpoch: epoch3,
      barrierRequestId: barrierB,
      attemptId: restoreAttempt2,
      idempotencyKey: key("fail-b-exact"),
    });
    assert.equal(failedB.state, "broken");
    assert.equal(failedB.replayBarrier, undefined);
    assert.equal(failedB.restoreAttemptId, undefined);
    assert.equal(failedB.sessionId, sessionId);
    assert.equal(failedB.adapterEpoch, epoch3);
  });

  it("rejects SessionAttemptId reuse across create, failed replacement, and completed restore", () => {
    const afterCreate = apply(
      apply(restorePending(), {
        type: "restore_failed",
        sessionId,
        adapterEpoch: epoch1,
        attemptId: restoreAttempt1,
        idempotencyKey: key("reuse-break"),
      }),
      {
        type: "authorize_replacement",
        idempotencyKey: key("reuse-auth"),
      },
    );
    const reuseInitialCreate = applySessionBindingEvent(afterCreate, {
      type: "replacement_creation_begins",
      attemptId: createAttempt,
      idempotencyKey: key("reuse-create"),
    });
    assert.equal(reuseInitialCreate.ok, false);
    if (!reuseInitialCreate.ok) {
      assert.equal(reuseInitialCreate.reason, "attempt_reused");
      assert.equal(reuseInitialCreate.binding.state, "replacement_pending");
      assert.equal(reuseInitialCreate.binding.createAttemptId, undefined);
    }

    const failedCreate = apply(
      apply(createUnboundBinding(taskId), {
        type: "start_session",
        attemptId: createAttempt,
        idempotencyKey: key("fail-create-start"),
      }),
      {
        type: "creation_failed",
        attemptId: createAttempt,
        idempotencyKey: key("fail-create"),
      },
    );
    const authFailedCreate = apply(failedCreate, {
      type: "authorize_replacement",
      idempotencyKey: key("fail-create-auth"),
    });
    const reuseFailedCreate = applySessionBindingEvent(authFailedCreate, {
      type: "replacement_creation_begins",
      attemptId: createAttempt,
      idempotencyKey: key("reuse-failed-create"),
    });
    assert.equal(reuseFailedCreate.ok, false);
    if (!reuseFailedCreate.ok) {
      assert.equal(reuseFailedCreate.reason, "attempt_reused");
      assert.equal(reuseFailedCreate.binding.state, "replacement_pending");
    }

    const failedReplace = apply(
      apply(authFailedCreate, {
        type: "replacement_creation_begins",
        attemptId: replaceAttempt,
        idempotencyKey: key("replace-after-fail"),
      }),
      {
        type: "creation_failed",
        attemptId: replaceAttempt,
        idempotencyKey: key("fail-replace"),
      },
    );
    const authFailedReplace = apply(failedReplace, {
      type: "authorize_replacement",
      idempotencyKey: key("fail-replace-auth"),
    });
    const reuseFailedReplace = applySessionBindingEvent(authFailedReplace, {
      type: "replacement_creation_begins",
      attemptId: replaceAttempt,
      idempotencyKey: key("reuse-failed-replace"),
    });
    assert.equal(reuseFailedReplace.ok, false);
    if (!reuseFailedReplace.ok) {
      assert.equal(reuseFailedReplace.reason, "attempt_reused");
      assert.equal(reuseFailedReplace.binding.state, "replacement_pending");
    }
    const nextReplace = apply(authFailedReplace, {
      type: "replacement_creation_begins",
      attemptId: replaceAttempt2,
      idempotencyKey: key("replace-2"),
    });
    assert.equal(nextReplace.state, "creating");
    assert.equal(nextReplace.createAttemptId, replaceAttempt2);

    const resumed = apply(restorePending(), {
      type: "resume_succeeded",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("resume-complete"),
    });
    assert.equal(resumed.state, "healthy");
    const reuseCompletedRestore = applySessionBindingEvent(resumed, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt1,
      idempotencyKey: key("reuse-restore"),
    });
    assert.equal(reuseCompletedRestore.ok, false);
    if (!reuseCompletedRestore.ok) {
      assert.equal(reuseCompletedRestore.reason, "attempt_reused");
      assert.equal(reuseCompletedRestore.binding.state, "healthy");
      assert.equal(reuseCompletedRestore.binding.restoreAttemptId, undefined);
      assert.equal(reuseCompletedRestore.binding.adapterEpoch, epoch2);
    }
    const nextRestore = apply(resumed, {
      type: "transport_lost",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: restoreAttempt2,
      idempotencyKey: key("restore-2-ok"),
    });
    assert.equal(nextRestore.state, "restore_pending");
    assert.equal(nextRestore.restoreAttemptId, restoreAttempt2);
  });

  it("does not bind a replacement from a delayed success of a prior create attempt", () => {
    const replacing = apply(
      apply(
        apply(restorePending(), {
          type: "restore_failed",
          sessionId,
          adapterEpoch: epoch1,
          attemptId: restoreAttempt1,
          idempotencyKey: key("break-delayed"),
        }),
        {
          type: "authorize_replacement",
          idempotencyKey: key("auth-delayed"),
        },
      ),
      {
        type: "replacement_creation_begins",
        attemptId: replaceAttempt,
        idempotencyKey: key("begin-delayed"),
      },
    );
    assert.equal(replacing.state, "creating");
    assert.equal(replacing.createAttemptId, replaceAttempt);
    assert.equal(replacing.sessionId, undefined);
    const snapshot = domainSnapshot(replacing);

    const delayedOldSuccess = applySessionBindingEvent(replacing, {
      type: "session_new_succeeded",
      sessionId,
      adapterEpoch: epoch2,
      attemptId: createAttempt,
      idempotencyKey: key("delayed-old-success"),
    });
    assert.equal(delayedOldSuccess.ok, false);
    if (!delayedOldSuccess.ok) {
      assert.equal(delayedOldSuccess.reason, "attempt_mismatch");
      assert.equal(delayedOldSuccess.audit, true);
      assert.deepEqual(domainSnapshot(delayedOldSuccess.binding), snapshot);
      assert.equal(delayedOldSuccess.binding.sessionId, undefined);
      assert.equal(delayedOldSuccess.binding.retainedSessionId, sessionId);
    }

    const boundReplacement = apply(replacing, {
      type: "session_new_succeeded",
      sessionId: otherSession,
      adapterEpoch: epoch2,
      attemptId: replaceAttempt,
      idempotencyKey: key("replace-success"),
    });
    assert.equal(boundReplacement.state, "healthy");
    assert.equal(boundReplacement.sessionId, otherSession);
    assert.equal(boundReplacement.createAttemptId, undefined);
  });

  it("rejects forged persisted state, barrier, ledger, and attempt provenance", () => {
    const unbound = createUnboundBinding(taskId);
    const pending = restorePending();
    const loaded = reconciling();
    const bound = healthy();
    const forgedHealthy = {
      ...structuredClone(unbound),
      state: "healthy",
      sessionId,
      retainedSessionId: sessionId,
      adapterEpoch: epoch1,
    };
    const suppressedStartKey = key("suppressed-start");
    const suppressedStartEvent: SessionBindingEvent = {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: suppressedStartKey,
    };
    const forgedFailedStart = {
      ...structuredClone(unbound),
      applied: [{
        key: suppressedStartKey,
        fingerprint: sessionBindingEventFingerprint(suppressedStartEvent),
        ok: false,
        state: "unbound" as const,
        reason: "illegal_transition",
      }],
    };
    const arbitraryHealthyKey = key("arbitrary-healthy");
    const forgedLedgerHealthy = {
      ...structuredClone(unbound),
      state: "healthy" as const,
      sessionId,
      retainedSessionId: sessionId,
      adapterEpoch: epoch1,
      applied: [{
        key: arbitraryHealthyKey,
        fingerprint: sessionBindingEventFingerprint({
          type: "authorize_replacement",
          idempotencyKey: arbitraryHealthyKey,
        }),
        ok: true,
        state: "healthy" as const,
        reason: undefined,
      }],
    };
    const forgedBarrier = structuredClone(loaded) as unknown as {
      replayBarrier: { attemptId: SessionAttemptId };
    };
    forgedBarrier.replayBarrier.attemptId = restoreAttempt2;
    const duplicateLedger = {
      ...structuredClone(bound),
      applied: [
        ...structuredClone(bound.applied),
        structuredClone(bound.applied[0]),
      ],
    };
    const missingAttempt = {
      ...structuredClone(pending),
      usedSessionAttemptIds: pending.usedSessionAttemptIds.filter(
        (candidate) => candidate !== restoreAttempt1,
      ),
    };
    const duplicateAttempt = {
      ...structuredClone(pending),
      usedSessionAttemptIds: [
        ...pending.usedSessionAttemptIds,
        restoreAttempt1,
      ],
    };
    const duplicateBarrier = {
      ...structuredClone(loaded),
      usedBarrierRequestIds: [
        ...loaded.usedBarrierRequestIds,
        barrierA,
      ],
    };
    const sparseAttempts = structuredClone(pending) as unknown as {
      usedSessionAttemptIds: SessionAttemptId[];
    };
    sparseAttempts.usedSessionAttemptIds = new Array<SessionAttemptId>(1);
    let arrayGetterCalls = 0;
    const accessorAttempts = [...pending.usedSessionAttemptIds];
    Object.defineProperty(accessorAttempts, 0, {
      enumerable: true,
      get() {
        arrayGetterCalls += 1;
        return pending.usedSessionAttemptIds[0];
      },
    });
    const accessorAttemptBinding = {
      ...structuredClone(pending),
      usedSessionAttemptIds: accessorAttempts,
    };
    let arrayPrototypeGetterCalls = 0;
    const customPrototypeLedger = [...bound.applied];
    Object.setPrototypeOf(customPrototypeLedger, {
      get [Symbol.iterator]() {
        arrayPrototypeGetterCalls += 1;
        return Array.prototype[Symbol.iterator];
      },
    });
    const customPrototypeBinding = {
      ...structuredClone(bound),
      applied: customPrototypeLedger,
    };
    const extraKey = { ...structuredClone(bound), forged: true };
    let getterCalls = 0;
    const accessor = structuredClone(bound) as unknown as Record<string, unknown>;
    delete accessor["state"];
    Object.defineProperty(accessor, "state", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not read binding getter");
      },
    });
    let proxyReads = 0;
    const proxy = new Proxy(structuredClone(bound), {
      get() {
        proxyReads += 1;
        throw new Error("must not read binding proxy");
      },
    });

    for (const forged of [
      forgedHealthy,
      forgedFailedStart,
      forgedLedgerHealthy,
      forgedBarrier,
      duplicateLedger,
      missingAttempt,
      duplicateAttempt,
      duplicateBarrier,
      sparseAttempts,
      accessorAttemptBinding,
      customPrototypeBinding,
      extraKey,
      accessor,
      proxy,
    ]) {
      assert.throws(
        () =>
          applySessionBindingEvent(forged as SessionBindingRecord, {
            type: "authorize_replacement",
            idempotencyKey: key("forged-binding"),
          }),
        (cause: unknown) =>
          cause instanceof SessionBindingValidationError &&
          cause.code === "invalid_session_binding",
      );
      assert.throws(
        () => canonicalizeSessionBindingRecord(forged),
        (cause: unknown) =>
          cause instanceof SessionBindingValidationError &&
          cause.code === "invalid_session_binding",
      );
    }
    assert.equal(getterCalls, 0);
    assert.equal(proxyReads, 0);
    assert.equal(arrayGetterCalls, 0);
    assert.equal(arrayPrototypeGetterCalls, 0);
  });

  it("fail-closes malformed events and canonicalizes fingerprint inputs", () => {
    const binding = createUnboundBinding(taskId);
    const before = structuredClone(binding);
    let getterCalls = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not read event getter");
      },
    });
    Object.defineProperty(accessor, "idempotencyKey", {
      enumerable: true,
      value: key("accessor-event"),
    });
    let proxyReads = 0;
    const proxy = new Proxy(
      {
        type: "start_session",
        attemptId: createAttempt,
        idempotencyKey: key("proxy-event"),
      },
      {
        get() {
          proxyReads += 1;
          throw new Error("must not read event proxy");
        },
      },
    );
    const prototypeEvent = Object.assign(Object.create({ forged: true }), {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: key("prototype-event"),
    });
    const sparseEvent = new Array(2);
    sparseEvent[0] = "start_session";
    const probes: readonly unknown[] = [
      null,
      { type: "unknown", idempotencyKey: key("unknown-event") },
      {
        type: "start_session",
        attemptId: "",
        idempotencyKey: key("empty-attempt"),
      },
      {
        type: "start_session",
        attemptId: createAttempt,
        idempotencyKey: "",
      },
      {
        type: "start_session",
        attemptId: createAttempt,
        idempotencyKey: key("extra-event"),
        extra: true,
      },
      {
        type: "session_new_succeeded",
        sessionId,
        adapterEpoch: 0,
        attemptId: createAttempt,
        idempotencyKey: key("bad-epoch"),
      },
      accessor,
      proxy,
      prototypeEvent,
      sparseEvent,
    ];

    for (const probe of probes) {
      let result: SessionBindingResult | undefined;
      assert.doesNotThrow(() => {
        result = applySessionBindingEvent(binding, probe as never);
      });
      if (result === undefined) assert.fail("missing malformed-event result");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid_session_binding_event");
        assert.equal(result.idempotent, false);
        assert.equal(result.audit, true);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.binding), true);
      }
      assert.deepEqual(result.binding, before);
      assert.throws(
        () => sessionBindingEventFingerprint(probe as never),
        (cause: unknown) =>
          cause instanceof SessionBindingValidationError &&
          cause.code === "invalid_session_binding_event",
      );
    }
    assert.equal(getterCalls, 0);
    assert.equal(proxyReads, 0);

    const valid = {
      type: "start_session" as const,
      attemptId: createAttempt,
      idempotencyKey: key("canonical-fingerprint"),
    };
    assert.equal(
      sessionBindingEventFingerprint(valid),
      sessionBindingEventFingerprint(JSON.parse(JSON.stringify(valid))),
    );
  });

  it("includes attempt id in fingerprints and treats a changed attempt as a collision", () => {
    const startKey = key("fp-start");
    const startEvent: SessionBindingEvent = {
      type: "start_session",
      attemptId: createAttempt,
      idempotencyKey: startKey,
    };
    const startChanged: SessionBindingEvent = {
      type: "start_session",
      attemptId: replaceAttempt,
      idempotencyKey: startKey,
    };
    assert.notEqual(
      sessionBindingEventFingerprint(startEvent),
      sessionBindingEventFingerprint(startChanged),
    );

    const firstStart = applySessionBindingEvent(
      createUnboundBinding(taskId),
      startEvent,
    );
    assertOk(firstStart);
    const startCollision = applySessionBindingEvent(
      firstStart.binding,
      startChanged,
    );
    assert.equal(startCollision.ok, false);
    if (!startCollision.ok) {
      assert.equal(startCollision.reason, "idempotency_collision");
      assert.equal(startCollision.binding.state, "creating");
      assert.equal(startCollision.binding.createAttemptId, createAttempt);
    }

    const loadKey = key("fp-load");
    const loadEvent: SessionBindingEvent = {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt1,
      idempotencyKey: loadKey,
    };
    const loadChanged: SessionBindingEvent = {
      type: "load_began",
      sessionId,
      adapterEpoch: epoch2,
      barrierRequestId: barrierA,
      attemptId: restoreAttempt2,
      idempotencyKey: loadKey,
    };
    assert.notEqual(
      sessionBindingEventFingerprint(loadEvent),
      sessionBindingEventFingerprint(loadChanged),
    );

    const firstLoad = applySessionBindingEvent(restorePending(), loadEvent);
    assertOk(firstLoad);
    const loadCollision = applySessionBindingEvent(
      firstLoad.binding,
      loadChanged,
    );
    assert.equal(loadCollision.ok, false);
    if (!loadCollision.ok) {
      assert.equal(loadCollision.reason, "idempotency_collision");
      assert.equal(loadCollision.binding.state, "replay_reconciling");
      assert.equal(loadCollision.binding.restoreAttemptId, restoreAttempt1);
      assert.equal(loadCollision.binding.replayBarrier?.attemptId, restoreAttempt1);
    }
  });
});
