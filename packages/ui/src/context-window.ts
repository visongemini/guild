import type { ContextWindowProjection, GuildLocale } from "@guild/contracts";

export type ContextWindowView = Readonly<{
  available: boolean;
  hasSize: boolean;
  percent: number;
  usedLabel: string;
  sizeLabel: string;
}>;

export function contextWindowView(
  contextWindow: ContextWindowProjection | undefined,
  locale: GuildLocale,
): ContextWindowView {
  if (contextWindow === undefined || contextWindow.status === "unavailable") {
    return Object.freeze({ available: false, hasSize: false, percent: 0, usedLabel: "", sizeLabel: "" });
  }
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  if (contextWindow.status === "used_only") {
    return Object.freeze({
      available: true,
      hasSize: false,
      percent: 0,
      usedLabel: formatter.format(contextWindow.used),
      sizeLabel: "",
    });
  }
  if (contextWindow.size <= 0) {
    return Object.freeze({ available: false, hasSize: false, percent: 0, usedLabel: "", sizeLabel: "" });
  }
  const percent = Math.round(Math.min(100, Math.max(0, contextWindow.used / contextWindow.size * 100)));
  return Object.freeze({
    available: true,
    hasSize: true,
    percent,
    usedLabel: formatter.format(contextWindow.used),
    sizeLabel: formatter.format(contextWindow.size),
  });
}
