import { freezeGrokModelCatalog, type GrokModelCatalog } from "@guild/contracts";

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
