import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModelCatalog, TaskModelSelectionProjection, TimelineItemProjection } from "@guild/contracts";
import { freezeModelCatalog } from "@guild/contracts/grok-models";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineItem } from "./App.js";
import { claudeDefaultsView } from "./claude-engine.js";
import { GuildHero } from "./GuildHero.js";
import { messagesFor } from "./locales.js";
import { CLAUDE_CATALOG, REAL_CATALOG } from "./model-catalog.fixture.js";
import { effortsDescending, headingIsStuck, modelPickerView, scrollCues } from "./model-picker.js";
import { ModelPicker } from "./ModelPicker.js";
import { permissionOptionView } from "./permission-options.js";
import { noTaskComposerPlaceholder } from "./welcome.js";

/*
 * Guild 3.0.2 UI polish: one test file for the behaviours added by the polish pass. Pure view logic is tested
 * directly; markup and wiring are checked through the exported components and the sources they are wired in.
 */

const noop = () => undefined;
const source = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

function permissionCard(options: readonly { optionId: string; name: string; kind: string }[], locale: "zh-CN" | "en-US", engine: "grok" | "claude" = "claude") {
  const item = {
    entryId: "p", taskId: "t", runId: "r", sequence: 3, createdAtMs: 1, updatedAtMs: 1, status: "waiting", kind: "permission",
    permissionId: "p1", title: "Write notes.txt", options,
  } as unknown as TimelineItemProjection;
  return renderToStaticMarkup(
    <TimelineItem item={item} locale={locale} engine={engine} canRetry={false} onOpenExternal={noop}
      onPermissionDecision={async () => undefined} onBranch={async () => undefined} onRetryToDraft={noop} onOpenRuntimeDiagnostics={noop} />,
  );
}

const CLAUDE_OPTIONS = [
  { optionId: "allow", name: "Yes", kind: "allow_once" },
  { optionId: "always", name: "Yes, allow all edits during this session", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];

test("permission buttons are labeled by their ACP kind in Chinese and keep the agent's text as the tooltip", () => {
  for (const engine of ["claude", "grok"] as const) {
    const markup = permissionCard(CLAUDE_OPTIONS, "zh-CN", engine);
    assert.match(markup, /title="Yes" class="allow primary">允许<\/button>/u);
    assert.match(markup, /title="Yes, allow all edits during this session" class="allow">本会话都允许<\/button>/u);
    assert.match(markup, /title="No" class="reject">拒绝<\/button>/u);
    assert.doesNotMatch(markup, />(?:Yes|No)</u);
  }
  const reject = permissionCard([{ optionId: "x", name: "Reject all", kind: "reject_always" }], "zh-CN");
  assert.match(reject, /title="Reject all" class="reject">都拒绝<\/button>/u);
});

test("an unknown kind and the English interface keep the agent's own text", () => {
  const unknown = permissionCard([{ optionId: "x", name: "Open the plan", kind: "something_new" }], "zh-CN");
  assert.match(unknown, />Open the plan<\/button>/u);
  assert.doesNotMatch(unknown, /title="Open the plan"/u);
  const english = permissionCard(CLAUDE_OPTIONS, "en-US");
  assert.match(english, /class="allow primary">Yes<\/button>/u);
  assert.match(english, />Yes, allow all edits during this session<\/button>/u);
  assert.match(english, />No<\/button>/u);
});

test("an always-option that does not speak of the session keeps the text that names its scope", () => {
  const zh = messagesFor("zh-CN");
  assert.deepEqual(
    permissionOptionView(zh, { name: "Yes, and allow access to notes/ and similar commands", kind: "allow_always" }),
    { label: "Yes, and allow access to notes/ and similar commands", title: undefined },
  );
  assert.deepEqual(
    permissionOptionView(zh, { name: "Always allow for this Session", kind: "allow_always" }),
    { label: "本会话都允许", title: "Always allow for this Session" },
  );
  assert.deepEqual(permissionOptionView(zh, { name: "允许", kind: "allow_once" }), { label: "允许", title: undefined });
});

test("the card's last button says it stops the turn, and it does stop the turn", async () => {
  const zh = permissionCard(CLAUDE_OPTIONS, "zh-CN");
  assert.match(zh, /class="dismiss" title="不执行这个操作，并停止本轮任务。">停止本轮<\/button>/u);
  assert.doesNotMatch(zh, />取消<\/button>/u);
  assert.match(permissionCard(CLAUDE_OPTIONS, "en-US"), /class="dismiss" title="Do not run this action, and stop the turn.">Stop this turn<\/button>/u);
  // A cancelled decision from the card goes down the stop path instead of sending ACP's cancelled outcome mid-turn.
  const app = await source("App.tsx");
  const start = app.indexOf("async function decidePermission");
  const body = app.slice(start, app.indexOf("function beginSidebarResize", start));
  assert.match(body, /decision\.type === "cancelled"[\s\S]*api\.cancelRun\(\{ taskId: item\.taskId, runId: item\.runId! \}\)/u);
  assert.match(body, /api\.decidePermission\(\{/u);
});

test("the online reminder dialog closes the model popover first and its copy is two-way", async () => {
  const picker = await source("ModelPicker.tsx");
  const app = await source("App.tsx");
  assert.match(picker, /useEffect\(\(\) => \{\s*if \(modalOpen\) setOpen\(false\);\s*\}, \[modalOpen\]\);/u);
  assert.match(app, /modalOpen=\{onlineReminder !== undefined\}/u);
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    const copy = [
      messages.onlineReminderTitle, messages.onlineReminderLead("DeepSeek"), messages.onlineReminderItemClaudeMd,
      messages.onlineReminderItemMemory, messages.onlineReminderItemConversation, messages.onlineReminderItemBrowser,
      messages.onlineReminderDontRemind, messages.onlineReminderSwitch,
    ].join("\n");
    assert.doesNotMatch(copy, /不能再|无法再|不可再|切回|cannot (?:go|switch) back|can(?:'|’)t (?:go|switch) back|one-way|no longer be able/iu, locale);
  }
  assert.equal(messagesFor("zh-CN").onlineReminderTitle, "发给在线模型前确认一下");
  assert.equal(messagesFor("en-US").onlineReminderTitle, "Confirm before sending to an online model");
});

// ---- model picker

const selection = (modelId: string | null, reasoningEffort: string | null = null): TaskModelSelectionProjection =>
  Object.freeze({ modelId, reasoningEffort, source: "task", canChange: true });

const ROUTED: ModelCatalog = freezeModelCatalog("claude", {
  engine: "claude",
  models: [
    { id: "ds-pro", name: "DeepSeek V4 Pro", description: "DeepSeek", group: "online", reasoningEfforts: [], contextWindows: [1_000_000], supportsImages: true },
    { id: "ds-flash", name: "DeepSeek V4 Flash", description: "DeepSeek", group: "online", reasoningEfforts: [], contextWindows: [1_000_000] },
    { id: "localmodel", name: "Local Model 27B", description: "LAN llama.cpp", group: "local", reasoningEfforts: [], contextWindows: [205_000], supportsImages: true },
    { id: "bare", name: "Bare model", group: "online", reasoningEfforts: [], contextWindows: [] },
  ],
});

test("Online and Local rows show the context window the source defines and a muted note when it states image support", () => {
  const view = modelPickerView({
    messages: messagesFor("zh-CN"), catalogs: { grok: REAL_CATALOG, claude: ROUTED },
    selection: selection("ds-pro"), taskEngine: "claude", engineFixed: true,
  });
  const row = (id: string) => view.models.find((candidate) => candidate.id === id)!;
  assert.equal(row("ds-pro").contextLabel, "1M 上下文");
  assert.equal(row("ds-pro").supportsImages, true);
  assert.equal(row("ds-flash").contextLabel, "1M 上下文");
  assert.equal(row("ds-flash").supportsImages, undefined);
  assert.equal(row("localmodel").contextLabel, "205K 上下文");
  assert.equal(row("bare").contextLabel, undefined, "a source that states no window shows none");
  const markup = renderToStaticMarkup(
    <ModelPicker messages={messagesFor("zh-CN")} catalogs={{ grok: REAL_CATALOG, claude: ROUTED }} selection={selection("ds-pro")}
      taskEngine="claude" engineFixed onApply={async () => undefined} initialOpen />,
  );
  assert.match(markup, /<small class="guild-model-row-meta">1M 上下文 · 支持图片<\/small>/u);
  assert.match(markup, /<small class="guild-model-row-meta">1M 上下文<\/small>/u);
  assert.match(markup, /<small class="guild-model-row-meta">205K 上下文 · 支持图片<\/small>/u);
  assert.equal(markup.match(/guild-model-row-meta/gu)?.length, 3, "the bare model has no meta line");
});

test("a catalog accepts image support only as true", () => {
  assert.throws(() => freezeModelCatalog("claude", {
    engine: "claude",
    models: [{ id: "x", name: "X", group: "online", reasoningEfforts: [], contextWindows: [], supportsImages: false }],
  }), /invalid_boolean/u);
  assert.equal(ROUTED.models[0]?.supportsImages, true);
  assert.equal("supportsImages" in ROUTED.models[1]!, false);
});

test("the Claude effort list reads from the strongest down like Grok's, with the default first", () => {
  const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);
  assert.deepEqual(ids(effortsDescending(CLAUDE_CATALOG.models.find((model) => model.id === "opus")!.reasoningEfforts)),
    ["default", "max", "xhigh", "high", "medium", "low"]);
  // Stable, and an effort the table does not know keeps the adapter's order after the known ones.
  assert.deepEqual(ids(effortsDescending([{ id: "low" }, { id: "turbo" }, { id: "weird" }, { id: "high" }])), ["high", "low", "turbo", "weird"]);
  const claude = modelPickerView({
    messages: messagesFor("zh-CN"), catalogs: { grok: REAL_CATALOG, claude: CLAUDE_CATALOG },
    selection: selection("opus", "high"), taskEngine: "claude", engineFixed: true,
  });
  assert.deepEqual(claude.efforts.map((effort) => effort.label), ["默认", "最高", "超高", "高", "中", "低"]);
  assert.equal(claude.efforts.filter((effort) => effort.tabStop).length, 1);
  // Grok keeps what the runtime reports (strongest first already).
  const grokModel = REAL_CATALOG.models.find((model) => model.reasoningEfforts.length > 1)!;
  const grok = modelPickerView({
    messages: messagesFor("zh-CN"), catalogs: { grok: REAL_CATALOG, claude: CLAUDE_CATALOG },
    selection: selection(grokModel.id, grokModel.reasoningEfforts[0]!.id), taskEngine: "grok", engineFixed: true,
  });
  assert.deepEqual(grok.efforts.map((effort) => effort.id), grokModel.reasoningEfforts.map((effort) => effort.id));
  // Settings reads the same direction as the picker.
  assert.deepEqual(claudeDefaultsView({ catalog: CLAUDE_CATALOG, model: "opus", reasoningEffort: "high" }).efforts.map((effort) => effort.id),
    ["default", "max", "xhigh", "high", "medium", "low"]);
});

test("scroll cues mark only an edge with content past it, and a heading is stuck once it sits on the top edge", () => {
  assert.deepEqual(scrollCues({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 }), { top: false, bottom: false });
  assert.deepEqual(scrollCues({ scrollTop: 0, scrollHeight: 900, clientHeight: 500 }), { top: false, bottom: true });
  assert.deepEqual(scrollCues({ scrollTop: 200, scrollHeight: 900, clientHeight: 500 }), { top: true, bottom: true });
  assert.deepEqual(scrollCues({ scrollTop: 400, scrollHeight: 900, clientHeight: 500 }), { top: true, bottom: false });
  assert.deepEqual(scrollCues({ scrollTop: 0.4, scrollHeight: 900.5, clientHeight: 500 }).top, false, "fractions are not a scroll");
  assert.equal(headingIsStuck(101, 100), false);
  assert.equal(headingIsStuck(100.4, 100), true);
  assert.equal(headingIsStuck(40, 100), true, "pushed up by the next group counts as past the edge");
});

test("the popover is wider, its group headings stick, and both edges have a fade marker driven by the scroll position", async () => {
  const css = await source("styles.css");
  const picker = await source("ModelPicker.tsx");
  const block = (selector: string) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^}]+)\\}`, "u"))?.[1] ?? "";
  assert.match(block(".guild-model-popover"), /width:\s*344px/u);
  assert.match(block(".guild-model-popover"), /max-width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/u);
  assert.match(block(".guild-model-group-heading"), /position:\s*sticky/u);
  assert.match(block(".guild-model-group-heading"), /top:\s*0/u);
  assert.match(block(".guild-model-group-heading"), /background:\s*var\(--guild-surface\)/u);
  assert.match(css, /\.guild-model-group-heading\[data-stuck="true"\]::after \{ opacity: 1; \}/u);
  assert.match(css, /\.guild-model-popover\[data-fade-top="true"\] \.guild-model-fade\.top::before, \.guild-model-popover\[data-fade-bottom="true"\] \.guild-model-fade\.bottom::before \{ opacity: 1; \}/u);
  assert.match(block(".guild-model-fade"), /position:\s*sticky/u);
  assert.match(block(".guild-model-fade"), /pointer-events:\s*none/u);
  assert.match(picker, /onScroll=\{syncScrollCues\}/u);
  assert.match(picker, /<div className="guild-model-fade top" aria-hidden="true" \/>/u);
  assert.match(picker, /<div className="guild-model-fade bottom" aria-hidden="true" \/>/u);
  // The fade markers are decoration: hidden from assistive technology, outside the listbox, never a tab stop.
  const markup = renderToStaticMarkup(
    <ModelPicker messages={messagesFor("zh-CN")} catalogs={{ grok: REAL_CATALOG, claude: CLAUDE_CATALOG }} selection={selection("opus", "high")}
      taskEngine="claude" engineFixed onApply={async () => undefined} initialOpen />,
  );
  assert.equal(markup.match(/class="guild-model-fade (?:top|bottom)" aria-hidden="true"/gu)?.length, 2);
});

// ---- empty and welcome screens

test("the composer without a task asks for a task when a workspace exists, and for a workspace only when none does", () => {
  for (const [locale, task, workspace] of [
    ["zh-CN", "新建任务后就能发送", "选择工作区后才能发送"],
    ["en-US", "Start a task to send a message", "Choose a workspace before sending"],
  ] as const) {
    const messages = messagesFor(locale);
    assert.equal(noTaskComposerPlaceholder(messages, true), task);
    assert.equal(noTaskComposerPlaceholder(messages, false), workspace);
  }
});

test("the hero renders the mascot, the five letters and the helper line it is given, in both languages", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    const markup = renderToStaticMarkup(<div><GuildHero messages={messages} help="helper line" /></div>);
    assert.equal(markup.match(/class="guild-banny"/gu)?.length, 1);
    assert.match(markup, /<img class="guild-banny"[^>]*alt=""[^>]*draggable="false"\/>/u);
    assert.deepEqual([...markup.matchAll(/<b>([A-Z])<\/b>/gu)].map((match) => match[1]), ["G", "U", "I", "L", "D"]);
    assert.match(markup, new RegExp(`<h1 class="guild-acronym" aria-label="${messages.starterTitle}">`, "u"));
    assert.match(markup, /<p>helper line<\/p>/u);
  }
  // The old welcome headline and its code-glyph tile are gone with their catalog entries.
  const zh = messagesFor("zh-CN") as unknown as Record<string, unknown>;
  assert.equal("welcomeTitle" in zh, false);
  assert.equal("noWorkspaceTitle" in zh, false);
  assert.match(messagesFor("zh-CN").welcomeBody, /新建/u);
});
