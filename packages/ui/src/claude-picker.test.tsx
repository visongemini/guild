import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TaskModelSelectionProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
  claudeModelIdentity,
  compareVersions,
  modelNameFromDescription,
  splitOlderClaudeModels,
  zhClaudeFamilyDescription,
} from "./claude-model-families.js";
import { messagesFor } from "./locales.js";
import { CLAUDE_ADAPTER_CATALOG, CLAUDE_CATALOG, REAL_CATALOG } from "./model-catalog.fixture.js";
import { modelPickerView, nextPickerIndex, selectionForRow } from "./model-picker.js";
import { ModelPicker } from "./ModelPicker.js";
import { taskHasNativeClaudeSession } from "./task-engine.js";

/*
 * The Claude group of the picker: the Default row and the newest model of each family up front, the rest under
 * "Older models (N)" (W2), and, for a task that runs through the model router, every Claude row disabled with one
 * line that says why (D-061).
 */

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");
const CATALOGS = Object.freeze({ grok: REAL_CATALOG, claude: CLAUDE_ADAPTER_CATALOG });

const selection = (
  modelId: string | null,
  reasoningEffort: string | null = null,
  source: TaskModelSelectionProjection["source"] = "task",
): TaskModelSelectionProjection => Object.freeze({ modelId, reasoningEffort, source, canChange: true });

const claudeView = (over: Partial<Parameters<typeof modelPickerView>[0]> = {}) => modelPickerView({
  messages: ZH,
  catalogs: CATALOGS,
  selection: selection("opus", "high"),
  taskEngine: "claude",
  engineFixed: true,
  ...over,
});
const groupOf = (view: ReturnType<typeof modelPickerView>, group: string) => view.groups.find((entry) => entry.group === group)!;

const OLDER_IDS = [
  "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
];

// ---- family reading

test("a family and a version are read from the display name first, then from the id", () => {
  const identity = (id: string, name: string) => claudeModelIdentity({ id, name });
  assert.deepEqual(identity("opus", "Opus 5.5"), { family: "opus", version: [5, 5] });
  assert.deepEqual(identity("x", "Sonnet 5"), { family: "sonnet", version: [5] });
  assert.deepEqual(identity("x", "Haiku 4.5 (1M context)"), { family: "haiku", version: [4, 5] });
  assert.deepEqual(identity("x", "Fable 12.30.1"), { family: "fable", version: [12, 30, 1] });
  // No version in the name: the id may carry one (a minor part of one or two digits, never a date).
  assert.deepEqual(identity("claude-opus-4-8", "Opus"), { family: "opus", version: [4, 8] });
  assert.deepEqual(identity("claude-fable-5-1[1m]", "Fable"), { family: "fable", version: [5, 1] });
  assert.deepEqual(identity("claude-haiku-4-5-20251001", "Haiku"), { family: "haiku", version: [4, 5] });
  assert.deepEqual(identity("claude-sonnet-5-20260101", "Sonnet"), { family: "sonnet", version: [5] });
  assert.deepEqual(identity("opus", "Opus"), { family: "opus", version: undefined });
  // Anything else is an unknown family: shown as the adapter gave it.
  assert.deepEqual(identity("default", "Default (recommended)"), { family: undefined, version: undefined });
  assert.equal(identity("x", "Mythos 6").family, undefined);
  assert.equal(identity("deepseek-v4-flash", "DeepSeek V4 Flash").family, undefined);
});

test("versions compare number by number, a missing part counts as zero and a missing version is the oldest", () => {
  assert.ok(compareVersions([5, 5], [5]) > 0);
  assert.ok(compareVersions([5], [4, 8]) > 0);
  assert.ok(compareVersions([4, 6], [4, 8]) < 0);
  assert.equal(compareVersions([5], [5, 0]), 0);
  assert.equal(compareVersions([12], [2]) > 0, true, "numeric, not alphabetical");
  assert.ok(compareVersions(undefined, [1]) < 0);
  assert.ok(compareVersions([1], undefined) > 0);
  assert.equal(compareVersions(undefined, undefined), 0);
});

test("the newest model of each known family stays; unknown families and the kept row always stay; ties stay together", () => {
  const rows = [
    { id: "default", name: "Default (recommended)" },
    { id: "a", name: "Opus 4.7" },
    { id: "b", name: "Opus 5.5" },
    { id: "c", name: "Opus 5.5 (1M context)" },
    { id: "d", name: "Mythos 1" },
    { id: "e", name: "Mythos 2" },
    { id: "f", name: "Haiku" },
    { id: "g", name: "Haiku 4.5" },
  ];
  const { shown, older } = splitOlderClaudeModels(rows, (row) => row.id === "default");
  assert.deepEqual(shown.map((row) => row.id), ["default", "b", "c", "d", "e", "g"]);
  assert.deepEqual(older.map((row) => row.id), ["a", "f"]);
  // A family with one model, and an unversioned model alone, are never hidden.
  assert.deepEqual(splitOlderClaudeModels([{ id: "x", name: "Sonnet" }], () => false).older, []);
  assert.deepEqual(splitOlderClaudeModels([], () => false), { shown: [], older: [] });
});

test("only a description that reads like a model name names the Default row", () => {
  assert.equal(modelNameFromDescription("Opus 5.5"), "Opus 5.5");
  assert.equal(modelNameFromDescription("  Sonnet 5 "), "Sonnet 5");
  assert.equal(modelNameFromDescription("Opus 4.7 (1M context)"), "Opus 4.7 (1M context)");
  for (const other of ["Use the best available model", "opus 5.5", "Opus", "5.5", "", undefined, "Opus 5.5 is the most capable model for complex work"]) {
    assert.equal(modelNameFromDescription(other), undefined, String(other));
  }
});

test("a known family gets its Chinese description, any other family keeps the adapter text", () => {
  assert.equal(zhClaudeFamilyDescription("opus", "Most capable"), "复杂任务和日常主力");
  assert.equal(zhClaudeFamilyDescription("sonnet", "x"), "速度和能力平衡");
  assert.equal(zhClaudeFamilyDescription("haiku", "x"), "最快，适合简单快速的任务");
  assert.equal(zhClaudeFamilyDescription("fable", "x"), "最难、最长的任务");
  assert.equal(zhClaudeFamilyDescription(undefined, "Adapter text"), "Adapter text");
  assert.equal(zhClaudeFamilyDescription("constructor", "Adapter text"), "Adapter text", "prototype keys are not families");
  assert.equal(zhClaudeFamilyDescription(undefined, undefined), undefined);
});

// ---- the Claude group of the picker

test("the group shows the Default row and the newest model of each family; the other eight sit under one row", () => {
  const view = claudeView();
  const claude = groupOf(view, "claude");
  assert.deepEqual(claude.models.map((row) => row.id), ["default", "opus", "fable", "sonnet", "haiku"]);
  assert.equal(claude.older?.count, 8);
  assert.equal(claude.older?.label, "更早的模型（8）");
  assert.equal(claude.older?.expanded, false);
  assert.deepEqual(claude.older?.models, [], "collapsed rows are not on screen");
  assert.equal(groupOf(claudeView({ messages: EN }), "claude").older?.label, "Older models (8)");
  // The keyboard and the tab stop walk only what is on screen; Online and Local rows follow.
  assert.deepEqual(view.models.map((row) => row.id), ["default", "opus", "fable", "sonnet", "haiku", "deepseek-v4-flash", "local-27b-model"]);
  assert.deepEqual(view.models.filter((row) => row.tabStop).map((row) => row.id), ["opus"], "the selected row is the one tab stop");
});

test("the expander opens inline after the newest rows, in the adapter's order, and takes no tab stop of its own", () => {
  const view = claudeView({ olderExpanded: true });
  const claude = groupOf(view, "claude");
  assert.equal(claude.older?.expanded, true);
  assert.deepEqual(claude.older?.models.map((row) => row.id), OLDER_IDS);
  assert.equal(claude.older?.state, "，已展开");
  assert.deepEqual(view.models.map((row) => row.id).slice(0, 5), ["default", "opus", "fable", "sonnet", "haiku"]);
  assert.deepEqual(view.models.slice(5, 13).map((row) => row.id), OLDER_IDS);
  assert.equal(view.models.filter((row) => row.tabStop).length, 1);
  // An explicit "closed" wins over the selection only when the selection is not hidden by it.
  assert.equal(groupOf(claudeView({ olderExpanded: false }), "claude").older?.expanded, false);
});

test("a selected older model starts the row open, so the selection is never hidden", () => {
  const view = claudeView({ selection: selection("claude-opus-4-7", "high") });
  const claude = groupOf(view, "claude");
  assert.equal(claude.older?.expanded, true);
  assert.deepEqual(view.models.filter((row) => row.selected).map((row) => row.id), ["claude-opus-4-7"]);
  assert.deepEqual(view.models.filter((row) => row.tabStop).map((row) => row.id), ["claude-opus-4-7"]);
  // The person can still close it; the tab stop then falls back to the first row.
  const closed = claudeView({ selection: selection("claude-opus-4-7", "high"), olderExpanded: false });
  assert.deepEqual(closed.models.filter((row) => row.tabStop).map((row) => row.id), ["default"]);
  // A newest model selected leaves it closed.
  assert.equal(groupOf(claudeView({ selection: selection("haiku") }), "claude").older?.expanded, false);
});

test("the Default row names the model it stands for; without that it is just Default", () => {
  const zh = groupOf(claudeView(), "claude").models[0]!;
  assert.equal(zh.name, "默认（Opus 5.5）");
  assert.equal(zh.description, undefined, "the model name is the description, said once");
  assert.equal(groupOf(claudeView({ messages: EN }), "claude").models[0]!.name, "Default (Opus 5.5)");
  const plain = groupOf(modelPickerView({
    messages: ZH, catalogs: { grok: REAL_CATALOG, claude: CLAUDE_CATALOG }, selection: selection("opus"), taskEngine: "claude", engineFixed: true,
  }), "claude").models[0]!;
  assert.equal(plain.name, "默认", "the adapter's text is not a model name");
  assert.equal(plain.description, "Use the best available model", "and it stays as the adapter said it");
  assert.equal(groupOf(modelPickerView({
    messages: EN, catalogs: { grok: REAL_CATALOG, claude: CLAUDE_CATALOG }, selection: selection("opus"), taskEngine: "claude", engineFixed: true,
  }), "claude").models[0]!.name, "Default");
});

test("rows are described by family in Chinese and keep the adapter's text in English; other groups are untouched", () => {
  const byId = (view: ReturnType<typeof modelPickerView>) => Object.fromEntries(view.models.map((row) => [row.id, row.description]));
  const zh = byId(claudeView({ olderExpanded: true }));
  assert.equal(zh["opus"], "复杂任务和日常主力");
  assert.equal(zh["fable"], "最难、最长的任务");
  assert.equal(zh["sonnet"], "速度和能力平衡");
  assert.equal(zh["haiku"], "最快，适合简单快速的任务");
  assert.equal(zh["claude-opus-4-6"], "复杂任务和日常主力");
  assert.equal(zh["claude-sonnet-4-6"], "速度和能力平衡");
  const en = byId(claudeView({ messages: EN, olderExpanded: true }));
  assert.equal(en["opus"], "Most capable for complex work");
  assert.equal(en["haiku"], "Fastest for quick answers");
  assert.equal(zh["deepseek-v4-flash"], undefined);
  assert.equal(en["deepseek-v4-flash"], undefined);
  // A family the picker does not know keeps the adapter text in Chinese too.
  const unknown = modelPickerView({
    messages: ZH,
    catalogs: { grok: REAL_CATALOG, claude: { ...CLAUDE_ADAPTER_CATALOG, models: [{ id: "mythos", name: "Mythos 1", group: "claude", description: "Adapter text", reasoningEfforts: [], contextWindows: [] }] } },
    selection: selection("mythos"), taskEngine: "claude", engineFixed: true,
  });
  assert.equal(groupOf(unknown, "claude").models[0]!.description, "Adapter text");
});

test("the trigger names the real model and the effort: Default resolves to the model it stands for", () => {
  const efforts = (messages: typeof ZH, modelId: string, effort: string | null) =>
    modelPickerView({ messages, catalogs: CATALOGS, selection: selection(modelId, effort), taskEngine: "claude", engineFixed: true });
  assert.equal(efforts(ZH, "default", null).triggerText, "Opus 5.5 · 默认");
  assert.equal(efforts(EN, "default", null).triggerText, "Opus 5.5 · Default");
  assert.equal(efforts(ZH, "default", "max").triggerText, "Opus 5.5 · 最高");
  assert.equal(efforts(ZH, "opus", "xhigh").triggerText, "Opus 5.5 · 超高");
  assert.equal(efforts(EN, "claude-opus-4-8", "xhigh").triggerText, "Opus 4.8 · Extra high");
  // The adapter did not say which model Default stands for.
  const plain = modelPickerView({ messages: ZH, catalogs: { grok: REAL_CATALOG, claude: CLAUDE_CATALOG }, selection: selection("default"), taskEngine: "claude", engineFixed: true });
  assert.equal(plain.triggerText, "默认模型 · 默认");
});

test("the effort segment of a Claude model reads Default, Low, Medium, High, Extra high, Max", () => {
  const labels = (messages: typeof ZH) => claudeView({ messages, selection: selection("opus", "high") }).efforts.map((effort) => effort.label);
  assert.deepEqual(labels(ZH), ["默认", "低", "中", "高", "超高", "最高"]);
  assert.deepEqual(labels(EN), ["Default", "Low", "Medium", "High", "Extra high", "Max"]);
});

test("choosing a row of the older list is an ordinary Claude choice", () => {
  const view = claudeView({ olderExpanded: true });
  const row = view.models.find((candidate) => candidate.id === "claude-opus-4-8")!;
  assert.deepEqual(selectionForRow(CATALOGS, row, "high", "claude"), { model: "claude-opus-4-8", reasoningEffort: "high", group: "claude" });
});

// ---- rendering and keyboard

function render(over: Partial<Parameters<typeof ModelPicker>[0]> = {}): string {
  return renderToStaticMarkup(
    <ModelPicker
      messages={ZH}
      catalogs={CATALOGS}
      selection={selection("opus", "high")}
      taskEngine="claude"
      engineFixed
      onApply={async () => { throw new Error("not called"); }}
      onOpenModelSources={() => undefined}
      initialOpen
      {...over}
    />,
  );
}
const optionTags = (markup: string): string[] => markup.match(/<(?:button|div)[^>]*role="option"[^>]*>/gu) ?? [];

test("the collapsed list is rows, then one expander option, then the other groups; opening puts the old rows right after it", () => {
  const closed = render();
  assert.match(closed, /<button type="button" role="option" aria-selected="false" tabindex="-1" class="guild-model-older"><svg[^>]*class="guild-model-older-caret"[^>]*>.*?<\/svg><span>更早的模型（8）<\/span><span class="guild-sr-only">，已折叠<\/span><\/button>/su);
  assert.match(closed, /<strong>默认（Opus 5\.5）<\/strong>/u);
  assert.doesNotMatch(closed, /Opus 4\.8/u, "an older model is not rendered while the row is closed");
  assert.equal(optionTags(closed).length, 5 + 1 + 2, "five rows, the expander, then Online and Local");
  assert.equal(optionTags(closed).filter((tag) => /tabindex="0"/u.test(tag)).length, 1, "one roving tab stop");

  const open = render({ initialOlderOpen: true });
  assert.equal(optionTags(open).length, 5 + 1 + 8 + 2);
  assert.match(open, /class="guild-model-older expanded"/u);
  assert.match(open, /<span class="guild-sr-only">，已展开<\/span>/u);
  // Rows read their name, the expander its label; the Chinese descriptions repeat per family, so only those are compared.
  const names = [...open.matchAll(/<strong>([^<]+)<\/strong>|<span>(更早的模型（8）)<\/span>/gu)].map((match) => match[1] ?? match[2]);
  assert.deepEqual(names.slice(names.indexOf("Haiku 5.5")), [
    "Haiku 5.5", "更早的模型（8）",
    "Haiku 4.5", "Sonnet 5", "Opus 5", "Fable 5", "Opus 4.8", "Opus 4.7", "Opus 4.6", "Sonnet 4.6",
    "DeepSeek V4 Flash", "Local 27B",
  ]);
  // The expander is English-spoken too.
  assert.match(render({ messages: EN, initialOlderOpen: true }), /<span>Older models \(8\)<\/span><span class="guild-sr-only">, expanded<\/span>/u);
});

test("a selected older model is rendered with the row already open and holds the only tab stop", () => {
  const markup = render({ selection: selection("claude-opus-4-7", "high") });
  assert.match(markup, /class="guild-model-older expanded"/u);
  assert.equal(optionTags(markup).length, 5 + 1 + 8 + 2);
  const selected = optionTags(markup).filter((tag) => /aria-selected="true"/u.test(tag));
  assert.equal(selected.length, 1);
  assert.match(selected[0] ?? "", /tabindex="0"/u);
});

test("arrow keys reach the expander and every row after it; the component wires the toggle", async () => {
  const count = optionTags(render({ initialOlderOpen: true })).length;
  assert.equal(nextPickerIndex(4, count, "ArrowDown", "vertical"), 5, "from the last newest row to the expander");
  assert.equal(nextPickerIndex(5, count, "ArrowDown", "vertical"), 6, "from the expander into the old rows");
  assert.equal(nextPickerIndex(6, count, "ArrowUp", "vertical"), 5);
  assert.equal(nextPickerIndex(count - 1, count, "ArrowDown", "vertical"), 0, "and wraps");
  const source = await readFile(new URL("../src/ModelPicker.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{\(\) => setOlderOpen\(!group\.older\?\.expanded\)\}/u);
  assert.match(source, /moveFocus\(event, '\[role="option"\]', "vertical"\)/u);
});

// ---- a task that runs through the model router (D-061)

test("a routed task shows its Claude rows disabled under one line that says why; Online and Local stay choosable", () => {
  const view = claudeView({ routed: true, selection: selection("deepseek-v4-flash"), olderExpanded: true });
  const claude = groupOf(view, "claude");
  assert.equal(claude.note, "这个任务用过在线或本地模型，不能再切回 Claude 订阅。要用 Claude 请新建任务。");
  assert.equal(groupOf(claudeView({ routed: true, messages: EN, selection: selection("deepseek-v4-flash") }), "claude").note,
    "This task has used an online or local model and cannot go back to a Claude subscription. Start a new task to use Claude.");
  assert.equal([...claude.models, ...(claude.older?.models ?? [])].every((row) => row.disabled === true), true);
  assert.equal(groupOf(view, "online").note, undefined);
  assert.equal(groupOf(view, "online").models.every((row) => row.disabled === undefined), true);
  assert.equal(groupOf(view, "local").models.every((row) => row.disabled === undefined), true);
  assert.deepEqual(view.models.filter((row) => row.selected).map((row) => row.id), ["deepseek-v4-flash"]);
  assert.deepEqual(view.models.filter((row) => row.tabStop).map((row) => row.id), ["deepseek-v4-flash"]);
  assert.equal(view.routed, true);
  // The note is a routed-task fact: absent for a native task.
  assert.equal(groupOf(claudeView(), "claude").note, undefined);
  assert.equal(claudeView().models.some((row) => row.disabled === true), false);
});

test("a routed task never marks a Claude row selected, offers no way back to a default, and never starts on a Claude tab stop", () => {
  // The projection of a task routed by an earlier build may still name a Claude model.
  const stale = claudeView({ routed: true, selection: selection("opus", "high", "runtime") });
  assert.equal(stale.models.some((row) => row.selected), false);
  assert.equal(stale.models.find((row) => row.tabStop)?.id, "deepseek-v4-flash", "the first row that can be chosen");
  assert.equal(stale.showUseDefault, false);
  assert.equal(claudeView({ routed: true, selection: selection("deepseek-v4-flash") }).showUseDefault, false);
  assert.equal(claudeView({ selection: selection("opus") }).showUseDefault, true, "a native task still can");
  // No model at all: the trigger asks for one instead of naming Claude's default.
  const none = modelPickerView({
    messages: ZH, catalogs: CATALOGS, selection: selection(null, null, "runtime"), taskEngine: "claude", engineFixed: true, routed: true,
  });
  assert.equal(none.modelName, "选择模型");
  assert.equal(modelPickerView({ messages: EN, catalogs: CATALOGS, selection: selection(null, null, "runtime"), taskEngine: "claude", engineFixed: true, routed: true }).modelName, "Choose a model");
  // Routed means nothing for a Grok task.
  assert.equal(modelPickerView({ messages: ZH, catalogs: CATALOGS, selection: selection("grok-4.7"), taskEngine: "grok", engineFixed: true, routed: true }).routed, false);
});

test("a routed task's markup: aria-disabled Claude options, the note, locked class, and nothing to activate", async () => {
  const markup = render({ selection: selection("deepseek-v4-flash"), routed: true, initialOlderOpen: true });
  assert.match(markup, /<p class="guild-model-group-note">这个任务用过在线或本地模型，不能再切回 Claude 订阅。要用 Claude 请新建任务。<\/p>/u);
  const tags = optionTags(markup);
  const locked = tags.filter((tag) => /guild-model-row locked/u.test(tag));
  assert.equal(locked.length, 5 + 8);
  for (const tag of locked) {
    assert.match(tag, /aria-disabled="true"/u);
    assert.match(tag, /tabindex="-1"/u);
  }
  assert.equal(tags.filter((tag) => /tabindex="0"/u.test(tag)).length, 1);
  const online = tags.find((tag) => /aria-selected="true"/u.test(tag));
  assert.ok(online !== undefined && !/aria-disabled/u.test(online), "the chosen Online row is a normal row");
  // No "Use default" way out for a routed task.
  assert.doesNotMatch(markup, /guild-model-use-default/u);
  // A disabled row does nothing, and the first focus goes to a row that can be chosen.
  const source = await readFile(new URL("../src/ModelPicker.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(row\.disabled === true\) return;\s*\n\s*void apply\(/u);
  assert.match(source, /button\[role="option"\]:not\(\[aria-disabled="true"\]\)/u);
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const name of ["guild-model-row.locked", "guild-model-group-note", "guild-model-older", "guild-model-older-caret"]) {
    assert.match(css, new RegExp(`\\.${name.replace(".", "\\.")}[\\s,:{.\\[]`), `${name} is not styled`);
  }
});

test("the picker is told a task is routed only by the projection, and a Claude conversation asks before it is", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /routed=\{activeTask\?\.engineStatus\?\.routed === true\}/u);
  type NativeInput = NonNullable<Parameters<typeof taskHasNativeClaudeSession>[0]>;
  const view = (over: { engine?: "grok" | "claude"; turns?: number; engineStatus?: NativeInput["engineStatus"] } = {}): NativeInput => ({
    task: { taskId: "t", workspaceId: "w", title: "T", pinned: false, archived: false, updatedAtMs: 1, engine: over.engine ?? "claude" },
    timeline: Array.from({ length: over.turns ?? 1 }, () => ({ kind: "user" })),
    queuedTurns: [],
    hasEarlierTimeline: false,
    ...(over.engineStatus === undefined ? {} : { engineStatus: over.engineStatus }),
  }) as unknown as NativeInput;
  // A Claude task that has run, on the subscription: its first switch to Online / Local asks.
  assert.equal(taskHasNativeClaudeSession(view(), false), true);
  assert.equal(taskHasNativeClaudeSession(view({ engineStatus: { accountLabel: "Claude Max" } }), false), true);
  // A new Claude task with no turn yet chooses freely, until its first message is being sent.
  assert.equal(taskHasNativeClaudeSession(view({ turns: 0 }), false), false);
  assert.equal(taskHasNativeClaudeSession(view({ turns: 0 }), true), true, "a first message being sent counts");
  // Already routed, a Grok task, and no task: nothing to confirm.
  assert.equal(taskHasNativeClaudeSession(view({ engineStatus: { routed: true } }), false), false);
  assert.equal(taskHasNativeClaudeSession(view({ engine: "grok" }), false), false);
  assert.equal(taskHasNativeClaudeSession(undefined, false), false);
});
