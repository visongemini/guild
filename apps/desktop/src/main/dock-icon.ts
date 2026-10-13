import { join } from "node:path";
import type { GuildDockIcon } from "@guild/contracts";

// The Dock icon the user picks in Settings > General (PC-SET-002). Electron has no way to unset a
// Dock icon, so both choices are applied the same way: load a PNG and hand it to app.dock.setIcon.
// Dark is the bundle icon, but nativeImage cannot read the bundle's icon.icns (it loads as an empty
// image), so the dark artwork ships as a 1024 px PNG next to the light one. The two files carry the
// same names in apps/desktop/build (development) and Contents/Resources (packaged).
const DOCK_ICON_FILES: Readonly<Record<GuildDockIcon, string>> = Object.freeze({
  dark: "icon.png",
  light: "icon-light.png",
});

/** The part of Electron's `app.dock` this module drives. */
export type DockPort = Readonly<{ setIcon(image: unknown): void }>;

/** What happened, as a fixed word: events never carry a path or an error message. */
export type DockIconEvent =
  | "applied"
  | "unsupported-platform"
  | "no-dock"
  | "file-missing"
  | "image-empty"
  | "failed";

export type DockIconDependencies = Readonly<{
  platform: NodeJS.Platform;
  /** `app.dock`; undefined off macOS. */
  dock: DockPort | undefined;
  /** Directory holding icon.png (dark) and icon-light.png: process.resourcesPath when packaged, apps/desktop/build otherwise. */
  iconDirectory: string;
  /** `nativeImage.createFromPath`; undefined or null for an image that did not load or is empty. */
  loadImage: (path: string) => unknown;
  fileExists: (path: string) => boolean;
  log?: (event: DockIconEvent) => void;
}>;

export type DockIconApplier = Readonly<{
  /** Sets the Dock icon. True when it was set; false for every quiet no-op. Never throws. */
  apply(choice: GuildDockIcon): boolean;
}>;

/** Where the artwork for a choice lives inside `iconDirectory`. */
export function dockIconPath(choice: GuildDockIcon, iconDirectory: string): string {
  return join(iconDirectory, DOCK_ICON_FILES[choice]);
}

export function createDockIconApplier(deps: DockIconDependencies): DockIconApplier {
  const report = (event: DockIconEvent): void => {
    try {
      deps.log?.(event);
    } catch {
      // Logging must never decide whether the icon changes.
    }
  };
  return Object.freeze({
    apply(choice: GuildDockIcon): boolean {
      if (deps.platform !== "darwin") {
        report("unsupported-platform");
        return false;
      }
      const dock = deps.dock;
      if (dock === undefined) {
        report("no-dock");
        return false;
      }
      try {
        const path = dockIconPath(choice, deps.iconDirectory);
        if (!deps.fileExists(path)) {
          report("file-missing");
          return false;
        }
        const image = deps.loadImage(path);
        if (image === undefined || image === null) {
          report("image-empty");
          return false;
        }
        dock.setIcon(image);
      } catch {
        report("failed");
        return false;
      }
      report("applied");
      return true;
    },
  });
}
