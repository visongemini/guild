import { freezeGrokModelCatalog, freezeModelCatalog, type GrokModelCatalog, type ModelCatalog } from "@guild/contracts";

/**
 * Shared test fixture: the catalog the official runtime advertised on 2026-10-09 (names, labels and
 * descriptions are its own strings). Not production code; never imported by the app.
 */
const efforts = (withXhigh: boolean) => [
  ...(withXhigh
    ? [{ id: "xhigh", label: "Extra High", description: "Maximum reasoning for the hardest tasks.", isDefault: false }]
    : []),
  { id: "high", label: "High", description: "Thorough reasoning and quality. Recommended.", isDefault: true },
  { id: "medium", label: "Medium", isDefault: false },
  { id: "low", label: "Low", isDefault: false },
];

export const REAL_CATALOG: GrokModelCatalog = freezeGrokModelCatalog({
  models: [
    {
      id: "grok-4.7",
      name: "Grok 4.7",
      description: "SpaceXAI's latest frontier model",
      reasoningEfforts: efforts(true),
      contextWindows: [256000, 500000],
    },
    {
      id: "grok-4.7-build-fast",
      name: "Grok 4.7 Fast",
      description: "Fast variant. 2x the price.",
      reasoningEfforts: efforts(true),
      contextWindows: [256000, 500000],
    },
    { id: "grok-4.6", name: "Grok 4.6", reasoningEfforts: efforts(true), contextWindows: [256000] },
    { id: "grok-4.5", name: "Grok 4.5", reasoningEfforts: efforts(false), contextWindows: [256000] },
  ],
  runtimeDefaultModelId: "grok-4.7",
});

const claudeEfforts = [
  { id: "default", label: "Default", isDefault: true },
  { id: "low", label: "Low", isDefault: false },
  { id: "medium", label: "Medium", isDefault: false },
  { id: "high", label: "High", isDefault: false },
  { id: "xhigh", label: "Extra High", isDefault: false },
  { id: "max", label: "Max", isDefault: false },
];

/**
 * A Claude-engine catalog as the main process builds it: the adapter's own models (group `claude`) plus the
 * enabled Online and Local model-source models. Ids and names are test data, never production code.
 */
export const CLAUDE_CATALOG: ModelCatalog = freezeModelCatalog("claude", {
  models: [
    { id: "default", name: "Default (recommended)", group: "claude", description: "Use the best available model", reasoningEfforts: claudeEfforts, contextWindows: [200000] },
    { id: "opus", name: "Opus", group: "claude", reasoningEfforts: claudeEfforts, contextWindows: [200000, 1000000] },
    { id: "haiku", name: "Haiku", group: "claude", reasoningEfforts: [], contextWindows: [200000] },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", group: "online", reasoningEfforts: [], contextWindows: [128000] },
    { id: "deepseek-v4-reasoner", name: "DeepSeek V4 Reasoner", group: "online", reasoningEfforts: [{ id: "high", label: "High", isDefault: true }, { id: "max", label: "Max", isDefault: false }], contextWindows: [128000] },
    { id: "local-27b-model", name: "Local 27B", group: "local", reasoningEfforts: [], contextWindows: [32768] },
  ],
  runtimeDefaultModelId: "default",
});

/**
 * The Claude group as the adapter listed it on 2026-10-12 with Claude Code 2.1.296 (names and descriptions are its own
 * strings, ids are test data): a Default row that stands for Opus 5.5, then twelve models over four families, newest
 * first within a family but not across them. Plus the two kinds of routed model.
 */
const adapterRow = (id: string, name: string, description: string) =>
  ({ id, name, group: "claude" as const, description, reasoningEfforts: claudeEfforts, contextWindows: [200000] });
export const CLAUDE_ADAPTER_CATALOG: ModelCatalog = freezeModelCatalog("claude", {
  models: [
    adapterRow("default", "Default (recommended)", "Opus 5.5"),
    adapterRow("opus", "Opus 5.5", "Most capable for complex work"),
    adapterRow("fable", "Fable 5.1", "Best for the hardest, longest-running tasks"),
    adapterRow("sonnet", "Sonnet 5.5", "Best for everyday tasks"),
    adapterRow("haiku", "Haiku 5.5", "Fastest for quick answers"),
    adapterRow("claude-haiku-4-5", "Haiku 4.5", "Fastest for quick answers"),
    adapterRow("claude-sonnet-5", "Sonnet 5", "Best for everyday tasks"),
    adapterRow("claude-opus-5", "Opus 5", "Most capable for complex work"),
    adapterRow("claude-fable-5", "Fable 5", "Best for the hardest, longest-running tasks"),
    adapterRow("claude-opus-4-8", "Opus 4.8", "Most capable for complex work"),
    adapterRow("claude-opus-4-7", "Opus 4.7", "Most capable for complex work"),
    adapterRow("claude-opus-4-6", "Opus 4.6", "Most capable for complex work"),
    adapterRow("claude-sonnet-4-6", "Sonnet 4.6", "Best for everyday tasks"),
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", group: "online", reasoningEfforts: [], contextWindows: [128000] },
    { id: "local-27b-model", name: "Local 27B", group: "local", reasoningEfforts: [], contextWindows: [32768] },
  ],
  runtimeDefaultModelId: "default",
});

/**
 * A Gemini-engine catalog as the main process builds it from the models gemini-cli 0.63.0 reported at `session/new`
 * on 2026-10-13 (docs/21 section 7), without `auto`. Names and descriptions are test data. Gemini has no effort setting
 * over ACP, so no model lists one.
 */
const geminiRow = (id: string, name: string, description?: string) =>
  ({ id, name, group: "gemini" as const, ...(description === undefined ? {} : { description }), reasoningEfforts: [], contextWindows: [] });
export const GEMINI_CATALOG: ModelCatalog = freezeModelCatalog("gemini", {
  engine: "gemini",
  models: [
    geminiRow("gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)", "Most capable, priced per use"),
    geminiRow("gemini-3-flash-preview", "Gemini 3 Flash (preview)"),
    geminiRow("gemini-2.5-pro", "Gemini 2.5 Pro"),
    geminiRow("gemini-3.8-flash", "Gemini 3.8 Flash"),
    geminiRow("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "Fastest and cheapest"),
  ],
});
