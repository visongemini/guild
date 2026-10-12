import type { BrowserWindow, Session, WebContents } from "electron";
import { isTrustedGuildAppUrl } from "./guild-url.js";

/*
 * Guards that decide what a web contents may do. This module imports Electron types only, so the
 * guards run under plain Node in unit tests; `window-security.ts` re-exports them and owns the
 * Electron-valued window construction.
 *
 * Two classes of web contents exist (docs/09, docs/20 section 3.5):
 *  - Guild's own window: every navigation, frame navigation, webview attach and window.open is
 *    denied and every permission is denied. These guards are unchanged by the browser pane.
 *  - Browser-pane tabs created by `BrowserPaneController`: they may navigate to http(s) and
 *    about:blank, nothing else. They are identified only by their id in `browserPaneRegistry`,
 *    never by URL, partition name or any other heuristic.
 */

// ---------------------------------------------------------------------------------------------
// Guild's own window (moved verbatim from window-security.ts)
// ---------------------------------------------------------------------------------------------

export function isTrustedGuildSender(window: BrowserWindow, sender: WebContents, frameUrl: string): boolean {
  if (isBrowserPaneContents(sender.id)) return false;
  if (sender !== window.webContents || sender.isDestroyed()) return false;
  try {
    const url = new URL(frameUrl);
    return isTrustedGuildAppUrl(url) && (url.pathname === "/" || url.pathname === "/index.html");
  } catch {
    return false;
  }
}

export function hardenWebContents(contents: WebContents): void {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function denyPermissions(session: Session): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}

// ---------------------------------------------------------------------------------------------
// Browser-pane contents
// ---------------------------------------------------------------------------------------------

/** Ids of the web contents created by a `BrowserPaneController`; nothing else is ever a pane. */
export type BrowserPaneRegistry = Readonly<{
  /** Returns the function that removes the id again. Registering twice is harmless. */
  register: (contentsId: number) => () => void;
  has: (contentsId: number) => boolean;
  size: () => number;
}>;

export function createBrowserPaneRegistry(): BrowserPaneRegistry {
  const ids = new Set<number>();
  return Object.freeze({
    register: (contentsId: number) => {
      ids.add(contentsId);
      return () => {
        ids.delete(contentsId);
      };
    },
    has: (contentsId: number) => ids.has(contentsId),
    size: () => ids.size,
  });
}

/** The process-wide registry. Tests build their own with `createBrowserPaneRegistry`. */
export const browserPaneRegistry: BrowserPaneRegistry = createBrowserPaneRegistry();

export function isBrowserPaneContents(
  contentsId: number,
  registry: BrowserPaneRegistry = browserPaneRegistry,
): boolean {
  return registry.has(contentsId);
}

const MAX_PANE_URL_LENGTH = 8_192;

/**
 * The only addresses a pane tab may load: http(s) with a host and no user-info, or exactly
 * `about:blank`. `file:`, `data:`, `blob:`, `javascript:`, `guild-app:`, `guild-media:` and every
 * unknown scheme are refused. Parsing uses `URL`; there are no prefix or substring tests.
 */
export function isPaneUrlAllowed(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_PANE_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol === "about:") return url.href === "about:blank";
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname !== "" && url.username === "" && url.password === "";
}

/**
 * Navigation decision for one web contents. The pane policy applies only when the contents id is
 * in the registry: an unregistered contents never gets it, whatever URL it asks for.
 */
export function isPaneNavigationAllowed(
  contentsId: number,
  rawUrl: string,
  registry: BrowserPaneRegistry = browserPaneRegistry,
): boolean {
  return registry.has(contentsId) && isPaneUrlAllowed(rawUrl);
}
