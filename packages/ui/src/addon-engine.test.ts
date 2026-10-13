import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_CODEX_MODEL_CATALOG, freezeModelCatalog } from "@guild/contracts";
import { addonDefaultsView, addonPermissionModeOf, addonStatusOf, addonStatusText } from "./addon-engine.js";
import { messagesFor } from "./locales.js";

/*
 * PC-ENG-003, PC-SET-002: what the renderer reads about an add-on engine (Codex first). The states and the plan label
 * rules are the Claude engine's, because the main process reports them the same way; the commands are Codex's own.
 */

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

const CODEX = freezeModelCatalog("codex", {
  engine: "codex",
  runtimeDefaultModelId: "gpt-6.1-sol",
  models: [
    {
      id: "gpt-6.1-sol", name: "6.1 Sol", group: "codex", contextWindows: [],
      reasoningEfforts: [
        { id: "low", label: "Low", isDefault: false },
        { id: "medium", label: "Medium", isDefault: false },
        { id: "high", label: "High", isDefault: true },
        { id: "ultra", label: "Ultra", isDefault: false },
      ],
    },
    { id: "gpt-6-luna", name: "6 Luna", group: "codex", contextWindows: [], reasoningEfforts: [{ id: "low", label: "Low", isDefault: true }] },
  ],
});

test("the status is read defensively from the engine settings the main process supplies", () => {
  assert.equal(addonStatusOf(undefined), undefined);
  assert.equal(addonStatusOf(null), undefined);
  assert.equal(addonStatusOf({ model: null, permissionMode: "workspace-write" }), undefined, "no status reported yet");
  assert.equal(addonStatusOf({ status: "online" }), undefined);
  assert.deepEqual(addonStatusOf({ status: "ready", accountLabel: "ChatGPT Plus", version: "0.160.1" }), {
    state: "ready", accountLabel: "ChatGPT Plus", version: "0.160.1",
  });
  // An account label that could be an address is never shown.
  assert.equal(addonStatusOf({ status: "ready", accountLabel: "me@example.com" })?.accountLabel, undefined);
});

test("each status has its own line, with the command Terminal needs for a missing install or login, and Guild runs none", () => {
  assert.deepEqual(addonStatusText(EN, "codex", { state: "ready", accountLabel: "ChatGPT Plus" }), { text: "Ready · ChatGPT Plus" });
  assert.deepEqual(addonStatusText(EN, "codex", { state: "ready" }), { text: "Ready · managed by Codex" });
  assert.deepEqual(addonStatusText(ZH, "codex", { state: "ready" }), { text: "已就绪 · 由 Codex 管理" });
  const missing = addonStatusText(EN, "codex", { state: "not_found" });
  assert.match(missing.text, /Codex adapter was not found/u);
  assert.equal(missing.command, "npm install -g @agentclientprotocol/codex-acp");
  const loggedOut = addonStatusText(EN, "codex", { state: "not_logged_in" });
  assert.match(loggedOut.text, /Not logged in/u);
  assert.equal(loggedOut.command, "codex login");
  assert.equal(addonStatusText(ZH, "codex", { state: "not_logged_in" }).command, "codex login");
  assert.equal(addonStatusText(EN, "codex", { state: "unavailable" }).command, undefined);
  const changed = addonStatusText(EN, "codex", { state: "integrity_changed" });
  assert.match(changed.text, /restart Guild to accept updated engine files/u);
  assert.equal(changed.command, undefined);
  // No API key is ever offered for Codex.
  for (const text of [missing.text, loggedOut.text, changed.text, EN.enginesAddonIntro("codex"), EN.addonSettingsHelp("codex")]) {
    assert.doesNotMatch(text, /api key.*(enter|paste|type)/iu);
  }
  assert.match(EN.enginesAddonIntro("codex"), /no API key field/u);
});

test("the default-model control lists Codex's own models and the efforts of the stored one, strongest first", () => {
  const none = addonDefaultsView({ catalog: CODEX, model: null, reasoningEffort: null });
  assert.deepEqual(none.models.map((model) => model.id), ["gpt-6.1-sol", "gpt-6-luna"]);
  assert.equal(none.efforts.length, 0, "no model stored: no effort control");
  assert.equal(none.unlistedModelId, undefined);

  const sol = addonDefaultsView({ catalog: CODEX, model: "gpt-6.1-sol", reasoningEffort: "medium" });
  assert.deepEqual(sol.efforts.map((effort) => effort.id), ["ultra", "high", "medium", "low"]);
  assert.equal(sol.effortId, "medium");
  // Without a stored effort the control shows the model's own default.
  assert.equal(addonDefaultsView({ catalog: CODEX, model: "gpt-6.1-sol", reasoningEffort: null }).effortId, "high");

  // A stored default the engine no longer lists stays visible instead of lying.
  const gone = addonDefaultsView({ catalog: CODEX, model: "gpt-5", reasoningEffort: null });
  assert.equal(gone.unlistedModelId, "gpt-5");
  assert.equal(addonDefaultsView({ catalog: EMPTY_CODEX_MODEL_CATALOG, model: null, reasoningEffort: null }).models.length, 0);
});

test("the permission mode of an add-on task is the live session mode when the engine offers it, else the Settings default, else nothing", () => {
  const modes = ["read-only", "workspace-write", "agent", "agent-full-access"];
  assert.equal(addonPermissionModeOf({ currentModeId: "agent" }, modes, "workspace-write"), "agent");
  assert.equal(addonPermissionModeOf({ currentModeId: "plan" }, modes, "workspace-write"), "workspace-write", "a mode the engine does not offer is not shown");
  assert.equal(addonPermissionModeOf(null, modes, "read-only"), "read-only");
  assert.equal(addonPermissionModeOf(undefined, undefined, undefined), undefined);
  assert.equal(addonPermissionModeOf({ currentModeId: "agent" }, undefined, undefined), undefined);
});
