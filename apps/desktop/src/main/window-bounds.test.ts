import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitInitialWindowBounds } from "./window-bounds.js";

describe("fitInitialWindowBounds", () => {
  it("keeps the preferred window size on a large display", () => {
    assert.deepEqual(fitInitialWindowBounds({ width: 1512, height: 945 }), {
      width: 1280,
      height: 820,
      minWidth: 680,
      minHeight: 520,
    });
  });

  it("keeps the whole window inside a smaller work area", () => {
    assert.deepEqual(fitInitialWindowBounds({ width: 1056, height: 700 }), {
      width: 1032,
      height: 676,
      minWidth: 680,
      minHeight: 520,
    });
  });

  it("never advertises a minimum larger than the fitted window", () => {
    assert.deepEqual(fitInitialWindowBounds({ width: 640, height: 480 }), {
      width: 616,
      height: 456,
      minWidth: 616,
      minHeight: 456,
    });
  });
});
