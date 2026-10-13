import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CLAUDE_MODEL_CATALOG,
  EMPTY_CODEX_MODEL_CATALOG,
  EMPTY_GEMINI_MODEL_CATALOG,
  defaultReasoningEffortOf,
  freezeGrokModelCatalog,
  freezeModelCatalog,
  grokModelById,
  modelSupportsReasoningEffort,
  resolveEffectiveSelection,
  type SetTaskRuntimeSettingsResponse,
  type TaskModelSelectionProjection,
  type TaskViewProjection,
} from "@guild/contracts";
import { messagesFor } from "./locales.js";
import { CLAUDE_CATALOG, GEMINI_CATALOG, REAL_CATALOG } from "./model-catalog.fixture.js";
import {
  CLEAR_MODEL_OVERRIDE,
  addonEngineOfGroup,
  catalogModelById,
  catalogOfEngine,
  engineOffersEffort,
  engineTakesApiKey,
  formatContextTokens,
  formatContextWindows,
  globalDefaultView,
  isSameSelection,
  modelDefaultEffort,
  modelOffersEffort,
  modelCatalogsOf,
  modelPickerView,
  nextPickerIndex,
  noticeForResponse,
  noticeText,
  pickerDisabledReason,
  pickerIsLocked,
  selectionAfterModelChange,
  selectionForRow,
  visibleModelGroups,
} from "./model-picker.js";

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

function selection(
  modelId: string | null,
  reasoningEffort: string | null,
  source: TaskModelSelectionProjection["source"] = "task",
  canChange = true,
): TaskModelSelectionProjection {
  return Object.freeze({ modelId, reasoningEffort, source, canChange });
}

test("the trigger reads the official model name and the effort label", () => {
  const fast = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection("grok-4.7-build-fast", "high"),
  });
  assert.equal(fast.modelName, "Grok 4.7 Fast");
  assert.equal(fast.triggerText, "Grok 4.7 Fast \u00b7 High");
  assert.equal(
    modelPickerView({ messages: ZH, catalog: REAL_CATALOG, selection: selection("grok-4.7", "xhigh") }).triggerText,
    "Grok 4.7 \u00b7 \u8d85\u9ad8",
  );
  assert.equal(
    modelPickerView({ messages: EN, catalog: REAL_CATALOG, selection: selection("grok-4.7", "xhigh") }).triggerText,
    "Grok 4.7 \u00b7 Extra high",
  );
});

test("an effort Guild has no translation for shows the runtime's label, then its id", () => {
  const catalog = freezeGrokModelCatalog({
    models: [{
      id: "grok-9",
      name: "Grok 9",
      reasoningEfforts: [{ id: "max", label: "Maximum", isDefault: true }],
      contextWindows: [],
    }],
  });
  assert.equal(
    modelPickerView({ messages: EN, catalog, selection: selection("grok-9", "max") }).effortLabel,
    "Max",
  );
  assert.equal(EN.reasoningEffortName("turbo"), "turbo");
  assert.equal(EN.reasoningEffortName("turbo", "Turbo mode"), "Turbo mode");
  assert.equal(ZH.reasoningEffortName("low", "Low"), "\u4f4e");
});

test("an unpinned effort shows the model's own default, a missing model shows the localized default name", () => {
  const unpinned = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection("grok-4.6", null, "global"),
  });
  assert.equal(unpinned.selectedEffortId, "high");
  assert.equal(unpinned.triggerText, "Grok 4.6 \u00b7 High");
  const noModel = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection(null, null, "runtime"),
  });
  assert.equal(noModel.triggerText, "Default model");
  assert.equal(
    modelPickerView({ messages: ZH, catalog: REAL_CATALOG, selection: selection(null, null, "runtime") }).triggerText,
    "\u9ed8\u8ba4\u6a21\u578b",
  );
});

test("an id the catalog lacks falls back to the raw id and selects no row", () => {
  const view = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection("grok-3-legacy", "ultra"),
  });
  assert.equal(view.triggerText, "grok-3-legacy \u00b7 ultra");
  assert.equal(view.models.some((row) => row.selected), false);
  assert.equal(view.models[0]?.tabStop, true);
  assert.equal(view.efforts.length, 0);
});

test("an empty catalog shows only the default label and no rows", () => {
  const view = modelPickerView({
    messages: EN,
    catalog: { models: [] },
    selection: selection(null, null, "runtime"),
  });
  assert.equal(view.catalogEmpty, true);
  assert.equal(view.triggerText, "Default model");
  assert.equal(view.models.length, 0);
  assert.equal(view.efforts.length, 0);
});

test("rows carry the official description and the context windows", () => {
  const view = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection("grok-4.7-build-fast", "high"),
  });
  const fast = view.models.find((row) => row.id === "grok-4.7-build-fast")!;
  assert.equal(fast.description, "Fast variant. 2x the price.");
  assert.equal(fast.contextLabel, "256K / 500K context");
  assert.equal(fast.selected, true);
  assert.equal(view.models.find((row) => row.id === "grok-4.6")!.description, undefined);
  assert.equal(
    modelPickerView({ messages: ZH, catalog: REAL_CATALOG, selection: selection("grok-4.6", "high") })
      .models.find((row) => row.id === "grok-4.6")!.contextLabel,
    "256K \u4e0a\u4e0b\u6587",
  );
  assert.deepEqual(view.models.filter((row) => row.tabStop).map((row) => row.id), ["grok-4.7-build-fast"]);
});

test("effort choices come from the selected model, with the model's default marked", () => {
  const four = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection("grok-4.7", "xhigh"),
  });
  assert.deepEqual(four.efforts.map((effort) => effort.id), ["xhigh", "high", "medium", "low"]);
  assert.deepEqual(four.efforts.filter((effort) => effort.isDefault).map((effort) => effort.id), ["high"]);
  assert.equal(four.efforts.find((effort) => effort.selected)!.id, "xhigh");
  assert.equal(four.efforts.find((effort) => effort.id === "xhigh")!.description, "Maximum reasoning for the hardest tasks.");
  const three = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection("grok-4.5", "high"),
  });
  assert.deepEqual(three.efforts.map((effort) => effort.id), ["high", "medium", "low"]);
});

test("choosing a model keeps the effort it offers, else takes the new model's default", () => {
  assert.deepEqual(selectionAfterModelChange(REAL_CATALOG, "grok-4.6", "medium"), {
    model: "grok-4.6",
    reasoningEffort: "medium",
  });
  assert.deepEqual(selectionAfterModelChange(REAL_CATALOG, "grok-4.6", "xhigh"), {
    model: "grok-4.6",
    reasoningEffort: "xhigh",
  });
  // grok-4.5 has no xhigh, so it falls back to its own default.
  assert.deepEqual(selectionAfterModelChange(REAL_CATALOG, "grok-4.5", "xhigh"), {
    model: "grok-4.5",
    reasoningEffort: "high",
  });
  assert.deepEqual(selectionAfterModelChange(REAL_CATALOG, "grok-4.7", null), {
    model: "grok-4.7",
    reasoningEffort: "high",
  });
  const noEfforts = freezeGrokModelCatalog({
    models: [{ id: "grok-plain", name: "Grok Plain", reasoningEfforts: [], contextWindows: [] }],
  });
  assert.deepEqual(selectionAfterModelChange(noEfforts, "grok-plain", "high"), {
    model: "grok-plain",
    reasoningEffort: null,
  });
  assert.deepEqual(selectionAfterModelChange(REAL_CATALOG, "grok-unlisted", "high"), {
    model: "grok-unlisted",
    reasoningEffort: null,
  });
});

test("the effort rule and the catalog lookups agree with the contract helpers", () => {
  for (const model of REAL_CATALOG.models) {
    const contractModel = grokModelById(REAL_CATALOG, model.id);
    assert.equal(catalogModelById(REAL_CATALOG, model.id), contractModel);
    assert.equal(modelDefaultEffort(model), defaultReasoningEffortOf(model) ?? null);
    for (const current of ["xhigh", "high", "medium", "low", "bogus", null]) {
      assert.equal(modelOffersEffort(model, current), modelSupportsReasoningEffort(model, current));
      assert.equal(
        selectionAfterModelChange(REAL_CATALOG, model.id, current).reasoningEffort,
        resolveEffectiveSelection({
          global: { modelId: model.id, reasoningEffort: current },
          catalog: REAL_CATALOG,
        }).reasoningEffort,
        `${model.id} from ${String(current)}`,
      );
    }
  }
});

test("only a task override offers Use default, and no-ops are not sent", () => {
  const pinned = selection("grok-4.7", "high", "task");
  const inherited = selection("grok-4.7", "high", "global");
  assert.equal(modelPickerView({ messages: EN, catalog: REAL_CATALOG, selection: pinned }).showUseDefault, true);
  assert.equal(modelPickerView({ messages: EN, catalog: REAL_CATALOG, selection: inherited }).showUseDefault, false);
  assert.equal(
    modelPickerView({ messages: EN, catalog: REAL_CATALOG, selection: selection("grok-4.7", "high", "runtime") }).showUseDefault,
    false,
  );
  assert.equal(isSameSelection(pinned, { model: "grok-4.7", reasoningEffort: "high" }), true);
  assert.equal(isSameSelection(pinned, { model: "grok-4.7", reasoningEffort: "low" }), false);
  assert.equal(isSameSelection(pinned, CLEAR_MODEL_OVERRIDE), false);
  // Choosing what is merely inherited pins it to the task; clearing nothing is a no-op.
  assert.equal(isSameSelection(inherited, { model: "grok-4.7", reasoningEffort: "high" }), false);
  assert.equal(isSameSelection(inherited, CLEAR_MODEL_OVERRIDE), true);
  // A change that also moves the task to the other engine is never a no-op, even for "no model, nothing pinned".
  assert.equal(isSameSelection(inherited, { ...CLEAR_MODEL_OVERRIDE, group: "claude", engine: "claude" }), false);
  assert.equal(isSameSelection(pinned, { model: "grok-4.7", reasoningEffort: "high", engine: "claude" }), false);
});

test("the picker is disabled with a stated reason while a turn runs, without a task, or in flight", () => {
  assert.equal(pickerDisabledReason({ selection: undefined, pending: false }), "no_task");
  assert.equal(pickerDisabledReason({ selection: selection("grok-4.7", "high", "task", false), pending: false }), "running");
  assert.equal(pickerDisabledReason({ selection: selection("grok-4.7", "high"), pending: true }), "pending");
  assert.equal(pickerDisabledReason({ selection: selection("grok-4.7", "high"), pending: false }), undefined);
  assert.equal(pickerIsLocked("no_task"), true);
  assert.equal(pickerIsLocked("running"), true);
  assert.equal(pickerIsLocked("pending"), false);
  assert.equal(pickerIsLocked(undefined), false);

  const running = modelPickerView({
    messages: EN,
    catalog: REAL_CATALOG,
    selection: selection("grok-4.7", "high", "task", false),
  });
  assert.equal(running.disabledReason, "running");
  assert.equal(running.triggerText, "Grok 4.7 \u00b7 High");
  assert.match(running.title, /after the current turn finishes/u);
  assert.match(running.ariaLabel, /after the current turn finishes/u);
  const noTask = modelPickerView({ messages: ZH, catalog: REAL_CATALOG, selection: undefined });
  assert.equal(noTask.disabledReason, "no_task");
  assert.equal(noTask.title.includes(ZH.modelPickerDisabledNoTask), true);
});

test("the title and label state the scope and source of the choice", () => {
  const task = modelPickerView({ messages: EN, catalog: REAL_CATALOG, selection: selection("grok-4.7", "high", "task") });
  assert.equal(task.title, "Set for this conversation");
  assert.equal(task.ariaLabel, "Model and reasoning effort: Grok 4.7 \u00b7 High. Set for this conversation.");
  assert.equal(
    modelPickerView({ messages: EN, catalog: REAL_CATALOG, selection: selection("grok-4.7", "high", "global") }).title,
    "Using your default setting",
  );
  assert.equal(
    modelPickerView({ messages: EN, catalog: REAL_CATALOG, selection: selection("grok-4.7", "high", "runtime") }).title,
    "Using Grok's default",
  );
});

test("context windows format compactly", () => {
  assert.equal(formatContextTokens(256000), "256K");
  assert.equal(formatContextTokens(500000), "500K");
  assert.equal(formatContextTokens(131072), "131K");
  assert.equal(formatContextTokens(1_000_000), "1M");
  assert.equal(formatContextTokens(1_048_576), "1M");
  assert.equal(formatContextTokens(1_500_000), "1.5M");
  assert.equal(formatContextTokens(800), "800");
  assert.equal(formatContextWindows([256000, 500000]), "256K / 500K");
  assert.equal(formatContextWindows([]), undefined);
});

test("arrow keys wrap around like the slash menu and ignore other keys", () => {
  assert.equal(nextPickerIndex(0, 4, "ArrowDown", "vertical"), 1);
  assert.equal(nextPickerIndex(3, 4, "ArrowDown", "vertical"), 0);
  assert.equal(nextPickerIndex(0, 4, "ArrowUp", "vertical"), 3);
  assert.equal(nextPickerIndex(-1, 4, "ArrowDown", "vertical"), 0);
  assert.equal(nextPickerIndex(-1, 4, "ArrowUp", "vertical"), 3);
  assert.equal(nextPickerIndex(1, 4, "Home", "vertical"), 0);
  assert.equal(nextPickerIndex(1, 4, "End", "vertical"), 3);
  assert.equal(nextPickerIndex(1, 4, "ArrowRight", "vertical"), undefined);
  assert.equal(nextPickerIndex(1, 4, "ArrowDown", "horizontal"), undefined);
  assert.equal(nextPickerIndex(1, 4, "ArrowRight", "horizontal"), 2);
  assert.equal(nextPickerIndex(1, 4, "ArrowDown", "both"), 2);
  assert.equal(nextPickerIndex(1, 4, "ArrowLeft", "both"), 0);
  assert.equal(nextPickerIndex(0, 4, "Enter", "both"), undefined);
  assert.equal(nextPickerIndex(0, 0, "ArrowDown", "both"), undefined);
});

test("responses map to inline notices, one per refusal reason", () => {
  const task = {} as TaskViewProjection;
  const applied: SetTaskRuntimeSettingsResponse = { status: "applied", task };
  const saved: SetTaskRuntimeSettingsResponse = { status: "saved", task };
  assert.equal(noticeForResponse(applied), undefined);
  assert.deepEqual(noticeForResponse(saved), { kind: "saved" });
  assert.equal(noticeText(EN, { kind: "saved" }), "Applies when the session opens.");
  assert.equal(noticeText(EN, { kind: "failed" }), EN.operationFailed);
  for (const reason of ["incompatible_agent", "unsupported_value", "unavailable"] as const) {
    const notice = noticeForResponse({ status: "refused", reason, task });
    assert.deepEqual(notice, { kind: "refused", reason });
    for (const messages of [EN, ZH]) {
      assert.match(noticeText(messages, notice!), /\S/u);
    }
    assert.match(noticeText(EN, notice!), /previous selection was kept/u);
  }
  assert.equal(
    noticeText(EN, { kind: "refused", reason: "incompatible_agent" }),
    "This model cannot be used in this conversation after it has started. Your previous selection was kept.",
  );
  assert.equal(
    noticeText(EN, { kind: "refused", reason: "unsupported_value" }),
    "Grok does not offer that option for this task right now. Your previous selection was kept.",
  );
  assert.equal(
    noticeText(EN, { kind: "refused", reason: "unavailable" }),
    "Grok could not switch right now. Your previous selection was kept.",
  );
});

test("the Settings default control maps null to the runtime default and lists the chosen model's efforts", () => {
  const runtimeDefault = globalDefaultView({ catalog: REAL_CATALOG, model: null, reasoningEffort: null });
  assert.equal(runtimeDefault.descriptor, undefined);
  assert.equal(runtimeDefault.unlistedModelId, undefined);
  assert.equal(runtimeDefault.efforts.length, 0);
  assert.equal(runtimeDefault.effortId, null);
  const chosen = globalDefaultView({ catalog: REAL_CATALOG, model: "grok-4.5", reasoningEffort: null });
  assert.deepEqual(chosen.efforts.map((effort) => effort.id), ["high", "medium", "low"]);
  assert.equal(chosen.effortId, "high");
  assert.equal(globalDefaultView({ catalog: REAL_CATALOG, model: "grok-4.7", reasoningEffort: "xhigh" }).effortId, "xhigh");
  const unlisted = globalDefaultView({ catalog: { models: [] }, model: "grok-4.6", reasoningEffort: "high" });
  assert.equal(unlisted.unlistedModelId, "grok-4.6");
  assert.equal(unlisted.efforts.length, 0);
});

// ---- Guild 3.0 grouped picker (PC-MODEL-001)

const CATALOGS = Object.freeze({ grok: REAL_CATALOG, claude: CLAUDE_CATALOG });
const groupView = (view: ReturnType<typeof modelPickerView>, group: string) =>
  view.groups.find((entry) => entry.group === group)!;

test("a task with a Run lists only its engine's groups, a task without one lists all six in order", () => {
  assert.deepEqual(visibleModelGroups("grok", true), ["grok"]);
  assert.deepEqual(visibleModelGroups("claude", true), ["claude", "online", "local"]);
  assert.deepEqual(visibleModelGroups("codex", true), ["codex"]);
  assert.deepEqual(visibleModelGroups("gemini", true), ["gemini"]);
  for (const engine of ["grok", "claude", "codex", "gemini"] as const) {
    assert.deepEqual(visibleModelGroups(engine, false), ["grok", "claude", "codex", "gemini", "online", "local"], engine);
  }
  const fixed = modelPickerView({
    messages: EN, catalogs: CATALOGS, selection: selection("opus", "high"), taskEngine: "claude", engineFixed: true,
  });
  assert.deepEqual(fixed.groups.map((entry) => entry.group), ["claude", "online", "local"]);
  assert.equal(fixed.showGroupHeadings, true);
  assert.equal(fixed.engineNote, undefined);
  const fresh = modelPickerView({
    messages: EN, catalogs: CATALOGS, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok", engineFixed: false,
  });
  assert.deepEqual(fresh.groups.map((entry) => entry.label), ["Grok", "Claude", "ChatGPT", "Gemini (API, pay-as-you-go)", "Online", "Local"]);
  assert.equal(fresh.engineNote, EN.modelPickerEngineNote);
  // A Grok task that already ran keeps the old single, heading-less list.
  const grokFixed = modelPickerView({ messages: EN, catalogs: CATALOGS, selection: selection("grok-4.7", "high"), taskEngine: "grok", engineFixed: true });
  assert.equal(grokFixed.showGroupHeadings, false);
  assert.equal(grokFixed.groups.length, 1);
});

test("group headings are localized: Grok, Claude (subscription), ChatGPT (subscription), Gemini (API, pay-as-you-go), Online, Local", () => {
  const zh = modelPickerView({
    messages: ZH, catalogs: CATALOGS, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok", engineFixed: false,
  });
  assert.deepEqual(zh.groups.map((entry) => entry.label), ["Grok", "Claude\uff08\u8ba2\u9605\uff09", "ChatGPT\uff08\u8ba2\u9605\uff09", "Gemini\uff08API \u6309\u91cf\uff09", "\u5728\u7ebf", "\u672c\u5730"]);
});

test("rows go to the group their catalog entry names and only the task's own engine marks a selection", () => {
  const view = modelPickerView({
    messages: EN, catalogs: CATALOGS, selection: selection("deepseek-v4-flash", null), taskEngine: "claude", engineFixed: true,
  });
  assert.deepEqual(groupView(view, "claude").models.map((row) => row.id), ["default", "opus", "haiku"]);
  assert.deepEqual(groupView(view, "online").models.map((row) => row.id), ["deepseek-v4-flash", "deepseek-v4-reasoner"]);
  assert.deepEqual(groupView(view, "local").models.map((row) => row.id), ["local-27b-model"]);
  assert.deepEqual(view.models.filter((row) => row.selected).map((row) => row.id), ["deepseek-v4-flash"]);
  assert.deepEqual(view.models.filter((row) => row.tabStop).map((row) => row.id), ["deepseek-v4-flash"]);
  assert.equal(view.models.every((row) => row.engine === "claude"), true);
  assert.equal(view.triggerText, "DeepSeek V4 Flash");
  // Without a selection the first row of the first group is the one tab stop.
  const none = modelPickerView({
    messages: EN, catalogs: CATALOGS, selection: selection(null, null, "runtime"), taskEngine: "grok", engineFixed: false,
  });
  assert.deepEqual(none.models.filter((row) => row.tabStop).map((row) => row.id), ["grok-4.7"]);
  assert.equal(none.models.some((row) => row.selected), false);
  assert.equal(groupView(none, "grok").models.every((row) => row.engine === "grok" && row.group === "grok"), true);
});

test("an empty Online or Local group says so and points at Model sources", () => {
  const catalogs = { grok: REAL_CATALOG, claude: freezeClaude([{ id: "opus", name: "Opus", group: "claude" }]) };
  const view = modelPickerView({
    messages: EN, catalogs, selection: selection("opus", "high"), taskEngine: "claude", engineFixed: true, claudeState: "ready",
  });
  const online = groupView(view, "online");
  assert.equal(online.models.length, 0);
  assert.equal(online.empty?.kind, "no_sources");
  assert.equal(online.empty?.action, "open_model_sources");
  assert.equal(online.empty?.text, "No online models \u2014 add one in Settings \u203a Model sources");
  assert.equal(groupView(view, "local").empty?.text, "No local models \u2014 add one in Settings \u203a Model sources");
  assert.equal(groupView(view, "claude").empty, undefined);
  assert.equal(view.catalogEmpty, false);
});

test("the Claude group is unavailable when the status says so, or the Claude catalog is empty without a status", () => {
  const input = { messages: EN, selection: selection(null, null, "runtime"), taskEngine: "claude" as const, engineFixed: true };
  const emptyClaude = { grok: REAL_CATALOG, claude: EMPTY_CLAUDE_MODEL_CATALOG };
  const noStatus = modelPickerView({ ...input, catalogs: emptyClaude });
  assert.equal(groupView(noStatus, "claude").empty?.kind, "claude_unavailable");
  assert.equal(groupView(noStatus, "claude").empty?.text, "Claude Code not found or not logged in");
  assert.match(groupView(noStatus, "claude").empty?.help ?? "", /run `claude` once in Terminal/u);
  // A status wins over the catalog: ready but nothing reported yet is just "not started".
  const ready = modelPickerView({ ...input, catalogs: emptyClaude, claudeState: "ready" });
  assert.equal(groupView(ready, "claude").empty?.kind, "not_started");
  assert.equal(groupView(ready, "claude").empty?.text, EN.modelPickerClaudeNotStarted);
  for (const claudeState of ["not_found", "not_logged_in"] as const) {
    const view = modelPickerView({ ...input, catalogs: CATALOGS, claudeState });
    assert.equal(groupView(view, "claude").models.length, 3, "the models stay listed; only an empty group explains itself");
    const empty = modelPickerView({ ...input, catalogs: emptyClaude, claudeState });
    assert.equal(groupView(empty, "claude").empty?.text, "Claude Code not found or not logged in");
  }
  // Installed but unusable (for example an unsupported adapter) is not "not found".
  const unusable = modelPickerView({ ...input, catalogs: emptyClaude, claudeState: "unavailable" });
  assert.equal(groupView(unusable, "claude").empty?.text, EN.claudeStatusUnavailable);
  assert.equal(groupView(unusable, "claude").empty?.help, undefined);
  // Changed engine files are named as such, with what to do about it.
  const refused = modelPickerView({ ...input, catalogs: emptyClaude, claudeState: "integrity_changed" });
  assert.equal(groupView(refused, "claude").empty?.kind, "claude_unavailable");
  assert.equal(groupView(refused, "claude").empty?.text, EN.claudeStatusIntegrityChanged);
  assert.match(groupView(refused, "claude").empty?.text ?? "", /restart Guild to accept updated engine files/u);
});

test("an empty Claude catalog offers Claude Code (default model), so a Claude task can still start (PC-ENG-001)", () => {
  const emptyClaude = { grok: REAL_CATALOG, claude: EMPTY_CLAUDE_MODEL_CATALOG };
  const fresh = { messages: EN, catalogs: emptyClaude, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok" as const, engineFixed: false };
  // Unknown, ready or not logged in: Claude can start, so the row is offered.
  for (const claudeState of [undefined, "ready", "not_logged_in"] as const) {
    const view = modelPickerView({ ...fresh, ...(claudeState === undefined ? {} : { claudeState }) });
    const claude = groupView(view, "claude");
    assert.deepEqual(
      claude.models.map((row) => [row.id, row.name, row.group, row.engine, row.runtimeDefault, row.selected]),
      [["", "Claude Code (default model)", "claude", "claude", true, false]],
      String(claudeState),
    );
    // The hint about the missing list stays under the row, and the row is part of the keyboard walk.
    assert.ok(claude.empty !== undefined, String(claudeState));
    assert.equal(view.models.some((row) => row.runtimeDefault === true), true);
    assert.equal(view.catalogEmpty, false);
  }
  // Missing, unavailable or changed engine files: Guild would refuse to start, so the row is withheld
  // (picking it would bind the task to an engine that cannot run).
  for (const claudeState of ["not_found", "unavailable", "integrity_changed"] as const) {
    assert.equal(groupView(modelPickerView({ ...fresh, claudeState }), "claude").models.length, 0, claudeState);
  }
  assert.equal(groupView(modelPickerView({ ...fresh, claudeState: "not_found" }), "claude").empty?.kind, "claude_unavailable");
  // Only models of Claude's own count: Online and Local models alone do not make the list.
  const routedOnly = { grok: REAL_CATALOG, claude: freezeClaude([{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", group: "online" }]) };
  const onlyRouted = modelPickerView({ ...fresh, catalogs: routedOnly, claudeState: "ready" });
  assert.deepEqual(groupView(onlyRouted, "claude").models.map((row) => row.name), ["Claude Code (default model)"]);
  assert.deepEqual(groupView(onlyRouted, "online").models.map((row) => row.id), ["deepseek-v4-flash"]);
  // Once Claude lists its own models there is nothing to stand in for them.
  for (const claudeState of [undefined, "ready"] as const) {
    const listed = modelPickerView({ ...fresh, catalogs: CATALOGS, ...(claudeState === undefined ? {} : { claudeState }) });
    assert.equal(groupView(listed, "claude").models.some((row) => row.runtimeDefault === true), false);
    assert.equal(groupView(listed, "claude").empty, undefined);
  }
  // A task bound to Grok never sees the Claude group, so it never sees the row.
  assert.equal(
    modelPickerView({ ...fresh, engineFixed: true }).models.some((row) => row.runtimeDefault === true),
    false,
  );
  assert.equal(modelPickerView({ ...fresh, messages: ZH }).models.find((row) => row.runtimeDefault)?.name, "Claude Code\uff08\u9ed8\u8ba4\u6a21\u578b\uff09");
});

test("the Claude default row is selected while a Claude task follows a default, and picking it clears the override and moves the task if needed", () => {
  const emptyClaude = { grok: REAL_CATALOG, claude: EMPTY_CLAUDE_MODEL_CATALOG };
  const view = (taskSelection: TaskModelSelectionProjection, taskEngine: "grok" | "claude", engineFixed: boolean) =>
    modelPickerView({ messages: EN, catalogs: emptyClaude, selection: taskSelection, taskEngine, engineFixed, claudeState: "ready" });
  const following = view(selection(null, null, "runtime"), "claude", true);
  const row = following.models.find((candidate) => candidate.runtimeDefault)!;
  assert.deepEqual(following.models.filter((candidate) => candidate.selected).map((candidate) => candidate.name), ["Claude Code (default model)"]);
  assert.equal(row.tabStop, true);
  // Already on Claude with nothing pinned: the row changes nothing, so it is not sent.
  const same = selectionForRow(emptyClaude, row, null, "claude");
  assert.deepEqual(same, { model: null, reasoningEffort: null, group: "claude" });
  assert.equal(isSameSelection(selection(null, null, "runtime"), same), true);
  // A pinned model (for example a routed one) is cleared back to Claude's default by picking it.
  const pinned = view(selection("deepseek-v4-flash", null, "task"), "claude", true);
  assert.equal(pinned.models.find((candidate) => candidate.runtimeDefault)!.selected, false);
  assert.equal(isSameSelection(selection("deepseek-v4-flash", null, "task"), same), false);
  // On a Grok task that has not run, picking it moves the task to Claude, whatever the Grok selection says.
  const fromGrok = view(selection("grok-4.7", "high", "runtime"), "grok", false);
  const grokRow = fromGrok.models.find((candidate) => candidate.runtimeDefault)!;
  assert.equal(grokRow.selected, false);
  const move = selectionForRow(emptyClaude, grokRow, fromGrok.selectedEffortId, "grok");
  assert.deepEqual(move, { model: null, reasoningEffort: null, group: "claude", engine: "claude" });
  assert.equal(isSameSelection(selection("grok-4.7", "high", "runtime"), move), false);
  assert.equal(isSameSelection(selection(null, null, "runtime"), move), false);
});

test("the Grok group of a not-yet-started runtime keeps its own hint, whatever engine the task sits on", () => {
  const view = modelPickerView({
    messages: messagesFor("en-US", "claude"),
    catalogs: { grok: { models: [] }, claude: CLAUDE_CATALOG },
    selection: selection("opus", "high"),
    taskEngine: "claude",
    engineFixed: false,
  });
  assert.equal(groupView(view, "grok").empty?.text, "Model choices appear once Grok has started.");
});

test("effort control follows the selected model; Online and Local models hide it unless they list efforts", () => {
  const base = { messages: EN, catalogs: CATALOGS, taskEngine: "claude" as const, engineFixed: true };
  const opus = modelPickerView({ ...base, selection: selection("opus", "high") });
  assert.deepEqual(opus.efforts.map((effort) => effort.id), ["default", "max", "xhigh", "high", "medium", "low"], "strongest first, like Grok");
  assert.equal(opus.showEfforts, true);
  assert.equal(opus.triggerText, "Opus \u00b7 High");
  // A Claude model without efforts keeps today's explanatory hint.
  const haiku = modelPickerView({ ...base, selection: selection("haiku", null) });
  assert.equal(haiku.efforts.length, 0);
  assert.equal(haiku.showEfforts, true);
  const flash = modelPickerView({ ...base, selection: selection("deepseek-v4-flash", null) });
  assert.equal(flash.showEfforts, false);
  assert.equal(modelPickerView({ ...base, selection: selection("local-27b-model", null) }).showEfforts, false);
  const reasoner = modelPickerView({ ...base, selection: selection("deepseek-v4-reasoner", null) });
  assert.equal(reasoner.showEfforts, true);
  assert.deepEqual(reasoner.efforts.map((effort) => effort.id), ["max", "high"]);
  assert.equal(reasoner.selectedEffortId, "high");
});

test("picking a row carries its group, moves the task only when the engine differs, and uses its own catalog's effort rules", () => {
  const claudeRow = modelPickerView({
    messages: EN, catalogs: CATALOGS, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok", engineFixed: false,
  }).models.find((row) => row.id === "opus")!;
  assert.deepEqual(selectionForRow(CATALOGS, claudeRow, "high", "grok"), {
    model: "opus", reasoningEffort: "high", group: "claude", engine: "claude",
  });
  // Same engine: no move. An effort the model lacks falls back to the model's own default.
  assert.deepEqual(selectionForRow(CATALOGS, claudeRow, "high", "claude"), {
    model: "opus", reasoningEffort: "high", group: "claude",
  });
  const onlineRow = { id: "deepseek-v4-flash", group: "online", engine: "claude" } as const;
  assert.deepEqual(selectionForRow(CATALOGS, onlineRow, "high", "claude"), {
    model: "deepseek-v4-flash", reasoningEffort: null, group: "online",
  });
  const grokRow = { id: "grok-4.5", group: "grok", engine: "grok" } as const;
  assert.deepEqual(selectionForRow(CATALOGS, grokRow, "xhigh", "claude"), {
    model: "grok-4.5", reasoningEffort: "high", group: "grok", engine: "grok",
  });
});

test("the catalogs come from modelCatalogs, falling back to the single Grok catalog", () => {
  const legacy = modelCatalogsOf({ modelCatalog: REAL_CATALOG });
  assert.equal(legacy.grok, REAL_CATALOG);
  assert.equal(legacy.claude, EMPTY_CLAUDE_MODEL_CATALOG);
  assert.equal(legacy.codex, EMPTY_CODEX_MODEL_CATALOG);
  assert.equal(legacy.gemini, EMPTY_GEMINI_MODEL_CATALOG);
  const both = modelCatalogsOf({
    modelCatalog: { models: [] },
    modelCatalogs: { grok: REAL_CATALOG, claude: CLAUDE_CATALOG, codex: EMPTY_CODEX_MODEL_CATALOG, gemini: GEMINI_CATALOG },
  });
  assert.equal(both.grok, REAL_CATALOG);
  assert.equal(both.claude, CLAUDE_CATALOG);
  assert.equal(both.codex, EMPTY_CODEX_MODEL_CATALOG);
  assert.equal(both.gemini, GEMINI_CATALOG);
});

test("a cancelled switch needs no notice", () => {
  assert.equal(noticeForResponse(undefined), undefined);
});

function freezeClaude(models: readonly { id: string; name: string; group: "claude" | "online" | "local" }[]) {
  return freezeModelCatalog("claude", {
    models: models.map((model) => ({ ...model, reasoningEfforts: [], contextWindows: [] })),
  });
}

// ---- Guild 3.1 ChatGPT (Codex) group (PC-ENG-003, PC-MODEL-001)

function freezeCodex(models: readonly { id: string; name: string; efforts?: readonly [string, boolean][]; description?: string }[]) {
  return freezeModelCatalog("codex", {
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      group: "codex",
      ...(model.description === undefined ? {} : { description: model.description }),
      reasoningEfforts: (model.efforts ?? []).map(([id, isDefault]) => ({ id, label: id, isDefault })),
      contextWindows: [],
    })),
  });
}

const CODEX_CATALOG = freezeCodex([
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", description: "Frontier coding model.", efforts: [["low", false], ["medium", true], ["high", false], ["ultra", false]] },
  { id: "gpt-6.1-luna", name: "GPT-6.1 Luna", efforts: [["low", false], ["medium", true]] },
]);

test("the ChatGPT group lists Codex's own models by id, with its own description and efforts strongest first", () => {
  const catalogs = { grok: REAL_CATALOG, claude: CLAUDE_CATALOG, codex: CODEX_CATALOG };
  const view = modelPickerView({
    messages: EN, catalogs, selection: selection("gpt-6.1-sol", "medium"), taskEngine: "codex", engineFixed: true, codexState: "ready",
  });
  assert.deepEqual(view.groups.map((entry) => entry.group), ["codex"]);
  // One group left: the list reads like a Grok task that already ran, without a heading.
  assert.equal(view.showGroupHeadings, false);
  assert.deepEqual(groupView(view, "codex").models.map((row) => [row.id, row.name, row.engine, row.group]), [
    ["gpt-6.1-sol", "GPT-6.1 Sol", "codex", "codex"],
    ["gpt-6.1-luna", "GPT-6.1 Luna", "codex", "codex"],
  ]);
  // Codex words its own models; Guild has no table of them to translate from.
  assert.equal(groupView(view, "codex").models[0]!.description, "Frontier coding model.");
  assert.deepEqual(view.models.filter((row) => row.selected).map((row) => row.id), ["gpt-6.1-sol"]);
  assert.equal(view.triggerText, "GPT-6.1 Sol \u00b7 Medium");
  // Strongest first, with ultra above high; the model's own default stays marked.
  assert.deepEqual(view.efforts.map((effort) => effort.id), ["ultra", "high", "medium", "low"]);
  assert.equal(view.efforts.find((effort) => effort.id === "medium")!.isDefault, true);
  // No default row once the models are known.
  assert.equal(view.models.some((row) => row.runtimeDefault === true), false);
  assert.equal(groupView(view, "codex").empty, undefined);
});

test("before Codex has reported models its group offers one 'Codex (default model)' row and the hint", () => {
  const catalogs = { grok: REAL_CATALOG, claude: CLAUDE_CATALOG, codex: EMPTY_CODEX_MODEL_CATALOG };
  const fresh = { messages: EN, catalogs, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok" as const, engineFixed: false };
  for (const codexState of [undefined, "ready", "not_logged_in"] as const) {
    const view = modelPickerView({ ...fresh, ...(codexState === undefined ? {} : { codexState }) });
    const codex = groupView(view, "codex");
    assert.deepEqual(
      codex.models.map((row) => [row.id, row.name, row.group, row.engine, row.runtimeDefault, row.selected]),
      [["", "Codex (default model)", "codex", "codex", true, false]],
      String(codexState),
    );
    if (codexState === "not_logged_in") {
      // The row still lets the task start (Codex reports the login on its first start); the hint says what is missing.
      assert.equal(codex.empty?.kind, "claude_unavailable");
      assert.equal(codex.empty?.text, EN.modelPickerAddonUnavailable("codex"));
    } else {
      assert.equal(codex.empty?.kind, "not_started", String(codexState));
      assert.equal(codex.empty?.text, EN.modelPickerAddonNotStarted("codex"));
    }
    assert.equal(view.models.some((row) => row.group === "codex" && row.runtimeDefault === true), true);
  }
  // A missing or refused installation offers no row, only the way to fix it.
  for (const codexState of ["not_found", "unavailable", "integrity_changed"] as const) {
    const codex = groupView(modelPickerView({ ...fresh, codexState }), "codex");
    assert.equal(codex.models.length, 0, codexState);
    assert.equal(codex.empty?.kind, "claude_unavailable", codexState);
  }
  assert.equal(groupView(modelPickerView({ ...fresh, codexState: "not_found" }), "codex").empty?.text, EN.modelPickerAddonUnavailable("codex"));
  assert.equal(groupView(modelPickerView({ ...fresh, codexState: "not_found" }), "codex").empty?.help, EN.modelPickerAddonUnavailableHelp("codex"));
  assert.equal(groupView(modelPickerView({ ...fresh, codexState: "unavailable" }), "codex").empty?.text, EN.addonStatusUnavailable("codex"));
  // A Grok task that already ran never sees the row.
  assert.equal(modelPickerView({ ...fresh, engineFixed: true }).models.some((row) => row.group === "codex"), false);
  // The zh wording is the owner-facing one.
  assert.equal(groupView(modelPickerView({ ...fresh, messages: ZH }), "codex").models[0]!.name, "Codex\uff08\u9ed8\u8ba4\u6a21\u578b\uff09");
});

test("choosing a Codex row moves an unstarted task to Codex; the default row pins nothing", () => {
  const catalogs = { grok: REAL_CATALOG, claude: CLAUDE_CATALOG, codex: CODEX_CATALOG };
  const view = modelPickerView({
    messages: EN, catalogs, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok", engineFixed: false,
  });
  const luna = view.models.find((row) => row.id === "gpt-6.1-luna")!;
  assert.deepEqual(selectionForRow(catalogs, luna, view.selectedEffortId, "grok"), {
    model: "gpt-6.1-luna", reasoningEffort: "medium", group: "codex", engine: "codex",
  });
  // On a Codex task the engine does not change, so the move is not announced.
  const sameEngine = selectionForRow(catalogs, luna, "low", "codex");
  assert.equal("engine" in sameEngine, false);
  assert.equal(sameEngine.model, "gpt-6.1-luna");
  // The default row clears the override, whatever the catalog says.
  const empty = { ...catalogs, codex: EMPTY_CODEX_MODEL_CATALOG };
  const emptyView = modelPickerView({ messages: EN, catalogs: empty, selection: selection(null, null, "runtime"), taskEngine: "grok", engineFixed: false });
  const defaultRow = emptyView.models.find((row) => row.group === "codex")!;
  assert.deepEqual(selectionForRow(empty, defaultRow, null, "grok"), { model: null, reasoningEffort: null, group: "codex", engine: "codex" });
});

test("an absent Codex catalog reads as an empty one, so a pre-3.1 caller still works", () => {
  const view = modelPickerView({
    messages: EN, catalogs: { grok: REAL_CATALOG, claude: CLAUDE_CATALOG }, selection: selection("grok-4.7", "high", "runtime"),
    taskEngine: "grok", engineFixed: false,
  });
  assert.equal(groupView(view, "codex").models[0]!.name, "Codex (default model)");
  assert.equal(modelCatalogsOf({ modelCatalog: REAL_CATALOG }).codex, EMPTY_CODEX_MODEL_CATALOG);
});

// ---- Guild 3.1 part 2: the Gemini group (PC-ENG-004, PC-MODEL-001)

test("the Gemini group comes after ChatGPT, says it is pay-as-you-go and carries the billing line under its heading", () => {
  const catalogs = { grok: REAL_CATALOG, claude: CLAUDE_CATALOG, codex: EMPTY_CODEX_MODEL_CATALOG, gemini: GEMINI_CATALOG };
  const fresh = { catalogs, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok" as const, engineFixed: false };
  const en = modelPickerView({ messages: EN, ...fresh });
  assert.deepEqual(en.groups.map((entry) => entry.group), ["grok", "claude", "codex", "gemini", "online", "local"]);
  assert.equal(groupView(en, "gemini").label, "Gemini (API, pay-as-you-go)");
  assert.equal(groupView(en, "gemini").hint, "Billed per use on your Google AI Studio account");
  const zh = modelPickerView({ messages: ZH, ...fresh });
  assert.equal(groupView(zh, "gemini").label, "Gemini\uff08API \u6309\u91cf\uff09");
  assert.equal(groupView(zh, "gemini").hint, "\u6309 Google AI Studio \u8d26\u6237\u7684\u7528\u91cf\u8ba1\u8d39");
  // Only the group paid for per use has the line.
  assert.deepEqual(en.groups.filter((entry) => entry.hint !== undefined).map((entry) => entry.group), ["gemini"]);
  // A Gemini task that already ran lists only its own group, which keeps its line though its heading is hidden.
  const fixed = modelPickerView({ messages: EN, catalogs, selection: selection("gemini-3.8-flash", null), taskEngine: "gemini", engineFixed: true, geminiState: "ready" });
  assert.deepEqual(fixed.groups.map((entry) => entry.group), ["gemini"]);
  assert.equal(fixed.showGroupHeadings, false);
  assert.equal(groupView(fixed, "gemini").hint, EN.modelGroupHint("gemini"));
  assert.equal(fixed.engineNote, undefined);
  // Every other task that already ran never sees the Gemini group.
  for (const taskEngine of ["grok", "claude", "codex"] as const) {
    assert.equal(modelPickerView({ messages: EN, catalogs, selection: selection(null, null, "runtime"), taskEngine, engineFixed: true })
      .groups.some((entry) => entry.group === "gemini"), false, taskEngine);
  }
});

test("Gemini rows are the session's own models with their own words, and never have an effort", () => {
  const catalogs = { grok: REAL_CATALOG, claude: CLAUDE_CATALOG, gemini: GEMINI_CATALOG };
  // Even a stored effort (from an older default) is ignored: Gemini has no effort setting over ACP.
  const view = modelPickerView({
    messages: EN, catalogs, selection: selection("gemini-3.8-flash", "high"), taskEngine: "gemini", engineFixed: true, geminiState: "ready",
  });
  const gemini = groupView(view, "gemini");
  assert.deepEqual(gemini.models.map((row) => [row.id, row.engine, row.group]), GEMINI_CATALOG.models.map((model) => [model.id, "gemini", "gemini"]));
  assert.equal(gemini.models.find((row) => row.id === "gemini-3.5-flash-lite")!.description, "Fastest and cheapest");
  assert.equal(gemini.models.some((row) => row.runtimeDefault === true), false, "no default row once the session listed its models");
  assert.equal(gemini.empty, undefined);
  assert.deepEqual(view.models.filter((row) => row.selected).map((row) => row.id), ["gemini-3.8-flash"]);
  assert.equal(view.triggerText, "Gemini 3.8 Flash");
  assert.equal(view.effortLabel, undefined);
  assert.equal(view.selectedEffortId, null);
  assert.deepEqual(view.efforts, []);
  assert.equal(view.showEfforts, false);
  // Nor does a Gemini catalog that somehow lists efforts bring the control back.
  const withEfforts = freezeModelCatalog("gemini", {
    models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", group: "gemini", contextWindows: [], reasoningEfforts: [{ id: "high", label: "High", isDefault: true }] }],
  });
  const odd = modelPickerView({
    messages: EN, catalogs: { ...catalogs, gemini: withEfforts }, selection: selection("gemini-3.8-flash", null), taskEngine: "gemini", engineFixed: true,
  });
  assert.equal(odd.showEfforts, false);
  assert.deepEqual(odd.efforts, []);
  assert.equal(odd.triggerText, "Gemini 3.8 Flash");
  // Choosing a Gemini row never carries an effort, and moves an unstarted task to Gemini.
  const row = odd.models.find((candidate) => candidate.id === "gemini-3.8-flash")!;
  assert.deepEqual(selectionForRow({ ...catalogs, gemini: withEfforts }, row, "high", "grok"), {
    model: "gemini-3.8-flash", reasoningEffort: null, group: "gemini", engine: "gemini",
  });
  const flashLite = view.models.find((candidate) => candidate.id === "gemini-3.5-flash-lite")!;
  const sameEngine = selectionForRow(catalogs, flashLite, "high", "gemini");
  assert.equal("engine" in sameEngine, false);
  assert.equal(sameEngine.reasoningEffort, null);
});

test("before a Gemini session reported models, its one default row exists only while the CLI is installed and has a usable key", () => {
  const catalogs = { grok: REAL_CATALOG, claude: CLAUDE_CATALOG, gemini: EMPTY_GEMINI_MODEL_CATALOG };
  const fresh = { messages: EN, catalogs, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok" as const, engineFixed: false };
  for (const geminiState of [undefined, "ready"] as const) {
    const view = modelPickerView({ ...fresh, ...(geminiState === undefined ? {} : { geminiState }) });
    const gemini = groupView(view, "gemini");
    assert.deepEqual(
      gemini.models.map((row) => [row.id, row.name, row.description, row.group, row.engine, row.runtimeDefault, row.selected]),
      [["", "Gemini (default model)", "Starts on the cheapest Flash model the session offers.", "gemini", "gemini", true, false]],
      String(geminiState),
    );
    assert.equal(gemini.empty?.kind, "not_started");
    assert.equal(gemini.empty?.text, "Model choices appear once Gemini has started.");
  }
  // No usable key (not_logged_in for Gemini), no CLI, changed files or an unavailable CLI: no row, only the way out.
  for (const geminiState of ["not_logged_in", "not_found", "unavailable", "integrity_changed"] as const) {
    const gemini = groupView(modelPickerView({ ...fresh, geminiState }), "gemini");
    assert.equal(gemini.models.length, 0, geminiState);
    assert.equal(gemini.empty?.kind, "claude_unavailable", geminiState);
  }
  for (const geminiState of ["not_logged_in", "not_found"] as const) {
    const empty = groupView(modelPickerView({ ...fresh, geminiState }), "gemini").empty;
    assert.equal(empty?.text, "Gemini not found or no API key");
    assert.equal(empty?.help, "Install the Gemini CLI (npm install -g @google/gemini-cli), then choose and confirm your API key file in Settings > Engines.");
  }
  assert.equal(groupView(modelPickerView({ ...fresh, geminiState: "unavailable" }), "gemini").empty?.text, EN.addonStatusUnavailable("gemini"));
  assert.match(groupView(modelPickerView({ ...fresh, geminiState: "integrity_changed" }), "gemini").empty?.text ?? "", /Gemini CLI files changed/u);
  // Codex keeps its own rule: a missing login still offers its row (the login can follow the first start).
  assert.equal(groupView(modelPickerView({ ...fresh, codexState: "not_logged_in" }), "codex").models.length, 1);
  // The row selected while a Gemini task follows its default; picking it clears the override and moves the task.
  const following = modelPickerView({ ...fresh, taskEngine: "gemini", engineFixed: true, selection: selection(null, null, "runtime") });
  const defaultRow = following.models.find((row) => row.group === "gemini")!;
  assert.equal(defaultRow.selected, true);
  assert.equal(following.triggerText, "Gemini (default model)");
  assert.equal(following.showEfforts, false);
  assert.deepEqual(selectionForRow(catalogs, defaultRow, null, "grok"), { model: null, reasoningEffort: null, group: "gemini", engine: "gemini" });
  // The owner-facing Chinese name.
  assert.equal(groupView(modelPickerView({ ...fresh, messages: ZH }), "gemini").models[0]!.name, "Gemini\uff08\u9ed8\u8ba4\u6a21\u578b\uff09");
});

test("the add-on engine table: Gemini owns its group, takes an API key and has no effort setting; Codex logs in and has efforts", () => {
  assert.equal(addonEngineOfGroup("gemini"), "gemini");
  assert.equal(addonEngineOfGroup("codex"), "codex");
  for (const group of ["grok", "claude", "online", "local"] as const) assert.equal(addonEngineOfGroup(group), undefined, group);
  assert.deepEqual((["grok", "claude", "codex", "gemini"] as const).map(engineOffersEffort), [true, true, true, false]);
  assert.deepEqual((["grok", "claude", "codex", "gemini"] as const).map(engineTakesApiKey), [false, false, false, true]);
  assert.equal(catalogOfEngine({ grok: REAL_CATALOG, claude: CLAUDE_CATALOG }, "gemini"), EMPTY_GEMINI_MODEL_CATALOG);
  assert.equal(catalogOfEngine({ grok: REAL_CATALOG, claude: CLAUDE_CATALOG, gemini: GEMINI_CATALOG }, "gemini"), GEMINI_CATALOG);
});
