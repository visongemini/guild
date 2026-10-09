/**
 * Runtime-advertised Grok model catalog (F1a / WP5, PC-ACC-001, D-011).
 *
 * Guild no longer owns a list of models. The official process advertises the models, their
 * reasoning efforts and context windows in `initialize` `_meta.modelState`, in `session/new`
 * `models`, and later in `_x.ai/models/update`. This module holds only
 *  - bounded identifier validation (a model id is data, never an enum),
 *  - the shape of the catalog Guild keeps and caches,
 *  - the D-011 policy predicate that keeps non-xAI models the owner may have configured in the
 *    official CLI out of Guild's selector,
 *  - pure selection helpers shared by main, persistence and the renderer.
 */

export const GUILD_GROK_IDENTIFIER_LIMITS = Object.freeze({
  modelIdLength: 64,
  effortIdLength: 32,
  maxModels: 32,
  maxEffortsPerModel: 8,
  maxContextWindows: 4,
  maxContextWindow: 100_000_000,
  maxNameLength: 128,
  maxDescriptionLength: 512,
  maxEffortLabelLength: 64,
  maxEffortDescriptionLength: 256,
});

/** `grok-` plus letters, digits and `. _ : -`, at most 64 characters: safe in argv, SQL text and URLs. */
const OFFICIAL_MODEL_ID_PATTERN = /^grok-[A-Za-z0-9][A-Za-z0-9._:-]{0,58}$/u;
const EFFORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export type GuildGrokModel = string;
export type GuildGrokReasoningEffort = string;

/** A bounded safe identifier that also passes the D-011 official-model policy. */
export function parseGuildGrokModel(value: unknown): GuildGrokModel {
  if (typeof value !== "string" || !isOfficialGrokModelId(value)) {
    throw new TypeError("invalid_grok_model");
  }
  return value;
}

export function parseGuildGrokReasoningEffort(value: unknown): GuildGrokReasoningEffort {
  if (typeof value !== "string" || !EFFORT_ID_PATTERN.test(value)) {
    throw new TypeError("invalid_grok_reasoning_effort");
  }
  return value;
}

export function parseGuildGrokContextWindow(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > GUILD_GROK_IDENTIFIER_LIMITS.maxContextWindow
  ) {
    throw new TypeError("invalid_grok_context_window");
  }
  return value;
}

/**
 * D-011 / PC-ACC-001: only xAI Grok models are selectable. The official CLI lets the owner add
 * other providers to its own config (they are advertised in the same list); xAI model ids all
 * start with `grok-`, and Guild fails closed on everything else.
 */
export function isOfficialGrokModelId(id: string): boolean {
  return OFFICIAL_MODEL_ID_PATTERN.test(id);
}

export type GrokReasoningEffortDescriptor = Readonly<{
  id: GuildGrokReasoningEffort;
  /** Official display name, for example "Extra High". */
  label: string;
  description?: string;
  isDefault: boolean;
}>;

export type GrokModelDescriptor = Readonly<{
  id: GuildGrokModel;
  /** Official display name, for example "Grok 4.7 Fast". */
  name: string;
  /** Official description, for example "Fast variant. 2x the price." */
  description?: string;
  agentType?: string;
  /** Empty when the model does not accept a reasoning effort. */
  reasoningEfforts: readonly GrokReasoningEffortDescriptor[];
  contextWindows: readonly number[];
  defaultContextWindow?: number;
}>;

export type GrokModelCatalog = Readonly<{
  models: readonly GrokModelDescriptor[];
  /** The official model the runtime itself had selected when the list was captured. */
  runtimeDefaultModelId?: GuildGrokModel;
}>;

export const EMPTY_GROK_MODEL_CATALOG: GrokModelCatalog = Object.freeze({
  models: Object.freeze([]),
});

export function grokModelById(
  catalog: GrokModelCatalog | undefined,
  id: string | null | undefined,
): GrokModelDescriptor | undefined {
  if (catalog === undefined || id === null || id === undefined) return undefined;
  return catalog.models.find((model) => model.id === id);
}

export function defaultReasoningEffortOf(
  model: GrokModelDescriptor | undefined,
): GuildGrokReasoningEffort | undefined {
  if (model === undefined || model.reasoningEfforts.length === 0) return undefined;
  return (model.reasoningEfforts.find((effort) => effort.isDefault) ?? model.reasoningEfforts[0])?.id;
}

export function modelSupportsReasoningEffort(
  model: GrokModelDescriptor | undefined,
  effort: string | null | undefined,
): boolean {
  if (model === undefined || effort === null || effort === undefined) return false;
  return model.reasoningEfforts.some((candidate) => candidate.id === effort);
}

/** The model a fresh install starts on: the runtime's own pick when official, else the first official model. */
export function runtimeDefaultModelOf(
  catalog: GrokModelCatalog | undefined,
): GrokModelDescriptor | undefined {
  if (catalog === undefined || catalog.models.length === 0) return undefined;
  return grokModelById(catalog, catalog.runtimeDefaultModelId) ?? catalog.models[0];
}

export type GuildModelSelectionSource = "task" | "global" | "runtime";

export type GuildModelSelection = Readonly<{
  modelId: GuildGrokModel | null;
  reasoningEffort: GuildGrokReasoningEffort | null;
}>;

/**
 * Task override, then the global default, then the runtime default. An effort the selected model
 * does not offer is replaced by that model's own default, so the pair is always one the runtime
 * accepts when the catalog is known.
 */
export function resolveEffectiveSelection(input: {
  readonly task?: GuildModelSelection | undefined;
  readonly global: GuildModelSelection;
  readonly catalog?: GrokModelCatalog | undefined;
}): GuildModelSelection & { readonly source: GuildModelSelectionSource } {
  const taskPinned = input.task !== undefined &&
    (input.task.modelId !== null || input.task.reasoningEffort !== null);
  const globalPinned = input.global.modelId !== null || input.global.reasoningEffort !== null;
  const modelId = input.task?.modelId ??
    input.global.modelId ??
    runtimeDefaultModelOf(input.catalog)?.id ??
    null;
  const model = grokModelById(input.catalog, modelId);
  let reasoningEffort = input.task?.reasoningEffort ?? input.global.reasoningEffort ?? null;
  if (model !== undefined) {
    if (reasoningEffort === null || !modelSupportsReasoningEffort(model, reasoningEffort)) {
      reasoningEffort = defaultReasoningEffortOf(model) ?? null;
    }
  }
  return Object.freeze({
    modelId,
    reasoningEffort,
    source: taskPinned ? "task" : globalPinned ? "global" : "runtime",
  });
}

function fail(code: string, path: string): never {
  throw new TypeError(`grok_model_catalog_${code}:${path}`);
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("not_object", path);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail("not_plain", path);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail("unexpected_key", `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail("missing_key", `${path}.${key}`);
  }
  return record;
}

function boundedString(value: unknown, max: number, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail("invalid_string", path);
  return value;
}

function contextWindow(value: unknown, path: string): number {
  try {
    return parseGuildGrokContextWindow(value);
  } catch {
    return fail("invalid_context_window", path);
  }
}

/**
 * Strictly validates, copies and deep-freezes a catalog. Used for the value the ACP codec builds
 * and for the copy read back from the local cache, so a corrupted cache is rejected rather than
 * trusted.
 */
export function freezeGrokModelCatalog(input: unknown): GrokModelCatalog {
  const limits = GUILD_GROK_IDENTIFIER_LIMITS;
  const root = exactKeys(input, ["models"], ["runtimeDefaultModelId"], "$");
  if (!Array.isArray(root["models"]) || root["models"].length > limits.maxModels) {
    fail("invalid_models", "$.models");
  }
  const seen = new Set<string>();
  const models = (root["models"] as unknown[]).map((entry, index): GrokModelDescriptor => {
    const path = `$.models[${index}]`;
    const record = exactKeys(
      entry,
      ["id", "name", "reasoningEfforts", "contextWindows"],
      ["description", "agentType", "defaultContextWindow"],
      path,
    );
    const id = boundedString(record["id"], limits.modelIdLength, `${path}.id`);
    if (!isOfficialGrokModelId(id)) fail("unofficial_model", `${path}.id`);
    if (seen.has(id)) fail("duplicate_model", `${path}.id`);
    seen.add(id);
    const efforts = record["reasoningEfforts"];
    if (!Array.isArray(efforts) || efforts.length > limits.maxEffortsPerModel) {
      fail("invalid_efforts", `${path}.reasoningEfforts`);
    }
    const effortIds = new Set<string>();
    const reasoningEfforts = (efforts as unknown[]).map((effort, effortIndex) => {
      const effortPath = `${path}.reasoningEfforts[${effortIndex}]`;
      const item = exactKeys(effort, ["id", "label", "isDefault"], ["description"], effortPath);
      let effortId: string;
      try {
        effortId = parseGuildGrokReasoningEffort(item["id"]);
      } catch {
        return fail("invalid_effort_id", `${effortPath}.id`);
      }
      if (effortIds.has(effortId)) fail("duplicate_effort", `${effortPath}.id`);
      effortIds.add(effortId);
      if (typeof item["isDefault"] !== "boolean") fail("invalid_boolean", `${effortPath}.isDefault`);
      return Object.freeze({
        id: effortId,
        label: boundedString(item["label"], limits.maxEffortLabelLength, `${effortPath}.label`),
        ...(item["description"] === undefined
          ? {}
          : {
              description: boundedString(
                item["description"],
                limits.maxEffortDescriptionLength,
                `${effortPath}.description`,
              ),
            }),
        isDefault: item["isDefault"] as boolean,
      });
    });
    if (reasoningEfforts.filter((effort) => effort.isDefault).length > 1) {
      fail("multiple_default_efforts", `${path}.reasoningEfforts`);
    }
    const windows = record["contextWindows"];
    if (!Array.isArray(windows) || windows.length > limits.maxContextWindows) {
      fail("invalid_context_windows", `${path}.contextWindows`);
    }
    const contextWindows = (windows as unknown[]).map((window, windowIndex) =>
      contextWindow(window, `${path}.contextWindows[${windowIndex}]`));
    return Object.freeze({
      id,
      name: boundedString(record["name"], limits.maxNameLength, `${path}.name`),
      ...(record["description"] === undefined
        ? {}
        : {
            description: boundedString(
              record["description"],
              limits.maxDescriptionLength,
              `${path}.description`,
            ),
          }),
      ...(record["agentType"] === undefined
        ? {}
        : { agentType: boundedString(record["agentType"], 64, `${path}.agentType`) }),
      reasoningEfforts: Object.freeze(reasoningEfforts),
      contextWindows: Object.freeze(contextWindows),
      ...(record["defaultContextWindow"] === undefined
        ? {}
        : { defaultContextWindow: contextWindow(record["defaultContextWindow"], `${path}.defaultContextWindow`) }),
    });
  });
  let runtimeDefaultModelId: string | undefined;
  if (root["runtimeDefaultModelId"] !== undefined) {
    runtimeDefaultModelId = boundedString(
      root["runtimeDefaultModelId"],
      limits.modelIdLength,
      "$.runtimeDefaultModelId",
    );
    if (!seen.has(runtimeDefaultModelId)) fail("unknown_default_model", "$.runtimeDefaultModelId");
  }
  return Object.freeze({
    models: Object.freeze(models),
    ...(runtimeDefaultModelId === undefined ? {} : { runtimeDefaultModelId }),
  });
}

/** Model and effort the session reports as selected, read from its official config options. */
export type SessionModelSelection = Readonly<{
  modelId?: GuildGrokModel;
  reasoningEffort?: GuildGrokReasoningEffort;
}>;

type SelectionOptionLike = Readonly<{
  id: string;
  category?: string | null;
  type: string;
  currentValue: string | boolean;
  choices?: unknown;
}>;

/** The official `model` (category `model`) and `reasoning_effort` (category `thought_level`) options. */
export function selectionOptionsOf<Option extends SelectionOptionLike>(
  options: readonly Option[],
): { readonly model?: Option; readonly effort?: Option } {
  const model = options.find((option) => option.category === "model" && option.type === "select");
  const effort = options.find((option) => option.category === "thought_level" && option.type === "select");
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

export function sessionSelectionOf(options: readonly SelectionOptionLike[]): SessionModelSelection {
  const { model, effort } = selectionOptionsOf(options);
  return Object.freeze({
    ...(typeof model?.currentValue === "string" ? { modelId: model.currentValue } : {}),
    ...(typeof effort?.currentValue === "string" ? { reasoningEffort: effort.currentValue } : {}),
  });
}
