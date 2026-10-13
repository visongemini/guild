import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CLAUDE_MODEL_CATALOG,
  EMPTY_CODEX_MODEL_CATALOG,
  EMPTY_GEMINI_MODEL_CATALOG,
  EMPTY_GROK_MODEL_CATALOG,
  emptyModelCatalogOf,
  defaultReasoningEffortOf,
  freezeGrokModelCatalog,
  freezeModelCatalog,
  grokModelById,
  isOfficialGrokModelId,
  modelCatalogEngineOf,
  modelGroupOf,
  modelSupportsReasoningEffort,
  parseGuildGrokContextWindow,
  parseGuildGrokModel,
  parseGuildGrokReasoningEffort,
  resolveEffectiveSelection,
  runtimeDefaultModelOf,
  selectionOptionsOf,
  sessionSelectionOf,
  type GrokModelCatalog,
} from "./grok-models.js";

const effort = (id: string, isDefault = false) => ({ id, label: id.toUpperCase(), description: `${id} d`, isDefault });
const rawCatalog = {
  runtimeDefaultModelId: "grok-4.7",
  models: [
    { id: "grok-4.7", name: "Grok 4.7", description: "frontier", reasoningEfforts: [effort("xhigh"), effort("high", true), effort("medium"), effort("low")], contextWindows: [256_000, 500_000], defaultContextWindow: 256_000, agentType: "grok-build-plan" },
    { id: "grok-4.7-build-fast", name: "Grok 4.7 Fast", description: "Fast variant. 2x the price.", reasoningEfforts: [effort("high", true)], contextWindows: [256_000] },
    { id: "grok-4.5", name: "Grok 4.5", reasoningEfforts: [effort("high", true), effort("medium"), effort("low")], contextWindows: [] },
    { id: "grok-plain", name: "No efforts", reasoningEfforts: [], contextWindows: [] },
  ],
};

test("model ids and efforts are bounded identifiers, with xAI models only (D-011)", () => {
  for (const good of ["grok-4.7", "grok-4.7-build-fast", "grok-5", "grok-code_fast:1", `grok-${"x".repeat(59)}`]) {
    assert.equal(parseGuildGrokModel(good), good);
    assert.equal(isOfficialGrokModelId(good), true);
  }
  for (const bad of [
    "", "grok-", "Grok-4.7", "MiniMax-M3", "ornith-1.5", "grok 4.7", "grok-4.7/x", "grok-4.7;", "grok-é",
    `grok-${"x".repeat(60)}`, "../grok-4.7", "grok-4.7\n", 4, null, undefined, {}, ["grok-4.7"],
  ]) {
    assert.throws(() => parseGuildGrokModel(bad), /invalid_grok_model/u, String(bad));
    if (typeof bad === "string") assert.equal(isOfficialGrokModelId(bad), false, bad);
  }
  for (const good of ["xhigh", "high", "low", "ultra", "a", "max-2", "very_high"]) {
    assert.equal(parseGuildGrokReasoningEffort(good), good);
  }
  for (const bad of ["", "High", "1x", "-x", "x y", "a".repeat(33), 1, null]) {
    assert.throws(() => parseGuildGrokReasoningEffort(bad), /invalid_grok_reasoning_effort/u, String(bad));
  }
  assert.equal(parseGuildGrokContextWindow(500_000), 500_000);
  for (const bad of [0, -1, 1.5, 100_000_001, "500000", Number.NaN, null]) {
    assert.throws(() => parseGuildGrokContextWindow(bad), /invalid_grok_context_window/u, String(bad));
  }
});

test("a catalog is validated strictly, copied and deep-frozen", () => {
  const catalog = freezeGrokModelCatalog(rawCatalog);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.models[0]), true);
  assert.equal(Object.isFrozen(catalog.models[0]?.reasoningEfforts[0]), true);
  assert.deepEqual(catalog.models.map((model) => model.id), ["grok-4.7", "grok-4.7-build-fast", "grok-4.5", "grok-plain"]);
  assert.deepEqual(freezeGrokModelCatalog(JSON.parse(JSON.stringify(catalog))), catalog, "round trips through the JSON cache");
  assert.deepEqual(freezeGrokModelCatalog({ models: [] }), EMPTY_GROK_MODEL_CATALOG);

  const mutate = (change: (copy: typeof rawCatalog) => void): unknown => {
    const copy = JSON.parse(JSON.stringify(rawCatalog)) as typeof rawCatalog;
    change(copy);
    return copy;
  };
  const rejected: Array<[string, unknown]> = [
    ["not an object", "catalog"],
    ["extra root key", { ...rawCatalog, extra: 1 }],
    ["unofficial model", mutate((c) => { c.models[0]!.id = "MiniMax-M3"; })],
    ["duplicate model", mutate((c) => { c.models[1]!.id = "grok-4.7"; })],
    ["default not in list", { ...rawCatalog, runtimeDefaultModelId: "grok-9" }],
    ["two default efforts", mutate((c) => { c.models[0]!.reasoningEfforts[0]!.isDefault = true; })],
    ["duplicate effort", mutate((c) => { c.models[0]!.reasoningEfforts[1]!.id = "xhigh"; })],
    ["bad effort id", mutate((c) => { c.models[0]!.reasoningEfforts[0]!.id = "Extra High"; })],
    ["extra model key", mutate((c) => { (c.models[0] as Record<string, unknown>)["secret"] = "x"; })],
    ["empty name", mutate((c) => { c.models[0]!.name = ""; })],
    ["long description", mutate((c) => { c.models[0]!.description = "d".repeat(513); })],
    ["too many windows", mutate((c) => { c.models[0]!.contextWindows = [1, 2, 3, 4, 5]; })],
    ["bad window", mutate((c) => { c.models[0]!.contextWindows = [0]; })],
    ["too many models", { models: Array.from({ length: 33 }, (_, i) => ({ id: `grok-${i}`, name: "n", reasoningEfforts: [], contextWindows: [] })) }],
  ];
  for (const [label, value] of rejected) {
    assert.throws(() => freezeGrokModelCatalog(value), /grok_model_catalog_/u, label);
  }
});

test("helpers read defaults, effort support and the runtime default from the catalog", () => {
  const catalog = freezeGrokModelCatalog(rawCatalog);
  assert.equal(runtimeDefaultModelOf(catalog)?.id, "grok-4.7");
  assert.equal(runtimeDefaultModelOf({ models: catalog.models })?.id, "grok-4.7", "falls back to the first model");
  assert.equal(runtimeDefaultModelOf(undefined), undefined);
  assert.equal(runtimeDefaultModelOf(EMPTY_GROK_MODEL_CATALOG), undefined);
  assert.equal(defaultReasoningEffortOf(grokModelById(catalog, "grok-4.5")), "high");
  assert.equal(defaultReasoningEffortOf(grokModelById(catalog, "grok-plain")), undefined);
  assert.equal(modelSupportsReasoningEffort(grokModelById(catalog, "grok-4.5"), "xhigh"), false);
  assert.equal(modelSupportsReasoningEffort(grokModelById(catalog, "grok-4.7"), "xhigh"), true);
  assert.equal(grokModelById(catalog, "nope"), undefined);
  assert.equal(grokModelById(catalog, null), undefined);
});

test("selection is task override, then global default, then the runtime default, and always a valid pair", () => {
  const catalog: GrokModelCatalog = freezeGrokModelCatalog(rawCatalog);
  const none = { modelId: null, reasoningEffort: null } as const;
  assert.deepEqual(resolveEffectiveSelection({ global: none, catalog }), {
    modelId: "grok-4.7", reasoningEffort: "high", source: "runtime",
  });
  assert.deepEqual(resolveEffectiveSelection({ global: none }), {
    modelId: null, reasoningEffort: null, source: "runtime",
  });
  assert.deepEqual(resolveEffectiveSelection({ global: { modelId: "grok-4.5", reasoningEffort: "low" }, catalog }), {
    modelId: "grok-4.5", reasoningEffort: "low", source: "global",
  });
  assert.deepEqual(resolveEffectiveSelection({
    task: { modelId: "grok-4.7", reasoningEffort: "xhigh" },
    global: { modelId: "grok-4.5", reasoningEffort: "low" },
    catalog,
  }), { modelId: "grok-4.7", reasoningEffort: "xhigh", source: "task" });
  // A pinned effort the selected model does not offer is replaced by that model's default.
  assert.deepEqual(resolveEffectiveSelection({
    task: { modelId: "grok-4.5", reasoningEffort: "xhigh" }, global: none, catalog,
  }), { modelId: "grok-4.5", reasoningEffort: "high", source: "task" });
  // A model without efforts has none.
  assert.deepEqual(resolveEffectiveSelection({
    global: { modelId: "grok-plain", reasoningEffort: "high" }, catalog,
  }), { modelId: "grok-plain", reasoningEffort: null, source: "global" });
  // Task effort only: model still comes from the global default.
  assert.deepEqual(resolveEffectiveSelection({
    task: { modelId: null, reasoningEffort: "low" }, global: { modelId: "grok-4.5", reasoningEffort: null }, catalog,
  }), { modelId: "grok-4.5", reasoningEffort: "low", source: "task" });
  // Without a catalog the pinned values are kept as they are.
  assert.deepEqual(resolveEffectiveSelection({ global: { modelId: "grok-4.6", reasoningEffort: "xhigh" } }), {
    modelId: "grok-4.6", reasoningEffort: "xhigh", source: "global",
  });
});

test("the session's own official options give its model and effort", () => {
  const options = [
    { id: "model", category: "model", type: "select", currentValue: "grok-4.7" },
    { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "low" },
    { id: "web", category: null, type: "boolean", currentValue: true },
  ] as const;
  assert.deepEqual(sessionSelectionOf(options), { modelId: "grok-4.7", reasoningEffort: "low" });
  assert.equal(selectionOptionsOf(options).model?.id, "model");
  assert.equal(selectionOptionsOf(options).effort?.id, "reasoning_effort");
  assert.deepEqual(sessionSelectionOf([]), {});
  assert.deepEqual(sessionSelectionOf([{ id: "model", category: "model", type: "boolean", currentValue: true }]), {});
});

const claudeRaw = {
  runtimeDefaultModelId: "default",
  models: [
    { id: "default", name: "Default", reasoningEfforts: [effort("high", true), effort("low")], contextWindows: [] },
    { id: "opus", name: "Opus", group: "claude", reasoningEfforts: [effort("max"), effort("high", true)], contextWindows: [200_000, 1_000_000] },
    { id: "claude-fable-5-1[1m]", name: "Fable 5.1 (1M)", group: "claude", reasoningEfforts: [], contextWindows: [1_000_000] },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", group: "online", reasoningEfforts: [], contextWindows: [128_000] },
    { id: "local-27b-model", name: "Local 27B", group: "local", reasoningEfforts: [], contextWindows: [] },
  ],
};

test("a Grok catalog keeps its Grok-era shape: no labels, and an absent label means grok (PC-MODEL-001)", () => {
  const catalog = freezeGrokModelCatalog(rawCatalog);
  assert.equal(Object.hasOwn(catalog, "engine"), false);
  assert.equal(catalog.models.some((model) => Object.hasOwn(model, "group")), false);
  assert.equal(modelCatalogEngineOf(catalog), "grok");
  assert.deepEqual(catalog.models.map((model) => modelGroupOf(model)), ["grok", "grok", "grok", "grok"]);
  assert.deepEqual(freezeModelCatalog("grok", rawCatalog), catalog, "the generic entry point agrees");
  assert.deepEqual(EMPTY_GROK_MODEL_CATALOG, { models: [] });
  // A cache written after labelling, or by hand, normalizes to the same value.
  const labelled = {
    ...rawCatalog,
    engine: "grok",
    models: rawCatalog.models.map((model) => ({ ...model, group: "grok" })),
  };
  assert.deepEqual(freezeGrokModelCatalog(labelled), catalog);
  assert.throws(() => freezeGrokModelCatalog({ ...rawCatalog, engine: "claude" }), /grok_model_catalog_engine_mismatch/u);
  const withGroup = (group: unknown) => ({
    models: [{ ...rawCatalog.models[3]!, group }],
  });
  for (const group of ["claude", "online", "local", "", 1, null]) {
    assert.throws(() => freezeGrokModelCatalog(withGroup(group)), /grok_model_catalog_invalid_group/u, String(group));
  }
  // Hand-built values keep their Grok-era meaning too.
  assert.equal(modelCatalogEngineOf({ models: [] }), "grok");
  assert.equal(modelGroupOf({ id: "grok-4.7", name: "n", reasoningEfforts: [], contextWindows: [] }), "grok");
  assert.equal(modelGroupOf({ id: "opus", name: "n", group: "claude", reasoningEfforts: [], contextWindows: [] }), "claude");
});

test("a Claude catalog follows the Claude id grammar and carries claude, online and local groups", () => {
  const catalog = freezeModelCatalog("claude", claudeRaw);
  assert.equal(catalog.engine, "claude");
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.models[1]), true);
  assert.deepEqual(catalog.models.map((model) => [model.id, model.group]), [
    ["default", "claude"],
    ["opus", "claude"],
    ["claude-fable-5-1[1m]", "claude"],
    ["deepseek-v4-flash", "online"],
    ["local-27b-model", "local"],
  ]);
  assert.equal(runtimeDefaultModelOf(catalog)?.id, "default");
  assert.equal(defaultReasoningEffortOf(grokModelById(catalog, "opus")), "high");
  assert.deepEqual(freezeModelCatalog("claude", JSON.parse(JSON.stringify(catalog))), catalog, "round trips through the JSON cache");
  assert.deepEqual(freezeModelCatalog("claude", { models: [] }), EMPTY_CLAUDE_MODEL_CATALOG);
  assert.equal(EMPTY_CLAUDE_MODEL_CATALOG.engine, "claude");

  const mutate = (change: (copy: typeof claudeRaw) => void): unknown => {
    const copy = JSON.parse(JSON.stringify(claudeRaw)) as typeof claudeRaw;
    change(copy);
    return copy;
  };
  const rejected: Array<[string, RegExp, unknown]> = [
    ["a space in an id", /claude_model_catalog_invalid_model/u, mutate((c) => { c.models[1]!.id = "claude opus"; })],
    ["a slash in an id", /claude_model_catalog_invalid_model/u, mutate((c) => { c.models[1]!.id = "claude/opus"; })],
    ["a 129 character id", /claude_model_catalog_invalid_string/u, mutate((c) => { c.models[1]!.id = "x".repeat(129); })],
    ["the grok group", /claude_model_catalog_invalid_group/u, mutate((c) => { (c.models[1] as Record<string, unknown>)["group"] = "grok"; })],
    ["an unknown group", /claude_model_catalog_invalid_group/u, mutate((c) => { (c.models[1] as Record<string, unknown>)["group"] = "remote"; })],
    ["a duplicate id", /claude_model_catalog_duplicate_model/u, mutate((c) => { c.models[2]!.id = "opus"; })],
    ["a default not in the list", /claude_model_catalog_unknown_default_model/u, { ...claudeRaw, runtimeDefaultModelId: "sonnet" }],
    ["a grok engine label", /claude_model_catalog_engine_mismatch/u, { ...claudeRaw, engine: "grok" }],
    ["an extra root key", /claude_model_catalog_unexpected_key/u, { ...claudeRaw, extra: 1 }],
    ["a bad effort id", /claude_model_catalog_invalid_effort_id/u, mutate((c) => { c.models[0]!.reasoningEfforts[0]!.id = "High"; })],
  ];
  for (const [label, pattern, value] of rejected) {
    assert.throws(() => freezeModelCatalog("claude", value), pattern, label);
  }
  // The same data is not a Grok catalog: Claude ids do not pass the D-011 policy.
  assert.throws(() => freezeModelCatalog("grok", claudeRaw), /grok_model_catalog_unofficial_model/u);
  assert.throws(() => freezeGrokModelCatalog(claudeRaw), /grok_model_catalog_/u);
});

const codexRaw = {
  engine: "codex",
  runtimeDefaultModelId: "gpt-6.1-sol",
  models: [
    { id: "gpt-6.1-sol", name: "6.1 Sol", group: "codex", description: "Latest workhorse model.", reasoningEfforts: [effort("low"), effort("high", true), effort("ultra")], contextWindows: [] },
    { id: "gpt-5.6-luna", name: "5.6 Luna", group: "codex", reasoningEfforts: [effort("low"), effort("max")], contextWindows: [] },
  ],
};

test("a Codex catalog uses the shared adapter grammar and only the codex group (PC-ENG-003, PC-MODEL-001)", () => {
  const catalog = freezeModelCatalog("codex", codexRaw);
  assert.equal(catalog.engine, "codex");
  assert.equal(modelCatalogEngineOf(catalog), "codex");
  assert.deepEqual(catalog.models.map((model) => [model.id, modelGroupOf(model)]), [
    ["gpt-6.1-sol", "codex"],
    ["gpt-5.6-luna", "codex"],
  ]);
  assert.equal(runtimeDefaultModelOf(catalog)?.id, "gpt-6.1-sol");
  assert.equal(defaultReasoningEffortOf(grokModelById(catalog, "gpt-6.1-sol")), "high");
  assert.deepEqual(freezeModelCatalog("codex", JSON.parse(JSON.stringify(catalog))), catalog, "round trips through the JSON cache");
  // An absent label defaults to the engine's own group.
  const unlabelled = freezeModelCatalog("codex", { models: [{ id: "gpt-6-sol", name: "n", reasoningEfforts: [], contextWindows: [] }] });
  assert.equal(unlabelled.models[0]!.group, "codex");
  assert.deepEqual(freezeModelCatalog("codex", { models: [] }), EMPTY_CODEX_MODEL_CATALOG);
  assert.equal(emptyModelCatalogOf("codex"), EMPTY_CODEX_MODEL_CATALOG);
  assert.equal(emptyModelCatalogOf("claude"), EMPTY_CLAUDE_MODEL_CATALOG);
  assert.equal(emptyModelCatalogOf("grok"), EMPTY_GROK_MODEL_CATALOG);

  const withModel = (patch: Record<string, unknown>) => ({
    models: [{ id: "gpt-6-sol", name: "n", reasoningEfforts: [], contextWindows: [], ...patch }],
  });
  for (const [label, pattern, value] of [
    ["the claude group", /codex_model_catalog_invalid_group/u, withModel({ group: "claude" })],
    ["an online group", /codex_model_catalog_invalid_group/u, withModel({ group: "online" })],
    ["a space in an id", /codex_model_catalog_invalid_model/u, withModel({ id: "gpt 6" })],
    ["a claude engine label", /codex_model_catalog_engine_mismatch/u, { ...codexRaw, engine: "claude" }],
    ["a default not in the list", /codex_model_catalog_unknown_default_model/u, { ...codexRaw, runtimeDefaultModelId: "gpt-9" }],
    ["a bad effort id", /codex_model_catalog_invalid_effort_id/u, withModel({ reasoningEfforts: [effort("Ultra")] })],
  ] as Array<[string, RegExp, unknown]>) {
    assert.throws(() => freezeModelCatalog("codex", value), pattern, label);
  }
  // A Claude catalog does not take the codex group, and a Grok catalog does not take codex ids.
  assert.throws(() => freezeModelCatalog("claude", { models: [{ id: "opus", name: "n", group: "codex", reasoningEfforts: [], contextWindows: [] }] }), /claude_model_catalog_invalid_group/u);
  assert.throws(() => freezeModelCatalog("grok", codexRaw), /grok_model_catalog_/u);
});

const geminiRaw = {
  engine: "gemini",
  runtimeDefaultModelId: "gemini-3.5-flash-lite",
  models: [
    { id: "gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite", group: "gemini", reasoningEfforts: [], contextWindows: [] },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview", group: "gemini", description: "Pro", reasoningEfforts: [], contextWindows: [] },
  ],
};

test("a Gemini catalog uses the shared adapter grammar, only the gemini group and no efforts (PC-ENG-004, PC-MODEL-001)", () => {
  const catalog = freezeModelCatalog("gemini", geminiRaw);
  assert.equal(catalog.engine, "gemini");
  assert.equal(modelCatalogEngineOf(catalog), "gemini");
  assert.deepEqual(catalog.models.map((model) => [model.id, modelGroupOf(model)]), [
    ["gemini-3.5-flash-lite", "gemini"],
    ["gemini-3.1-pro-preview", "gemini"],
  ]);
  assert.equal(runtimeDefaultModelOf(catalog)?.id, "gemini-3.5-flash-lite");
  assert.equal(defaultReasoningEffortOf(grokModelById(catalog, "gemini-3.5-flash-lite")), undefined);
  assert.deepEqual(freezeModelCatalog("gemini", JSON.parse(JSON.stringify(catalog))), catalog, "round trips through the JSON cache");
  assert.equal(freezeModelCatalog("gemini", { models: [{ id: "gemini-2.5-pro", name: "n", reasoningEfforts: [], contextWindows: [] }] }).models[0]!.group, "gemini");
  assert.deepEqual(freezeModelCatalog("gemini", { models: [] }), EMPTY_GEMINI_MODEL_CATALOG);
  assert.equal(emptyModelCatalogOf("gemini"), EMPTY_GEMINI_MODEL_CATALOG);
  for (const [label, pattern, value] of [
    ["the codex group", /gemini_model_catalog_invalid_group/u, { models: [{ id: "gemini-2.5-pro", name: "n", group: "codex", reasoningEfforts: [], contextWindows: [] }] }],
    ["a space in an id", /gemini_model_catalog_invalid_model/u, { models: [{ id: "gemini 2", name: "n", reasoningEfforts: [], contextWindows: [] }] }],
    ["a codex engine label", /gemini_model_catalog_engine_mismatch/u, { ...geminiRaw, engine: "codex" }],
    ["a default not in the list", /gemini_model_catalog_unknown_default_model/u, { ...geminiRaw, runtimeDefaultModelId: "auto" }],
  ] as Array<[string, RegExp, unknown]>) {
    assert.throws(() => freezeModelCatalog("gemini", value), pattern, label);
  }
  assert.throws(() => freezeModelCatalog("codex", geminiRaw), /codex_model_catalog_engine_mismatch/u);
  assert.throws(() => freezeModelCatalog("grok", geminiRaw), /grok_model_catalog_/u);
});

test("a Claude catalog may hold native models plus the models of every source, a Grok catalog stays at 32", () => {
  const many = (count: number, prefix: string) => ({
    models: Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${i}`, name: "n", reasoningEfforts: [], contextWindows: [],
    })),
  });
  assert.equal(freezeModelCatalog("claude", many(256, "model-")).models.length, 256);
  assert.throws(() => freezeModelCatalog("claude", many(257, "model-")), /claude_model_catalog_invalid_models/u);
  assert.equal(freezeModelCatalog("grok", many(32, "grok-")).models.length, 32);
  assert.throws(() => freezeModelCatalog("grok", many(33, "grok-")), /grok_model_catalog_invalid_models/u);
});
