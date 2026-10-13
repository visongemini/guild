import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { GuildLocale } from "@guild/contracts";
import { LOCALES, addonOverrideKeys, messagesFor } from "./locales.js";

/*
 * A Gemini task speaks of Gemini (PC-ENG-004), as a Codex task speaks of Codex (codex-wording.test.ts). The add-on
 * wording replaces the strings that name the runtime; what still names Grok or Claude belongs to a surface of that
 * engine only. Gemini is paid for per use with an API key, so its wording never offers a login and never a key field.
 */

const GROK_ONLY_SURFACES: ReadonlySet<string> = new Set([
  "settingsGrok", "runtimeSettingsHelp", "webSearchHelp", "planModeHelp", "subagentsHelp", "permissionFullAccessHelp",
  "grokToolsGrokOnly", "usageLoading", "usageUnavailable", "viewOfficialUsage", "modelPickerEmpty", "modelPickerEngineNote",
  "aboutRole", "privacyBrowserSyncHelp", "officialSettingScope", "commandsAppearAfterConnect",
]);

/** Strings that name Claude because the surface they belong to is Claude's, or is global and lists the engines. */
const CLAUDE_SURFACES: ReadonlySet<string> = new Set([
  "aboutRole", "modelPickerEngineNote", "modelPickerRestartHint", "onlineReminderItemClaudeMd", "privacyOnlineReminderHelp",
  "sourcesIntro", "sourcesSaveError",
]);

async function probeArguments(): Promise<readonly string[]> {
  const names = ["locales.ts", "change-messages.ts", "workshop-messages.ts"];
  const source = (await Promise.all(names.map((name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")))).join("\n");
  const words = [...source.matchAll(/(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)(?=\s*:)/gu)].map((match) => match[1]!);
  // A word that already says an engine's name would only be echoed back, not asked about.
  return [...new Set(words)].filter((word) => !/grok|claude/iu.test(word));
}

function named(locale: GuildLocale, pattern: RegExp, probes: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>();
  const note = (key: string, text: unknown) => { if (typeof text === "string" && pattern.test(text)) found.add(key); };
  const pairs = ["queued", "steered", "unsupported", "runtime_unavailable", "running", "pending", "x"];
  for (const [key, value] of Object.entries(messagesFor(locale, "gemini"))) {
    if (typeof value === "string") note(key, value);
    if (typeof value !== "function") continue;
    const ask = value as (...args: unknown[]) => unknown;
    for (const probe of probes) { try { note(key, ask(probe)); } catch { /* not a string-keyed function */ } }
    for (const count of [0, 1, 2, 3]) { try { note(key, ask(count)); } catch { /* not a count-keyed function */ } }
    for (const first of pairs) for (const second of pairs) { try { note(key, ask(first, second)); } catch { /* not a two-argument function */ } }
    try { note(key, ask()); } catch { /* needs arguments */ }
  }
  return found;
}

test("no string a Gemini task resolves names Grok or Claude, except the strings of those engines' own surfaces", async () => {
  const probes = await probeArguments();
  assert.ok(probes.length > 300, "the probe words come from the catalog sources");
  assert.ok(probes.includes("gemini"), "the Gemini tables are probed too");
  for (const locale of ["zh-CN", "en-US"] as const) {
    const grok = [...named(locale, /grok/iu, probes)].filter((key) => !GROK_ONLY_SURFACES.has(key) && !key.startsWith("grokManagement"));
    assert.deepEqual(grok, [], `${locale}: these strings name Grok in a Gemini task; give them a Gemini wording (ADDON_ZH / ADDON_EN)`);
    const claude = [...named(locale, /claude/iu, probes)].filter((key) =>
      !CLAUDE_SURFACES.has(key) && !/^(claude|usageClaude|settingsClaude|enginesClaude|modelPickerClaude)/u.test(key));
    assert.deepEqual(claude, [], `${locale}: these strings name Claude in a Gemini task; give them a Gemini wording`);
  }
});

test("a Gemini task words the runtime strings for Gemini, leaves the other catalogs untouched and never reuses Codex's", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const grok = messagesFor(locale);
    const gemini = messagesFor(locale, "gemini");
    assert.equal(grok, LOCALES[locale]);
    assert.notEqual(gemini, grok);
    assert.notEqual(gemini, messagesFor(locale, "codex"));
    assert.notEqual(gemini, messagesFor(locale, "claude"));
    assert.equal(messagesFor(locale, "gemini"), gemini, "one catalog per locale, not a new one per call");
    assert.deepEqual(Object.keys(gemini).sort(), Object.keys(grok).sort());
    const overridden = addonOverrideKeys(locale);
    for (const key of Object.keys(grok)) {
      const changed = (gemini as Record<string, unknown>)[key] !== (grok as Record<string, unknown>)[key];
      assert.equal(changed, overridden.includes(key), `${locale}: ${key}`);
    }
    for (const key of overridden) {
      const value = (gemini as Record<string, unknown>)[key];
      if (typeof value === "string") {
        assert.equal(/Grok|Claude|Codex|ChatGPT/u.test(value), false, `${locale}: ${key} names another engine`);
        if (key !== "terminalOutputUnavailable") assert.equal(/Gemini/u.test(value), true, `${locale}: ${key} does not name Gemini`);
      }
    }
  }
});

test("the connecting, starting, steering and rewind lines name Gemini", () => {
  const en = messagesFor("en-US", "gemini");
  const zh = messagesFor("zh-CN", "gemini");
  assert.equal(en.connectingRuntime, "Connecting to Gemini…");
  assert.equal(zh.connectingRuntime, "正在连接 Gemini…");
  assert.equal(en.runPhaseStartingRuntime, "Starting Gemini");
  assert.equal(en.slashCommands, "Gemini commands");
  assert.equal(en.modelPickerScopeRuntime, "Using Gemini's default");
  assert.match(en.rewindFilesOnlyBody("unsupported"), /Gemini cannot rewind the conversation, so only the files go back/u);
  assert.match(en.steerNotice("queued", "unsupported"), /Gemini/u);
  assert.doesNotMatch(en.steerNotice("queued", "unsupported"), /Grok/u);
  assert.match(zh.rewindFilesOnlyBody("unsupported"), /Gemini 目前不能退回对话/u);
  assert.match(en.continuousStopReason("runtime_unavailable"), /Gemini/u);
  assert.equal(en.taskEngineName("gemini"), "Gemini");
  assert.equal(en.taskEngineMarkerTitle("gemini"), "Gemini conversation");
  assert.equal(zh.taskEngineMarkerTitle("gemini"), "Gemini 对话");
});

test("the stop button, the start timeout and the commands tell the truth about Gemini", () => {
  const en = messagesFor("en-US");
  const zh = messagesFor("zh-CN");
  assert.match(en.addonStopCaveat("gemini"), /a command Gemini has already started may keep running until this conversation's process closes/u);
  assert.match(zh.addonStopCaveat("gemini"), /Gemini 已经开始运行的命令可能还会继续/u);
  assert.match(en.addonStartTimeout("gemini"), /Gemini is still starting/u);
  assert.match(zh.addonStartTimeout("gemini"), /Gemini 仍在启动/u);
  assert.equal(en.addonInstallCommand("gemini"), "npm install -g @google/gemini-cli");
  // An API key, not a login: there is no command to log in, and the missing-key line points at Settings instead.
  assert.equal(en.addonLoginCommand("gemini"), undefined);
  assert.equal(zh.addonLoginCommand("gemini"), undefined);
  assert.equal(en.addonStatusNotLoggedIn("gemini"), "No usable API key. Choose and confirm the key file below.");
  assert.doesNotMatch(en.addonStatusNotLoggedIn("gemini"), /log ?in|Terminal/iu);
  assert.equal(en.addonStatusNotLoggedIn("codex"), "Not logged in. Run this in Terminal:");
  assert.equal(en.modelPickerAddonUnavailable("gemini"), "Gemini not found or no API key");
});

test("the account card says Gemini API (pay-as-you-go), names no plan and no cost, and defers to Google AI Studio's billing", () => {
  const en = messagesFor("en-US");
  const zh = messagesFor("zh-CN");
  assert.equal(en.usageAddonHeading("gemini"), "Gemini API (pay-as-you-go)");
  assert.equal(zh.usageAddonHeading("gemini"), "Gemini API（按量计费）");
  assert.equal(en.usageAddonQuota("gemini"), "Token counts are approximate; billing is authoritative on Google AI Studio");
  assert.equal(zh.usageAddonQuota("gemini"), "令牌数为估算，计费以 Google AI Studio 为准");
  for (const text of [en.usageAddonHeading("gemini"), en.usageAddonQuota("gemini"), zh.usageAddonQuota("gemini")]) {
    assert.doesNotMatch(text, /\$|USD|subscription|Plus|Pro\b|订阅/u);
  }
  // Codex keeps its own card.
  assert.equal(en.usageAddonQuota("codex"), "Quota: managed by Codex");
});
