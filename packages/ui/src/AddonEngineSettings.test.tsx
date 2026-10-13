import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_CODEX_MODEL_CATALOG, freezeModelCatalog, type AddonEngineSettingsProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { AddonEngineSettings } from "./AddonEngineSettings.js";
import { messagesFor } from "./locales.js";

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
  // Files others could change: the path and the reason, nothing to run, and the state has its own look.
  const shared = render({ settings: { status: "install_not_private", installPath: "/usr/local/lib/node_modules/@agentclientprotocol/codex-acp" } });
  assert.match(shared, /class="guild-engine-status install_not_private"/u);
  assert.match(shared, /\/usr\/local\/lib\/node_modules\/@agentclientprotocol\/codex-acp/u);
  assert.match(shared, /someone other than you/u);
  assert.doesNotMatch(shared, /guild-engine-command/u);
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
