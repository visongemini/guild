import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTerminalRunState,
  LIVE_UPDATE_CHANNELS,
  RUN_EFFECTS,
  RUN_STATES,
  TERMINAL_RUN_STATES,
} from "@guild/contracts";

function assertFrozenArray(value: readonly unknown[]): void {
  assert.equal(Object.isFrozen(value), true);
  assert.throws(
    () => (value as unknown as unknown[]).push("poison"),
    TypeError,
  );
}

describe("run states", () => {
  it("treats only completed, failed, cancelled, and interrupted as terminal", () => {
    assert.deepEqual([...TERMINAL_RUN_STATES], [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    for (const state of RUN_STATES) {
      assert.equal(
        isTerminalRunState(state),
        (TERMINAL_RUN_STATES as readonly string[]).includes(state),
      );
    }
  });

  it("freezes every package-root Run constant at runtime", () => {
    assertFrozenArray(RUN_STATES);
    assertFrozenArray(TERMINAL_RUN_STATES);
    assertFrozenArray(RUN_EFFECTS);
    assertFrozenArray(LIVE_UPDATE_CHANNELS);

    assert.deepEqual([...TERMINAL_RUN_STATES], [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]);
    assert.equal(isTerminalRunState("queued"), false);
    assert.equal(isTerminalRunState("completed"), true);
  });
});
