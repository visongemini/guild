import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_MENU_CONFIRM_WIDTH,
  CONTEXT_MENU_HEIGHT,
  CONTEXT_MENU_MARGIN,
  CONTEXT_MENU_WIDTH,
  clampContextMenuPosition,
} from "./popover-bounds.js";

test("context menu opened near a wide corner stays inside after the window shrinks", () => {
  const opened = clampContextMenuPosition(1268, 808, 1280, 820);
  assert.equal(opened.x, 1280 - CONTEXT_MENU_WIDTH);
  assert.equal(opened.y, 820 - CONTEXT_MENU_HEIGHT);

  const afterNarrow = clampContextMenuPosition(opened.x, opened.y, 680, 560);
  assert.equal(afterNarrow.x, 680 - CONTEXT_MENU_WIDTH);
  assert.equal(afterNarrow.y, 560 - CONTEXT_MENU_HEIGHT);
  assert.ok(afterNarrow.x + CONTEXT_MENU_WIDTH <= 680);
  assert.ok(afterNarrow.y + CONTEXT_MENU_HEIGHT <= 560);
  assert.ok(afterNarrow.x >= CONTEXT_MENU_MARGIN);
  assert.ok(afterNarrow.y >= CONTEXT_MENU_MARGIN);
});

test("confirming delete uses the wider box", () => {
  const box = clampContextMenuPosition(900, 400, 680, 560, true);
  assert.equal(box.x, 680 - CONTEXT_MENU_CONFIRM_WIDTH);
  assert.ok(box.x + CONTEXT_MENU_CONFIRM_WIDTH <= 680);
});
