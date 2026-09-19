import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextWindowView } from "./context-window.js";

describe("context window view", () => {
  it("keeps unavailable usage explicit", () => {
    assert.deepEqual(contextWindowView({ status: "unavailable" }, "zh-CN"), {
      available: false,
      hasSize: false,
      percent: 0,
      usedLabel: "",
      sizeLabel: "",
    });
  });

  it("shows exact official token occupancy when the runtime omits window size", () => {
    assert.deepEqual(contextWindowView({ status: "used_only", used: 25_523 }, "en-US"), {
      available: true,
      hasSize: false,
      percent: 0,
      usedLabel: "25,523",
      sizeLabel: "",
    });
  });

  it("shows exact used and size values with a bounded percentage", () => {
    assert.deepEqual(contextWindowView({ status: "available", used: 81_920, size: 262_144 }, "en-US"), {
      available: true,
      hasSize: true,
      percent: 31,
      usedLabel: "81,920",
      sizeLabel: "262,144",
    });
    assert.equal(contextWindowView({ status: "available", used: 300, size: 100 }, "en-US").percent, 100);
  });
});
