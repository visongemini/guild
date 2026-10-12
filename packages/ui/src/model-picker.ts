import type {
  GrokModelCatalog,
  GrokModelDescriptor,
  GuildEngine,
  GuildModelSwitchRefusalReason,
  ModelCatalog,
  ModelGroup,
  RuntimeSettingsProjection,
  SetTaskRuntimeSettingsResponse,
  TaskModelSelectionProjection,
} from "@guild/contracts";
import {
  EMPTY_CLAUDE_MODEL_CATALOG,
  EMPTY_GROK_MODEL_CATALOG,
  defaultReasoningEffortOf,
  grokModelById,
  modelGroupOf,
  modelSupportsReasoningEffort,
} from "@guild/contracts/grok-models";
import type { ClaudeStatusState } from "./claude-engine.js";
import type { GuildMessages } from "./locales.js";

/*
 * Pure view-model for the composer model picker and the Settings default-model control.
 * The model list, names, descriptions, efforts and context windows all come from the catalogs the
 * engines advertised (and the model sources the user configured); nothing here knows a model id.
 * Guild 3.0 (PC-MODEL-001): the picker is grouped Grok / Claude / Online / Local. A task that already
 * has a Run is bound to its engine and shows only that engine's groups; a task without a Run shows
 * every group, and choosing a model of the other engine moves the task to that engine first.
 */

/** Middle dot used between the model name and the effort label. */
export const MODEL_PICKER_SEPARATOR = " \u00b7 ";

export type ModelSelectionChange = Readonly<{
  /** `null` with a `null` effort clears the task override. */
  model: string | null;
  reasoningEffort: string | null;
  /** Picker group of the chosen model; the Online reminder keys on it. Absent for a cleared override. */
  group?: ModelGroup;
  /** Set only when the task must move to this engine before the model can apply (task has no Run yet). */
  engine?: GuildEngine;
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
 * does not exist is the no-op there. A change that moves the task to the other engine is never a
 * no-op, whatever the model says (the engine is part of the selection).
 */
export function isSameSelection(
  selection: Pick<TaskModelSelectionProjection, "modelId" | "reasoningEffort" | "source">,
  change: ModelSelectionChange,
): boolean {
  if (change.engine !== undefined) return false;
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
  /** Picker group the row sits in. */
  group: ModelGroup;
  /** Engine the model belongs to: Grok for the Grok group, Claude for Claude, Online and Local. */
  engine: GuildEngine;
  /**
   * The row names no model: it follows Claude Code's own default. Only the Claude group offers it, and only while
   * Claude lists no model of its own (a first run), so a task can still start on Claude before the list exists.
   */
  runtimeDefault?: true;
}>;

export type EffortChoiceView = Readonly<{
  id: string;
  label: string;
  description?: string;
  isDefault: boolean;
  selected: boolean;
  tabStop: boolean;
}>;

/** Why a group lists no model, and what the user can do about it. */
export type ModelGroupEmptyView = Readonly<{
  kind: "not_started" | "claude_unavailable" | "no_sources";
  text: string;
  help?: string;
  /** Online and Local: the way out is the Model sources settings tab. */
  action?: "open_model_sources";
}>;

export type ModelGroupView = Readonly<{
  group: ModelGroup;
  label: string;
  models: readonly ModelRowView[];
  /** Present exactly when the group lists no model of the catalog (the Claude group may still hold its default row). */
  empty?: ModelGroupEmptyView;
}>;

/** The two catalogs the picker draws from; the Claude one also carries the Online and Local models. */
export type ModelPickerCatalogs = Readonly<{
  grok: GrokModelCatalog;
  claude: ModelCatalog;
}>;

/** `modelCatalogs` from the engines, falling back to the single Grok `modelCatalog` while an older main process supplies only that. */
export function modelCatalogsOf(
  runtimeSettings: Pick<RuntimeSettingsProjection, "modelCatalog" | "modelCatalogs">,
): ModelPickerCatalogs {
  return Object.freeze({
    grok: runtimeSettings.modelCatalogs?.grok ?? runtimeSettings.modelCatalog,
    claude: runtimeSettings.modelCatalogs?.claude ?? EMPTY_CLAUDE_MODEL_CATALOG,
  });
}

const GROUPS_OF_ENGINE: Readonly<Record<GuildEngine, readonly ModelGroup[]>> = Object.freeze({
  grok: Object.freeze(["grok"] as const),
  claude: Object.freeze(["claude", "online", "local"] as const),
});
const ALL_GROUPS: readonly ModelGroup[] = Object.freeze(["grok", "claude", "online", "local"] as const);

/** Groups an open picker lists, in display order: the task's own engine once it has a Run, otherwise all four. */
export function visibleModelGroups(engine: GuildEngine, engineFixed: boolean): readonly ModelGroup[] {
  return engineFixed ? GROUPS_OF_ENGINE[engine] : ALL_GROUPS;
}

export function engineOfGroup(group: ModelGroup): GuildEngine {
  return group === "grok" ? "grok" : "claude";
}

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
  /** One visible group and no model in it: the popover shows that group's hint and nothing else. */
  catalogEmpty: boolean;
  /** Visible groups in display order, each with its rows or the reason it has none. */
  groups: readonly ModelGroupView[];
  /** Group headings are shown only when more than one group is visible. */
  showGroupHeadings: boolean;
  /** Every row of every visible group, in order (the keyboard and the tab stop walk this list). */
  models: readonly ModelRowView[];
  efforts: readonly EffortChoiceView[];
  /** False for an Online or Local model whose catalog entry lists no effort: the control is hidden. */
  showEfforts: boolean;
  selectedModelId: string | null;
  selectedEffortId: string | null;
  /** The "Use default" footer exists only while the task carries its own override. */
  showUseDefault: boolean;
  /** Said while the task can still choose its engine: the first message fixes it. */
  engineNote: string | undefined;
}>;

export function effortDisplayLabel(
  messages: Pick<GuildMessages, "reasoningEffortName">,
  effortId: string,
  officialLabel?: string,
): string {
  return messages.reasoningEffortName(effortId, officialLabel);
}

function groupEmptyView(
  messages: GuildMessages,
  group: ModelGroup,
  claudeAvailable: boolean,
  claudeState: ClaudeStatusState | undefined,
): ModelGroupEmptyView {
  if (group === "online" || group === "local") {
    return Object.freeze({
      kind: "no_sources",
      text: messages.modelPickerGroupEmpty(group),
      action: "open_model_sources",
    });
  }
  if (group === "claude" && !claudeAvailable) {
    // "Not found or not logged in" is only true when nothing says otherwise; a Claude Code that is
    // installed but cannot run (for example an unsupported adapter) gets the generic wording.
    return claudeState === "unavailable" || claudeState === "integrity_changed"
      ? Object.freeze({
          kind: "claude_unavailable",
          text: claudeState === "unavailable" ? messages.claudeStatusUnavailable : messages.claudeStatusIntegrityChanged,
        })
      : Object.freeze({
          kind: "claude_unavailable",
          text: messages.modelPickerClaudeUnavailable,
          help: messages.modelPickerClaudeUnavailableHelp,
        });
  }
  return Object.freeze({
    kind: "not_started",
    text: group === "claude" ? messages.modelPickerClaudeNotStarted : messages.modelPickerEmpty,
  });
}

export function modelPickerView(input: {
  readonly messages: GuildMessages;
  /** Legacy single catalog: the Grok catalog of a Grok-only picker. Ignored when `catalogs` is given. */
  readonly catalog?: GrokModelCatalog;
  readonly catalogs?: ModelPickerCatalogs;
  readonly selection: TaskModelSelectionProjection | undefined;
  readonly pending?: boolean;
  /** Engine of the task; Grok when absent. */
  readonly taskEngine?: GuildEngine;
  /** True once the task has a Run: the picker then lists only the task's engine. Default true. */
  readonly engineFixed?: boolean;
  /**
   * Claude Code's state, when the main process reports one. Without it the Claude group reads as
   * unavailable exactly while the Claude catalog is empty.
   */
  readonly claudeState?: ClaudeStatusState;
}): ModelPickerView {
  const { messages, selection } = input;
  const catalogs: ModelPickerCatalogs = input.catalogs ?? Object.freeze({
    grok: input.catalog ?? EMPTY_GROK_MODEL_CATALOG,
    claude: EMPTY_CLAUDE_MODEL_CATALOG,
  });
  const taskEngine = input.taskEngine ?? "grok";
  const engineFixed = input.engineFixed ?? true;
  const claudeAvailable = input.claudeState === undefined
    ? catalogs.claude.models.length > 0
    : input.claudeState === "ready";
  const catalog = catalogs[taskEngine];
  const model = catalogModelById(catalog, selection?.modelId);
  const modelId = selection?.modelId ?? null;
  const modelName = model?.name ?? modelId ?? messages.modelDefaultName;
  // An effort the task has not pinned is the model's own default, which is what the engine will use.
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

  const visible = visibleModelGroups(taskEngine, engineFixed);
  const rowOf = (candidate: GrokModelDescriptor, group: ModelGroup): Omit<ModelRowView, "tabStop"> => {
    const contextSizes = formatContextWindows(candidate.contextWindows);
    const engine = engineOfGroup(group);
    // The price tag always follows the runtime's own statement, whatever language the description is shown in.
    const priceMultiplier = officialPriceMultiplier(candidate.description);
    const description = messages.modelDescription(candidate.id, candidate.description);
    return {
      id: candidate.id,
      name: candidate.name,
      ...(description === undefined ? {} : { description }),
      ...(priceMultiplier === undefined ? {} : { priceMultiplier }),
      ...(contextSizes === undefined ? {} : { contextLabel: messages.modelPickerContext(contextSizes) }),
      selected: engine === taskEngine && candidate.id === modelId,
      group,
      engine,
    };
  };
  const rowsOfGroup = (group: ModelGroup): Omit<ModelRowView, "tabStop">[] =>
    (group === "grok" ? catalogs.grok : catalogs.claude).models
      .filter((candidate) => modelGroupOf(candidate) === group)
      .map((candidate) => rowOf(candidate, group));
  // Claude Code lists its models only once a session has started. Until then (and whenever it lists none) the Claude
  // group offers "Claude Code (default model)", so a fresh install can still start a Claude task. It is offered only
  // when Claude can start (ready, not yet logged in, or unknown): a missing installation, changed engine files or an
  // unavailable engine would bind the task to an engine Guild already refuses to run.
  const claudeDefaultOffered =
    (input.claudeState === undefined || input.claudeState === "ready" || input.claudeState === "not_logged_in") &&
    !catalogs.claude.models.some((candidate) => modelGroupOf(candidate) === "claude");
  const claudeDefaultRow = (): Omit<ModelRowView, "tabStop"> => ({
    id: "",
    name: messages.modelPickerClaudeDefault,
    // Selected while the task follows a default instead of a pinned model.
    selected: taskEngine === "claude" && selection !== undefined && selection.source !== "task",
    group: "claude",
    engine: "claude",
    runtimeDefault: true,
  });
  const rawGroups = visible.map((group) => {
    const catalogRows = rowsOfGroup(group);
    return {
      group,
      catalogRows: catalogRows.length,
      rows: group === "claude" && claudeDefaultOffered ? [claudeDefaultRow(), ...catalogRows] : catalogRows,
    };
  });
  const allRows = rawGroups.flatMap((entry) => entry.rows);
  // One roving tab stop: the selected row, else the first one.
  const tabStopIndex = Math.max(0, allRows.findIndex((row) => row.selected));
  let flatIndex = 0;
  const groups = rawGroups.map((entry): ModelGroupView => {
    const models = entry.rows.map((row) => Object.freeze({ ...row, tabStop: flatIndex++ === tabStopIndex }));
    return Object.freeze({
      group: entry.group,
      label: messages.modelGroupName(entry.group),
      models: Object.freeze(models),
      ...(entry.catalogRows === 0 ? { empty: groupEmptyView(messages, entry.group, claudeAvailable, input.claudeState) } : {}),
    });
  });
  const models = groups.flatMap((entry) => entry.models);
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
  const selectedGroup = model === undefined ? undefined : modelGroupOf(model);
  const showEfforts = !(
    (selectedGroup === "online" || selectedGroup === "local") && efforts.length === 0
  );
  return Object.freeze({
    modelName,
    effortLabel,
    triggerText,
    scopeText,
    title: disabledText === undefined ? scopeText : `${scopeText}${MODEL_PICKER_SEPARATOR}${disabledText}`,
    ariaLabel: messages.modelPickerAria(triggerText, scopeText, disabledText),
    disabledReason,
    catalogEmpty: groups.length === 1 && models.length === 0,
    groups: Object.freeze(groups),
    showGroupHeadings: groups.length > 1,
    models: Object.freeze(models),
    efforts: Object.freeze(efforts),
    showEfforts,
    selectedModelId: modelId,
    selectedEffortId: effortId,
    showUseDefault: selection?.source === "task",
    engineNote: !engineFixed && groups.length > 1 ? messages.modelPickerEngineNote : undefined,
  });
}

/**
 * The change to submit when the user picks `row`: the model with the effort rules of its own catalog,
 * its group (the Online reminder keys on it), and the engine to move the task to when the row belongs
 * to the other engine than the task's.
 */
export function selectionForRow(
  catalogs: ModelPickerCatalogs,
  row: Pick<ModelRowView, "id" | "group" | "engine" | "runtimeDefault">,
  currentEffort: string | null,
  taskEngine: GuildEngine,
): ModelSelectionChange {
  // The default row pins nothing: it clears the task's override so the engine's own default applies.
  const change = row.runtimeDefault === true
    ? CLEAR_MODEL_OVERRIDE
    : selectionAfterModelChange(catalogs[row.engine], row.id, currentEffort);
  return Object.freeze({
    ...change,
    group: row.group,
    ...(row.engine === taskEngine ? {} : { engine: row.engine }),
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

/** The note to show after a response; an applied switch needs none, and neither does a switch the user cancelled (`undefined`). */
export function noticeForResponse(response: SetTaskRuntimeSettingsResponse | undefined): PickerNotice | undefined {
  if (response === undefined) return undefined;
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
