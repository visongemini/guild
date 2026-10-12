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
