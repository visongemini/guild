import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_CODEX_MODEL_CATALOG, EMPTY_GEMINI_MODEL_CATALOG, freezeModelCatalog, type AddonEngineSettingsProjection, type EngineApiKeyProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { AddonEngineSettings } from "./AddonEngineSettings.js";
import { messagesFor } from "./locales.js";
import { GEMINI_CATALOG } from "./model-catalog.fixture.js";

/*
 * PC-ENG-003, PC-SET-002: the Codex section of Settings > Engines. It shows the status the engine itself reported,
 * the command that fixes a missing install or login, the defaults a new Codex task starts from, and the four
 * permission modes in the product's own words. It offers no credential field.
 */

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

const CATALOG = freezeModelCatalog("codex", {
  engine: "codex",
  runtimeDefaultModelId: "gpt-6.1-sol",
  models: [
    {
      id: "gpt-6.1-sol", name: "6.1 Sol", description: "Latest workhorse model.", group: "codex", contextWindows: [],
      reasoningEfforts: [
        { id: "low", label: "Low", isDefault: false },
        { id: "high", label: "High", isDefault: true },
        { id: "ultra", label: "Ultra", isDefault: false },
      ],
    },
    { id: "gpt-6-luna", name: "6 Luna", group: "codex", contextWindows: [], reasoningEfforts: [] },
  ],
});

const SETTINGS: AddonEngineSettingsProjection = Object.freeze({
  status: "ready",
  accountLabel: "ChatGPT Plus",
  version: "0.160.1",
  model: "gpt-6.1-sol",
  reasoningEffort: "ultra",
  permissionMode: "workspace-write",
  availablePermissionModes: Object.freeze(["read-only", "workspace-write", "agent", "agent-full-access"]),
});

function render(over: { settings?: Partial<AddonEngineSettingsProjection>; locale?: "en" | "zh"; failed?: boolean; catalog?: typeof CATALOG } = {}): string {
  return renderToStaticMarkup(
    <AddonEngineSettings
      engine="codex"
      messages={over.locale === "zh" ? ZH : EN}
      settings={{ ...SETTINGS, ...over.settings }}
      catalog={over.catalog ?? CATALOG}
      busy={false}
      failed={over.failed ?? false}
      onChange={() => undefined}
    />,
  );
}

test("a ready Codex shows its status line, the model and effort selects and the four permission modes", () => {
  const markup = render();
  assert.match(markup, /<h3 class="guild-engine-heading" id="guild-engine-codex-heading">Codex<\/h3>/u);
  assert.match(markup, /class="guild-engine-status ready" role="status"/u);
  assert.match(markup, /<strong>Ready · ChatGPT Plus<\/strong>/u);
  assert.doesNotMatch(markup, /guild-engine-command/u, "nothing to run when it is ready");
  // Model: Codex's default first, then its own models; the stored one is selected.
  assert.match(markup, /<option value="">Codex default \(recommended\)<\/option>/u);
  assert.match(markup, /<option value="gpt-6\.1-sol" selected="">6\.1 Sol · Latest workhorse model\.<\/option>/u);
  assert.match(markup, /<option value="gpt-6-luna">6 Luna<\/option>/u);
  // Effort: the stored model's efforts, strongest first, the stored one selected.
  const efforts = [...markup.matchAll(/<option value="(low|high|ultra)"( selected="")?>/gu)].map((match) => [match[1], match[2] !== undefined]);
  assert.deepEqual(efforts, [["ultra", true], ["high", false], ["low", false]]);
  // The four modes, the stored one checked, and only the full-access one marked as a warning.
  assert.equal(markup.match(/role="radio"/gu)?.length, 4);
  assert.match(markup, /aria-checked="true" class="guild-claude-mode selected"[^>]*><strong>Workspace access<\/strong>/u);
  assert.match(markup, /class="guild-claude-mode warn"[^>]*><strong>Full access<\/strong>/u);
  assert.equal(markup.match(/guild-claude-mode[^"]* warn/gu)?.length, 1);
  assert.match(markup, /<strong>Read-only, ask first<\/strong>/u);
  assert.match(markup, /<strong>Auto review<\/strong>/u);
});

test("the Chinese section uses the product's own permission words", () => {
  const markup = render({ locale: "zh" });
  for (const name of ["只读，需确认", "工作区访问", "自动审查", "完全访问"]) assert.match(markup, new RegExp(`<strong>${name}</strong>`, "u"));
  assert.match(markup, /Codex 默认（推荐）/u);
  assert.match(markup, /已就绪 · ChatGPT Plus/u);
});

test("a missing adapter or login shows the command to run in Terminal and no credential field", () => {
  const missing = render({ settings: { status: "not_found" } });
  assert.match(missing, /class="guild-engine-status not_found"/u);
  assert.match(missing, /<code class="guild-engine-command">npm install -g @agentclientprotocol\/codex-acp<\/code>/u);
  const loggedOut = render({ settings: { status: "not_logged_in" } });
  assert.match(loggedOut, /<code class="guild-engine-command">codex login<\/code>/u);
  for (const markup of [missing, loggedOut, render()]) {
    assert.doesNotMatch(markup, /<input|<textarea|type="password"/u, "no field takes a key or a password");
  }
  // Integrity: the text only, nothing to run.
  const changed = render({ settings: { status: "integrity_changed" } });
  assert.match(changed, /restart Guild to accept updated engine files/u);
  assert.doesNotMatch(changed, /guild-engine-command/u);
});

test("with no status reported yet the section shows no status line, and with no models only the default option", () => {
  const { status: _status, ...rest } = SETTINGS;
  const markup = renderToStaticMarkup(
    <AddonEngineSettings
      engine="codex" messages={EN} settings={{ ...rest, model: null, reasoningEffort: null }}
      catalog={EMPTY_CODEX_MODEL_CATALOG} busy={false} failed={false} onChange={() => undefined}
    />,
  );
  assert.doesNotMatch(markup, /role="status"/u);
  assert.equal(markup.match(/<option /gu)?.length, 2, "the default model option and the effort follow-the-runtime option");
  assert.match(markup, new RegExp(EN.reasoningFollowsRuntimeDefault, "u"));
});

test("a stored default the engine no longer lists stays visible, and a failed save says so", () => {
  const stale = render({ settings: { model: "gpt-5", reasoningEffort: null } });
  assert.match(stale, /<option value="gpt-5" selected="">gpt-5<\/option>/u);
  assert.doesNotMatch(render(), /role="alert"/u);
  const failed = render({ failed: true });
  assert.match(failed, /role="alert">The Codex settings were not saved\. Try again\./u);
  assert.match(render({ failed: true, locale: "zh" }), /Codex 设置没有保存，请重试。/u);
});

// ---- Gemini (PC-ENG-004, PC-SET-002): the same section with the key binding, no effort and the CLI's four modes

const API_KEY: EngineApiKeyProjection = Object.freeze({
  keyFile: null,
  keyVariable: "GEMINI_API_KEY",
  host: "generativelanguage.googleapis.com",
  confirmed: true,
  defaultKeyFile: "/Users/me/.config/guild/keys.env",
  state: "usable",
});

const GEMINI_SETTINGS: AddonEngineSettingsProjection = Object.freeze({
  status: "ready",
  version: "0.63.0",
  model: "gemini-3.8-flash",
  reasoningEffort: null,
  permissionMode: "default",
  // The CLI's own order; Settings shows them its own way.
  availablePermissionModes: Object.freeze(["default", "autoEdit", "yolo", "plan"]),
  apiKey: API_KEY,
});

function renderGemini(over: {
  settings?: Partial<AddonEngineSettingsProjection>;
  apiKey?: Partial<EngineApiKeyProjection>;
  locale?: "en" | "zh";
  keyBusy?: boolean;
  keyFailed?: boolean;
  busy?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <AddonEngineSettings
      engine="gemini"
      messages={over.locale === "zh" ? ZH : EN}
      settings={{ ...GEMINI_SETTINGS, ...over.settings, apiKey: { ...API_KEY, ...over.apiKey } }}
      catalog={GEMINI_CATALOG}
      busy={over.busy ?? false}
      failed={false}
      keyBusy={over.keyBusy ?? false}
      keyFailed={over.keyFailed ?? false}
      onChange={() => undefined}
      onConfirmKey={() => undefined}
    />,
  );
}

test("a ready Gemini shows its CLI version, the key binding, the model select without any effort select, and the four modes", () => {
  const markup = renderGemini();
  assert.match(markup, /<h3 class="guild-engine-heading" id="guild-engine-gemini-heading">Gemini<\/h3>/u);
  assert.match(markup, /class="guild-settings-section guild-engine-gemini"/u);
  assert.match(markup, /paid per use on your Google AI Studio account and never through a subscription/u);
  assert.match(markup, /class="guild-engine-status ready" role="status"><span>Status<\/span><strong>Ready \u00b7 Gemini CLI 0\.63\.0<\/strong><\/p>/u);
  // Model: Gemini's default (the cheapest Flash) first, then the session's models; no effort select at all.
  assert.match(markup, /<option value="">Gemini default: cheapest Flash \(recommended\)<\/option>/u);
  assert.match(markup, /<option value="gemini-3\.8-flash" selected="">Gemini 3\.8 Flash<\/option>/u);
  assert.equal(markup.match(/<select/gu)?.length, 1, "the model select only");
  assert.doesNotMatch(markup, new RegExp(`>${EN.reasoningEffort}<|${EN.reasoningFollowsRuntimeDefault}`, "u"));
  // The four modes in the order Default, Auto-edit, Plan, Full access (YOLO); only YOLO is the warning one.
  const modes = [...markup.matchAll(/role="radio" aria-checked="(true|false)" class="(guild-claude-mode[^"]*)"[^>]*><strong>([^<]+)<\/strong>/gu)]
    .map((match) => [match[3], match[1], match[2]]);
  assert.deepEqual(modes, [
    ["Default", "true", "guild-claude-mode selected"],
    ["Auto-edit", "false", "guild-claude-mode"],
    ["Plan", "false", "guild-claude-mode"],
    ["Full access (YOLO)", "false", "guild-claude-mode warn"],
  ]);
  assert.match(markup, /<strong>Default<\/strong><small>Asks you before each file edit and each command\.<\/small>/u);
  assert.match(markup, /<strong>Auto-edit<\/strong><small>Edits files without asking; asks you before each command\.<\/small>/u);
  assert.match(markup, /<strong>Plan<\/strong><small>Read-only/u);
  assert.match(markup, /cheapest Flash model the session offers/u);
});

test("the key binding: two name fields (the default file as placeholder), the host read-only, the confirmation, the key state, Confirm", () => {
  const markup = renderGemini();
  const block = markup.match(/<div class="guild-settings-section guild-engine-key" role="group" aria-labelledby="guild-engine-gemini-key-heading">(.*?)<label class="guild-setting-field"><span class="guild-setting-label">Model/su)?.[1] ?? "";
  assert.ok(block.length > 0, "the key block sits between the status and the model select");
  assert.match(block, /<div class="guild-setting-label" id="guild-engine-gemini-key-heading">API key<\/div>/u);
  // Exactly two text fields, and they take names: the file (empty means the default, shown as the placeholder) and the variable.
  const inputs = block.match(/<input[^>]*>/gu) ?? [];
  assert.equal(inputs.length, 2);
  assert.equal(inputs.every((tag) => /type="text"/u.test(tag) && /autoComplete="off"|autocomplete="off"/iu.test(tag)), true);
  assert.match(inputs[0]!, /placeholder="\/Users\/me\/\.config\/guild\/keys\.env"/u);
  assert.match(inputs[0]!, /value=""/u);
  assert.match(inputs[1]!, /value="GEMINI_API_KEY"/u);
  assert.match(block, /<span class="guild-setting-label">Key file<\/span>/u);
  assert.match(block, /<span class="guild-setting-label">Key variable<\/span>/u);
  assert.match(block, /for example GEMINI_API_KEY\. Guild reads its value from the key file and neither shows nor saves it; never paste the key itself here\./u);
  // The host is shown, not editable.
  assert.match(block, /<dt>Sent only to<\/dt><dd><code>generativelanguage\.googleapis\.com<\/code><\/dd>/u);
  assert.match(block, /<dt>Confirmation<\/dt><dd class="confirmed">Confirmed for generativelanguage\.googleapis\.com<\/dd>/u);
  assert.match(block, /<dt>Key<\/dt><dd class="usable">Found in that file<\/dd>/u);
  assert.match(block, /<button type="button" class="guild-soft-button primary">Confirm\u2026<\/button>/u);
  assert.doesNotMatch(block, /role="alert"/u);
});

test("no field of the Gemini section takes a key value: no password, no textarea, nothing named or labelled as the key itself", () => {
  for (const markup of [renderGemini(), renderGemini({ apiKey: { confirmed: false, state: "unconfirmed" } }), renderGemini({ locale: "zh" })]) {
    assert.doesNotMatch(markup, /type="password"|<textarea/u);
    const inputs = markup.match(/<input[^>]*>/gu) ?? [];
    assert.equal(inputs.length, 2);
    // The two values are the stored names, never anything that came from the key file.
    assert.deepEqual(inputs.map((tag) => /value="([^"]*)"/u.exec(tag)?.[1]), ["", "GEMINI_API_KEY"]);
  }
});

test("each confirmation and key state has its own words, in both languages", () => {
  const states = (over: Partial<EngineApiKeyProjection>, locale: "en" | "zh" = "en") => {
    const markup = renderGemini({ apiKey: over, locale });
    return [...markup.matchAll(/<dd class="([a-z]+)">([^<]+)<\/dd>/gu)].map((match) => `${match[1]}:${match[2]}`);
  };
  assert.deepEqual(states({ confirmed: false, state: "unconfirmed" }), ["unconfirmed:Not confirmed", "unconfirmed:Not read until you confirm"]);
  assert.deepEqual(states({ confirmed: true, state: "unchecked" }), ["confirmed:Confirmed for generativelanguage.googleapis.com", "unchecked:Not looked at yet"]);
  assert.deepEqual(states({ confirmed: true, state: "unusable" }), ["confirmed:Confirmed for generativelanguage.googleapis.com", "unusable:Not found in that file"]);
  assert.deepEqual(states({ confirmed: true, state: "usable" }, "zh"), ["confirmed:已确认可以发送到 generativelanguage.googleapis.com", "usable:已在这个文件里找到"]);
  assert.deepEqual(states({ confirmed: false, state: "unconfirmed" }, "zh"), ["unconfirmed:尚未确认", "unconfirmed:确认之后才会读取"]);
  // A file of the user's own shows in the field.
  assert.match(renderGemini({ apiKey: { keyFile: "/Users/me/gemini.env" } }), /value="\/Users\/me\/gemini\.env"/u);
});

test("while a key call runs the fields and Confirm are disabled and say the system window is waiting; a failure says so", () => {
  const busy = renderGemini({ keyBusy: true });
  const block = busy.match(/guild-engine-key"(.*?)guild-engine-key-actions(.*?)<\/div>/su) ?? [];
  assert.equal((busy.match(/<input[^>]*disabled=""[^>]*>/gu) ?? []).length, 2);
  assert.match(block[2] ?? "", /<button type="button" class="guild-soft-button primary" disabled="" aria-busy="true"><svg[^>]*class="guild-spin"[^>]*>.*?<\/svg>Waiting for your confirmation in the system window…<\/button>/su);
  // The whole Settings being busy disables Confirm too, without saying it is waiting for the dialog.
  assert.match(renderGemini({ busy: true }), /<button type="button" class="guild-soft-button primary" disabled="">Confirm…<\/button>/u);
  assert.match(renderGemini({ keyFailed: true }), /role="alert">The key file and variable were not saved or confirmed\. Try again\.<\/p>/u);
  assert.match(renderGemini({ keyFailed: true, locale: "zh" }), /role="alert">密钥文件和变量名没有保存或确认，请重试。<\/p>/u);
});

test("a key typed into the variable field is refused with the hint that it takes a name, and Confirm stays disabled", () => {
  // The renderer can only start from what is stored; an odd stored value shows the same refusal a typed one does.
  const markup = renderGemini({ apiKey: { keyVariable: "AIzaSyD-1234567890abcdefghijklmnop" } });
  assert.match(markup, /aria-invalid="true" aria-describedby="guild-engine-gemini-key-variable-hint guild-engine-gemini-key-variable-error"/u);
  assert.match(markup, /<p class="guild-source-error" id="guild-engine-gemini-key-variable-error" role="alert">Enter the name of the variable, not the key itself\.<\/p>/u);
  assert.match(markup, /<button type="button" class="guild-soft-button primary" disabled="">Confirm…<\/button>/u);
  const relative = renderGemini({ apiKey: { keyFile: "keys.env" } });
  assert.match(relative, /id="guild-engine-gemini-key-file-error" role="alert">The key file needs an absolute path \(starting with \/\), or leave it empty\.<\/p>/u);
});

test("Gemini's status variants: not installed with the install command, no usable key without a command, integrity, unavailable", () => {
  const missing = renderGemini({ settings: { status: "not_found" } });
  assert.match(missing, /class="guild-engine-status not_found"/u);
  assert.match(missing, /<code class="guild-engine-command">npm install -g @google\/gemini-cli<\/code>/u);
  const noKey = renderGemini({ settings: { status: "not_logged_in" }, apiKey: { confirmed: false, state: "unconfirmed" } });
  assert.match(noKey, /class="guild-engine-status not_logged_in" role="status"><span>Status<\/span><strong>No usable API key\. Choose and confirm the key file below\.<\/strong><\/p>/u);
  assert.doesNotMatch(noKey, /guild-engine-command/u, "no login command for an API key");
  assert.match(renderGemini({ settings: { status: "integrity_changed" } }), /Gemini CLI files changed unexpectedly/u);
  assert.match(renderGemini({ settings: { status: "unavailable" } }), /Not available right now/u);
  // Chinese.
  const zh = renderGemini({ locale: "zh" });
  for (const name of ["默认", "自动编辑", "规划", "完全访问 \\(YOLO\\)"]) assert.match(zh, new RegExp(`<strong>${name}</strong>`, "u"));
  assert.match(zh, /Gemini 默认：最便宜的 Flash（推荐）/u);
  assert.match(zh, /<div class="guild-setting-label" id="guild-engine-gemini-key-heading">API 密钥<\/div>/u);
  assert.match(zh, />确认…<\/button>/u);
});

test("with no models listed yet and no key binding reported, the Gemini section still renders without an effort control", () => {
  const { apiKey: _apiKey, ...rest } = GEMINI_SETTINGS;
  const markup = renderToStaticMarkup(
    <AddonEngineSettings
      engine="gemini" messages={EN} settings={{ ...rest, model: null }}
      catalog={EMPTY_GEMINI_MODEL_CATALOG} busy={false} failed={false} onChange={() => undefined}
    />,
  );
  assert.equal(markup.match(/<option /gu)?.length, 1, "only the default model option");
  assert.doesNotMatch(markup, /guild-engine-key|<input/u);
});
