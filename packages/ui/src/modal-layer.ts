import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A modal dialog of the app (D-064). The narrow-window workbench is `aria-modal` too, but it is a panel of the page
 * that already makes its own background inert, not a layer above the rest.
 */
export const MODAL_SELECTOR = '[aria-modal="true"]:not(.guild-workbench)';

/** How many focused elements are remembered to give focus back to. */
export const FOCUS_HISTORY_LIMIT = 8;

export function modalPresent(root: Pick<ParentNode, "querySelector">): boolean {
  return root.querySelector(MODAL_SELECTOR) !== null;
}

/**
 * The value to store when a modal appeared or went, nothing when the stored value already says so. The check runs after
 * every commit of the app, so it must not set state for a value that is already stored: a same-value update from a
 * layout effect can still schedule a render, and a render that is not skipped runs the effect again (the live QA hit
 * "Maximum update depth exceeded" this way when a routed model switch settled).
 */
export function modalStateChange(stored: boolean, present: boolean): boolean | undefined {
  return stored === present ? undefined : present;
}

/** Newest first, without repeats, at most `limit` entries. */
export function rememberFocus<T>(history: readonly T[], element: T, limit = FOCUS_HISTORY_LIMIT): readonly T[] {
  return [element, ...history.filter((entry) => entry !== element)].slice(0, limit);
}

/**
 * Where focus goes back to once the last modal is gone: the newest element that held focus outside a modal and can
 * take it now. The element that opened the dialog is often gone by then (a menu item of a popover that closed with
 * the click), and the element focused before it, the popover's own button, is the next best.
 */
export function focusReturnTarget<T>(history: readonly T[], canTakeFocus: (element: T) => boolean): T | undefined {
  return history.find(canTakeFocus);
}

/** Nothing holds focus: the dialog that had it was removed. Anything else was put there on purpose and stays. */
export function focusIsLost(active: Element | null, body: Element | null): boolean {
  return active === null || active === body;
}

function canTakeFocus(element: HTMLElement): boolean {
  return element.isConnected && !element.hasAttribute("disabled") && element.closest("[inert], [hidden]") === null &&
    element.getClientRects().length > 0;
}

/**
 * Whether a modal is open, for the page behind it to be made `inert` (out of the tab order and the accessibility
 * tree); when the last one closes, focus goes back to where it came from unless something already took it.
 *
 * The check runs after every commit of the app, so a dialog the app renders is seen in the commit that mounts it
 * and the page behind it is inert before any later handler can move focus there. Dialogs attached to the body
 * (the fullscreen image preview) change no app commit, so the body's children are watched too.
 */
export function useModalLayer(): boolean {
  const [open, setOpen] = useState(false);
  const stored = useRef(false);
  const history = useRef<readonly HTMLElement[]>([]);
  const wasOpen = useRef(false);
  const sync = useCallback(() => {
    const change = modalStateChange(stored.current, modalPresent(document));
    if (change === undefined) return;
    stored.current = change;
    setOpen(change);
  }, []);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body || target.closest(MODAL_SELECTOR) !== null) return;
      history.current = rememberFocus(history.current, target);
    };
    document.addEventListener("focusin", onFocusIn, true);
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true });
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      observer.disconnect();
    };
  }, [sync]);

  useLayoutEffect(sync);

  useLayoutEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (!focusIsLost(document.activeElement, document.body)) return;
    focusReturnTarget(history.current, canTakeFocus)?.focus({ preventScroll: true });
  }, [open]);

  return open;
}
