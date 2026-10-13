import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { GuildEngine, GuildLocale } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineItem } from "./App.js";
import { entry } from "./checkpoint.fixture.js";
import { ContinuousTaskCard } from "./ContinuousTask.js";
import { messagesFor } from "./locales.js";

/*
 * A Claude task speaks of Claude, not Grok (PC-ENG-001). The Claude catalog replaces the strings that name the
 * runtime; the only strings left that name Grok belong to Grok-only surfaces (settings, the Grok tools, the
 * usage card, the engine note). A new string that names Grok must either get a Claude wording or be added here
 * with the Grok-only surface it belongs to.
 */

const GROK_ONLY_SURFACES: ReadonlyMap<string, string> = new Map([
  ["settingsGrok", "the Grok heading of Settings > Engines"],
  ["runtimeSettingsHelp", "the Grok section of Settings > Engines"],
  ["webSearchHelp", "the Grok section of Settings > Engines"],
  ["planModeHelp", "the Grok section of Settings > Engines"],
  ["subagentsHelp", "the Grok section of Settings > Engines"],
  ["permissionFullAccessHelp", "the Grok section of Settings > Engines"],
  ["grokToolsGrokOnly", "the disabled Grok tools button, which says so"],
  ["usageLoading", "the Grok usage card; a Claude task shows its own card"],
  ["usageUnavailable", "the Grok usage card; a Claude task shows its own card"],
  ["viewOfficialUsage", "the Grok usage card; a Claude task shows its own card"],
  ["modelPickerEmpty", "the hint of the Grok group of the picker"],
  ["modelPickerEngineNote", "the note that the first message chooses between Grok, Claude, ChatGPT and Gemini"],
  ["aboutRole", "Settings > About, which names both engines"],
  ["privacyBrowserSyncHelp", "Settings > Privacy (global)"],
  ["officialSettingScope", "not shown to a Claude task"],
  ["commandsAppearAfterConnect", "not shown to a Claude task"],
]);

/** Every key and value word of the catalog sources, so a function-valued string is asked about each of its cases. */
async function probeArguments(): Promise<readonly string[]> {
  const names = ["locales.ts", "change-messages.ts", "workshop-messages.ts"];
  const source = (await Promise.all(names.map((name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")))).join("\n");
  const words = [...source.matchAll(/(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)(?=\s*:)/gu)].map((match) => match[1]!);
  // A word that already says Grok would only be echoed back, not asked about.
  return [...new Set(words)].filter((word) => !/grok/iu.test(word));
}

function grokStrings(locale: GuildLocale, engine: GuildEngine, probes: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, Set<string>>();
  const note = (key: string, text: unknown) => {
    if (typeof text === "string" && /grok/iu.test(text)) found.set(key, (found.get(key) ?? new Set()).add(text));
  };
  const pairs = ["queued", "steered", "unsupported", "runtime_unavailable", "running", "pending", "x", "claude"];
  for (const [key, value] of Object.entries(messagesFor(locale, engine))) {
    if (typeof value === "string") note(key, value);
    if (typeof value !== "function") continue;
    const ask = value as (...args: unknown[]) => unknown;
    for (const probe of probes) {
      try { note(key, ask(probe)); } catch { /* not a string-keyed function */ }
    }
    for (const count of [0, 1, 2, 3]) {
      try { note(key, ask(count)); } catch { /* not a count-keyed function */ }
    }
    for (const first of pairs) for (const second of pairs) {
      try { note(key, ask(first, second)); } catch { /* not a two-argument function */ }
    }
    try { note(key, ask()); } catch { /* needs arguments */ }
  }
  return new Map([...found].map(([key, texts]) => [key, [...texts]]));
}

test("no string a Claude task resolves names Grok, except the strings of Grok-only surfaces", async () => {
  const probes = await probeArguments();
  assert.ok(probes.length > 300, "the probe words come from the catalog sources");
  for (const locale of ["zh-CN", "en-US"] as const) {
    const named = [...grokStrings(locale, "claude", probes).keys()]
      .filter((key) => !GROK_ONLY_SURFACES.has(key) && !key.startsWith("grokManagement"));
    assert.deepEqual(named, [], `${locale}: these strings name Grok in a Claude task; give them a Claude wording (CLAUDE_ZH / CLAUDE_EN)`);
    // The allowlist is not a place to forget things: every entry still names Grok.
    const stillNamed = new Set(grokStrings(locale, "claude", probes).keys());
    for (const key of GROK_ONLY_SURFACES.keys()) assert.equal(stillNamed.has(key), true, `${locale}: ${key} no longer names Grok; drop it from the list`);
    // A Grok task keeps its own wording: the overrides are for Claude only.
    const grokTask = grokStrings(locale, "grok", probes);
    for (const key of ["continuousStopReason", "interjectionReason", "steerNotice", "rewindRuntimeRestoreHeading", "terminalOutputUnavailable", "runtimeUnavailable"]) {
      assert.equal(grokTask.has(key), true, `${locale}: a Grok task still says Grok in ${key}`);
    }
  }
});

test("a continuous task that stopped names the runtime it ran on", () => {
  const ZH_REASONS = {
    runtime_unavailable: "Claude Code 运行时当前不可用；检查登录或连接后可继续。",
    empty_runtime_response: "Claude Code 没有返回可用内容；请检查连接后重试。",
    transport_interrupted: "与 Claude Code 的连接中断；任务已安全暂停，没有自动重发。",
  };
  const EN_REASONS = {
    runtime_unavailable: "The Claude Code runtime is unavailable. Check sign-in or connectivity, then resume.",
    empty_runtime_response: "Claude Code returned no usable content. Check connectivity, then retry.",
    transport_interrupted: "The Claude Code connection was interrupted. The task paused safely and was not resent.",
  };
  for (const [locale, reasons] of [["zh-CN", ZH_REASONS], ["en-US", EN_REASONS]] as const) {
    for (const [reason, text] of Object.entries(reasons)) {
      assert.equal(messagesFor(locale, "claude").continuousStopReason(reason), text, `${locale} ${reason}`);
      assert.match(messagesFor(locale).continuousStopReason(reason), /Grok/u, `${locale} ${reason} stays Grok for a Grok task`);
    }
    // The reasons that name no runtime read the same on both engines.
    for (const reason of ["desktop_restarted", "paused_by_user", "objective_verified_complete", "run_failed", "something_else"]) {
      assert.equal(messagesFor(locale, "claude").continuousStopReason(reason), messagesFor(locale).continuousStopReason(reason), reason);
    }
  }
});

const stoppedTask = { objective: "Ship it", phase: "work", cycle: 2, status: "blocked", stopReason: "transport_interrupted" } as const;
const card = (engine: GuildEngine | undefined, locale: GuildLocale) => renderToStaticMarkup(
  <ContinuousTaskCard
    task={stoppedTask}
    locale={locale}
    {...(engine === undefined ? {} : { engine })}
    running={false}
    busy={false}
    onAction={() => undefined}
  />,
);

test("the continuous card of a Claude task shows its stop reason in Claude's words, a Grok task's stays Grok's", () => {
  const claude = card("claude", "en-US");
  assert.match(claude, /The Claude Code connection was interrupted\./u);
  assert.doesNotMatch(claude, /Grok/u);
  assert.doesNotMatch(card("claude", "zh-CN"), /Grok/u);
  assert.match(card("claude", "zh-CN"), /与 Claude Code 的连接中断/u);
  assert.match(card("grok", "en-US"), /The Grok connection was interrupted\./u);
  assert.match(card(undefined, "en-US"), /The Grok connection was interrupted\./u);
});

test("a Steer the runtime did not take is explained in the words of the task's engine", () => {
  const notice = (engine: GuildEngine | undefined, locale: GuildLocale, reason: string) => renderToStaticMarkup(
    <TimelineItem
      item={entry("notice", "n1", { interjection: { interjectionId: "i1", state: "fallen_back", reason } })}
      locale={locale}
      {...(engine === undefined ? {} : { engine })}
      canRetry={false}
      onOpenExternal={() => undefined}
      onPermissionDecision={async () => undefined}
      onBranch={async () => undefined}
      onRetryToDraft={() => undefined}
      onOpenRuntimeDiagnostics={() => undefined}
    />,
  );
  assert.match(notice("claude", "en-US", "unsupported"), /this Claude Code version cannot take messages mid-turn/u);
  assert.match(notice("claude", "en-US", "runtime_error"), /Claude Code did not accept it/u);
  assert.match(notice("claude", "zh-CN", "unsupported"), /当前 Claude Code 版本不支持插话/u);
  assert.match(notice("claude", "zh-CN", "runtime_error"), /Claude Code 没有收下这条插话/u);
  for (const reason of ["unsupported", "runtime_error"]) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      assert.doesNotMatch(notice("claude", locale, reason), /Grok/u, `${locale} ${reason}`);
    }
  }
  assert.match(notice("grok", "en-US", "unsupported"), /this Grok version cannot take messages mid-turn/u);
  assert.match(notice(undefined, "en-US", "runtime_error"), /Grok did not accept it/u);
  // The notice shown when a Steer is turned into a queued message reads the same way.
  assert.equal(
    messagesFor("en-US", "claude").steerNotice("queued", "unsupported"),
    "Could not steer, so the message was queued: this Claude Code version cannot take messages mid-turn.",
  );
  assert.match(messagesFor("zh-CN", "claude").steerNotice("started", "runtime_error"), /Claude Code 没有收下这条插话/u);
  assert.equal(messagesFor("en-US", "claude").rewindRuntimeRestoreHeading(1), "Claude Code's edit snapshots can restore 1 file");
  assert.equal(messagesFor("zh-CN", "claude").rewindRuntimeRestoreHeading(2), "Claude Code 的编辑快照可以还原 2 个文件");
});

test("the conversation components that word the runtime are handed the task's engine", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const continuous = await readFile(new URL("../src/ContinuousTask.tsx", import.meta.url), "utf8");
  assert.match(app, /<ContinuousTaskCard\s*\n(?:.*\n){0,6}?\s*engine=\{activeEngine\}/u);
  assert.match(continuous, /export function ContinuousTaskCard\(\{ task, locale, engine = "grok", running, busy, onAction \}/u);
  assert.match(continuous, /const messages = messagesFor\(locale, engine\);\s*\n\s*const status =/u);
  // Timeline -> row -> item, activity group, tool row and run card.
  assert.match(app, /<TimelineGroupRow\s*\n(?:.*\n){0,8}?\s*engine=\{engine\}/u);
  assert.match(app, /<TimelineItem\s*\n\s*item=\{group\.item\}\s*\n\s*locale=\{locale\}\s*\n\s*engine=\{engine\}/u);
  assert.match(app, /<ActivityGroupView items=\{group\.items\} locale=\{locale\} engine=\{engine\} \/>/u);
  assert.match(app, /<ToolRow item=\{item\} locale=\{locale\} engine=\{engine\} key=\{item\.entryId\} \/>/u);
  assert.equal(app.match(/<RunCardView card=\{card\} locale=\{locale\} engine=\{engine\}/gu)?.length, 2);
  assert.match(app, /messages=\{messagesFor\(locale, engine\)\}\s*\n\s*onViewDiff=\{onViewRunDiff \?\? NO_RUN_DIFF\}/u);
  assert.match(app, /previous\.engine === next\.engine &&\s*\n\s*previous\.handlers === next\.handlers/u);
});
