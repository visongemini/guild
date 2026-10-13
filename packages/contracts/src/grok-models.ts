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
 *
 * Guild 3.0 (PC-ENG-001, PC-MODEL-001): the same catalog shape now also describes the Claude
 * engine, and in 3.1 every add-on engine (Codex, Gemini). A catalog and each of its models carry an `engine` / `group` label, the model id grammar
 * is chosen per engine (`parseGuildModelId`), and `freezeModelCatalog(engine, ...)` validates either.
 * The Grok-era names below keep their meaning and behavior for the Grok engine.
 */

import {
  GUILD_CLAUDE_IDENTIFIER_LIMITS,
  isClaudeModelId,
  modelGroupsOfEngine,
  parseGuildClaudeReasoningEffort,
  type GuildEngine,
  type ModelGroup,
} from "./engines.js";

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

/**
 * Model id of a task or default on `engine`. Grok ids must also pass the D-011 official-model
 * policy; Claude ids follow the Claude grammar and may name an Online / Local model.
 */
export function parseGuildModelId(engine: GuildEngine, value: unknown): string {
  if (engine === "grok") return parseGuildGrokModel(value);
  if (typeof value !== "string" || !isClaudeModelId(value)) {
    throw new TypeError(`invalid_${engine}_model`);
  }
  return value;
}

/**
 * Boundary check for a request that names a task but not its engine (`setTaskRuntimeSettings`): the
 * wider Claude grammar applies, because every Grok id is also a valid Claude id. The rule of the
 * task's own engine is enforced where the engine is known: `parseGuildModelId` in main and the store.
 */
export function parseGuildModelIdOfAnyEngine(value: unknown): string {
  if (typeof value !== "string" || !isClaudeModelId(value)) {
    throw new TypeError("invalid_model_id");
  }
  return value;
}

export function isModelIdOfEngine(engine: GuildEngine, id: string): boolean {
  return engine === "grok" ? isOfficialGrokModelId(id) : isClaudeModelId(id);
}

export function parseGuildReasoningEffort(engine: GuildEngine, value: unknown): string {
  if (engine === "grok") return parseGuildGrokReasoningEffort(value);
  try {
    return parseGuildClaudeReasoningEffort(value);
  } catch {
    throw new TypeError(`invalid_${engine}_reasoning_effort`);
  }
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

export type ModelDescriptor = Readonly<{
  id: GuildGrokModel;
  /** Official display name, for example "Grok 4.7 Fast". */
  name: string;
  /** Official description, for example "Fast variant. 2x the price." */
  description?: string;
  agentType?: string;
  /**
   * Picker group (PC-MODEL-001). Always present in a Claude catalog; absent in a Grok catalog (the
   * Grok-era shape), where it means `"grok"`.
   */
  group?: ModelGroup;
  /** Empty when the model does not accept a reasoning effort. */
  reasoningEfforts: readonly GrokReasoningEffortDescriptor[];
  contextWindows: readonly number[];
  defaultContextWindow?: number;
  /** An Online or Local model its source states accepts images; absent when the source says nothing. */
  supportsImages?: true;
}>;

export type ModelCatalog = Readonly<{
  /**
   * Engine the models belong to. Always present in a Claude catalog; absent in a Grok catalog (the
   * Grok-era shape), where it means `"grok"`.
   */
  engine?: GuildEngine;
  models: readonly ModelDescriptor[];
  /** The model the engine itself had selected when the list was captured. */
  runtimeDefaultModelId?: GuildGrokModel;
}>;

/** Grok-era names: the same shapes, kept so existing code compiles unchanged. */
export type GrokModelDescriptor = ModelDescriptor;
export type GrokModelCatalog = ModelCatalog;

export const EMPTY_GROK_MODEL_CATALOG: GrokModelCatalog = Object.freeze({
  models: Object.freeze([]),
});

export const EMPTY_CLAUDE_MODEL_CATALOG: ModelCatalog = Object.freeze({
  engine: "claude",
  models: Object.freeze([]),
});

export const EMPTY_CODEX_MODEL_CATALOG: ModelCatalog = Object.freeze({
  engine: "codex",
  models: Object.freeze([]),
});

export const EMPTY_GEMINI_MODEL_CATALOG: ModelCatalog = Object.freeze({
  engine: "gemini",
  models: Object.freeze([]),
});

/** The empty catalog of `engine`: what a picker shows before any session of that engine reported a list. */
export function emptyModelCatalogOf(engine: GuildEngine): ModelCatalog {
  switch (engine) {
    case "claude": return EMPTY_CLAUDE_MODEL_CATALOG;
    case "codex": return EMPTY_CODEX_MODEL_CATALOG;
    case "gemini": return EMPTY_GEMINI_MODEL_CATALOG;
    case "grok": return EMPTY_GROK_MODEL_CATALOG;
  }
}

export function modelCatalogEngineOf(catalog: ModelCatalog): GuildEngine {
  return catalog.engine ?? "grok";
}

export function modelGroupOf(model: ModelDescriptor): ModelGroup {
  return model.group ?? "grok";
}

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

/** The Claude adapter's own alias for "whatever Claude Code picks": the Default row of the Claude list. */
export const CLAUDE_DEFAULT_MODEL_ID = "default";

/** What a model name looks like as a plain description: capitalized words, a version, maybe a short note. */
const MODEL_NAME_TEXT = /^[A-Z][A-Za-z-]*(?: [A-Z][A-Za-z-]*){0,2} \d+(?:\.\d+)*(?: \([^()]{1,32}\))?$/u;

/**
 * The adapter's description of the Claude Default row when it reads like a model name ("Opus 5.5"), else
 * undefined. The picker names the row after it, and so does the record of which model answered a turn.
 */
export function modelNameFromDescription(description: string | undefined): string | undefined {
  const text = description?.trim();
  return text !== undefined && text.length <= 48 && MODEL_NAME_TEXT.test(text) ? text : undefined;
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

type CatalogFail = (code: string, path: string) => never;

function catalogFailure(engine: GuildEngine): CatalogFail {
  return (code, path) => {
    throw new TypeError(`${engine}_model_catalog_${code}:${path}`);
  };
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  fail: CatalogFail,
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

function boundedString(value: unknown, max: number, path: string, fail: CatalogFail): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail("invalid_string", path);
  return value;
}

function contextWindow(value: unknown, path: string, fail: CatalogFail): number {
  try {
    return parseGuildGrokContextWindow(value);
  } catch {
    return fail("invalid_context_window", path);
  }
}

function catalogLimits(engine: GuildEngine) {
  const limits = GUILD_GROK_IDENTIFIER_LIMITS;
  return engine === "grok"
    ? limits
    : {
        ...limits,
        modelIdLength: GUILD_CLAUDE_IDENTIFIER_LIMITS.modelIdLength,
        maxModels: GUILD_CLAUDE_IDENTIFIER_LIMITS.maxModels,
      };
}

/**
 * Strictly validates, copies and deep-freezes the catalog of `engine`. Used for the value a codec
 * builds and for the copy read back from the local cache, so a corrupted cache is rejected rather
 * than trusted. A root `engine` and a per-model `group` are optional in the input (a cache written
 * before Guild 3.0 has neither) and must agree with the engine when present. Grok-engine ids must
 * pass the D-011 official-model policy.
 *
 * A Claude catalog always carries `engine: "claude"` and a `group` on every model. A Grok catalog
 * keeps its Grok-era shape, byte for byte: no labels, so every existing consumer and cached value is
 * unchanged, and an absent label means grok (`modelCatalogEngineOf`, `modelGroupOf`).
 */
export function freezeModelCatalog(engine: GuildEngine, input: unknown): ModelCatalog {
  const fail = catalogFailure(engine);
  const limits = catalogLimits(engine);
  const groups = modelGroupsOfEngine(engine);
  const root = exactKeys(input, ["models"], ["runtimeDefaultModelId", "engine"], "$", fail);
  if (root["engine"] !== undefined && root["engine"] !== engine) fail("engine_mismatch", "$.engine");
  if (!Array.isArray(root["models"]) || root["models"].length > limits.maxModels) {
    fail("invalid_models", "$.models");
  }
  const seen = new Set<string>();
  const models = (root["models"] as unknown[]).map((entry, index): ModelDescriptor => {
    const path = `$.models[${index}]`;
    const record = exactKeys(
      entry,
      ["id", "name", "reasoningEfforts", "contextWindows"],
      ["description", "agentType", "defaultContextWindow", "group", "supportsImages"],
      path,
      fail,
    );
    const id = boundedString(record["id"], limits.modelIdLength, `${path}.id`, fail);
    if (!isModelIdOfEngine(engine, id)) {
      fail(engine === "grok" ? "unofficial_model" : "invalid_model", `${path}.id`);
    }
    if (seen.has(id)) fail("duplicate_model", `${path}.id`);
    seen.add(id);
    let group: ModelGroup = groups[0]!;
    if (record["group"] !== undefined) {
      if (typeof record["group"] !== "string" || !(groups as readonly string[]).includes(record["group"])) {
        fail("invalid_group", `${path}.group`);
      }
      group = record["group"] as ModelGroup;
    }
    const efforts = record["reasoningEfforts"];
    if (!Array.isArray(efforts) || efforts.length > limits.maxEffortsPerModel) {
      fail("invalid_efforts", `${path}.reasoningEfforts`);
    }
    const effortIds = new Set<string>();
    const reasoningEfforts = (efforts as unknown[]).map((effort, effortIndex) => {
      const effortPath = `${path}.reasoningEfforts[${effortIndex}]`;
      const item = exactKeys(effort, ["id", "label", "isDefault"], ["description"], effortPath, fail);
      let effortId: string;
      try {
        effortId = parseGuildReasoningEffort(engine, item["id"]);
      } catch {
        return fail("invalid_effort_id", `${effortPath}.id`);
      }
      if (effortIds.has(effortId)) fail("duplicate_effort", `${effortPath}.id`);
      effortIds.add(effortId);
      if (typeof item["isDefault"] !== "boolean") fail("invalid_boolean", `${effortPath}.isDefault`);
      return Object.freeze({
        id: effortId,
        label: boundedString(item["label"], limits.maxEffortLabelLength, `${effortPath}.label`, fail),
        ...(item["description"] === undefined
          ? {}
          : {
              description: boundedString(
                item["description"],
                limits.maxEffortDescriptionLength,
                `${effortPath}.description`,
                fail,
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
      contextWindow(window, `${path}.contextWindows[${windowIndex}]`, fail));
    return Object.freeze({
      id,
      name: boundedString(record["name"], limits.maxNameLength, `${path}.name`, fail),
      ...(record["description"] === undefined
        ? {}
        : {
            description: boundedString(
              record["description"],
              limits.maxDescriptionLength,
              `${path}.description`,
              fail,
            ),
          }),
      ...(record["agentType"] === undefined
        ? {}
        : { agentType: boundedString(record["agentType"], 64, `${path}.agentType`, fail) }),
      ...(engine === "grok" ? {} : { group }),
      reasoningEfforts: Object.freeze(reasoningEfforts),
      contextWindows: Object.freeze(contextWindows),
      ...(record["defaultContextWindow"] === undefined
        ? {}
        : {
            defaultContextWindow: contextWindow(
              record["defaultContextWindow"],
              `${path}.defaultContextWindow`,
              fail,
            ),
          }),
      ...(record["supportsImages"] === undefined
        ? {}
        : record["supportsImages"] === true
          ? { supportsImages: true as const }
          : fail("invalid_boolean", `${path}.supportsImages`)),
    });
  });
  let runtimeDefaultModelId: string | undefined;
  if (root["runtimeDefaultModelId"] !== undefined) {
    runtimeDefaultModelId = boundedString(
      root["runtimeDefaultModelId"],
      limits.modelIdLength,
      "$.runtimeDefaultModelId",
      fail,
    );
    if (!seen.has(runtimeDefaultModelId)) fail("unknown_default_model", "$.runtimeDefaultModelId");
  }
  return Object.freeze({
    ...(engine === "grok" ? {} : { engine }),
    models: Object.freeze(models),
    ...(runtimeDefaultModelId === undefined ? {} : { runtimeDefaultModelId }),
  });
}

/** The Grok engine's catalog (D-011: only `grok-*` models). */
export function freezeGrokModelCatalog(input: unknown): GrokModelCatalog {
  return freezeModelCatalog("grok", input);
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
