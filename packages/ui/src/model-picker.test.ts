import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultReasoningEffortOf,
  freezeGrokModelCatalog,
  grokModelById,
  modelSupportsReasoningEffort,
  resolveEffectiveSelection,
  type SetTaskRuntimeSettingsResponse,
  type TaskModelSelectionProjection,
  type TaskViewProjection,
} from "@guild/contracts";
import { messagesFor } from "./locales.js";
import { REAL_CATALOG } from "./model-catalog.fixture.js";
import {
  CLEAR_MODEL_OVERRIDE,
  catalogModelById,
  formatContextTokens,
  formatContextWindows,
  globalDefaultView,
  isSameSelection,
  modelDefaultEffort,
  modelOffersEffort,
  modelPickerView,
  nextPickerIndex,
  noticeForResponse,
  noticeText,
  pickerDisabledReason,
  pickerIsLocked,
  selectionAfterModelChange,
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
    "Maximum",
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
