import type { GrokModelCatalog, SetTaskRuntimeSettingsResponse, TaskModelSelectionProjection } from "@guild/contracts";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { GuildMessages } from "./locales.js";
import {
  CLEAR_MODEL_OVERRIDE,
  isSameSelection,
  modelPickerView,
  nextPickerIndex,
  noticeForResponse,
  noticeText,
  pickerIsLocked,
  selectionAfterModelChange,
  type ModelSelectionChange,
  type PickerNavigationOrientation,
  type PickerNotice,
} from "./model-picker.js";

export type ModelPickerProps = Readonly<{
  messages: GuildMessages;
  catalog: GrokModelCatalog;
  /** The active task's selection; undefined when no task is open. */
  selection: TaskModelSelectionProjection | undefined;
  /**
   * Applies a change for the active task and resolves with the response. The caller owns the API
   * call and replaces its task state with the returned task; the picker owns the pending state and
   * the inline notice. A rejection is shown inside the popover, not as a global error.
   */
  onApply: (change: ModelSelectionChange) => Promise<SetTaskRuntimeSettingsResponse>;
  /** Test seams: render the popover / a notice without a pointer. */
  initialOpen?: boolean;
  initialNotice?: PickerNotice;
}>;

/** Moves focus between the enabled items of a roving group (model rows or effort buttons). */
function moveFocus(
  event: ReactKeyboardEvent<HTMLElement>,
  itemSelector: string,
  orientation: PickerNavigationOrientation,
) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(itemSelector));
  const current = items.findIndex((item) => item === document.activeElement);
  const next = nextPickerIndex(current, items.length, event.key, orientation);
  if (next === undefined) return;
  event.preventDefault();
  items[next]?.focus();
}

export function ModelPicker({ messages, catalog, selection, onApply, initialOpen = false, initialNotice }: ModelPickerProps) {
  const [open, setOpen] = useState(initialOpen);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<PickerNotice | undefined>(initialNotice);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const popoverId = useId();
  const view = modelPickerView({ messages, catalog, selection, pending });
  const locked = pickerIsLocked(view.disabledReason);
  const panelOpen = open && !locked;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // A running turn (or a closed task) takes the picker away; do not reopen it on its own later.
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);

  useEffect(() => {
    if (!panelOpen) return;
    const popover = popoverRef.current;
    if (popover === null) return;
    const target = popover.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      popover.querySelector<HTMLElement>('[role="option"]') ??
      popover;
    target.focus();
  }, [panelOpen]);

  useEffect(() => {
    if (!panelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (wrapper === null || (event.target instanceof Node && wrapper.contains(event.target))) return;
      const focusInside = wrapper.contains(document.activeElement);
      setOpen(false);
      if (focusInside) triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [panelOpen]);

  async function apply(change: ModelSelectionChange) {
    if (pending || locked || selection === undefined || isSameSelection(selection, change)) return;
    setPending(true);
    setNotice(undefined);
    try {
      const response = await onApply(change);
      if (mountedRef.current) setNotice(noticeForResponse(response));
    } catch {
      if (mountedRef.current) setNotice(Object.freeze({ kind: "failed" }));
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !panelOpen) return;
    event.preventDefault();
    event.stopPropagation();
    const focusInside = wrapperRef.current?.contains(document.activeElement) === true;
    setOpen(false);
    if (focusInside) triggerRef.current?.focus();
  }

  return <div className="guild-model-picker" ref={wrapperRef} onKeyDown={onKeyDown}>
    <button
      ref={triggerRef}
      type="button"
      className="guild-model-picker-trigger"
      title={view.title}
      aria-label={view.ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={panelOpen}
      aria-controls={panelOpen ? popoverId : undefined}
      aria-busy={pending || undefined}
      aria-disabled={view.disabledReason !== undefined || undefined}
      disabled={locked}
      onClick={() => {
        if (view.disabledReason !== undefined) return;
        if (!open) setNotice(undefined);
        setOpen(!open);
      }}
    >
      <span>{view.triggerText}</span>
      {pending && <SpinnerGap size={11} className="guild-spin" aria-hidden="true" />}
    </button>
    {panelOpen && <div
      ref={popoverRef}
      id={popoverId}
      className="guild-model-popover"
      role="dialog"
      aria-label={messages.modelPickerTitle}
      aria-busy={pending || undefined}
      tabIndex={-1}
    >
      {view.catalogEmpty ? (
        <p className="guild-model-hint">{messages.modelPickerEmpty}</p>
      ) : (
        <>
          <div className="guild-model-heading">{messages.model}</div>
          <div
            className="guild-model-list"
            role="listbox"
            aria-label={messages.model}
            onKeyDown={(event) => moveFocus(event, '[role="option"]', "vertical")}
          >
            {view.models.map((row) => (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={row.selected}
                aria-disabled={pending || undefined}
                tabIndex={row.tabStop ? 0 : -1}
                className={`guild-model-row${row.selected ? " selected" : ""}`}
                onClick={() => void apply(selectionAfterModelChange(catalog, row.id, view.selectedEffortId))}
              >
                <span className="guild-model-row-name">
                  <strong>{row.name}</strong>
                  {row.selected && <Check size={13} weight="bold" aria-hidden="true" />}
                </span>
                {row.description !== undefined && <small className="guild-model-row-description">{row.description}</small>}
                {row.contextLabel !== undefined && <small className="guild-model-row-meta">{row.contextLabel}</small>}
              </button>
            ))}
          </div>
          <div className="guild-model-heading">{messages.reasoningEffort}</div>
          {view.efforts.length === 0 ? (
            <p className="guild-model-hint">{messages.modelPickerNoEfforts}</p>
          ) : (
            <div
              className="guild-segmented guild-model-efforts"
              role="radiogroup"
              aria-label={messages.reasoningEffort}
              onKeyDown={(event) => moveFocus(event, '[role="radio"]', "both")}
            >
              {view.efforts.map((effort) => (
                <button
                  key={effort.id}
                  type="button"
                  role="radio"
                  aria-checked={effort.selected}
                  aria-disabled={pending || undefined}
                  tabIndex={effort.tabStop ? 0 : -1}
                  className={effort.selected ? "selected" : undefined}
                  title={effort.description}
                  onClick={() => {
                    if (view.selectedModelId !== null) {
                      void apply({ model: view.selectedModelId, reasoningEffort: effort.id });
                    }
                  }}
                >
                  {effort.label}
                  {effort.isDefault && <>
                    <span className="guild-model-default-dot" aria-hidden="true" />
                    <span className="guild-sr-only"> ({messages.modelPickerDefaultMark})</span>
                  </>}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {notice !== undefined && (
        <p
          className={`guild-model-notice ${notice.kind}`}
          role={notice.kind === "saved" ? "status" : "alert"}
        >{noticeText(messages, notice)}</p>
      )}
      {view.showUseDefault && (
        <button
          type="button"
          className="guild-model-use-default"
          aria-disabled={pending || undefined}
          onClick={() => void apply(CLEAR_MODEL_OVERRIDE)}
        >{messages.modelPickerUseDefault}</button>
      )}
    </div>}
  </div>;
}
