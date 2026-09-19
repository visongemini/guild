import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADAPTER_EPOCH_STATUSES,
  INGEST_MODES,
  liveEventKindAllowed,
  LIVE_EVENT_KINDS_BY_RUN_STATE,
  parsePermissionIdentity,
  parseRuntimeEnvelope,
  parseRuntimeEventKind,
  permissionIdentitiesEqual,
  PERMISSION_IDENTITY_FIELDS,
  RUNTIME_EVENT_KINDS,
  type RuntimeEventKind,
} from "./runtime-envelope.js";

function identity(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-a",
    runId: "run-1",
    sessionId: "sess-1",
    toolCallId: "tool-1",
    adapterEpoch: 1,
    windowId: "win-1",
    ...overrides,
  };
}

describe("permission identity (PC-PERM-001)", () => {
  it("requires the exact six-field tuple", () => {
    assert.deepEqual([...PERMISSION_IDENTITY_FIELDS], [
      "taskId",
      "runId",
      "sessionId",
      "toolCallId",
      "adapterEpoch",
      "windowId",
    ]);
    const parsed = parsePermissionIdentity(identity());
    assert.equal(parsed.ok, true);
  });

  it("rejects incomplete or empty identity fields", () => {
    for (const field of PERMISSION_IDENTITY_FIELDS) {
      const missing = identity();
      delete missing[field];
      assert.equal(parsePermissionIdentity(missing).ok, false);
      const empty = identity({ [field]: field === "adapterEpoch" ? 0 : "" });
      assert.equal(parsePermissionIdentity(empty).ok, false);
    }
  });

  it("compares every field with exact equality", () => {
    const left = parsePermissionIdentity(identity());
    assert.equal(left.ok, true);
    if (!left.ok) {
      return;
    }
    const mismatches = [
      identity({ taskId: "task-b" }),
      identity({ runId: "run-2" }),
      identity({ sessionId: "sess-2" }),
      identity({ toolCallId: "tool-2" }),
      identity({ adapterEpoch: 2 }),
      identity({ windowId: "win-2" }),
    ];
    for (const candidate of mismatches) {
      const right = parsePermissionIdentity(candidate);
      assert.equal(right.ok, true);
      if (!right.ok) {
        return;
      }
      assert.equal(permissionIdentitiesEqual(left.value, right.value), false);
    }
    const same = parsePermissionIdentity(identity());
    assert.equal(same.ok, true);
    if (!same.ok) {
      return;
    }
    assert.equal(permissionIdentitiesEqual(left.value, same.value), true);
  });
});

describe("runtime envelope", () => {
  it("runtime-freezes public event allowlists and nested state guards", () => {
    for (const allowlist of [
      INGEST_MODES,
      ADAPTER_EPOCH_STATUSES,
      RUNTIME_EVENT_KINDS,
      PERMISSION_IDENTITY_FIELDS,
    ] as const) {
      assert.equal(Object.isFrozen(allowlist), true);
      assert.throws(() => {
        (allowlist as unknown as string[]).push("forged");
      }, TypeError);
    }
    assert.equal(Object.isFrozen(LIVE_EVENT_KINDS_BY_RUN_STATE), true);
    for (const kinds of Object.values(LIVE_EVENT_KINDS_BY_RUN_STATE)) {
      assert.equal(Object.isFrozen(kinds), true);
      assert.throws(() => {
        (kinds as RuntimeEventKind[]).push("terminal_success");
      }, TypeError);
    }
    assert.equal(parseRuntimeEventKind("forged").ok, false);
    assert.equal(parseRuntimeEventKind("session_update").ok, true);
    assert.equal(liveEventKindAllowed("starting", "terminal_success"), false);
    assert.equal(liveEventKindAllowed("running", "terminal_success"), true);
  });

  it("parses a live envelope and rejects empty identities", () => {
    const parsed = parseRuntimeEnvelope({
      taskId: "task-a",
      runId: "run-1",
      sessionId: "sess-1",
      adapterEpoch: 1,
      ingestMode: "live",
      receiveSequence: 1,
      idempotencyKey: "evt-1",
      kind: "session_update",
      semanticPayloadDigest: "sem-default",
    });
    assert.equal(parsed.ok, true);
    assert.equal(
      parseRuntimeEnvelope({
        taskId: "",
        runId: "run-1",
        sessionId: "sess-1",
        adapterEpoch: 1,
        ingestMode: "live",
        receiveSequence: 1,
        idempotencyKey: "evt-1",
        kind: "session_update",
      }).ok,
      false,
    );
    assert.equal(
      parseRuntimeEnvelope({
        taskId: "task-a",
        runId: "run-1",
        sessionId: "sess-1",
        adapterEpoch: 1,
        ingestMode: "buffered",
        receiveSequence: 1,
        idempotencyKey: "evt-1",
        kind: "session_update",
      }).ok,
      false,
    );
  });
});
