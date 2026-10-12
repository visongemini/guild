import { ANTHROPIC_SOURCE_ID, type RouterModel, type RouterSource } from "./types.js";

export interface SourceRegistry {
  readonly models: readonly { readonly model: RouterModel; readonly source: RouterSource }[];
  sourceForModel(modelId: string): RouterSource | undefined;
}

/**
 * Builds the exact model registry. Entries of kind "anthropic" are not routable (the Anthropic
 * upstream is fixed). Throws on ambiguity so a model id can never reach an unintended vendor.
 */
export function createRegistry(sources: readonly RouterSource[]): SourceRegistry {
  const sourceIds = new Set<string>();
  const byModel = new Map<string, RouterSource>();
  const models: { model: RouterModel; source: RouterSource }[] = [];
  for (const original of sources) {
    if (original.kind === "anthropic") continue;
    if (original.id === ANTHROPIC_SOURCE_ID) throw new Error(`source id "${ANTHROPIC_SOURCE_ID}" is reserved`);
    if (sourceIds.has(original.id)) throw new Error(`duplicate source id "${original.id}"`);
    sourceIds.add(original.id);
    const source: RouterSource = { ...original, models: original.models.map((model) => ({ ...model })) };
    for (const model of source.models) {
      if (byModel.has(model.id)) throw new Error(`model id "${model.id}" is configured more than once`);
      byModel.set(model.id, source);
      models.push({ model, source });
    }
  }
  return { models, sourceForModel: (modelId) => byModel.get(modelId) };
}
