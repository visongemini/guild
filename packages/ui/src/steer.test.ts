import assert from "node:assert/strict";
import test from "node:test";
import { composerEnterAction, steerButtonState, type ComposerEnterKey } from "./steer.js";

const key = (patch: Partial<ComposerEnterKey> = {}): ComposerEnterKey => ({
  key: "Enter", shiftKey: false, altKey: false, isComposing: false, keyCode: 13, ...patch,
});

test("Enter keeps sending or queueing whether or not Steer is available", () => {
  assert.equal(composerEnterAction(key(), { steerAvailable: true }), "send");
  assert.equal(composerEnterAction(key(), { steerAvailable: false }), "send");
});

test("Option+Enter steers when the runtime can take it, and behaves like Enter when it cannot", () => {
  assert.equal(composerEnterAction(key({ altKey: true }), { steerAvailable: true }), "steer");
  assert.equal(composerEnterAction(key({ altKey: true }), { steerAvailable: false }), "send");
});

test("Shift+Enter, IME composition and other keys never send", () => {
  assert.equal(composerEnterAction(key({ shiftKey: true }), { steerAvailable: true }), "none");
  assert.equal(composerEnterAction(key({ shiftKey: true, altKey: true }), { steerAvailable: true }), "none");
  assert.equal(composerEnterAction(key({ isComposing: true }), { steerAvailable: true }), "none");
  assert.equal(composerEnterAction(key({ keyCode: 229, altKey: true }), { steerAvailable: true }), "none");
  assert.equal(composerEnterAction(key({ key: "a", altKey: true }), { steerAvailable: true }), "none");
  assert.equal(composerEnterAction(key({ key: "Tab" }), { steerAvailable: true }), "none");
});

test("the Steer button exists only while a turn runs and the runtime can take a message, and needs text", () => {
  const base = { running: true, steerAvailable: true, draft: "look at the runway lights", busy: false, sendPending: false, hasAttachments: false };
  assert.deepEqual(steerButtonState(base), { visible: true, disabled: false, needsText: false });
  assert.deepEqual(steerButtonState({ ...base, draft: "  \n " }), { visible: true, disabled: true, needsText: true });
  assert.equal(steerButtonState({ ...base, running: false }).visible, false);
  assert.equal(steerButtonState({ ...base, steerAvailable: false }).visible, false);
  assert.equal(steerButtonState({ ...base, busy: true }).disabled, true);
  assert.equal(steerButtonState({ ...base, sendPending: true }).disabled, true);
  assert.equal(steerButtonState({ ...base, hasAttachments: true }).disabled, true, "attachments cannot ride along");
});
