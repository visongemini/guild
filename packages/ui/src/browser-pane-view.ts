import type { BrowserAgentControl, BrowserPaneProjection } from "@guild/contracts";
import { useEffect, useState } from "react";
import { createFrameScheduler } from "./frame-scheduler.js";

/*
 * View logic for the workbench's Browser tab (PC-BROWSER-001, PC-BROWSER-002). The page itself is a
 * native view that main draws above the DOM, so the renderer decides when it may be seen: never under
 * a menu or dialog, and only while the Browser tab of an open workbench is on screen. The agent's
 * rendering tools (screenshots) refuse while the view is hidden, so an agent that starts operating
 * brings the tab forward.
 */

export type WorkbenchTab = "files" | "review" | "browser";

/** What main knows before it has pushed anything: no tabs, nobody in control. */
export const EMPTY_BROWSER_PANE: BrowserPaneProjection = Object.freeze({
  tabs: Object.freeze([]),
  activeTabId: null,
  agentControl: "idle",
});

export type BrowserPaneVisibility = Readonly<{
  /** The workbench column exists and is open. */
  workbenchOpen: boolean;
  /** A task is open (the workbench only exists for one). */
  hasTask: boolean;
  tab: WorkbenchTab;
  /** A menu, dialog, popover, the command palette or the Online reminder is on screen. */
  overlayOpen: boolean;
}>;

/** True unless the native view may be drawn: it would cover (or be a leftover of) something else. */
export function browserPaneHidden(visibility: BrowserPaneVisibility): boolean {
  return !visibility.workbenchOpen ||
    !visibility.hasTask ||
    visibility.tab !== "browser" ||
    visibility.overlayOpen;
}

/** The agent just took the pane over: show it, once, without fighting a person who looks elsewhere afterwards. */
export function revealsBrowserTab(previous: BrowserAgentControl, next: BrowserAgentControl): boolean {
  return next === "operating" && previous !== "operating";
}

/**
 * Anything modal or menu-like drawn by the page: the safety net behind the overlay state App already
 * knows (dialogs and menus owned by other components, the fullscreen image viewer). The workbench is
 * itself `aria-modal` in a narrow window and is not an overlay over its own content.
 */
export const BROWSER_OVERLAY_SELECTOR = '[aria-modal="true"]:not(.guild-workbench), [role="menu"]';

export function modalOverlayPresent(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector(BROWSER_OVERLAY_SELECTOR) !== null;
}

/**
 * Watches the app for such an overlay while `active` (only a visible Browser tab has a native view to
 * protect, so nothing is observed otherwise). Checks coalesce to one per frame.
 */
export function useModalOverlayPresent(active: boolean): boolean {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    if (!active) {
      setPresent(false);
      return undefined;
    }
    const check = () => setPresent(modalOverlayPresent(document));
    check();
    const scheduler = createFrameScheduler(check);
    const observer = new MutationObserver(() => scheduler.schedule());
    observer.observe(document.querySelector(".guild-shell") ?? document.body, { childList: true, subtree: true });
    // Portals (the image viewer) attach to the body, outside the shell.
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      scheduler.cancel();
    };
  }, [active]);
  return present;
}
