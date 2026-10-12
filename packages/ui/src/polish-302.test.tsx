import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModelCatalog, ModelSourceProjection, TaskModelSelectionProjection, TimelineItemProjection } from "@guild/contracts";
import { freezeModelCatalog } from "@guild/contracts/grok-models";
import { renderToStaticMarkup } from "react-dom/server";
import { Timeline, TimelineItem } from "./App.js";
import { claudeDefaultModelOptions, claudeDefaultSelectValue, claudeDefaultsView } from "./claude-engine.js";
import { GuildHero } from "./GuildHero.js";
import { messagesFor } from "./locales.js";
import { CLAUDE_ADAPTER_CATALOG, CLAUDE_CATALOG, REAL_CATALOG } from "./model-catalog.fixture.js";
import { effortsDescending, headingIsStuck, modelPickerView, scrollCues } from "./model-picker.js";
import { ModelPicker } from "./ModelPicker.js";
import { ModelSourcesSettings, type SourceTestState } from "./ModelSourcesSettings.js";
import { OnlineReminderSetting } from "./OnlineReminderSetting.js";
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

// ---- which model answered

const answerItem = (runId: string, createdAtMs: number, updatedAtMs: number, patch: Record<string, unknown> = {}) => ({
  entryId: `a-${runId}`, taskId: "t", runId, sequence: 2, createdAtMs, updatedAtMs, status: "completed", kind: "assistant", text: "ok", ...patch,
}) as unknown as TimelineItemProjection;
const userItem = (runId: string, at: number) => ({
  entryId: `u-${runId}`, taskId: "t", runId, sequence: 1, createdAtMs: at, updatedAtMs: at, status: "completed", kind: "user", text: "hi",
}) as unknown as TimelineItemProjection;

function turnFooter(extra: { turnMeta?: string; turnModel?: string; lastTurn?: boolean }): string {
  return renderToStaticMarkup(
    <TimelineItem item={answerItem("r1", 0, 8_000)} locale="zh-CN" canRetry={false} onOpenExternal={noop}
      onPermissionDecision={async () => undefined} onBranch={async () => undefined} onRetryToDraft={noop} onOpenRuntimeDiagnostics={noop}
      {...(extra.lastTurn === undefined ? {} : { lastTurn: extra.lastTurn })}
      {...(extra.turnMeta === undefined ? {} : { turnMeta: extra.turnMeta })}
      {...(extra.turnModel === undefined ? {} : { turnModel: extra.turnModel })} />,
  );
}

test("the footer names the model before the time on one muted line, and shows only the time for an older turn", () => {
  const both = turnFooter({ turnMeta: "用时 8 秒", turnModel: "Haiku 5.5", lastTurn: true });
  assert.match(both, /<span class="guild-turn-meta"><span class="guild-turn-model" title="Haiku 5.5">Haiku 5.5<\/span><span class="guild-turn-took"> · 用时 8 秒<\/span><\/span>/u);
  const modelOnly = turnFooter({ turnModel: "DeepSeek V4 Flash" });
  assert.match(modelOnly, /<span class="guild-turn-meta"><span class="guild-turn-model" title="DeepSeek V4 Flash">DeepSeek V4 Flash<\/span><\/span>/u);
  assert.doesNotMatch(modelOnly, /guild-turn-took/u);
  // A turn that ran before the model was recorded: the footer is what it always was.
  assert.match(turnFooter({ turnMeta: "用时 8 秒" }), /<span class="guild-turn-meta">用时 8 秒<\/span>/u);
  assert.doesNotMatch(turnFooter({}), /guild-turn-meta/u);
});

test("the timeline labels a finished turn with its recorded model, never the live one, and tolerates a missing record", () => {
  const items = [userItem("r1", 0), answerItem("r1", 1_000, 62_000), userItem("r2", 70_000), answerItem("r2", 80_000, 90_000), userItem("r3", 100_000), answerItem("r3", 101_000, 110_000)];
  const render = (running: boolean) => renderToStaticMarkup(
    <Timeline items={items} locale="zh-CN" running={running} runModels={[{ runId: "r1" as never, label: "Grok 4.7" }, { runId: "r3" as never, label: "DeepSeek V4 Flash" }]}
      onOpenExternal={noop} onPermissionDecision={async () => undefined} onBranch={async () => undefined} onRetryToDraft={noop} onOpenRuntimeDiagnostics={noop} />,
  );
  const finished = render(false);
  assert.deepEqual([...finished.matchAll(/class="guild-turn-model" title="([^"]+)"/gu)].map((match) => match[1]), ["Grok 4.7", "DeepSeek V4 Flash"], "r2 has no record");
  assert.match(finished, /Grok 4\.7<\/span><span class="guild-turn-took"> · 用时 1 分 02 秒/u);
  const live = render(true);
  assert.deepEqual([...live.matchAll(/class="guild-turn-model" title="([^"]+)"/gu)].map((match) => match[1]), ["Grok 4.7"], "the live turn (r3) says nothing yet");
});

test("the footer's model name truncates before the time does, and the app hands the projection's records to the timeline", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.guild-turn-meta \{[^}]*min-width: 0;[^}]*display: flex;[^}]*white-space: nowrap;/u);
  assert.match(css, /\.guild-turn-model \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/u);
  assert.match(css, /\.guild-turn-took \{ flex: none;/u);
  assert.match(await source("App.tsx"), /runModels=\{activeTask\.runModels\}/u);
});

// ---- settings

const cssBlock = (css: string, selector: string): string =>
  css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^}]+)\\}`, "u"))?.[1] ?? "";

test("the settings dialog has one height for every tab that fits the window, and its tab body scrolls inside", async () => {
  const css = await source("styles.css");
  const app = await source("App.tsx");
  const dialog = cssBlock(css, ".guild-dialog-settings");
  assert.match(dialog, /height:\s*min\(720px, calc\(100vh - 48px\)\)/u);
  assert.match(dialog, /max-height:\s*min\(720px, calc\(100vh - 48px\)\)/u, "never taller than the window, whatever the tab");
  // The backdrop's own air (3vh, at most 24px) is inside that 48px: the dialog can never reach the window's edge.
  assert.match(cssBlock(css, ".guild-dialog-backdrop"), /padding:\s*clamp\(8px, 3vh, 24px\)/u);
  for (const viewportHeight of [600, 700, 800, 900, 1200]) {
    const air = Math.min(24, Math.max(8, viewportHeight * 0.03));
    const height = Math.min(720, viewportHeight - 48);
    assert.ok(height + 2 * air <= viewportHeight, `${viewportHeight}: ${height} + 2 x ${air}`);
  }
  assert.match(cssBlock(css, ".guild-settings-body"), /display:\s*flex;[^]*overflow:\s*hidden/u);
  assert.match(cssBlock(css, ".guild-settings-panel"), /flex:\s*1 1 auto;[^]*min-height:\s*0;[^]*overflow-y:\s*auto/u);
  assert.match(app, /className="guild-dialog-body guild-settings-body"/u);
  assert.equal(app.match(/className="guild-settings-panel[ "]/gu)?.length, 5, "every tab body is the one scrolling panel");
});

test("the source form's footer is sticky at the bottom of the dialog body and follows short forms", async () => {
  const css = await source("styles.css");
  const actions = cssBlock(css, ".guild-sources-actions");
  assert.match(actions, /position:\s*sticky/u);
  assert.match(actions, /bottom:\s*0/u);
  assert.match(actions, /background:\s*var\(--guild-surface\)/u);
  assert.match(actions, /border-top:/u);
  assert.doesNotMatch(actions, /margin-top:\s*auto/u, "no pushing the footer away from short forms");
  // The "Enabled" row no longer reserves the 64px a toggle with help text needs.
  assert.match(cssBlock(css, ".guild-sources-form .guild-setting-toggle"), /min-height:\s*0/u);
  assert.match(css, /\.guild-settings-panel:has\(> \.guild-sources-form\) \{ padding-bottom: 0; \}/u);
  // The footer is the last thing in the form, after the fields and any failure line.
  const component = await source("ModelSourcesSettings.tsx");
  const form = component.slice(component.indexOf('className="guild-sources-form"'), component.indexOf("return <div className=\"guild-sources\">"));
  assert.ok(form.lastIndexOf('className="guild-sources-actions"') > form.lastIndexOf("guild-setting-toggle"));
});

const projectedSource = (patch: Partial<ModelSourceProjection> = {}): ModelSourceProjection => Object.freeze({
  id: "deepseek", kind: "online", label: "DeepSeek", baseUrl: "https://api.example.com/anthropic", keyFile: null,
  keyVariable: "EXAMPLE_API_KEY", enabled: true, confirmedHost: "api.example.com",
  models: Object.freeze([{ id: "m1", label: "Model One" }, { id: "m2", label: "Model Two" }, { id: "m3", label: "Model Three" }]),
  ...patch,
});
const sourcesMarkup = (initialTests: Readonly<Record<string, SourceTestState>> | undefined, locale: "zh-CN" | "en-US" = "zh-CN", sources = [projectedSource()]) =>
  renderToStaticMarkup(
    <ModelSourcesSettings messages={messagesFor(locale)} onChanged={noop} initialSources={sources}
      api={{ listModelSources: async () => ({ sources: [] }), upsertModelSource: async () => { throw new Error("no"); }, deleteModelSource: async () => { throw new Error("no"); },
        confirmModelSource: async () => { throw new Error("no"); }, testModelSource: async () => { throw new Error("no"); } }}
      {...(initialTests === undefined ? {} : { initialTests })} />,
  );

test("a connection test says per model what happened, in plain words, and a refusal says why nothing was sent", () => {
  const done = (results: readonly [string, import("@guild/contracts").ModelProbeOutcome][], refused?: import("@guild/contracts").ModelSourceTestRefusal): SourceTestState => ({
    state: "done",
    response: { id: "deepseek", ...(refused === undefined ? {} : { refused }), results: results.map(([modelId, outcome]) => ({ modelId, outcome })) },
  });
  const zh = sourcesMarkup({ deepseek: done([
    ["m1", { kind: "ok", latencyMs: 820 }], ["m2", { kind: "ok", latencyMs: 1_240 }], ["m3", { kind: "model_not_found", status: 404 }],
  ]) });
  assert.match(zh, /<ul class="guild-source-test-results" role="status" aria-label="连接测试结果">/u);
  assert.match(zh, /<li class="ok"><span class="guild-source-test-model" title="m1">Model One<\/span><span class="guild-source-test-outcome">连通 · 820 毫秒<\/span><\/li>/u);
  assert.match(zh, /连通 · 1\.2 秒/u);
  assert.match(zh, /<li class="bad"><span class="guild-source-test-model" title="m3">Model Three<\/span><span class="guild-source-test-outcome">找不到这个模型<\/span><\/li>/u);
  const sentences = (outcome: import("@guild/contracts").ModelProbeOutcome, locale: "zh-CN" | "en-US" = "zh-CN") => messagesFor(locale).sourcesProbeOutcome(outcome);
  assert.equal(sentences({ kind: "key_rejected", status: 401 }), "密钥不对或没权限");
  assert.equal(sentences({ kind: "key_rejected", status: 403 }), "密钥不对或没权限");
  assert.equal(sentences({ kind: "unreachable" }), "连不上");
  assert.equal(sentences({ kind: "timeout" }), "超时");
  assert.equal(sentences({ kind: "http_error", status: 429 }), "对方返回了状态码 429");
  assert.equal(sentences({ kind: "ok", latencyMs: 40 }, "en-US"), "Connected · 40 ms");
  assert.equal(sentences({ kind: "http_error", status: 503 }, "en-US"), "The server answered with status 503");
  // A refusal is one line under the source, not a list.
  const refused = sourcesMarkup({ deepseek: done([], "key_unavailable") });
  assert.match(refused, /<p class="guild-setting-help blocked" role="status">没找到密钥：请检查密钥文件和变量名。<\/p>/u);
  assert.doesNotMatch(refused, /guild-source-test-results/u);
  assert.match(sourcesMarkup({ deepseek: done([], "address_not_allowed") }), /这个地址不符合规则，没有发出请求。/u);
  assert.match(sourcesMarkup({ deepseek: { state: "failed" } }), /测试没能进行，请稍后再试。/u);
});

test("while a source is being tested its button says so and cannot be pressed again", () => {
  const running = sourcesMarkup({ deepseek: { state: "running" } });
  assert.match(running, /<button type="button" class="guild-soft-button" disabled="" aria-busy="true"><svg[^>]*class="guild-spin"[^>]*>.*?<\/svg>正在测试…<\/button>/su);
  assert.doesNotMatch(running, /guild-source-test-results/u);
  assert.match(sourcesMarkup(undefined), />测试连接<\/button>/u);
});

test("the test is asked of the main process only for the source that was clicked, and its results go when the source changes", async () => {
  const component = await source("ModelSourcesSettings.tsx");
  assert.match(component, /api\.testModelSource\(\{ id: source\.id \}\)/u);
  assert.match(component, /if \(tests\[source\.id\]\?\.state === "running"\) return;/u);
  for (const place of ["async function remove(", "async function confirm(", "async function save()"]) {
    const body = component.slice(component.indexOf(place), component.indexOf("\n  }\n", component.indexOf(place)));
    assert.match(body, /forgetTest\(/u, place);
  }
  assert.match(component, /forgetTest\(source\.id\); setForm\(formFromSource\(source\)\)/u, "editing forgets it too");
});

test("the Claude default-model list shows the default once, newest per family first, older ones apart, in Chinese", () => {
  const zh = messagesFor("zh-CN");
  const options = claudeDefaultModelOptions(zh, CLAUDE_ADAPTER_CATALOG);
  assert.deepEqual(options.current.map((option) => option.id), ["opus", "fable", "sonnet", "haiku"], "no Default row: the control's own option is the default");
  assert.deepEqual(options.older.map((option) => option.id), [
    "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
  ]);
  assert.deepEqual(options.current.map((option) => option.label), [
    "Opus 5.5 · 复杂任务和日常主力", "Fable 5.1 · 最难、最长的任务", "Sonnet 5.5 · 速度和能力平衡", "Haiku 5.5 · 最快，适合简单快速的任务",
  ]);
  assert.equal(options.current.concat(options.older).some((option) => /Default|recommended/u.test(option.label)), false);
  // English keeps the adapter's own text; Online and Local models are never a default here.
  assert.equal(claudeDefaultModelOptions(messagesFor("en-US"), CLAUDE_ADAPTER_CATALOG).current[0]?.label, "Opus 5.5 · Most capable for complex work");
  assert.equal(options.current.concat(options.older).some((option) => /deepseek|localmodel/iu.test(option.id)), false);
  assert.deepEqual(claudeDefaultModelOptions(zh, { engine: "claude", models: [] }), { current: [], older: [] });
  assert.equal(claudeDefaultSelectValue(null), "");
  assert.equal(claudeDefaultSelectValue("default"), "", "a stored adapter Default is the same option as no choice");
  assert.equal(claudeDefaultSelectValue("opus"), "opus");
});

test("the Engines tab lists the default once through the shared options and groups the older models", async () => {
  const app = await source("App.tsx");
  assert.match(app, /const claudeModelOptions = claudeDefaultModelOptions\(baseMessages, claudeDefaults\.catalog\);/u);
  assert.match(app, /value=\{claudeDefaultSelectValue\(claude\.model\)\}/u);
  assert.match(app, /<optgroup label=\{baseMessages\.modelPickerOlderModels\(claudeModelOptions\.older\.length\)\}>/u);
  assert.doesNotMatch(app, /claudeDefaults\.models\.map/u);
});

test("the About tab starts every line on the heading's edge, and the copyright is Chinese in the Chinese interface", async () => {
  const css = await source("styles.css");
  assert.equal(messagesFor("zh-CN").aboutCopyright, "版权所有 © 2026 BDV");
  assert.equal(messagesFor("en-US").aboutCopyright, "Copyright © 2026 BDV");
  assert.match(cssBlock(css, ".guild-about-block .guild-account-meta"), /padding:\s*0/u);
  assert.match(cssBlock(css, ".guild-about-block p, .guild-about-block .guild-independent"), /margin:\s*0/u);
  assert.match(cssBlock(css, ".guild-about-block"), /gap:\s*var\(--guild-s3\)/u);
  const action = cssBlock(css, ".guild-about-action");
  assert.match(action, /justify-self:\s*start/u, "auto width, left-aligned, like the Privacy buttons");
  assert.match(action, /margin-top:/u);
  assert.match(await source("App.tsx"), /className="guild-soft-button guild-about-action"/u);
});

test("the Privacy tab has a heading on every block and one row of auto-width buttons", async () => {
  const app = await source("App.tsx");
  const css = await source("styles.css");
  const privacy = app.slice(app.indexOf('{settingsTab === "privacy" && ('), app.indexOf('{settingsTab === "about" && ('));
  // The browser-sync line is under its own heading; the other two blocks are headed too, all with one style.
  assert.match(privacy, /<h3 className="guild-settings-heading" id="guild-privacy-browser-heading">\{messages\.privacyBrowserSyncHeading\}<\/h3>\s*<p className="guild-setting-help">\{messages\.privacyBrowserSyncOff\}<\/p>/u);
  assert.match(privacy, /<h3 className="guild-settings-heading" id="guild-privacy-data-heading">\{messages\.localData\}<\/h3>/u);
  assert.ok(privacy.indexOf("<OnlineReminderSetting") > privacy.indexOf("privacyBrowserSyncOff"));
  const reminder = renderToStaticMarkup(<OnlineReminderSetting messages={messagesFor("zh-CN")} workspaceId={undefined}
    api={{ getWorkspacePrefs: async () => { throw new Error("no"); }, setWorkspacePrefs: async () => { throw new Error("no"); } }} />);
  assert.match(reminder, /<h3 class="guild-settings-heading" id="guild-privacy-online-heading">在线模型<\/h3>/u);
  // The four actions share one wrapping row, each at its own width, and the help follows the row.
  const row = privacy.slice(privacy.indexOf('<div className="guild-settings-actions">'), privacy.indexOf("</div>", privacy.indexOf('<div className="guild-settings-actions">')));
  assert.equal(row.match(/<button /gu)?.length, 4);
  assert.match(cssBlock(css, ".guild-settings-actions"), /display:\s*flex;[^]*flex-wrap:\s*wrap;[^]*gap:\s*var\(--guild-s2\)/u);
  assert.match(cssBlock(css, ".guild-settings-heading"), /font-weight:\s*650/u);
  assert.match(css, /\.guild-settings-block \+ \.guild-settings-block \{[^}]*border-top:/u);
  assert.match(messagesFor("zh-CN").privacyBrowserSyncHeading, /浏览器登录同步/u);
});

test("the language control has room before the toggle under it", async () => {
  const css = await source("styles.css");
  assert.match(css, /\.guild-segmented \+ \.guild-setting-toggle \{ margin-top: var\(--guild-s4\); \}/u);
});

// ---- visual details

type Rgb = readonly [number, number, number];
const luminanceOf = ([r, g, b]: Rgb): number => {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrastOf = (a: Rgb, b: Rgb): number => {
  const [high, low] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
};
const hex = (value: string): Rgb => {
  const match = /^#([0-9a-fA-F]{6})$/u.exec(value.trim());
  assert.ok(match !== null, `not a hex colour: ${value}`);
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t)) as unknown as Rgb;

/** A token of a theme, the dark block falling back to the light one and `var(--other)` followed. */
function themeTokens(css: string) {
  const block = (selector: string) => {
    const open = css.indexOf("{", css.indexOf(`${selector} {`));
    return css.slice(open + 1, css.indexOf("\n}", open));
  };
  const light = block("\n:root");
  const dark = block(':root[data-theme="dark"]');
  return (theme: "light" | "dark", name: string): string => {
    const read = (body: string) => new RegExp(`${name}:\\s*([^;]+);`, "u").exec(body)?.[1]?.trim();
    const value = (theme === "dark" ? read(dark) : undefined) ?? read(light);
    assert.ok(value !== undefined, `missing ${name}`);
    const reference = /^var\((--guild-[a-z0-9-]+)\)$/u.exec(value);
    return reference === null ? value : themeTokens(css)(theme, reference[1]!);
  };
}

test("the avatar initial reads at 4.5:1 or better on its whole gradient in both themes", async () => {
  const token = themeTokens(await source("styles.css"));
  for (const theme of ["light", "dark"] as const) {
    const from = hex(token(theme, "--guild-avatar-from"));
    const to = hex(token(theme, "--guild-avatar-to"));
    const text = hex(token(theme, "--guild-avatar-text"));
    for (const [where, background] of [["start", from], ["middle", mixRgb(from, to, 0.5)], ["end", to]] as const) {
      const ratio = contrastOf(text, background);
      assert.ok(ratio >= 4.5, `${theme}: initial on the ${where} of the gradient is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.match(await source("styles.css"), /\.guild-avatar \{[^}]*color: var\(--guild-avatar-text\)/u);
});

test("a hovered sidebar row is a lighter tint than the selected one, in both themes", async () => {
  const css = await source("styles.css");
  const token = themeTokens(css);
  for (const theme of ["light", "dark"] as const) {
    const hover = Number.parseFloat(token(theme, "--guild-row-hover-pct"));
    const selected = Number.parseFloat(token(theme, "--guild-row-selected-pct"));
    assert.ok(hover > 0 && selected - hover >= 4, `${theme}: hover ${hover}% and selected ${selected}%`);
    const panel = hex(token(theme, "--guild-panel"));
    const text = hex(token(theme, "--guild-text"));
    const hovered = mixRgb(panel, text, hover / 100);
    const chosen = mixRgb(panel, text, selected / 100);
    // Different enough to tell apart at a glance: at least 8 levels of lightness between the two fills.
    const level = ([r, g, b]: Rgb) => (r + g + b) / 3;
    assert.ok(Math.abs(level(chosen) - level(hovered)) >= 8, `${theme}: ${hovered} against ${chosen}`);
  }
  assert.match(css, /\.guild-task-row-wrap:hover \.guild-task-row \{ background: color-mix\(in srgb, var\(--guild-text\) var\(--guild-row-hover-pct\), transparent\); \}/u);
  assert.match(css, /\.guild-task-row\.active, \.guild-task-row-wrap\.active:hover \.guild-task-row \{ background: color-mix\(in srgb, var\(--guild-text\) var\(--guild-row-selected-pct\), transparent\); \}/u);
});

test("in the dark theme field borders, placeholders, diff meta lines and the dialog edge stand out, and text stays AA", async () => {
  const css = await source("styles.css");
  const token = themeTokens(css);
  const surface = hex(token("dark", "--guild-surface"));
  const soft = hex(token("dark", "--guild-soft"));
  const border = hex(token("dark", "--guild-field-border"));
  assert.ok(contrastOf(border, surface) >= 3 && contrastOf(border, soft) >= 3, "an input's boundary is a 3:1 component edge");
  assert.ok(contrastOf(border, surface) > contrastOf(hex(token("dark", "--guild-line-strong")), surface) + 1, "and clearly stronger than the old line colour");
  const placeholder = hex(token("dark", "--guild-placeholder"));
  assert.ok(contrastOf(placeholder, surface) >= 7, `placeholder ${contrastOf(placeholder, surface).toFixed(2)}:1`);
  assert.ok(contrastOf(placeholder, hex(token("dark", "--guild-text"))) > 1, "still not the colour of typed text");
  // The dialog's edge against the dimmed backdrop: the scrim is black at its own alpha over the canvas.
  const scrim = /rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/u.exec(token("dark", "--guild-scrim"));
  assert.ok(scrim !== null);
  const backdrop = mixRgb(hex(token("dark", "--guild-canvas")), [Number(scrim[1]), Number(scrim[2]), Number(scrim[3])], Number(scrim[4]));
  assert.ok(contrastOf(hex(token("dark", "--guild-dialog-edge")), backdrop) >= 3, "the dialog edge against the backdrop");
  assert.match(css, /\.guild-dialog \{[^}]*border: 1px solid var\(--guild-dialog-edge\)/u);
  // Diff meta lines and hunk headers use the muted text colour in dark, which is AA on the code background.
  assert.match(css, /:root\[data-theme="dark"\] \.guild-rundiff-code \.line\.hunk, :root\[data-theme="dark"\] \.guild-rundiff-code \.line\.meta \{ color: var\(--guild-muted\); \}/u);
  assert.ok(contrastOf(hex(token("dark", "--guild-muted")), hex(token("dark", "--guild-code-bg"))) >= 6.5);
  // Every field the settings and dialogs draw takes its boundary from the one token, and every placeholder from its own.
  assert.equal(css.match(/border: 1px solid var\(--guild-field-border\)/gu)?.length, 9);
  assert.equal(css.match(/::placeholder \{ color: var\(--guild-placeholder\); opacity: 1; \}/gu)?.length, 5);
  assert.doesNotMatch(css, /::placeholder \{ color: var\(--guild-faint\)/u);
});

test("the account popover shows a focus ring only for keyboard focus", async () => {
  const app = await source("App.tsx");
  const css = await source("styles.css");
  // A mouse open focuses the popover itself (no ring); the first action takes focus only when the click was a keyboard activation.
  assert.match(app, /accountOpenedByKeyboard\.current = event\.detail === 0;/u);
  assert.match(app, /\(accountOpenedByKeyboard\.current \? accountFirstActionRef\.current : accountPopoverRef\.current\)\?\.focus\(\);/u);
  assert.match(css, /\.guild-account-popover:focus \{ outline: 0; \}/u);
  // The ring itself is the :focus-visible one, never a plain :focus rule on a button.
  assert.match(css, /button:focus-visible, input:focus-visible/u);
  assert.doesNotMatch(css, /\bbutton:focus\s*\{/u);
});

test("the Files tab names a line only when it says something", async () => {
  const app = await source("App.tsx");
  assert.match(app, /file\.line !== undefined && file\.line > 1 && <small title=\{messages\.fileLineHelp\}>\{messages\.fileLine\(file\.line\)\}<\/small>/u);
  assert.doesNotMatch(app, /<small>:\{file\.line\}<\/small>/u);
  assert.equal(messagesFor("zh-CN").fileLine(42), "第 42 行");
  assert.equal(messagesFor("en-US").fileLine(42), "line 42");
  assert.equal(messagesFor("zh-CN").fileLineHelp, "最近一次读取或修改的位置");
});

test("the context ring opens its figures on click, Enter and Space, closes on Escape, an outside press and when focus leaves", async () => {
  const app = await source("App.tsx");
  const classAt = app.indexOf('className={`guild-context-usage ');
  const ring = app.slice(app.lastIndexOf("<button", classAt), app.indexOf("<ModelPicker"));
  // A real button: Enter and Space activate it like a click, so touch and keyboard users get the same popover as the tooltip.
  assert.match(ring, /<button\s+type="button"\s+className=\{`guild-context-usage /u);
  assert.match(ring, /aria-expanded=\{contextUsageOpen\}/u);
  assert.match(ring, /onClick=\{\(\) => setContextUsageOpen\(\(open\) => !open\)\}/u);
  assert.match(ring, /onBlur=\{\(\) => setContextUsageOpen\(false\)\}/u);
  assert.match(ring, /\{contextUsageOpen && <span className="guild-context-usage-detail" role="status">/u);
  // Escape and a press anywhere else close it.
  assert.match(app, /const closeOnEscape = \(event: KeyboardEvent\) => \{\s*if \(event\.key === "Escape"\) close\(\);/u);
  assert.match(app, /window\.addEventListener\("pointerdown", close\);/u);
  assert.match(app, /setContextUsageOpen\(false\);\s*\};/u);
});
