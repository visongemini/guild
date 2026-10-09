import type {
  GrokModelCatalog,
  GrokModelDescriptor,
  GuildModelSwitchRefusalReason,
  SetTaskRuntimeSettingsResponse,
  TaskModelSelectionProjection,
} from "@guild/contracts";
import {
  defaultReasoningEffortOf,
  grokModelById,
  modelSupportsReasoningEffort,
} from "@guild/contracts/grok-models";
import type { GuildMessages } from "./locales.js";

/*
 * Pure view-model for the composer model picker and the Settings default-model control.
 * The model list, names, descriptions, efforts and context windows all come from the catalog the
 * official runtime advertised; nothing here knows a model id.
 */

/** Middle dot used between the model name and the effort label. */
export const MODEL_PICKER_SEPARATOR = " \u00b7 ";

export type ModelSelectionChange = Readonly<{
  /** `null` with a `null` effort clears the task override. */
  model: string | null;
  reasoningEffort: string | null;
}>;

export const CLEAR_MODEL_OVERRIDE: ModelSelectionChange = Object.freeze({
  model: null,
  reasoningEffort: null,
});

export const catalogModelById = grokModelById;

/** The effort the model itself advertises as its default, else its first one. */
export function modelDefaultEffort(model: GrokModelDescriptor | undefined): string | null {
  return defaultReasoningEffortOf(model) ?? null;
}

export const modelOffersEffort = modelSupportsReasoningEffort;

/**
 * Choosing a model keeps the current effort when the new model offers it, otherwise it takes the
 * new model's own default effort (null when the model has no effort setting).
 */
export function selectionAfterModelChange(
  catalog: GrokModelCatalog,
  modelId: string,
  currentEffort: string | null,
): ModelSelectionChange {
  const model = catalogModelById(catalog, modelId);
  const reasoningEffort = modelOffersEffort(model, currentEffort)
    ? currentEffort
    : modelDefaultEffort(model);
  return Object.freeze({ model: modelId, reasoningEffort });
}

/**
 * Clicking what the task already pins is a no-op. A selection that is only inherited (global or
 * runtime default) is not a task override yet, so choosing it pins it; clearing an override that
 * does not exist is the no-op there.
 */
export function isSameSelection(
  selection: Pick<TaskModelSelectionProjection, "modelId" | "reasoningEffort" | "source">,
  change: ModelSelectionChange,
): boolean {
  if (change.model === null) return selection.source !== "task";
  return selection.source === "task" &&
    selection.modelId === change.model &&
    selection.reasoningEffort === change.reasoningEffort;
}

export type PickerDisabledReason = "no_task" | "running" | "pending";

export function pickerDisabledReason(input: {
  readonly selection: TaskModelSelectionProjection | undefined;
  readonly pending: boolean;
}): PickerDisabledReason | undefined {
  if (input.selection === undefined) return "no_task";
  if (!input.selection.canChange) return "running";
  return input.pending ? "pending" : undefined;
}

/** `no_task` and `running` take the picker away entirely; `pending` only holds inputs for a moment. */
export function pickerIsLocked(reason: PickerDisabledReason | undefined): boolean {
  return reason === "no_task" || reason === "running";
}

/** 256000 -> "256K", 500000 -> "500K", 1000000 -> "1M", 1500000 -> "1.5M". */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 999_500) {
    const millions = Math.round(tokens / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function formatContextWindows(windows: readonly number[]): string | undefined {
  if (windows.length === 0) return undefined;
  return windows.map(formatContextTokens).join(" / ");
}

/**
 * A price tag appears only when the runtime's own description states a premium multiple, for
 * example "2x the price" or "2 倍价格". Nothing is inferred from a model id or a name. Returns the
 * multiple as text ("2", "1.5"), or undefined when the description makes no such claim.
 */
export function officialPriceMultiplier(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  // Only a statement about price counts; "2x usage limits" or "3x cost savings" is not a premium.
  const latin = /(?<![\w.])(\d+(?:\.\d+)?)\s*[x\u00d7]\s*(?:the\s+|of\s+the\s+)?(?:price|pricing|cost(?!\s*(?:saving|efficien|reduc|cut)))\b/iu.exec(description);
  const chinese = /(\d+(?:\.\d+)?)\s*倍\s*(?:价格|价|费用)/u.exec(description);
  const twice = /\btwice\s+the\s+(?:price|cost)\b/iu.test(description) ? ["", "2"] : undefined;
  const match = latin ?? chinese ?? twice;
  if (match === null || match === undefined) return undefined;
  const multiple = Number(match[1]);
  return Number.isFinite(multiple) && multiple > 1 ? String(multiple) : undefined;
}

export type ModelRowView = Readonly<{
  id: string;
  name: string;
  description?: string;
  /** The premium multiple the official description states, if any (see `officialPriceMultiplier`). */
  priceMultiplier?: string;
  /** For example "256K / 500K context". */
  contextLabel?: string;
  selected: boolean;
  /** Roving tab stop: the selected row, else the first one. */
  tabStop: boolean;
}>;

export type EffortChoiceView = Readonly<{
  id: string;
  label: string;
  description?: string;
  isDefault: boolean;
  selected: boolean;
  tabStop: boolean;
}>;

export type ModelPickerView = Readonly<{
  modelName: string;
  /** Undefined when no effort applies (unknown selection or a model without efforts). */
  effortLabel: string | undefined;
  /** Model name, separator, effort label (for example "Grok 4.7 Fast" and "High"). */
  triggerText: string;
  scopeText: string;
  title: string;
  ariaLabel: string;
  disabledReason: PickerDisabledReason | undefined;
  catalogEmpty: boolean;
  models: readonly ModelRowView[];
  efforts: readonly EffortChoiceView[];
  selectedModelId: string | null;
  selectedEffortId: string | null;
  /** The "Use default" footer exists only while the task carries its own override. */
  showUseDefault: boolean;
}>;

export function effortDisplayLabel(
  messages: Pick<GuildMessages, "reasoningEffortName">,
  effortId: string,
  officialLabel?: string,
): string {
  return messages.reasoningEffortName(effortId, officialLabel);
}

export function modelPickerView(input: {
  readonly messages: GuildMessages;
  readonly catalog: GrokModelCatalog;
  readonly selection: TaskModelSelectionProjection | undefined;
  readonly pending?: boolean;
}): ModelPickerView {
  const { messages, catalog, selection } = input;
  const model = catalogModelById(catalog, selection?.modelId);
  const modelId = selection?.modelId ?? null;
  const modelName = model?.name ?? modelId ?? messages.modelDefaultName;
  // An effort the task has not pinned is the model's own default, which is what Grok will use.
  const effortId = selection === undefined
    ? null
    : selection.reasoningEffort ?? (model === undefined ? null : modelDefaultEffort(model));
  const officialEffort = model?.reasoningEfforts.find((effort) => effort.id === effortId);
  const effortLabel = effortId === null
    ? undefined
    : effortDisplayLabel(messages, effortId, officialEffort?.label);
  const triggerText = effortLabel === undefined
    ? modelName
    : `${modelName}${MODEL_PICKER_SEPARATOR}${effortLabel}`;
  const scopeText = selection?.source === "task"
    ? messages.modelPickerScopeTask
    : selection?.source === "global"
      ? messages.modelPickerScopeGlobal
      : messages.modelPickerScopeRuntime;
  const disabledReason = pickerDisabledReason({ selection, pending: input.pending === true });
  const disabledText = disabledReason === "no_task"
    ? messages.modelPickerDisabledNoTask
    : disabledReason === "running"
      ? messages.modelPickerDisabledRunning
      : disabledReason === "pending"
        ? messages.modelPickerDisabledPending
        : undefined;
  const models = catalog.models.map((candidate, index): ModelRowView => {
    const contextSizes = formatContextWindows(candidate.contextWindows);
    const selected = candidate.id === modelId;
    // The price tag always follows the runtime's own statement, whatever language the description is shown in.
    const priceMultiplier = officialPriceMultiplier(candidate.description);
    const description = messages.modelDescription(candidate.id, candidate.description);
    return Object.freeze({
      id: candidate.id,
      name: candidate.name,
      ...(description === undefined ? {} : { description }),
      ...(priceMultiplier === undefined ? {} : { priceMultiplier }),
      ...(contextSizes === undefined ? {} : { contextLabel: messages.modelPickerContext(contextSizes) }),
      selected,
      tabStop: model === undefined ? index === 0 : selected,
    });
  });
  const efforts = (model?.reasoningEfforts ?? []).map((candidate, index): EffortChoiceView => {
    const selected = candidate.id === effortId;
    return Object.freeze({
      id: candidate.id,
      label: effortDisplayLabel(messages, candidate.id, candidate.label),
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
      isDefault: candidate.isDefault,
      selected,
      tabStop: modelOffersEffort(model, effortId) ? selected : index === 0,
    });
  });
  return Object.freeze({
    modelName,
    effortLabel,
    triggerText,
    scopeText,
    title: disabledText === undefined ? scopeText : `${scopeText}${MODEL_PICKER_SEPARATOR}${disabledText}`,
    ariaLabel: messages.modelPickerAria(triggerText, scopeText, disabledText),
    disabledReason,
    catalogEmpty: catalog.models.length === 0,
    models: Object.freeze(models),
    efforts: Object.freeze(efforts),
    selectedModelId: modelId,
    selectedEffortId: effortId,
    showUseDefault: selection?.source === "task",
  });
}

/** What the Settings default-model control shows for the global default (`null` = runtime default). */
export function globalDefaultView(input: {
  readonly catalog: GrokModelCatalog;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}): Readonly<{
  /** The model descriptor, undefined for the runtime default or an id the catalog lacks. */
  descriptor: GrokModelDescriptor | undefined;
  /** A stored id the catalog does not list; the select keeps it visible instead of lying. */
  unlistedModelId: string | undefined;
  effortId: string | null;
  efforts: readonly Readonly<{ id: string; label: string }>[];
}> {
  const descriptor = catalogModelById(input.catalog, input.model);
  return Object.freeze({
    descriptor,
    unlistedModelId: input.model !== null && descriptor === undefined ? input.model : undefined,
    effortId: descriptor === undefined
      ? null
      : input.reasoningEffort ?? modelDefaultEffort(descriptor),
    efforts: Object.freeze((descriptor?.reasoningEfforts ?? []).map((effort) =>
      Object.freeze({ id: effort.id, label: effort.label }))),
  });
}

export type PickerNotice =
  | Readonly<{ kind: "saved" }>
  | Readonly<{ kind: "refused"; reason: GuildModelSwitchRefusalReason }>
  | Readonly<{ kind: "failed" }>;

/** The note to show after a response; an applied switch needs none. */
export function noticeForResponse(response: SetTaskRuntimeSettingsResponse): PickerNotice | undefined {
  if (response.status === "refused") return Object.freeze({ kind: "refused", reason: response.reason });
  if (response.status === "saved") return Object.freeze({ kind: "saved" });
  return undefined;
}

export function noticeText(
  messages: Pick<GuildMessages, "modelPickerSaved" | "modelPickerRefused" | "operationFailed">,
  notice: PickerNotice,
): string {
  if (notice.kind === "saved") return messages.modelPickerSaved;
  if (notice.kind === "refused") return messages.modelPickerRefused(notice.reason);
  return messages.operationFailed;
}

export type PickerNavigationOrientation = "vertical" | "horizontal" | "both";

/**
 * Arrow-key movement for a roving list, with wrap-around like the slash menu. Returns the index to
 * focus next, or undefined when the key does not navigate. `current` is -1 when nothing is focused.
 */
export function nextPickerIndex(
  current: number,
  count: number,
  key: string,
  orientation: PickerNavigationOrientation,
): number | undefined {
  if (count <= 0) return undefined;
  const vertical = orientation !== "horizontal";
  const horizontal = orientation !== "vertical";
  if ((vertical && key === "ArrowDown") || (horizontal && key === "ArrowRight")) {
    return current < 0 ? 0 : (current + 1) % count;
  }
  if ((vertical && key === "ArrowUp") || (horizontal && key === "ArrowLeft")) {
    return current < 0 ? count - 1 : (current - 1 + count) % count;
  }
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}
