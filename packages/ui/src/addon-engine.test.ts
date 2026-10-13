import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CODEX_MODEL_CATALOG,
  GUILD_ADDON_PERMISSION_MODES,
  freezeModelCatalog,
  type ConfirmEngineApiKeyRequest,
  type DesktopBootstrapProjection,
  type SetEngineApiKeyRequest,
} from "@guild/contracts";
import {
  addonDefaultsView,
  addonModeIsFullAccess,
  addonPermissionModeOf,
  addonPermissionModesInOrder,
  addonStatusOf,
  addonStatusText,
  engineKeyIssues,
  engineKeyRequest,
  saveAndConfirmEngineApiKey,
} from "./addon-engine.js";
import { messagesFor } from "./locales.js";
import { GEMINI_CATALOG } from "./model-catalog.fixture.js";

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

// ---- Gemini (PC-ENG-004): an engine paid for per use with an API key the user binds by name

test("Gemini's status lines: the CLI version when ready, the install command, no usable key without any command", () => {
  assert.deepEqual(addonStatusText(EN, "gemini", { state: "ready", version: "0.63.0" }), { text: "Ready \u00b7 Gemini CLI 0.63.0" });
  assert.deepEqual(addonStatusText(ZH, "gemini", { state: "ready", version: "0.63.0" }), { text: "\u5df2\u5c31\u7eea \u00b7 Gemini CLI 0.63.0" });
  assert.deepEqual(addonStatusText(EN, "gemini", { state: "ready" }), { text: "Ready \u00b7 pay-as-you-go API key" });
  // Codex keeps its account wording, version or not.
  assert.deepEqual(addonStatusText(EN, "codex", { state: "ready", version: "0.160.1" }), { text: "Ready \u00b7 managed by Codex" });
  const missing = addonStatusText(EN, "gemini", { state: "not_found" });
  assert.match(missing.text, /Gemini CLI was not found/u);
  assert.equal(missing.command, "npm install -g @google/gemini-cli");
  assert.equal(addonStatusText(ZH, "gemini", { state: "not_found" }).command, "npm install -g @google/gemini-cli");
  // not_logged_in is "no usable API key" for Gemini: what is missing, and no login command to run.
  const noKey = addonStatusText(EN, "gemini", { state: "not_logged_in" });
  assert.equal(noKey.text, "No usable API key. Choose and confirm the key file below.");
  assert.equal("command" in noKey, false);
  assert.equal(addonStatusText(ZH, "gemini", { state: "not_logged_in" }).text, "\u6ca1\u6709\u53ef\u7528\u7684 API \u5bc6\u94a5\u3002\u8bf7\u5728\u4e0b\u9762\u9009\u62e9\u5e76\u786e\u8ba4\u5bc6\u94a5\u6587\u4ef6\u3002");
  const changed = addonStatusText(EN, "gemini", { state: "integrity_changed" });
  assert.match(changed.text, /Gemini CLI files changed unexpectedly/u);
  assert.equal(changed.command, undefined);
  assert.equal(addonStatusText(EN, "gemini", { state: "unavailable" }).command, undefined);
  // Every line and the intro speak of a key by its file and name only; nothing invites typing a key.
  for (const text of [missing.text, noKey.text, changed.text, EN.addonSettingsHelp("gemini")]) {
    assert.doesNotMatch(text, /(enter|paste|type) (your|the) (api )?key/iu);
  }
  assert.match(EN.enginesAddonIntro("gemini"), /never shows or stores the key/u);
  assert.match(EN.enginesAddonIntro("gemini"), /sends it only to generativelanguage\.googleapis\.com/u);
  assert.match(EN.enginesAddonIntro("gemini"), /never through a subscription/u);
});

test("Gemini's default-model control has its models and never an effort", () => {
  const view = addonDefaultsView({ catalog: GEMINI_CATALOG, model: "gemini-3.8-flash", reasoningEffort: "high", engine: "gemini" });
  assert.deepEqual(view.models.map((model) => model.id), GEMINI_CATALOG.models.map((model) => model.id));
  assert.equal(view.showEfforts, false);
  assert.equal(view.effortId, null, "a stored effort is ignored");
  assert.deepEqual(view.efforts, []);
  // Codex, named or not, keeps its efforts.
  assert.equal(addonDefaultsView({ catalog: CODEX, model: "gpt-6.1-sol", reasoningEffort: null, engine: "codex" }).showEfforts, true);
  assert.equal(addonDefaultsView({ catalog: CODEX, model: "gpt-6.1-sol", reasoningEffort: null }).efforts.length, 4);
});

test("Gemini's four modes show from the most careful to asking nothing, and only YOLO is the warning one", () => {
  const offered = GUILD_ADDON_PERMISSION_MODES.gemini;
  assert.deepEqual(offered, ["default", "autoEdit", "yolo", "plan"], "the CLI's own order");
  assert.deepEqual(addonPermissionModesInOrder("gemini", offered), ["default", "autoEdit", "plan", "yolo"]);
  // A mode the table does not know stays visible, after the known ones.
  assert.deepEqual(addonPermissionModesInOrder("gemini", ["yolo", "future", "default"]), ["default", "yolo", "future"]);
  // Codex keeps its adapter's order.
  assert.deepEqual(addonPermissionModesInOrder("codex", GUILD_ADDON_PERMISSION_MODES.codex), GUILD_ADDON_PERMISSION_MODES.codex);
  assert.deepEqual(offered.filter((mode) => addonModeIsFullAccess("gemini", mode)), ["yolo"]);
  assert.deepEqual(GUILD_ADDON_PERMISSION_MODES.codex.filter((mode) => addonModeIsFullAccess("codex", mode)), ["agent-full-access"]);
  assert.equal(addonModeIsFullAccess("codex", "yolo"), false);
  // The live session mode of a Gemini task is shown when Gemini offers it.
  assert.equal(addonPermissionModeOf({ currentModeId: "autoEdit" }, offered, "default"), "autoEdit");
});

test("the key binding takes names only: an absolute file or none, and a variable name; a key typed as the name is called out", () => {
  assert.deepEqual(engineKeyIssues({ keyFile: "", keyVariable: "GEMINI_API_KEY" }), {});
  assert.deepEqual(engineKeyIssues({ keyFile: " /Users/me/.config/keys.env ", keyVariable: " MY_GEMINI_KEY " }), {});
  assert.deepEqual(engineKeyIssues({ keyFile: "keys.env", keyVariable: "GEMINI_API_KEY" }), { keyFile: "key_file" });
  assert.deepEqual(engineKeyIssues({ keyFile: "/Users/me/../keys.env", keyVariable: "GEMINI_API_KEY" }), { keyFile: "key_file" });
  // The contract's grammar: capital letters, digits and underscores, not starting with a digit, at most 64.
  assert.deepEqual(engineKeyIssues({ keyFile: "", keyVariable: "" }), { keyVariable: "key_variable" });
  assert.deepEqual(engineKeyIssues({ keyFile: "", keyVariable: "gemini_api_key" }), { keyVariable: "key_variable" });
  assert.deepEqual(engineKeyIssues({ keyFile: "", keyVariable: "1KEY" }), { keyVariable: "key_variable" });
  assert.deepEqual(engineKeyIssues({ keyFile: "", keyVariable: `K${"A".repeat(64)}` }), { keyVariable: "key_variable_secret" });
  // Something that looks like a key is never a name.
  for (const key of ["AIzaSyD-1234567890abcdefghijklmnopqrstu", "sk-abcdef1234567890", "Bearer abcdefghijkl"]) {
    assert.deepEqual(engineKeyIssues({ keyFile: "", keyVariable: key }), { keyVariable: "key_variable_secret" }, key);
  }
  assert.deepEqual(engineKeyRequest({ keyFile: "  ", keyVariable: " GEMINI_API_KEY " }), { keyFile: null, keyVariable: "GEMINI_API_KEY" });
  assert.deepEqual(engineKeyRequest({ keyFile: " /k.env ", keyVariable: "K" }), { keyFile: "/k.env", keyVariable: "K" });
});

function keyApi(options: { failSet?: boolean; failConfirm?: boolean } = {}) {
  const calls: (readonly ["setEngineApiKey", SetEngineApiKeyRequest] | readonly ["confirmEngineApiKey", ConfirmEngineApiKeyRequest])[] = [];
  const projection = (name: string) => ({ name }) as unknown as DesktopBootstrapProjection;
  return {
    calls,
    api: {
      setEngineApiKey: async (request: SetEngineApiKeyRequest) => {
        calls.push(["setEngineApiKey", request]);
        if (options.failSet === true) throw new Error("invalid_model_source_key_variable");
        return projection("saved");
      },
      confirmEngineApiKey: async (request: ConfirmEngineApiKeyRequest) => {
        calls.push(["confirmEngineApiKey", request]);
        if (options.failConfirm === true) throw new Error("guild_operation_failed");
        return projection("confirmed");
      },
    },
  };
}

test("Confirm saves changed names first, then asks for the native confirmation, and applies each projection as it arrives", async () => {
  const { api, calls } = keyApi();
  const applied: unknown[] = [];
  await saveAndConfirmEngineApiKey(api, {
    engine: "gemini",
    current: { keyFile: null, keyVariable: "GEMINI_API_KEY" },
    keyFile: "/Users/me/keys.env",
    keyVariable: "MY_GEMINI_KEY",
  }, (projection) => applied.push(projection));
  assert.deepEqual(calls, [
    ["setEngineApiKey", { engine: "gemini", keyFile: "/Users/me/keys.env", keyVariable: "MY_GEMINI_KEY" }],
    ["confirmEngineApiKey", { engine: "gemini" }],
  ]);
  assert.deepEqual(applied, [{ name: "saved" }, { name: "confirmed" }]);
  // Unchanged names are not saved again (a save would void the confirmation): only the dialog is asked for.
  const unchanged = keyApi();
  await saveAndConfirmEngineApiKey(unchanged.api, {
    engine: "gemini", current: { keyFile: null, keyVariable: "GEMINI_API_KEY" }, keyFile: null, keyVariable: "GEMINI_API_KEY",
  }, () => undefined);
  assert.deepEqual(unchanged.calls, [["confirmEngineApiKey", { engine: "gemini" }]]);
  // Going back to the default file is a change too.
  const toDefault = keyApi();
  await saveAndConfirmEngineApiKey(toDefault.api, {
    engine: "gemini", current: { keyFile: "/Users/me/keys.env", keyVariable: "GEMINI_API_KEY" }, keyFile: null, keyVariable: "GEMINI_API_KEY",
  }, () => undefined);
  assert.deepEqual(toDefault.calls[0], ["setEngineApiKey", { engine: "gemini", keyFile: null, keyVariable: "GEMINI_API_KEY" }]);
});

test("a refused save stops before the dialog, and a failed confirmation still applies the saved names; both reject", async () => {
  const refused = keyApi({ failSet: true });
  const appliedRefused: unknown[] = [];
  await assert.rejects(saveAndConfirmEngineApiKey(refused.api, {
    engine: "gemini", current: { keyFile: null, keyVariable: "GEMINI_API_KEY" }, keyFile: null, keyVariable: "OTHER_KEY",
  }, (projection) => appliedRefused.push(projection)));
  assert.deepEqual(refused.calls.map(([name]) => name), ["setEngineApiKey"]);
  assert.deepEqual(appliedRefused, []);
  const failed = keyApi({ failConfirm: true });
  const appliedFailed: unknown[] = [];
  await assert.rejects(saveAndConfirmEngineApiKey(failed.api, {
    engine: "gemini", current: { keyFile: null, keyVariable: "GEMINI_API_KEY" }, keyFile: null, keyVariable: "OTHER_KEY",
  }, (projection) => appliedFailed.push(projection)));
  assert.deepEqual(failed.calls.map(([name]) => name), ["setEngineApiKey", "confirmEngineApiKey"]);
  assert.deepEqual(appliedFailed, [{ name: "saved" }]);
});
