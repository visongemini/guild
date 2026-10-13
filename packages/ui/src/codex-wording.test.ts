import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { GuildLocale } from "@guild/contracts";
import { LOCALES, addonOverrideKeys, claudeOverrideKeys, messagesFor } from "./locales.js";

/*
 * A Codex task speaks of Codex (PC-ENG-003), as a Claude task speaks of Claude. The add-on wording replaces the
 * strings that name the runtime; what still names Grok or Claude belongs to a surface of that engine only.
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
  for (const [key, value] of Object.entries(messagesFor(locale, "codex"))) {
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

test("no string a Codex task resolves names Grok or Claude, except the strings of those engines' own surfaces", async () => {
  const probes = await probeArguments();
  assert.ok(probes.length > 300, "the probe words come from the catalog sources");
  for (const locale of ["zh-CN", "en-US"] as const) {
    const grok = [...named(locale, /grok/iu, probes)].filter((key) => !GROK_ONLY_SURFACES.has(key) && !key.startsWith("grokManagement"));
    assert.deepEqual(grok, [], `${locale}: these strings name Grok in a Codex task; give them a Codex wording (ADDON_ZH / ADDON_EN)`);
    const claude = [...named(locale, /claude/iu, probes)].filter((key) =>
      !CLAUDE_SURFACES.has(key) && !/^(claude|usageClaude|settingsClaude|enginesClaude|modelPickerClaude)/u.test(key));
    assert.deepEqual(claude, [], `${locale}: these strings name Claude in a Codex task; give them a Codex wording`);
  }
});

test("a Codex task words the runtime strings for Codex, leaves the Grok and Claude catalogs untouched and never reuses Claude's", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const grok = messagesFor(locale);
    const codex = messagesFor(locale, "codex");
    assert.equal(messagesFor(locale, "grok"), grok);
    assert.equal(grok, LOCALES[locale]);
    assert.notEqual(codex, grok);
    assert.notEqual(codex, messagesFor(locale, "claude"));
    assert.deepEqual(Object.keys(codex).sort(), Object.keys(grok).sort());
    const overridden = addonOverrideKeys(locale);
    assert.ok(overridden.length >= 25);
    for (const key of Object.keys(grok)) {
      const changed = (codex as Record<string, unknown>)[key] !== (grok as Record<string, unknown>)[key];
      assert.equal(changed, overridden.includes(key), `${locale}: ${key}`);
    }
    for (const key of overridden) {
      const value = (codex as Record<string, unknown>)[key];
      if (typeof value === "string") {
        assert.equal(/Grok|Claude/u.test(value), false, `${locale}: ${key} names another engine`);
        if (key !== "terminalOutputUnavailable") assert.equal(/Codex/u.test(value), true, `${locale}: ${key} does not name Codex`);
      }
    }
  }
  // The same keys are reworded for Claude and for an add-on engine: no runtime string is left out of either.
  assert.deepEqual(addonOverrideKeys("zh-CN"), addonOverrideKeys("en-US"));
  assert.deepEqual(addonOverrideKeys("en-US"), claudeOverrideKeys("en-US"));
});

test("the connecting, starting, steering and rewind lines name Codex", () => {
  const en = messagesFor("en-US", "codex");
  const zh = messagesFor("zh-CN", "codex");
  assert.equal(en.connectingRuntime, "Connecting to Codex…");
  assert.equal(zh.connectingRuntime, "正在连接 Codex…");
  assert.equal(en.runPhaseStartingRuntime, "Starting Codex");
  assert.equal(en.slashCommands, "Codex commands");
  assert.equal(en.modelPickerScopeRuntime, "Using Codex's default");
  assert.match(en.rewindFilesOnlyBody("unsupported"), /Codex cannot rewind the conversation, so only the files go back/u);
  assert.match(en.steerNotice("queued", "unsupported"), /Codex/u);
  assert.doesNotMatch(en.steerNotice("queued", "unsupported"), /Grok/u);
  assert.match(zh.rewindFilesOnlyBody("unsupported"), /Codex 目前不能退回对话/u);
  assert.match(en.continuousStopReason("runtime_unavailable"), /Codex/u);
});

test("the stop button and the start timeout tell the truth about Codex", () => {
  const en = messagesFor("en-US");
  assert.match(en.addonStopCaveat("codex"), /a command Codex has already started may keep running until this conversation's process closes/u);
  assert.match(messagesFor("zh-CN").addonStopCaveat("codex"), /Codex 已经开始运行的命令可能还会继续/u);
  assert.match(en.addonStartTimeout("codex"), /Codex is still starting/u);
  assert.match(messagesFor("zh-CN").addonStartTimeout("codex"), /Codex 仍在启动/u);
  assert.equal(en.addonInstallCommand("codex"), "npm install -g @agentclientprotocol/codex-acp");
  assert.equal(en.addonLoginCommand("codex"), "codex login");
});

test("the account card never invents a plan: it says Codex manages it unless the engine named one", () => {
  const en = messagesFor("en-US");
  const zh = messagesFor("zh-CN");
  assert.equal(en.usageAddonHeading("codex"), "ChatGPT subscription");
  assert.equal(zh.usageAddonHeading("codex"), "ChatGPT 订阅");
  assert.equal(en.usageAddonAccountManaged("codex"), "managed by Codex");
  assert.equal(zh.usageAddonAccountManaged("codex"), "由 Codex 管理");
  assert.equal(en.usageAddonQuota("codex"), "Quota: managed by Codex");
});
