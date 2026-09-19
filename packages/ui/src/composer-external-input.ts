/**
 * A11Y-COMPOSER-001: the composer is a controlled React `<textarea>`, so its
 * value only reaches application state through React's synthetic `onChange`.
 *
 * React tracks the last value it rendered on the DOM node itself. When the
 * value is written from outside React — an accessibility client such as
 * VoiceOver, a UI-automation driver, or any tool that performs the
 * `AXSetValue` action — Chromium assigns through the same value setter React
 * patched, so the tracker records the new text and then reports "unchanged".
 * The synthetic `onChange` never fires, the draft state stays empty, and the
 * visible field snaps back on the next render. Submitting after such a write
 * sends nothing.
 *
 * Native DOM events are unaffected by that tracker: Chromium dispatches real
 * `input` and `change` events for the set-value action. Observing them and
 * pushing the DOM value back into React state makes external writes behave
 * exactly like typing.
 */

export type ExternalComposerInputTarget = {
  readonly value: string;
  addEventListener(type: "input" | "change", listener: () => void): void;
  removeEventListener(type: "input" | "change", listener: () => void): void;
};

export type ExternalComposerInputOptions = {
  /** Current draft held in React state, read at event time to avoid stale closures. */
  readonly readDraft: () => string;
  /** Called only when the DOM value diverged from the draft React believes it rendered. */
  readonly onExternalInput: (value: string) => void;
};

const OBSERVED_EVENTS = ["input", "change"] as const;

/**
 * Subscribes to external value writes on one composer node.
 * Returns a cleanup function; calling it twice is safe.
 */
export function observeExternalComposerInput(
  node: ExternalComposerInputTarget | null | undefined,
  options: ExternalComposerInputOptions,
): () => void {
  if (node === null || node === undefined) {
    return () => {};
  }

  const sync = (): void => {
    const domValue = node.value;
    if (domValue === options.readDraft()) {
      return;
    }
    options.onExternalInput(domValue);
  };

  for (const type of OBSERVED_EVENTS) {
    node.addEventListener(type, sync);
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    for (const type of OBSERVED_EVENTS) {
      node.removeEventListener(type, sync);
    }
  };
}
