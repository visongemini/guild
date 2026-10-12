import type { GuildEngine, SetTaskRuntimeSettingsResponse, TaskModelSelectionProjection } from "@guild/contracts";
import { CaretDownIcon as CaretDown } from "@phosphor-icons/react/CaretDown";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { ClaudeStatusState } from "./claude-engine.js";
import type { GuildMessages } from "./locales.js";
import {
  CLEAR_MODEL_OVERRIDE,
  isSameSelection,
  modelPickerView,
  nextPickerIndex,
  noticeForResponse,
  noticeText,
  pickerIsLocked,
  selectionForRow,
  type ModelGroupEmptyView,
  type ModelPickerCatalogs,
  type ModelSelectionChange,
  type PickerNavigationOrientation,
  type PickerNotice,
} from "./model-picker.js";

export type ModelPickerProps = Readonly<{
  messages: GuildMessages;
  /** What the engines advertised; the Claude catalog also holds the Online and Local models. */
  catalogs: ModelPickerCatalogs;
  /** The active task's selection; undefined when no task is open. */
  selection: TaskModelSelectionProjection | undefined;
  /** Engine of the active task. */
  taskEngine: GuildEngine;
  /** True once the task has a Run: only the task's own engine is listed then. */
  engineFixed: boolean;
  /** Claude Code's state, when the main process reports one; see `modelPickerView`. */
  claudeState?: ClaudeStatusState;
  /**
   * Applies a change for the active task and resolves with the response. The caller owns the API
   * calls (moving the task to the other engine first, the Online reminder) and replaces its task
   * state with the returned task; the picker owns the pending state and the inline notice. A
   * resolved `undefined` means the user cancelled (no notice); a rejection is shown inside the
   * popover, not as a global error.
   */
  onApply: (change: ModelSelectionChange) => Promise<SetTaskRuntimeSettingsResponse | undefined>;
  /** Opens Settings on the Model sources tab (the way out of an empty Online or Local group). */
  onOpenModelSources?: () => void;
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

/**
 * Why a group has no model, with the one-line way out. Inside the listbox it is a disabled option, so a screen reader
 * reaches it with the arrow keys and announces it like the rows around it (a bare paragraph in a listbox is skipped);
 * the action under it is its own option. Alone in the popover (no listbox) it is plain text.
 */
function EmptyHint({ empty, fallback, inListbox }: {
  readonly empty: ModelGroupEmptyView | undefined;
  readonly fallback: string;
  readonly inListbox: boolean;
}) {
  const body = <>
    <p>{empty?.text ?? fallback}</p>
    {empty?.help !== undefined && <small>{empty.help}</small>}
  </>;
  return inListbox
    ? <div className="guild-model-hint" role="option" aria-disabled="true" aria-selected="false" tabIndex={-1}>{body}</div>
    : <div className="guild-model-hint">{body}</div>;
}

export function ModelPicker({
  messages,
  catalogs,
  selection,
  taskEngine,
  engineFixed,
  claudeState,
  onApply,
  onOpenModelSources,
  initialOpen = false,
  initialNotice,
}: ModelPickerProps) {
  const [open, setOpen] = useState(initialOpen);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<PickerNotice | undefined>(initialNotice);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const popoverId = useId();
  const view = modelPickerView({
    messages,
    catalogs,
    selection,
    pending,
    taskEngine,
    engineFixed,
    ...(claudeState === undefined ? {} : { claudeState }),
  });
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
    // The selected row, else the first row (a hint is an option too, but a row is what the person came to pick).
    const target = popover.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      popover.querySelector<HTMLElement>('button[role="option"]') ??
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
      {pending
        ? <SpinnerGap size={11} className="guild-spin" aria-hidden="true" />
        : <CaretDown size={11} className="guild-model-picker-caret" aria-hidden="true" />}
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
        <EmptyHint empty={view.groups[0]?.empty} fallback={messages.modelPickerEmpty} inListbox={false} />
      ) : (
        <>
          {!view.showGroupHeadings && <div className="guild-model-heading">{messages.model}</div>}
          <div
            className="guild-model-list"
            role="listbox"
            aria-label={messages.model}
            onKeyDown={(event) => moveFocus(event, '[role="option"]', "vertical")}
          >
            {view.groups.map((group) => {
              const headingId = `${popoverId}-group-${group.group}`;
              return <div key={group.group} className="guild-model-group" role="group" aria-labelledby={headingId}>
                <div
                  id={headingId}
                  className={view.showGroupHeadings ? "guild-model-heading guild-model-group-heading" : "guild-sr-only"}
                >{group.label}</div>
                {group.models.map((row) => (
                  <button
                    key={`${row.group}:${row.runtimeDefault === true ? "(default)" : row.id}`}
                    type="button"
                    role="option"
                    aria-selected={row.selected}
                    aria-disabled={pending || undefined}
                    tabIndex={row.tabStop ? 0 : -1}
                    className={`guild-model-row${row.selected ? " selected" : ""}`}
                    onClick={() => void apply(selectionForRow(catalogs, row, view.selectedEffortId, taskEngine))}
                  >
                    <span className="guild-model-row-name">
                      <span className="guild-model-row-title">
                        <strong>{row.name}</strong>
                        {row.priceMultiplier !== undefined && (
                          <em className="guild-model-price-tag">{messages.modelPriceTag(row.priceMultiplier)}</em>
                        )}
                      </span>
                      {row.selected && <Check size={14} weight="bold" aria-hidden="true" />}
                    </span>
                    {row.description !== undefined && <small className="guild-model-row-description">{row.description}</small>}
                    {row.contextLabel !== undefined && <small className="guild-model-row-meta">{row.contextLabel}</small>}
                  </button>
                ))}
                {group.empty !== undefined && <>
                  <EmptyHint empty={group.empty} fallback={messages.modelPickerEmpty} inListbox />
                  {group.empty.action === "open_model_sources" && onOpenModelSources !== undefined && (
                    <button
                      type="button"
                      role="option"
                      aria-selected="false"
                      tabIndex={-1}
                      className="guild-model-action"
                      onClick={() => {
                        setOpen(false);
                        onOpenModelSources();
                      }}
                    >{messages.modelPickerOpenModelSources}</button>
                  )}
                </>}
              </div>;
            })}
          </div>
          {view.showEfforts && <>
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
          </>}
          <p className="guild-model-footnote">{messages.modelPickerFootnote}</p>
          {view.engineNote !== undefined && <p className="guild-model-footnote guild-model-engine-note">{view.engineNote}</p>}
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
