import { useEffect, useState } from "react";
import type { GuildMessages } from "./locales.js";

export type Appearance = Readonly<{ theme: "light" | "dark" | "system"; textSize: 16 | 18; density: "comfortable" | "compact" }>;
const KEY = "guild:v2:appearance";
export function readAppearance(storage: Pick<Storage, "getItem">): Appearance {
  const fallback: Appearance = { theme: "light", textSize: 16, density: "comfortable" };
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) ?? "null");
    if (value === null || typeof value !== "object") return fallback;
    const data = value as Record<string, unknown>;
    return {
      theme: data.theme === "dark" || data.theme === "system" ? data.theme : "light",
      textSize: data.textSize === 18 ? 18 : 16,
      density: data.density === "compact" ? "compact" : "comfortable",
    };
  } catch { return fallback; }
}
export function useAppearance() {
  const [appearance, setAppearance] = useState(() => readAppearance(window.localStorage));
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = appearance.theme === "system" ? query.matches ? "dark" : "light" : appearance.theme;
      document.documentElement.dataset.density = appearance.density;
      document.documentElement.style.setProperty("--guild-message-size", `${appearance.textSize}px`);
    };
    apply();
    query.addEventListener("change", apply);
    try { window.localStorage.setItem(KEY, JSON.stringify(appearance)); } catch { /* Session preferences still apply. */ }
    return () => query.removeEventListener("change", apply);
  }, [appearance]);
  return [appearance, setAppearance] as const;
}
export function AppearanceSettings({ value, onChange, messages }: {
  readonly value: Appearance; readonly onChange: (value: Appearance) => void; readonly messages: GuildMessages;
}) {
  return <fieldset className="guild-appearance"><legend>{messages.appearance}</legend>
    <label>{messages.theme}<select value={value.theme} onChange={(event) => onChange({ ...value, theme: event.currentTarget.value as Appearance["theme"] })}>
      <option value="light">{messages.lightTheme}</option><option value="dark">{messages.darkTheme}</option><option value="system">{messages.systemTheme}</option>
    </select></label>
    <label>{messages.textSize}<select value={value.textSize} onChange={(event) => onChange({ ...value, textSize: Number(event.currentTarget.value) as 16 | 18 })}>
      <option value={16}>{messages.standardText}</option><option value={18}>{messages.largeText}</option>
    </select></label>
    <label>{messages.density}<select value={value.density} onChange={(event) => onChange({ ...value, density: event.currentTarget.value as Appearance["density"] })}>
      <option value="comfortable">{messages.comfortable}</option><option value="compact">{messages.compact}</option>
    </select></label>
  </fieldset>;
}
