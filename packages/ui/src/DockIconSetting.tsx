import type { GuildDockIcon } from "@guild/contracts";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { GuildMessages } from "./locales.js";
import { nextPickerIndex } from "./model-picker.js";

/*
 * Settings > General > Dock icon (PC-SET-002, docs/21 section 9): the dark (default) or the light "G", each with a
 * small preview. A choice is saved the moment it is made, like the other general settings, and the main process
 * applies it to the Dock at once. The previews are decorative; each option is named by its text.
 */

const DOCK_ICONS: readonly GuildDockIcon[] = Object.freeze(["dark", "light"] as const);

const DOCK_ICON_PREVIEW: Readonly<Record<GuildDockIcon, string>> = Object.freeze({
  dark: new URL("./assets/dock-icon-dark.png", import.meta.url).href,
  light: new URL("./assets/dock-icon-light.png", import.meta.url).href,
});

/** The icon an arrow, Home or End key moves to from `current` (a radio group: moving also chooses); undefined for any other key. */
export function dockIconForKey(current: GuildDockIcon, key: string): GuildDockIcon | undefined {
  const next = nextPickerIndex(DOCK_ICONS.indexOf(current), DOCK_ICONS.length, key, "both");
  return next === undefined ? undefined : DOCK_ICONS[next];
}

export function DockIconSetting({ messages, value, onChange }: Readonly<{
  messages: GuildMessages;
  value: GuildDockIcon;
  onChange: (icon: GuildDockIcon) => void;
}>) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const next = dockIconForKey(value, event.key);
    if (next === undefined) return;
    event.preventDefault();
    event.currentTarget.querySelector<HTMLElement>(`[data-dock-icon="${next}"]`)?.focus();
    if (next !== value) onChange(next);
  }
  return <>
    <div className="guild-setting-label" id="guild-dock-icon-label">{messages.dockIcon}</div>
    <div
      className="guild-segmented guild-dock-icons"
      role="radiogroup"
      aria-labelledby="guild-dock-icon-label"
      aria-describedby="guild-dock-icon-help"
      data-guild-setting="dock-icon"
      onKeyDown={onKeyDown}
    >
      {DOCK_ICONS.map((icon) => (
        <button
          key={icon}
          type="button"
          role="radio"
          aria-checked={value === icon}
          tabIndex={value === icon ? 0 : -1}
          className={value === icon ? "selected" : ""}
          data-dock-icon={icon}
          onClick={() => { if (icon !== value) onChange(icon); }}
        >
          <img src={DOCK_ICON_PREVIEW[icon]} alt="" width={64} height={64} draggable={false} />
          <span>{messages.dockIconName(icon)}</span>
        </button>
      ))}
    </div>
    <p className="guild-setting-help" id="guild-dock-icon-help">{messages.dockIconHelp}</p>
  </>;
}
