import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACP_V1_METHODS } from "./acp-v1-methods.js";

describe("ACP v1 production method surface", () => {
  it("exports only the exact frozen first-adapter methods", () => {
    assert.deepEqual(ACP_V1_METHODS, {
      initialize: "initialize",
      authenticate: "authenticate",
      officialBilling: "_x.ai/billing",
      sessionNew: "session/new",
      sessionResume: "session/resume",
      sessionLoad: "session/load",
      sessionPrompt: "session/prompt",
      sessionCancel: "session/cancel",
      sessionSetModel: "session/set_model",
      sessionSetMode: "session/set_mode",
      sessionSetConfigOption: "session/set_config_option",
      sessionUpdate: "session/update",
      sessionRequestPermission: "session/request_permission",
    });
    assert.equal(Object.isFrozen(ACP_V1_METHODS), true);
    assert.throws(() => {
      (ACP_V1_METHODS as unknown as Record<string, string>).server =
        "server/start";
    }, TypeError);
  });
});
