import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRequirementPhase,
  isRequirementSeverity,
  nextAdapterEpoch,
  nextPermissionOutboxVersion,
  parseAdapterEpoch,
  parseBarrierRequestId,
  parseIdempotencyKey,
  parsePermissionDeliveryAttemptId,
  parsePermissionOutboxCommandId,
  parsePermissionOutboxVersion,
  parseProductRequirementId,
  parseRunId,
  parseSessionAttemptId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  PRODUCT_REQUIREMENT_ID_PATTERN,
  REQUIREMENT_PHASES,
  REQUIREMENT_SEVERITIES,
} from "./ids.js";

describe("opaque identifiers", () => {
  it("accepts non-empty branded strings", () => {
    assert.equal(parseTaskId("task-1").ok, true);
    assert.equal(parseRunId("run-1").ok, true);
    assert.equal(parseSessionId("sess-1").ok, true);
    assert.equal(parseToolCallId("tool-1").ok, true);
    assert.equal(parseWindowId("win-1").ok, true);
    assert.equal(parseBarrierRequestId("barrier-1").ok, true);
    assert.equal(parseSessionAttemptId("attempt-1").ok, true);
    assert.equal(parsePermissionOutboxCommandId("cmd-1").ok, true);
    assert.equal(parsePermissionDeliveryAttemptId("delivery-1").ok, true);
    assert.equal(parseIdempotencyKey("key-1").ok, true);
  });

  it("rejects empty and non-string values", () => {
    for (const value of ["", 1, null, undefined, {}, []]) {
      assert.equal(parseTaskId(value).ok, false);
      assert.equal(parseRunId(value).ok, false);
      assert.equal(parseSessionId(value).ok, false);
      assert.equal(parseToolCallId(value).ok, false);
      assert.equal(parseWindowId(value).ok, false);
      assert.equal(parseBarrierRequestId(value).ok, false);
      assert.equal(parseSessionAttemptId(value).ok, false);
      assert.equal(parsePermissionOutboxCommandId(value).ok, false);
      assert.equal(parsePermissionDeliveryAttemptId(value).ok, false);
      assert.equal(parseIdempotencyKey(value).ok, false);
    }
  });

  it("validates product requirement IDs", () => {
    assert.equal(parseProductRequirementId("PC-TRACE-001").ok, true);
    assert.equal(parseProductRequirementId("PC-RUN-001").ok, true);
    assert.equal(parseProductRequirementId("pc-trace-001").ok, false);
    assert.equal(parseProductRequirementId("PC-TRACE-1").ok, false);
    assert.equal(parseProductRequirementId("").ok, false);
    assert.equal(PRODUCT_REQUIREMENT_ID_PATTERN.test("PC-PERM-002"), true);
  });

  it("keeps requirement parsing independent of RegExp state poisoning", () => {
    assert.equal(Object.isFrozen(PRODUCT_REQUIREMENT_ID_PATTERN), true);
    assert.equal(Object.isFrozen(PRODUCT_REQUIREMENT_ID_PATTERN.test), true);
    assert.equal(
      Object.hasOwn(PRODUCT_REQUIREMENT_ID_PATTERN, "compile"),
      false,
    );
    assert.throws(() => {
      (PRODUCT_REQUIREMENT_ID_PATTERN as unknown as { source: string }).source =
        ".*";
    }, TypeError);
    assert.throws(() => {
      (
        PRODUCT_REQUIREMENT_ID_PATTERN as unknown as {
          test: (value: unknown) => boolean;
        }
      ).test = () => true;
    }, TypeError);
    assert.equal(PRODUCT_REQUIREMENT_ID_PATTERN.source, "^PC-[A-Z][A-Z0-9]*-[0-9]{3}$");
    assert.equal(parseProductRequirementId("forged").ok, false);
    assert.equal(parseProductRequirementId("PC-TRACE-001").ok, true);
  });

  it("runtime-freezes requirement parser allowlists", () => {
    assert.equal(Object.isFrozen(REQUIREMENT_SEVERITIES), true);
    assert.equal(Object.isFrozen(REQUIREMENT_PHASES), true);
    assert.throws(() => {
      (REQUIREMENT_SEVERITIES as unknown as string[]).push("forged");
    }, TypeError);
    assert.throws(() => {
      (REQUIREMENT_PHASES as unknown as number[]).push(99);
    }, TypeError);
    assert.equal(isRequirementSeverity("forged"), false);
    assert.equal(isRequirementSeverity("P1"), true);
    assert.equal(isRequirementPhase(99), false);
    assert.equal(isRequirementPhase(1), true);
  });
});

describe("adapter epochs (PC-TRN-002)", () => {
  it("starts at 1 and increases monotonically without reuse", () => {
    const first = nextAdapterEpoch(undefined);
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(first.value, 1);
    const second = nextAdapterEpoch(first.value);
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.value, 2);
    assert.equal(second.value > first.value, true);
    const third = nextAdapterEpoch(second.value);
    assert.equal(third.ok, true);
    if (!third.ok) {
      return;
    }
    assert.equal(third.value, 3);
    assert.notEqual(third.value, first.value);
    assert.notEqual(third.value, second.value);
  });

  it("rejects zero, negative, and non-integer epochs", () => {
    assert.equal(parseAdapterEpoch(0).ok, false);
    assert.equal(parseAdapterEpoch(-1).ok, false);
    assert.equal(parseAdapterEpoch(1.5).ok, false);
    assert.equal(parseAdapterEpoch("1").ok, false);
  });
});

describe("permission outbox versions (PC-PERM-002)", () => {
  it("starts at 1 and increases monotonically without reuse", () => {
    const first = nextPermissionOutboxVersion(undefined);
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(first.value, 1);
    const second = nextPermissionOutboxVersion(first.value);
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.value, 2);
    assert.equal(second.value > first.value, true);
  });

  it("rejects zero, negative, and non-integer versions", () => {
    assert.equal(parsePermissionOutboxVersion(0).ok, false);
    assert.equal(parsePermissionOutboxVersion(-1).ok, false);
    assert.equal(parsePermissionOutboxVersion(1.5).ok, false);
    assert.equal(parsePermissionOutboxVersion("1").ok, false);
  });
});
