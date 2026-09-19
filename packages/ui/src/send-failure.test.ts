import assert from "node:assert/strict";
import test from "node:test";
import { GUILD_MAX_MESSAGE_LENGTH } from "@guild/contracts/desktop-ipc";
import { classifyComposerSendFailure, isComposerTextTooLong } from "./send-failure.js";

test("maps a vanished workspace folder through Electron invoke wrapping", () => {
  const wrapped = new Error("Error invoking remote method 'guild:v1:run:send': Error: workspace_folder_missing");
  assert.equal(classifyComposerSendFailure(wrapped), "workspace");
  assert.equal(classifyComposerSendFailure(new Error("guild_operation_failed")), "runtime");
  assert.equal(classifyComposerSendFailure("guild_operation_failed"), "runtime");
  assert.equal(
    classifyComposerSendFailure(new Error(
      "Error invoking remote method 'guild:v1:run:send': Error: session_recovery_context_required",
    )),
    "recovery",
  );
});

test("names an overlong composer payload instead of collapsing it to runtime", () => {
  assert.equal(isComposerTextTooLong("x".repeat(GUILD_MAX_MESSAGE_LENGTH)), false);
  assert.equal(isComposerTextTooLong("x".repeat(GUILD_MAX_MESSAGE_LENGTH + 1)), true);
  assert.equal(classifyComposerSendFailure(new Error("invalid_draft")), "message");
  assert.equal(classifyComposerSendFailure(new Error("invalid_message")), "message");
  assert.equal(
    classifyComposerSendFailure(new Error(
      "Error invoking remote method 'guild:v1:run:send': Error: message_too_long",
    )),
    "message",
  );
});
