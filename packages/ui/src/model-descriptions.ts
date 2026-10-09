import { officialPriceMultiplier } from "./model-picker.js";

/*
 * Chinese descriptions for the model ids Guild knows by name. This is the only renderer file that
 * names model ids, and only to translate text: the catalog the runtime advertises still decides
 * which models exist, their names, efforts and context sizes. An id that is not in the table keeps
 * the official description, and so does every id in the English locale.
 */
type KnownModelText = Readonly<{
  text: string;
  /** The premium multiple this text states, if any; the official statement wins when it differs. */
  priceMultiplier?: string;
}>;

const ZH_MODEL_TEXT: Readonly<Record<string, KnownModelText>> = Object.freeze({
  "grok-4.7": { text: "最新一代，官方默认" },
  "grok-4.7-build-fast": { text: "回得更快，额度消耗约 2 倍", priceMultiplier: "2" },
  "grok-4.6": { text: "上一代" },
  "grok-4.5": { text: "更早一代" },
});

export function zhModelDescription(
  modelId: string,
  officialDescription: string | undefined,
): string | undefined {
  const known = Object.hasOwn(ZH_MODEL_TEXT, modelId) ? ZH_MODEL_TEXT[modelId] : undefined;
  if (known === undefined) return officialDescription;
  if (known.priceMultiplier !== undefined) {
    const official = officialPriceMultiplier(officialDescription);
    // The runtime now states a different premium than this text: do not contradict it.
    if (official !== undefined && official !== known.priceMultiplier) return officialDescription;
  }
  return known.text;
}
