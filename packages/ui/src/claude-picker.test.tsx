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

/*
 * The Claude group of the picker: the Default row and the newest model of each family up front, the rest under
 * "Older models (N)" (W2), and the "Restarts" tag on the rows that switch between a Claude model and an Online or
 * Local one (D-062).
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

// ---- switching between a Claude model and an Online / Local one (D-062)

const allRows = (view: ReturnType<typeof modelPickerView>) => view.groups.flatMap((entry) => [...entry.models, ...(entry.older?.models ?? [])]);
const tagged = (view: ReturnType<typeof modelPickerView>) => allRows(view).filter((row) => row.restarts === true).map((row) => row.id);

test("a native Claude task tags its Online and Local rows: choosing one restarts Claude Code", () => {
  const view = claudeView({ olderExpanded: true });
  assert.deepEqual(tagged(view), ["deepseek-v4-flash", "local-27b-model"]);
  assert.equal(groupOf(view, "claude").models.some((row) => row.restarts === true), false, "a Claude row of a Claude task does not");
  assert.equal(groupOf(view, "claude").older?.models.some((row) => row.restarts === true), false);
  // Every Claude row stays choosable: nothing is disabled or noted any more.
  assert.equal(allRows(view).some((row) => "disabled" in row), false);
  assert.equal(view.groups.some((entry) => "note" in entry), false);
});

test("a routed task tags every Claude row, the Default row and 'Use default', and no Online or Local row", () => {
  const view = claudeView({ selection: selection("deepseek-v4-flash"), olderExpanded: true });
  const claudeIds = [...groupOf(view, "claude").models, ...(groupOf(view, "claude").older?.models ?? [])].map((row) => row.id);
  assert.deepEqual(tagged(view), claudeIds);
  assert.equal(claudeIds.length, 5 + 8);
  assert.equal(groupOf(view, "online").models.some((row) => row.restarts === true), false, "the vendor the task runs on, even another model of it");
  assert.equal(groupOf(view, "local").models.some((row) => row.restarts === true), false, "Local to Online is a plain switch inside the router");
  assert.equal(view.showUseDefault, true, "a routed task can go back to Claude's default too");
  assert.equal(view.useDefaultRestarts, true);
  // The routed model is the selection and the one tab stop; Claude rows are ordinary rows again.
  assert.deepEqual(allRows(view).filter((row) => row.selected).map((row) => row.id), ["deepseek-v4-flash"]);
  assert.deepEqual(allRows(view).filter((row) => row.tabStop).map((row) => row.id), ["deepseek-v4-flash"]);
  // A local model is routed too.
  assert.deepEqual(tagged(claudeView({ selection: selection("local-27b-model") })).includes("opus"), true);
  assert.equal(claudeView({ selection: selection("opus") }).useDefaultRestarts, false);
});

test("the Default row and a task that follows a default count as Claude", () => {
  // Following the runtime default (nothing pinned): native, so only the routed rows restart.
  const following = claudeView({ selection: selection("default", null, "runtime") });
  assert.deepEqual(tagged(following), ["deepseek-v4-flash", "local-27b-model"]);
  // Before the adapter listed any model, the one Claude row is the follow-the-default row.
  const unlisted = modelPickerView({
    messages: ZH,
    catalogs: { grok: REAL_CATALOG, claude: freezeClaudeRoutedOnly() },
    selection: selection(null, null, "runtime"),
    taskEngine: "claude",
    engineFixed: true,
  });
  assert.deepEqual(allRows(unlisted).filter((row) => row.restarts === true).map((row) => row.id), ["deepseek-v4-flash", "local-27b-model"]);
  const routedUnlisted = modelPickerView({
    messages: ZH,
    catalogs: { grok: REAL_CATALOG, claude: freezeClaudeRoutedOnly() },
    selection: selection("deepseek-v4-flash"),
    taskEngine: "claude",
    engineFixed: true,
  });
  const defaultRow = allRows(routedUnlisted).find((row) => row.runtimeDefault === true);
  assert.equal(defaultRow?.restarts, true, "the follow-the-default row restarts a routed task");
});

function freezeClaudeRoutedOnly() {
  return { ...CLAUDE_ADAPTER_CATALOG, models: CLAUDE_ADAPTER_CATALOG.models.filter((model) => model.group !== "claude") };
}

test("no tag for a brand-new task with no turn, for a Grok task, or for a task that has no router", () => {
  // A new task starts in the right mode whatever it picks: engineFixed is false until its first message.
  const fresh = claudeView({ engineFixed: false, selection: selection(null, null, "runtime") });
  assert.deepEqual(tagged(fresh), []);
  assert.deepEqual(tagged(claudeView({ engineFixed: false, selection: selection("deepseek-v4-flash") })), []);
  assert.equal(claudeView({ engineFixed: false, selection: selection("deepseek-v4-flash") }).useDefaultRestarts, false);
  const grok = modelPickerView({ messages: ZH, catalogs: CATALOGS, selection: selection("grok-4.7"), taskEngine: "grok", engineFixed: true });
  assert.deepEqual(tagged(grok), []);
  assert.equal(grok.useDefaultRestarts, false);
  assert.equal(grok.switching, false);
  // A Claude task without Online or Local sources has nothing to tag.
  const nativeOnly = modelPickerView({
    messages: ZH,
    catalogs: { grok: REAL_CATALOG, claude: { ...CLAUDE_ADAPTER_CATALOG, models: CLAUDE_ADAPTER_CATALOG.models.filter((model) => model.group === "claude") } },
    selection: selection("opus"),
    taskEngine: "claude",
    engineFixed: true,
  });
  assert.deepEqual(tagged(nativeOnly), []);
});

test("the tag, its tooltip and its description are worded in both languages", () => {
  assert.equal(ZH.modelPickerRestartTag, "需重启");
  assert.equal(ZH.modelPickerRestartHint, "切换后要重启 Claude Code，再接上这段对话");
  assert.equal(EN.modelPickerRestartTag, "Restarts");
  assert.match(EN.modelPickerRestartHint, /restarts Claude Code/u);
  assert.equal(ZH.modelPickerSwitching, "切换中…");
  assert.equal(EN.modelPickerSwitching, "Switching\u2026");
  assert.equal(ZH.modelSwitchStatus("DeepSeek V4 Flash"), "正在切换到「DeepSeek V4 Flash」，需要重启引擎，通常 30–90 秒。消息会在切换完成后发出。");
  assert.match(EN.modelSwitchStatus("Opus 5.5"), /Opus 5\.5.*restart.*30\u201390 seconds.*once the switch is done/u);
});

test("the markup of a native task: tags aria-hidden on the Online and Local rows, the meaning in one shared description", () => {
  const markup = render();
  const tags = optionTags(markup).filter((tag) => /aria-describedby/u.test(tag));
  assert.equal(tags.length, 2, "the two routed rows");
  for (const tag of tags) {
    assert.match(tag, /title="切换后要重启 Claude Code，再接上这段对话"/u);
    assert.match(tag, /role="option"/u);
    assert.doesNotMatch(tag, /aria-disabled/u, "a tagged row is an ordinary, choosable option");
  }
  assert.equal(markup.match(/<em class="guild-model-restart-tag" aria-hidden="true">需重启<\/em>/gu)?.length, 2);
  const describedBy = /aria-describedby="([^"]+)"/u.exec(tags[0] ?? "")?.[1];
  assert.ok(describedBy !== undefined);
  assert.equal(tags.every((tag) => tag.includes(`aria-describedby="${describedBy}"`)), true);
  assert.match(markup, new RegExp(`<span id="${describedBy.replace(/[:]/gu, "\\:")}" class="guild-sr-only">切换后要重启 Claude Code，再接上这段对话</span>`, "u"));
  // The English wording.
  assert.equal(render({ messages: EN }).match(/<em class="guild-model-restart-tag" aria-hidden="true">Restarts<\/em>/gu)?.length, 2);
  // A task with no turn yet shows none of it.
  const fresh = render({ engineFixed: false, selection: selection(null, null, "runtime") });
  assert.doesNotMatch(fresh, /guild-model-restart-tag|aria-describedby|guild-sr-only">切换后/u);
});

test("the markup of a routed task: Claude rows tagged and choosable, one tab stop, 'Use default' tagged too", () => {
  const markup = render({ selection: selection("deepseek-v4-flash"), initialOlderOpen: true });
  const tags = optionTags(markup);
  const described = tags.filter((tag) => /aria-describedby/u.test(tag));
  assert.equal(described.length, 5 + 8, "the Claude rows, the expander excluded");
  assert.equal(tags.some((tag) => /guild-model-row locked|aria-disabled/u.test(tag)), false, "nothing is disabled");
  assert.equal(tags.filter((tag) => /tabindex="0"/u.test(tag)).length, 1);
  const selected = tags.filter((tag) => /aria-selected="true"/u.test(tag));
  assert.equal(selected.length, 1);
  assert.doesNotMatch(selected[0] ?? "", /aria-describedby/u, "the row it runs on has no tag");
  assert.doesNotMatch(markup, /guild-model-group-note/u);
  assert.match(markup, /<button type="button" class="guild-model-use-default"[^>]*aria-describedby="[^"]+"[^>]*title="切换后要重启 Claude Code，再接上这段对话">使用默认设置<em class="guild-model-restart-tag" aria-hidden="true">需重启<\/em><\/button>/u);
});

test("the trigger says Switching while a cross-mode switch of the task runs, and never otherwise", () => {
  const idle = claudeView();
  assert.equal(idle.switching, false);
  assert.equal(idle.triggerText, "Opus 5.5 · 高");
  const running = claudeView({ switching: true });
  assert.equal(running.switching, true);
  assert.equal(running.triggerText, "切换中…");
  assert.match(running.ariaLabel, /切换中…/u);
  assert.equal(claudeView({ switching: true, messages: EN }).triggerText, "Switching\u2026");
  const markup = render({ switching: true });
  assert.match(markup, /<span>切换中…<\/span><svg[^>]*class="guild-spin"/u);
  assert.doesNotMatch(render(), /guild-spin/u);
  // Only a Claude task switches modes.
  assert.equal(modelPickerView({ messages: ZH, catalogs: CATALOGS, selection: selection("grok-4.7"), taskEngine: "grok", engineFixed: true, switching: true }).switching, false);
});

test("the lock is gone: no routed prop, no disabled row, no note, no one-way notice in the app", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /engineStatus\?\.routed|routedModelName|taskHasNativeClaudeSession|routedNotice/u);
  assert.match(app, /switching=\{modelSwitchRunning\(modelSwitch, activeTask\?\.task\.taskId\)\}/u);
  const component = await readFile(new URL("../src/ModelPicker.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /routed|row\.disabled|guild-model-row locked/u);
  const messagesSource = await readFile(new URL("../src/locales.ts", import.meta.url), "utf8");
  assert.doesNotMatch(messagesSource, /claude_locked|ClaudeLockedNote|routedSwitch|modelPickerChooseModel/u);
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /guild-model-row\.locked|guild-model-group-note/u);
  for (const name of ["guild-model-restart-tag", "guild-composer-switch", "guild-model-older", "guild-model-older-caret"]) {
    assert.match(css, new RegExp(`\\.${name}[\\s,:{.\\[]`), `${name} is not styled`);
  }
});
