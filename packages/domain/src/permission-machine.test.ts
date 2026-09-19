import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  freezeRuntimePayload,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parsePermissionDeliveryAttemptId,
  parsePermissionOutboxCommandId,
  parsePermissionOutboxVersion,
  parseRunId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  type JsonRpcCallbackId,
  type PermissionIdentity,
  type Result,
  type RuntimePermissionRequestPayload,
} from "@guild/contracts";
import {
  applyPermissionEvent,
  canonicalizePermissionRecord,
  isTerminalPermissionState,
  PERMISSION_OUTBOX_LIFECYCLES,
  PERMISSION_REGISTER_MODES,
  PERMISSION_SIDE_EFFECTS,
  PERMISSION_STATES,
  permissionRegistrationFingerprint,
  registerPermissionRequest,
  TERMINAL_PERMISSION_STATES,
  type PermissionApplyResult,
  type PermissionRecord,
} from "./permission-machine.js";

function must<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

const identity: PermissionIdentity = {
  taskId: must(parseTaskId("task-1")),
  runId: must(parseRunId("run-1")),
  sessionId: must(parseSessionId("session-1")),
  toolCallId: must(parseToolCallId("tool-1")),
  adapterEpoch: must(parseAdapterEpoch(1)),
  windowId: must(parseWindowId("window-1")),
};
const received = { wallClockIso: "2026-08-27T12:00:00.000Z", monotonicMs: 100 };

function request(
  callbackRequestId: JsonRpcCallbackId = "callback-1",
  options = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" as const },
    { optionId: "reject-once", name: "Reject once", kind: "reject_once" as const },
    { optionId: "reject-always", name: "Always reject", kind: "reject_always" as const },
  ],
): RuntimePermissionRequestPayload {
  const payload = freezeRuntimePayload({
    type: "permission_request",
    sessionId: "session-1",
    received,
    callbackRequestId,
    toolCallId: "tool-1",
    title: "Write file?",
    options,
  });
  if (payload.type !== "permission_request") assert.fail("wrong payload");
  return payload;
}

let sequence = 0;
function key(label: string) {
  sequence += 1;
  return must(parseIdempotencyKey(`${label}-${sequence}`));
}
function commandId(label: string) {
  return must(parsePermissionOutboxCommandId(label));
}
function attemptId(label: string) {
  return must(parsePermissionDeliveryAttemptId(label));
}
function outboxVersion(value: number) {
  return must(parsePermissionOutboxVersion(value));
}
function registered(
  exactRequest = request(),
  overrides: Partial<Parameters<typeof registerPermissionRequest>[1]> = {},
): PermissionApplyResult & { ok: true } {
  const result = registerPermissionRequest([], {
    identity,
    request: exactRequest,
    idempotencyKey: key("register"),
    ...overrides,
  });
  if (!result.ok) assert.fail(result.reason);
  return result;
}
function applied(records: readonly PermissionRecord[], event: Parameters<typeof applyPermissionEvent>[1]) {
  const result = applyPermissionEvent(records, event);
  if (!result.ok) assert.fail(result.reason);
  return result;
}

describe("exact ACP permission domain", () => {
  it("runtime-freezes every exported permission enumeration", () => {
    for (const values of [
      PERMISSION_STATES,
      TERMINAL_PERMISSION_STATES,
      PERMISSION_REGISTER_MODES,
      PERMISSION_SIDE_EFFECTS,
      PERMISSION_OUTBOX_LIFECYCLES,
    ]) {
      assert.equal(Object.isFrozen(values), true);
      assert.throws(() => {
        (values as unknown as string[]).push("forged");
      }, TypeError);
    }
  });

  it("selects all four advertised option kinds with exact persisted metadata", () => {
    for (const option of request().options) {
      const start = registered();
      const cmd = commandId(`choose-${option.optionId}`);
      const resolved = applied(start.records, {
        type: "resolve",
        identity,
        callbackRequestId: "callback-1",
        outcome: { outcome: "selected", optionId: option.optionId },
        commandId: cmd,
      });
      assert.deepEqual(resolved.record.resolution, { outcome: "selected", option });
      assert.deepEqual(resolved.record.outbox?.command, {
        kind: "permission_response",
        target: { adapterEpoch: 1, callbackRequestId: "callback-1" },
        outcome: { outcome: "selected", option },
        cause: "explicit_user",
      });
      assert.deepEqual(resolved.record.decisionCommit, {
        cause: "explicit_user",
        outcome: { outcome: "selected", option },
        orphanCause: undefined,
        commandId: cmd,
        outboxVersion: 1,
      });
      assert.equal(Object.isFrozen(resolved.record.decisionCommit), true);
      assert.equal(Object.isFrozen(resolved.record.decisionCommit?.outcome), true);
      assert.equal(Object.isFrozen(resolved.record.outbox?.command), true);
      const version = resolved.record.outbox?.version;
      if (version === undefined) assert.fail("missing version");
      const delivery = attemptId(`delivery-${option.optionId}`);
      const claimed = applied(resolved.records, {
        type: "request_outbox_delivery",
        identity,
        commandId: cmd,
        version,
        deliveryAttemptId: delivery,
      });
      assert.equal(claimed.sideEffect, "request_one_upstream_write");
      const completed = applied(claimed.records, {
        type: "response_frame_flush_completed",
        identity,
        commandId: cmd,
        version,
        deliveryAttemptId: delivery,
      });
      assert.equal(
        completed.record.state,
        option.kind.startsWith("allow") ? "selected_allow" : "selected_rejection",
      );
      assert.equal(completed.record.outbox?.lifecycle, "completed");
    }
  });

  it("preserves typed callback IDs and rejects type-changing mismatches", () => {
    for (const callback of ["7", 7, null] as const) {
      const start = registered(request(callback));
      const ok = applied(start.records, {
        type: "resolve",
        identity,
        callbackRequestId: callback,
        outcome: { outcome: "cancelled" },
        commandId: commandId(`callback-${String(callback)}`),
      });
      assert.equal(ok.record.outbox?.command.target.callbackRequestId, callback);
      const mismatch = applyPermissionEvent(start.records, {
        type: "resolve",
        identity,
        callbackRequestId: callback === 7 ? "7" : callback === "7" ? 7 : "null",
        outcome: { outcome: "cancelled" },
        commandId: commandId(`mismatch-${String(callback)}`),
      });
      assert.deepEqual(mismatch.ok ? undefined : mismatch.reason, "callback_id_mismatch");
    }
  });

  it("rejects unadvertised options and malformed or mismatched requests without a command", () => {
    const start = registered();
    const unadvertised = applyPermissionEvent(start.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "selected", optionId: "missing" },
      commandId: commandId("missing-option"),
    });
    assert.equal(unadvertised.ok, false);
    assert.equal(start.record.outbox, undefined);

    for (const bad of [
      { ...request(), sessionId: "other-session" },
      { ...request(), toolCallId: "other-tool" },
      { ...request(), options: [{ optionId: "", name: "Bad", kind: "allow_once" }] },
      { ...request(), options: [request().options[0], request().options[0]] },
    ]) {
      const result = registerPermissionRequest([], {
        identity,
        request: bad as never,
        idempotencyKey: key("bad-request"),
      });
      assert.equal(result.ok, false);
      assert.equal(result.records.length, 0);
    }
  });

  it("copies canonical identity and freezes success, failure, records, and outbox capabilities", () => {
    const callerIdentity = { ...identity };
    const start = registerPermissionRequest([], {
      identity: callerIdentity,
      request: request(),
      idempotencyKey: key("immutable-register"),
    });
    if (!start.ok) assert.fail(start.reason);
    const originalWindow = start.record.identity.windowId;
    (callerIdentity as unknown as { windowId: PermissionIdentity["windowId"] }).windowId =
      must(parseWindowId("mutated-caller-window"));
    assert.equal(start.record.identity.windowId, originalWindow);
    assert.notEqual(start.record.identity, callerIdentity);
    assert.equal(Object.isFrozen(start), true);
    assert.equal(Object.isFrozen(start.records), true);
    assert.equal(Object.isFrozen(start.record), true);
    assert.equal(Object.isFrozen(start.record.identity), true);
    assert.equal(Object.isFrozen(start.record.request), true);
    assert.throws(() => {
      (start.record as unknown as { state: string }).state = "selected_allow";
    }, TypeError);
    assert.equal(start.record.state, "pending");

    const resolved = applied(start.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "cancelled" },
      commandId: commandId("immutable-command"),
    });
    assert.equal(Object.isFrozen(resolved.record.outbox), true);
    assert.equal(Object.isFrozen(resolved.record.outbox?.command), true);
    assert.equal(Object.isFrozen(resolved.record.decisionCommit), true);
    assert.equal(Object.isFrozen(resolved.record.decisionCommit?.outcome), true);
    assert.throws(() => {
      (resolved.record.outbox as unknown as { lifecycle: string }).lifecycle =
        "completed";
    }, TypeError);
    assert.throws(() => {
      (resolved.record.decisionCommit as unknown as { cause: string }).cause =
        "deadline";
    }, TypeError);
    assert.equal(resolved.record.outbox?.lifecycle, "pending");
    const immutableVersion = resolved.record.outbox?.version;
    if (immutableVersion === undefined) assert.fail("missing immutable version");
    const claimedAfterMutation = applied(resolved.records, {
      type: "request_outbox_delivery",
      identity,
      commandId: commandId("immutable-command"),
      version: immutableVersion,
      deliveryAttemptId: attemptId("immutable-attempt"),
    });
    assert.equal(claimedAfterMutation.record.outbox?.lifecycle, "in_flight");

    const denied = applyPermissionEvent(start.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "selected", optionId: "not-advertised" },
      commandId: commandId("immutable-denial"),
    });
    if (denied.ok) assert.fail("expected denial");
    assert.equal(Object.isFrozen(denied), true);
    assert.equal(Object.isFrozen(denied.records), true);
    assert.equal(Object.isFrozen(denied.record), true);
    assert.throws(() => {
      (denied as unknown as { ok: boolean }).ok = true;
    }, TypeError);
    assert.throws(() => {
      (denied.record as unknown as { state: string }).state = "selected_allow";
    }, TypeError);
    assert.throws(() => {
      (denied.records as unknown as PermissionRecord[]).push(start.record);
    }, TypeError);
    const later = applied(denied.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "cancelled" },
      commandId: commandId("after-denial"),
    });
    assert.equal(later.record.state, "resolving");
  });

  it("validates record provenance before register or apply can produce a side effect", () => {
    const start = registered();
    const selected = applied(start.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "selected", optionId: "allow-once" },
      commandId: commandId("provenance-command"),
    });
    const selectedVersion = selected.record.outbox?.version;
    if (selectedVersion === undefined) assert.fail("missing selected version");
    const claimed = applied(selected.records, {
      type: "request_outbox_delivery",
      identity,
      commandId: commandId("provenance-command"),
      version: selectedVersion,
      deliveryAttemptId: attemptId("provenance-attempt"),
    });

    const callbackForgery = JSON.parse(JSON.stringify(selected.record));
    callbackForgery.outbox.command.target.callbackRequestId = 7;
    const outcomeForgery = JSON.parse(JSON.stringify(selected.record));
    outcomeForgery.outbox.command.outcome = { outcome: "cancelled" };
    outcomeForgery.resolution = { outcome: "cancelled" };
    const commitForgery = JSON.parse(JSON.stringify(selected.record));
    commitForgery.decisionCommit.outcome = { outcome: "cancelled" };
    const commitExtra = JSON.parse(JSON.stringify(selected.record));
    commitExtra.decisionCommit.unexpected = true;
    const commitAccessor = structuredClone(selected.record) as unknown as {
      decisionCommit: Record<string, unknown>;
    };
    let commitGetterCalls = 0;
    Object.defineProperty(commitAccessor.decisionCommit, "cause", {
      enumerable: true,
      get() {
        commitGetterCalls += 1;
        return "explicit_user";
      },
    });
    const proxiedCommit = structuredClone(selected.record) as unknown as {
      decisionCommit: Record<string, unknown>;
    };
    let commitProxyReads = 0;
    proxiedCommit.decisionCommit = new Proxy(proxiedCommit.decisionCommit, {
      get() {
        commitProxyReads += 1;
        throw new Error("must not read decision commit proxy");
      },
    });
    const optionForgery = JSON.parse(JSON.stringify(selected.record));
    optionForgery.resolution.option.name = "Forged option";
    const lifecycleForgery = JSON.parse(JSON.stringify(selected.record));
    lifecycleForgery.outbox.lifecycle = "completed";
    lifecycleForgery.outbox.deliveryAttemptId = "forged-attempt";
    const attemptForgery = JSON.parse(JSON.stringify(claimed.record));
    delete attemptForgery.outbox.deliveryAttemptId;
    const fingerprintForgery = structuredClone(start.record) as unknown as {
      registrationFingerprint: string;
    };
    fingerprintForgery.registrationFingerprint = "forged-fingerprint";
    const identityForgery = structuredClone(start.record) as unknown as {
      identity: { windowId: string };
    };
    identityForgery.identity.windowId = "";

    const forgeries = [
      callbackForgery,
      outcomeForgery,
      commitForgery,
      commitExtra,
      commitAccessor,
      proxiedCommit,
      optionForgery,
      lifecycleForgery,
      attemptForgery,
      fingerprintForgery,
      identityForgery,
      [structuredClone(start.record), structuredClone(start.record)],
    ];
    for (const [index, candidate] of forgeries.entries()) {
      const records = Array.isArray(candidate) ? candidate : [candidate];
      const applyResult = applyPermissionEvent(
        records as readonly PermissionRecord[],
        {
          type: "deadline_passed",
          identity,
          transportCanReceive: true,
          commandId: commandId(`forged-apply-${index}`),
        },
      );
      assert.equal(applyResult.ok, false);
      if (!applyResult.ok) {
        assert.match(applyResult.reason, /invalid_permission_record|ambiguous_identity/);
        assert.equal(applyResult.records.length, 0);
        assert.equal("sideEffect" in applyResult, false);
      }
      const registerResult = registerPermissionRequest(
        records as readonly PermissionRecord[],
        {
          identity,
          request: request(),
          idempotencyKey: key(`forged-register-${index}`),
        },
      );
      assert.equal(registerResult.ok, false);
      if (!registerResult.ok) {
        assert.match(registerResult.reason, /invalid_permission_record|ambiguous_identity/);
        assert.equal(registerResult.records.length, 0);
        assert.equal("sideEffect" in registerResult, false);
      }
    }
    assert.equal(commitGetterCalls, 0);
    assert.equal(commitProxyReads, 0);

    const validClone = structuredClone(start.records);
    const admittedClone = applied(validClone, {
      type: "deadline_passed",
      identity,
      transportCanReceive: false,
    });
    assert.equal(admittedClone.record.state, "expired");
    assert.equal(Object.isFrozen(admittedClone.record), true);
    assert.notEqual(admittedClone.record, validClone[0]);
  });

  it("restores only one exact canonical persisted permission record", () => {
    const start = registered();
    const resolved = applied(start.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "selected", optionId: "allow-once" },
      commandId: commandId("restore-command"),
    });
    const persisted = structuredClone(resolved.record);
    const restored = canonicalizePermissionRecord(persisted);
    assert.deepEqual(restored, resolved.record);
    assert.notEqual(restored, persisted);
    assert.equal(Object.isFrozen(restored), true);
    assert.equal(Object.isFrozen(restored.identity), true);
    assert.equal(Object.isFrozen(restored.request), true);
    assert.equal(Object.isFrozen(restored.decisionCommit), true);
    assert.equal(Object.isFrozen(restored.outbox), true);

    const cases: unknown[] = [];
    const extra = structuredClone(resolved.record) as unknown as Record<string, unknown>;
    extra["unexpected"] = true;
    cases.push(extra);

    const forgedCommit = structuredClone(resolved.record) as unknown as {
      decisionCommit: { outcome: unknown };
    };
    forgedCommit.decisionCommit.outcome = { outcome: "cancelled" };
    cases.push(forgedCommit);

    const forgedOutbox = structuredClone(resolved.record) as unknown as {
      outbox: { lifecycle: string; deliveryAttemptId: string };
    };
    forgedOutbox.outbox.lifecycle = "completed";
    forgedOutbox.outbox.deliveryAttemptId = "forged-attempt";
    cases.push(forgedOutbox);

    let getterCalls = 0;
    const accessor = structuredClone(resolved.record) as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "state", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not invoke persisted record getter");
      },
    });
    cases.push(accessor);

    let proxyReads = 0;
    const proxy = new Proxy(structuredClone(resolved.record), {
      get() {
        proxyReads += 1;
        throw new Error("must not read persisted record proxy");
      },
    });
    cases.push(proxy);

    for (const candidate of cases) {
      assert.throws(
        () => canonicalizePermissionRecord(candidate),
        (error: unknown) =>
          error instanceof TypeError && error.message === "invalid_permission_record",
      );
    }
    assert.equal(getterCalls, 0);
    assert.equal(proxyReads, 0);
  });

  it("fail-closes malformed runtime events without throwing or mutating records", () => {
    const start = registered();
    const before = structuredClone(start.records);
    let getterCalls = 0;
    const getterEvent = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(getterEvent, "type", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not invoke event getter");
      },
    });
    Object.defineProperty(getterEvent, "identity", {
      enumerable: true,
      value: identity,
    });
    const prototypeEvent = Object.assign(Object.create({ forged: true }), {
      type: "deadline_passed",
      identity,
      transportCanReceive: false,
    });
    const sparseEvent = new Array(2);
    sparseEvent[0] = "deadline_passed";

    const probes: readonly unknown[] = [
      {
        type: "resolve",
        identity,
        callbackRequestId: "callback-1",
        outcome: { outcome: "cancelled" },
        commandId: "",
      },
      {
        type: "resolve",
        identity,
        callbackRequestId: "callback-1",
        outcome: null,
        commandId: "valid-command",
      },
      {
        type: "resolve",
        identity,
        callbackRequestId: Number.MAX_SAFE_INTEGER + 1,
        outcome: { outcome: "cancelled" },
        commandId: "valid-command",
      },
      {
        type: "request_outbox_delivery",
        identity,
        commandId: "valid-command",
        version: 1,
        deliveryAttemptId: "",
      },
      {
        type: "request_outbox_delivery",
        identity,
        commandId: "valid-command",
        version: 0,
        deliveryAttemptId: "valid-attempt",
      },
      {
        type: "orphan",
        identity,
        cause: "forged_cause",
        transportCanReceive: false,
      },
      {
        type: "deadline_passed",
        identity,
        transportCanReceive: "false",
      },
      { type: "deadline_passed", identity: {}, transportCanReceive: false },
      { type: "unknown", identity },
      null,
      getterEvent,
      prototypeEvent,
      sparseEvent,
    ];

    for (const probe of probes) {
      let result: PermissionApplyResult | undefined;
      assert.doesNotThrow(() => {
        result = applyPermissionEvent(start.records, probe as never);
      });
      if (result === undefined) assert.fail("missing malformed-event result");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid_permission_event");
        assert.equal("sideEffect" in result, false);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.records), true);
      }
      assert.deepEqual(start.records, before);
    }
    assert.equal(getterCalls, 0);
  });

  it("fail-closes malformed register inputs and sparse records without reading capabilities", () => {
    const start = registered();
    const validInput = {
      identity,
      request: request(),
      idempotencyKey: key("register-probe"),
    };
    let getterCalls = 0;
    const accessorInput = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorInput, "identity", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not invoke register getter");
      },
    });
    Object.defineProperty(accessorInput, "request", {
      enumerable: true,
      value: request(),
    });
    Object.defineProperty(accessorInput, "idempotencyKey", {
      enumerable: true,
      value: key("accessor-input"),
    });
    let proxyReads = 0;
    const proxyInput = new Proxy(validInput, {
      get() {
        proxyReads += 1;
        throw new Error("must not read register proxy");
      },
    });
    const prototypeInput = Object.assign(Object.create({ forged: true }), validInput);
    const probes: readonly unknown[] = [
      null,
      { ...validInput, unknown: true },
      accessorInput,
      prototypeInput,
      proxyInput,
      { ...validInput, commandId: "" },
      { ...validInput, transportCanReceive: "true" },
      { ...validInput, mode: "forged" },
    ];
    for (const probe of probes) {
      let result: PermissionApplyResult | undefined;
      assert.doesNotThrow(() => {
        result = registerPermissionRequest(start.records, probe as never);
      });
      if (result === undefined) assert.fail("missing register rejection");
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.reason, "invalid_permission_register_input");
        assert.equal(result.records.length, 1);
        assert.equal("sideEffect" in result, false);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.records), true);
      }
    }
    assert.equal(getterCalls, 0);
    assert.equal(proxyReads, 0);

    const sparseRecords = new Array<PermissionRecord>(1);
    const sparseResult = registerPermissionRequest(
      sparseRecords,
      validInput,
    );
    assert.equal(sparseResult.ok, false);
    if (!sparseResult.ok) {
      assert.equal(sparseResult.reason, "invalid_permission_record");
      assert.equal(sparseResult.records.length, 0);
      assert.equal("sideEffect" in sparseResult, false);
      assert.equal(Object.isFrozen(sparseResult), true);
    }

    let recordArrayGetterCalls = 0;
    const accessorRecords = [start.record];
    Object.defineProperty(accessorRecords, 0, {
      enumerable: true,
      get() {
        recordArrayGetterCalls += 1;
        return start.record;
      },
    });
    const accessorRecordsResult = registerPermissionRequest(
      accessorRecords,
      validInput,
    );
    assert.equal(accessorRecordsResult.ok, false);
    assert.equal(recordArrayGetterCalls, 0);

    let recordArrayProxyReads = 0;
    const proxyRecords = new Proxy([start.record], {
      get() {
        recordArrayProxyReads += 1;
        throw new Error("must not read records proxy");
      },
    });
    const proxyRecordsResult = registerPermissionRequest(
      proxyRecords,
      validInput,
    );
    assert.equal(proxyRecordsResult.ok, false);
    assert.equal(recordArrayProxyReads, 0);

    const extraRecords = [start.record] as PermissionRecord[] & {
      unexpected?: boolean;
    };
    extraRecords.unexpected = true;
    const extraRecordsResult = registerPermissionRequest(
      extraRecords,
      validInput,
    );
    assert.equal(extraRecordsResult.ok, false);

    let recordArrayPrototypeReads = 0;
    const customPrototypeRecords = [start.record];
    Object.setPrototypeOf(customPrototypeRecords, {
      get [Symbol.iterator]() {
        recordArrayPrototypeReads += 1;
        return Array.prototype[Symbol.iterator];
      },
    });
    const customPrototypeResult = registerPermissionRequest(
      customPrototypeRecords,
      validInput,
    );
    assert.equal(customPrototypeResult.ok, false);
    assert.equal(recordArrayPrototypeReads, 0);
  });

  it("fingerprints complete request semantics except receive time", () => {
    const firstRequest = request(1);
    const firstKey = key("same-key");
    const first = registerPermissionRequest([], { identity, request: firstRequest, idempotencyKey: firstKey });
    if (!first.ok) assert.fail(first.reason);
    const exact = registerPermissionRequest(first.records, { identity, request: firstRequest, idempotencyKey: firstKey });
    assert.equal(exact.ok && exact.duplicate, true);
    const reordered = request(1, [...firstRequest.options].reverse());
    const collision = registerPermissionRequest(first.records, { identity, request: reordered, idempotencyKey: firstKey });
    assert.deepEqual(collision.ok ? undefined : collision.reason, "idempotency_collision");
    const typeChanged = registerPermissionRequest(first.records, { identity, request: request("1"), idempotencyKey: key("new-key") });
    assert.deepEqual(typeChanged.ok ? undefined : typeChanged.reason, "registration_collision");
    const changedTitle = freezeRuntimePayload({ ...firstRequest, title: "A different title" });
    if (changedTitle.type !== "permission_request") assert.fail("wrong payload");
    const titleCollision = registerPermissionRequest(first.records, {
      identity,
      request: changedTitle,
      idempotencyKey: key("changed-title"),
    });
    assert.deepEqual(titleCollision.ok ? undefined : titleCollision.reason, "registration_collision");
    const laterTimestamp = freezeRuntimePayload({
      ...firstRequest,
      received: {
        wallClockIso: "2026-08-27T12:01:00.000Z",
        monotonicMs: 200,
      },
    });
    if (laterTimestamp.type !== "permission_request") assert.fail("wrong payload");
    const timestampDuplicate = registerPermissionRequest(first.records, {
      identity,
      request: laterTimestamp,
      idempotencyKey: key("later-timestamp"),
    });
    assert.equal(timestampDuplicate.ok && timestampDuplicate.duplicate, true);
    assert.notEqual(
      permissionRegistrationFingerprint(identity, firstRequest, "pending"),
      permissionRegistrationFingerprint(identity, changedTitle, "pending"),
    );
    assert.equal(
      permissionRegistrationFingerprint(identity, firstRequest, "pending"),
      permissionRegistrationFingerprint(identity, laterTimestamp, "pending"),
    );
    assert.notEqual(
      permissionRegistrationFingerprint(identity, firstRequest, "pending"),
      permissionRegistrationFingerprint(identity, firstRequest, "run_cancel_requested"),
    );
  });

  it("deduplicates the same semantics under a distinct delivery key", () => {
    const exactRequest = request();
    const first = registered(exactRequest);
    const second = registerPermissionRequest(first.records, {
      identity,
      request: exactRequest,
      idempotencyKey: key("redelivery"),
    });
    assert.equal(second.ok && second.duplicate, true);
    assert.equal(second.records.length, 1);
  });

  it("automatically selects reject_once, otherwise cancelled, and never reject_always", () => {
    const withRejectOnce = registered();
    const expired = applied(withRejectOnce.records, {
      type: "deadline_passed",
      identity,
      transportCanReceive: true,
      commandId: commandId("deadline-reject-once"),
    });
    assert.deepEqual(expired.record.resolution, {
      outcome: "selected",
      option: request().options.find((option) => option.kind === "reject_once"),
    });

    const noRejectOnce = request("callback-2", [
      { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
      { optionId: "allow", name: "Allow", kind: "allow_once" },
    ]);
    const fallback = registered(noRejectOnce);
    const orphaned = applied(fallback.records, {
      type: "orphan",
      identity,
      cause: "window_closed",
      transportCanReceive: true,
      commandId: commandId("orphan-cancelled"),
    });
    assert.deepEqual(orphaned.record.resolution, { outcome: "cancelled" });
    assert.equal(orphaned.record.outbox?.command.outcome.outcome, "cancelled");
  });

  it("creates no outbox command when the transport cannot receive", () => {
    const start = registered();
    const dead = applied(start.records, {
      type: "orphan",
      identity,
      cause: "transport_cannot_reply",
      transportCanReceive: false,
    });
    assert.equal(dead.record.state, "orphaned");
    assert.equal(dead.record.outbox, undefined);
  });

  it("enforces pending -> in_flight -> completed and delivery uncertainty", () => {
    const start = registered();
    const cmd = commandId("lifecycle-command");
    const resolved = applied(start.records, { type: "resolve", identity, callbackRequestId: "callback-1", outcome: { outcome: "cancelled" }, commandId: cmd });
    const committedDecision = structuredClone(resolved.record.decisionCommit);
    assert.equal(resolved.record.outbox?.lifecycle, "pending");
    const version = resolved.record.outbox?.version;
    if (version === undefined) assert.fail("missing version");
    const delivery = attemptId("lifecycle-delivery");
    const claimed = applied(resolved.records, { type: "request_outbox_delivery", identity, commandId: cmd, version, deliveryAttemptId: delivery });
    assert.equal(claimed.record.outbox?.lifecycle, "in_flight");
    assert.deepEqual(claimed.record.decisionCommit, committedDecision);
    const repeatedClaim = applied(claimed.records, { type: "request_outbox_delivery", identity, commandId: cmd, version, deliveryAttemptId: delivery });
    assert.equal(repeatedClaim.duplicate, true);
    const lost = applied(claimed.records, { type: "orphan", identity, cause: "epoch_exited", transportCanReceive: false });
    assert.equal(lost.record.state, "delivery_uncertain");
    assert.equal(lost.record.outbox?.lifecycle, "delivery_uncertain");
    assert.deepEqual(lost.record.decisionCommit, committedDecision);
    const repeatedLoss = applied(lost.records, { type: "orphan", identity, cause: "session_changed", transportCanReceive: false });
    assert.equal(repeatedLoss.duplicate, true);
    assert.equal(repeatedLoss.record.state, "delivery_uncertain");
    assert.deepEqual(repeatedLoss.record.outbox, lost.record.outbox);
    const deadlineAfterLoss = applied(repeatedLoss.records, { type: "deadline_passed", identity, transportCanReceive: true, commandId: commandId("must-not-replace-uncertain") });
    assert.equal(deadlineAfterLoss.duplicate, true);
    assert.equal(deadlineAfterLoss.sideEffect, "none");
    assert.deepEqual(deadlineAfterLoss.record.outbox, lost.record.outbox);
    const reloadAfterLoss = applied(deadlineAfterLoss.records, { type: "orphan", identity, cause: "window_reloaded", transportCanReceive: true, commandId: commandId("must-not-replace-reload") });
    assert.equal(reloadAfterLoss.duplicate, true);
    assert.equal(reloadAfterLoss.sideEffect, "none");
    assert.deepEqual(reloadAfterLoss.record.outbox, lost.record.outbox);
    const retry = applyPermissionEvent(lost.records, { type: "request_outbox_delivery", identity, commandId: cmd, version, deliveryAttemptId: attemptId("other-delivery") });
    assert.deepEqual(retry.ok ? undefined : retry.reason, "delivery_uncertain");
    const lateAck = applied(repeatedLoss.records, { type: "response_frame_flush_completed", identity, commandId: cmd, version, deliveryAttemptId: delivery });
    assert.equal(lateAck.record.state, "cancelled");
    assert.equal(lateAck.record.outbox?.lifecycle, "completed");
    assert.deepEqual(lateAck.record.decisionCommit, committedDecision);

    const automatic = registered();
    const automaticCommand = commandId("automatic-lifecycle-command");
    const expired = applied(automatic.records, { type: "deadline_passed", identity, transportCanReceive: true, commandId: automaticCommand });
    const automaticVersion = expired.record.outbox?.version;
    if (automaticVersion === undefined) assert.fail("missing automatic version");
    const automaticDelivery = attemptId("automatic-lifecycle-delivery");
    const claimedAutomatic = applied(expired.records, { type: "request_outbox_delivery", identity, commandId: automaticCommand, version: automaticVersion, deliveryAttemptId: automaticDelivery });
    const lostAutomatic = applied(claimedAutomatic.records, { type: "orphan", identity, cause: "epoch_exited", transportCanReceive: false });
    assert.equal(lostAutomatic.record.state, "delivery_uncertain");
    assert.equal(lostAutomatic.record.outbox?.lifecycle, "delivery_uncertain");

    const claimedBeforeDeadline = applied(resolved.records, { type: "request_outbox_delivery", identity, commandId: cmd, version, deliveryAttemptId: attemptId("claimed-before-deadline") });
    const deadlineAfterClaim = applied(claimedBeforeDeadline.records, { type: "deadline_passed", identity, transportCanReceive: false });
    assert.equal(deadlineAfterClaim.duplicate, true);
    assert.equal(deadlineAfterClaim.record.state, "resolving");
    assert.equal(deadlineAfterClaim.record.outbox?.lifecycle, "in_flight");
    assert.equal(deadlineAfterClaim.record.outbox?.command.cause, "explicit_user");
    const epochAfterDeadline = applied(deadlineAfterClaim.records, { type: "orphan", identity, cause: "epoch_exited", transportCanReceive: false });
    assert.equal(epochAfterDeadline.record.state, "delivery_uncertain");
    assert.equal(epochAfterDeadline.record.outbox?.lifecycle, "delivery_uncertain");
  });

  it("rejects conflicting resolution and enforces command, version, and attempt CAS", () => {
    const start = registered();
    const command = commandId("cas-command");
    const resolved = applied(start.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "selected", optionId: "allow-once" },
      commandId: command,
    });
    const version = resolved.record.outbox?.version;
    if (version === undefined) assert.fail("missing CAS version");
    const exactRepeat = applied(resolved.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "selected", optionId: "allow-once" },
      commandId: commandId("ignored-repeat-command"),
    });
    assert.equal(exactRepeat.duplicate, true);
    assert.equal(exactRepeat.record.outbox?.commandId, command);
    const conflicting = applyPermissionEvent(resolved.records, {
      type: "resolve",
      identity,
      callbackRequestId: "callback-1",
      outcome: { outcome: "cancelled" },
      commandId: commandId("conflicting-command"),
    });
    assert.equal(conflicting.ok, false);
    if (!conflicting.ok) assert.equal(conflicting.reason, "not_pending");

    const beforeClaim = applyPermissionEvent(resolved.records, {
      type: "response_frame_flush_completed",
      identity,
      commandId: command,
      version,
      deliveryAttemptId: attemptId("ack-before-claim"),
    });
    assert.equal(beforeClaim.ok, false);
    if (!beforeClaim.ok) assert.equal(beforeClaim.reason, "write_not_in_progress");

    for (const event of [
      {
        type: "request_outbox_delivery" as const,
        identity,
        commandId: commandId("old-command"),
        version,
        deliveryAttemptId: attemptId("old-command-attempt"),
      },
      {
        type: "request_outbox_delivery" as const,
        identity,
        commandId: command,
        version: outboxVersion(version + 1),
        deliveryAttemptId: attemptId("old-version-attempt"),
      },
    ]) {
      const rejected = applyPermissionEvent(resolved.records, event);
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.reason, "outbox_cas_mismatch");
    }

    const attempt = attemptId("cas-attempt");
    const claimed = applied(resolved.records, {
      type: "request_outbox_delivery",
      identity,
      commandId: command,
      version,
      deliveryAttemptId: attempt,
    });
    const secondAttempt = applyPermissionEvent(claimed.records, {
      type: "request_outbox_delivery",
      identity,
      commandId: command,
      version,
      deliveryAttemptId: attemptId("second-attempt"),
    });
    assert.equal(secondAttempt.ok, false);
    if (!secondAttempt.ok) assert.equal(secondAttempt.reason, "already_in_flight");

    for (const event of [
      {
        type: "response_frame_flush_completed" as const,
        identity,
        commandId: commandId("old-ack-command"),
        version,
        deliveryAttemptId: attempt,
      },
      {
        type: "response_frame_flush_completed" as const,
        identity,
        commandId: command,
        version: outboxVersion(version + 1),
        deliveryAttemptId: attempt,
      },
      {
        type: "response_frame_flush_completed" as const,
        identity,
        commandId: command,
        version,
        deliveryAttemptId: attemptId("old-ack-attempt"),
      },
    ]) {
      const rejected = applyPermissionEvent(claimed.records, event);
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.reason, "outbox_cas_mismatch");
    }

    const completed = applied(claimed.records, {
      type: "response_frame_flush_completed",
      identity,
      commandId: command,
      version,
      deliveryAttemptId: attempt,
    });
    assert.equal(completed.record.state, "selected_allow");
    const duplicateAck = applied(completed.records, {
      type: "response_frame_flush_completed",
      identity,
      commandId: command,
      version,
      deliveryAttemptId: attempt,
    });
    assert.equal(duplicateAck.duplicate, true);
    assert.equal(duplicateAck.record.state, "selected_allow");
  });

  it("settles automatic and uncertain ACKs by durable command cause", () => {
    const deadlineRequest = request(7);
    const deadlineStart = registered(deadlineRequest);
    const deadlineCommand = commandId("automatic-deadline-command");
    const deadlinePending = applied(deadlineStart.records, {
      type: "deadline_passed",
      identity,
      transportCanReceive: true,
      commandId: deadlineCommand,
    });
    assert.equal(deadlinePending.record.outbox?.command.target.callbackRequestId, 7);
    const deadlineVersion = deadlinePending.record.outbox?.version;
    if (deadlineVersion === undefined) assert.fail("missing deadline version");
    const deadlineAttempt = attemptId("automatic-deadline-attempt");
    const deadlineClaimed = applied(deadlinePending.records, {
      type: "request_outbox_delivery",
      identity,
      commandId: deadlineCommand,
      version: deadlineVersion,
      deliveryAttemptId: deadlineAttempt,
    });
    const deadlineUncertain = applied(deadlineClaimed.records, {
      type: "orphan",
      identity,
      cause: "epoch_exited",
      transportCanReceive: false,
    });
    const deadlineCompleted = applied(deadlineUncertain.records, {
      type: "response_frame_flush_completed",
      identity,
      commandId: deadlineCommand,
      version: deadlineVersion,
      deliveryAttemptId: deadlineAttempt,
    });
    assert.equal(deadlineCompleted.record.state, "expired");
    assert.equal(deadlineCompleted.record.orphanCause, undefined);

    const orphanStart = registered(request(null));
    const orphanCommand = commandId("automatic-orphan-command");
    const orphanPending = applied(orphanStart.records, {
      type: "orphan",
      identity,
      cause: "window_closed",
      transportCanReceive: true,
      commandId: orphanCommand,
    });
    assert.equal(orphanPending.record.outbox?.command.target.callbackRequestId, null);
    const orphanVersion = orphanPending.record.outbox?.version;
    if (orphanVersion === undefined) assert.fail("missing orphan version");
    const orphanAttempt = attemptId("automatic-orphan-attempt");
    const orphanClaimed = applied(orphanPending.records, {
      type: "request_outbox_delivery",
      identity,
      commandId: orphanCommand,
      version: orphanVersion,
      deliveryAttemptId: orphanAttempt,
    });
    const orphanUncertain = applied(orphanClaimed.records, {
      type: "orphan",
      identity,
      cause: "session_changed",
      transportCanReceive: false,
    });
    const orphanCompleted = applied(orphanUncertain.records, {
      type: "response_frame_flush_completed",
      identity,
      commandId: orphanCommand,
      version: orphanVersion,
      deliveryAttemptId: orphanAttempt,
    });
    assert.equal(orphanCompleted.record.state, "orphaned");

    const runCancelCommand = commandId("automatic-run-cancel-command");
    const runCancel = registered(request(null), {
      mode: "run_cancel_requested",
      commandId: runCancelCommand,
      transportCanReceive: true,
    });
    const runCancelVersion = runCancel.record.outbox?.version;
    if (runCancelVersion === undefined) assert.fail("missing run-cancel version");
    const runCancelAttempt = attemptId("automatic-run-cancel-attempt");
    const runCancelClaimed = applied(runCancel.records, {
      type: "request_outbox_delivery",
      identity,
      commandId: runCancelCommand,
      version: runCancelVersion,
      deliveryAttemptId: runCancelAttempt,
    });
    const runCancelCompleted = applied(runCancelClaimed.records, {
      type: "response_frame_flush_completed",
      identity,
      commandId: runCancelCommand,
      version: runCancelVersion,
      deliveryAttemptId: runCancelAttempt,
    });
    assert.equal(runCancelCompleted.record.state, "orphaned");
    assert.equal(runCancelCompleted.record.orphanCause, "run_cancel_requested");
  });

  it("rejects a new epoch and never replaces a durable explicit response", () => {
    const start = registered();
    const cmd = commandId("window-command");
    const resolved = applied(start.records, { type: "resolve", identity, callbackRequestId: "callback-1", outcome: { outcome: "selected", optionId: "allow-once" }, commandId: cmd });
    const originalCommit = structuredClone(resolved.record.decisionCommit);
    const version = resolved.record.outbox?.version;
    if (version === undefined) assert.fail("missing version");
    const foreignIdentity = { ...identity, adapterEpoch: must(parseAdapterEpoch(2)) };
    const foreign = applyPermissionEvent(resolved.records, { type: "request_outbox_delivery", identity: foreignIdentity, commandId: cmd, version, deliveryAttemptId: attemptId("foreign") });
    assert.equal(foreign.ok, false);

    const afterWindowClose = applied(resolved.records, { type: "orphan", identity, cause: "window_closed", transportCanReceive: true, commandId: commandId("must-not-replace-window") });
    assert.equal(afterWindowClose.duplicate, true);
    assert.equal(afterWindowClose.record.state, "resolving");
    assert.equal(afterWindowClose.record.outbox?.command.cause, "explicit_user");
    assert.equal(afterWindowClose.record.outbox?.commandId, cmd);
    assert.deepEqual(afterWindowClose.record.decisionCommit, originalCommit);
    const afterDeadline = applied(afterWindowClose.records, { type: "deadline_passed", identity, transportCanReceive: true, commandId: commandId("must-not-replace-deadline") });
    assert.equal(afterDeadline.duplicate, true);
    assert.equal(afterDeadline.record.outbox?.command.cause, "explicit_user");
    assert.equal(afterDeadline.record.outbox?.commandId, cmd);
    assert.deepEqual(afterDeadline.record.decisionCommit, originalCommit);
    const claimed = applied(resolved.records, { type: "request_outbox_delivery", identity, commandId: cmd, version, deliveryAttemptId: attemptId("claimed") });
    const afterClaim = applied(claimed.records, { type: "orphan", identity, cause: "window_closed", transportCanReceive: true, commandId: commandId("ignored-replacement") });
    assert.equal(afterClaim.duplicate, true);
    assert.equal(afterClaim.record.state, "resolving");
    assert.equal(afterClaim.record.outbox?.command.cause, "explicit_user");
    assert.equal(afterClaim.record.outbox?.lifecycle, "in_flight");
    assert.deepEqual(afterClaim.record.decisionCommit, originalCommit);
  });

  it("registers run-cancel requests with one exact safe command and no actionable state", () => {
    const result = registered(request(), {
      mode: "run_cancel_requested",
      transportCanReceive: true,
      commandId: commandId("run-cancel-command"),
    });
    assert.equal(result.record.state, "orphaned");
    assert.equal(result.record.outbox?.command.cause, "run_cancel_requested");
    assert.equal(result.record.outbox?.command.outcome.outcome, "selected");
    const existing = applied(registered().records, {
      type: "orphan",
      identity,
      cause: "run_cancel_requested",
      transportCanReceive: true,
      commandId: commandId("existing-run-cancel-command"),
    });
    assert.equal(existing.record.state, "orphaned");
    assert.equal(existing.record.outbox?.command.cause, "run_cancel_requested");
    const dead = registered(request(), {
      mode: "run_cancel_requested",
      transportCanReceive: false,
    });
    assert.equal(dead.record.outbox, undefined);
  });

  it("clears automatic pending commands when their transport epoch is permanently dead", () => {
    const sources = [
      applied(registered().records, {
        type: "resolve",
        identity,
        callbackRequestId: "callback-1",
        outcome: { outcome: "selected", optionId: "allow-once" },
        commandId: commandId("dead-explicit"),
      }),
      registered(request(), {
        mode: "run_cancel_requested",
        transportCanReceive: true,
        commandId: commandId("dead-run-cancel"),
      }),
      applied(registered().records, {
        type: "deadline_passed",
        identity,
        transportCanReceive: true,
        commandId: commandId("dead-deadline"),
      }),
      applied(registered().records, {
        type: "orphan",
        identity,
        cause: "window_closed",
        transportCanReceive: true,
        commandId: commandId("dead-window"),
      }),
    ];

    for (const [index, source] of sources.entries()) {
      const pending = source.record.outbox;
      if (pending === undefined) assert.fail("missing pending command");
      const committedDecision = structuredClone(source.record.decisionCommit);
      const closed = applied(source.records, {
        type: "orphan",
        identity,
        cause: "epoch_exited",
        transportCanReceive: false,
      });
      assert.equal(closed.record.outbox, undefined);
      assert.deepEqual(closed.record.decisionCommit, committedDecision);
      assert.equal(closed.sideEffect, "none");
      const claimAfterClose = applyPermissionEvent(closed.records, {
        type: "request_outbox_delivery",
        identity,
        commandId: pending.commandId,
        version: pending.version,
        deliveryAttemptId: attemptId(`closed-attempt-${index}`),
      });
      assert.equal(claimAfterClose.ok, false);
      if (!claimAfterClose.ok) {
        assert.equal(claimAfterClose.reason, "write_not_in_progress");
        assert.equal("sideEffect" in claimAfterClose, false);
      }
    }
  });

  it("keeps concurrent identities independent and terminal states explicit", () => {
    const otherIdentity = { ...identity, toolCallId: must(parseToolCallId("tool-2")) };
    const otherRequest = freezeRuntimePayload({ ...request(), toolCallId: "tool-2" });
    if (otherRequest.type !== "permission_request") assert.fail("wrong payload");
    const first = registered();
    const second = registerPermissionRequest(first.records, { identity: otherIdentity, request: otherRequest, idempotencyKey: key("other-register") });
    if (!second.ok) assert.fail(second.reason);
    const resolveOther = applied(second.records, { type: "resolve", identity: otherIdentity, callbackRequestId: "callback-1", outcome: { outcome: "cancelled" }, commandId: commandId("resolve-other") });
    assert.equal(resolveOther.records.length, 2);
    assert.equal(resolveOther.records.find((record) => permissionRegistrationFingerprint(record.identity, record.request, record.registrationMode) === first.record.registrationFingerprint)?.state, "pending");
    for (const state of TERMINAL_PERMISSION_STATES) assert.equal(isTerminalPermissionState(state), true);
    assert.equal(isTerminalPermissionState("pending"), false);
  });
});
