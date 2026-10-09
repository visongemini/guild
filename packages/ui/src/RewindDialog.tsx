import type {
  ExecuteRewindRequest,
  ExecuteRewindResponse,
  PreviewRewindResponse,
  RewindConflictProjection,
  RewindPlanProjection,
  RunId,
  TaskId,
} from "@guild/contracts";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { GuildMessages } from "./locales.js";
import {
  REWIND_LOADING,
  beginSubmit,
  canConfirm,
  canDismiss,
  confirmRewind,
  loadRewindPreview,
  needsOverwriteOptIn,
  toggleOverwrite,
  type RewindState,
  type RolledBackResult,
} from "./rewind-flow.js";

export type RewindDialogProps = Readonly<{
  taskId: TaskId;
  runId: RunId;
  messages: GuildMessages;
  preview: () => Promise<PreviewRewindResponse>;
  execute: (request: ExecuteRewindRequest) => Promise<ExecuteRewindResponse>;
  /** Fires the moment a rewind succeeded, while the result is still on screen, so the host can refresh the draft. */
  onRolledBack: (result: RolledBackResult) => void;
  /** The dialog is done; `rewound` says whether anything was undone. Escape, backdrop and Cancel all end here. */
  onClose: (rewound: boolean) => void;
  /** The app's modal keyboard handling (Escape and Tab containment). */
  onDialogKeyDown: (event: ReactKeyboardEvent<HTMLElement>, onEscape: () => void) => void;
  /** Test seam: render a state without a request. */
  initialState?: RewindState;
}>;

function PathList({ paths, label }: { readonly paths: readonly string[]; readonly label: string }) {
  return <ul className="guild-rewind-files" aria-label={label}>
    {paths.map((path) => <li key={path}><code title={path}>{path}</code></li>)}
  </ul>;
}

function ConflictList({ conflicts, messages }: {
  readonly conflicts: readonly RewindConflictProjection[];
  readonly messages: GuildMessages;
}) {
  return <ul className="guild-rewind-files conflicts" aria-label={messages.rewindConflictsHeading(conflicts.length)}>
    {conflicts.map((conflict) => <li key={conflict.path}>
      <code title={conflict.path}>{conflict.path}</code>
      <small>{messages.rewindConflictReason(conflict.reason)}</small>
    </li>)}
  </ul>;
}

function FilesSection({ plan, messages }: { readonly plan: RewindPlanProjection; readonly messages: GuildMessages }) {
  const files = plan.files;
  if (files.kind === "none") {
    return files.runtimeRestore.length > 0
      ? <section className="guild-rewind-section">
          <h3>{messages.rewindRuntimeRestoreHeading(files.runtimeRestore.length)}</h3>
          <PathList paths={files.runtimeRestore} label={messages.rewindRuntimeRestoreHeading(files.runtimeRestore.length)} />
        </section>
      : <p className="guild-rewind-plain">{messages.rewindNoCheckpoint(files.reason)}</p>;
  }
  if (files.restore.length === 0 && files.remove.length === 0) {
    return <p className="guild-rewind-plain">{messages.rewindNoFileChanges}</p>;
  }
  return <>
    {files.restore.length > 0 && <section className="guild-rewind-section">
      <h3>{messages.rewindRestoreHeading(files.restore.length)}</h3>
      <PathList paths={files.restore} label={messages.rewindRestoreHeading(files.restore.length)} />
    </section>}
    {files.remove.length > 0 && <section className="guild-rewind-section">
      <h3>{messages.rewindRemoveHeading(files.remove.length)}</h3>
      <PathList paths={files.remove} label={messages.rewindRemoveHeading(files.remove.length)} />
    </section>}
    {files.truncated && <p className="guild-rewind-plain faint">{messages.rewindListTruncated}</p>}
  </>;
}

function ReadyBody({ state, messages, onToggleOverwrite }: {
  readonly state: Extract<RewindState, { readonly phase: "ready" }>;
  readonly messages: GuildMessages;
  readonly onToggleOverwrite: () => void;
}) {
  const { plan } = state;
  const files = plan.files;
  const conflicts: readonly RewindConflictProjection[] = files.kind === "git"
    ? files.conflicts
    : files.runtimeConflicts.map((path) => ({ path, reason: "modified_after_run" as const }));
  const optIn = needsOverwriteOptIn(plan);
  return <>
    {plan.conversation.available
      ? <p className="guild-rewind-plain">{messages.rewindIntro(Math.max(0, plan.rolledBackRuns.length - 1))}</p>
      : <section className="guild-rewind-scope" aria-label={messages.rewindFilesOnlyTitle}>
          <span className="guild-rewind-radio" aria-hidden="true" />
          <div>
            <strong>{messages.rewindFilesOnlyTitle}</strong>
            <p>{messages.rewindFilesOnlyBody(plan.conversation.reason)}</p>
          </div>
        </section>}
    <FilesSection plan={plan} messages={messages} />
    {conflicts.length > 0 && <section className="guild-rewind-section warn">
      <h3>{messages.rewindConflictsHeading(conflicts.length)}</h3>
      {state.notice?.kind === "conflicts" && <p className="guild-rewind-alert" role="alert"><WarningCircle size={14} aria-hidden="true" />{messages.rewindConflictsChanged}</p>}
      <ConflictList conflicts={conflicts} messages={messages} />
      {optIn && <label className="guild-rewind-optin">
        <input type="checkbox" checked={state.overwrite} disabled={state.submitting} onChange={onToggleOverwrite} />
        <span><strong>{messages.rewindOverwriteLabel}</strong><small>{messages.rewindOverwriteNeeded}</small></span>
      </label>}
    </section>}
    {plan.cannotUndo.length > 0 && <section className="guild-rewind-section cannot-undo">
      <h3>{messages.rewindCannotUndoHeading}</h3>
      <ul>
        {plan.cannotUndo.map((item) => <li key={item.kind}>{messages.rewindCannotUndoKind(item.kind) ?? item.text}</li>)}
      </ul>
    </section>}
    {state.notice?.kind === "failed" && <p className="guild-rewind-alert" role="alert"><WarningCircle size={14} aria-hidden="true" />{messages.rewindFailed}</p>}
  </>;
}

function DoneBody({ result, messages }: { readonly result: RolledBackResult; readonly messages: GuildMessages }) {
  const summary = result.scope === "files_only"
    ? messages.rewindDoneFilesOnly(result.restoredFiles.length, result.removedFiles.length)
    : messages.rewindDoneConversation(result.rolledBackRuns.length, result.restoredFiles.length, result.removedFiles.length);
  return <div className="guild-rewind-done" role="status">
    <span className="guild-rewind-done-mark" aria-hidden="true"><Check size={16} weight="bold" /></span>
    <div>
      <strong>{messages.rewindDoneTitle}</strong>
      <p>{summary}</p>
      {result.scope === "conversation_and_files" && result.draftRestored && <p>{messages.rewindDraftBack}</p>}
      {result.failedFiles.length > 0 && <>
        <p className="guild-rewind-alert" role="alert"><WarningCircle size={14} aria-hidden="true" />{messages.rewindFailedFiles(result.failedFiles.length)}</p>
        <PathList paths={result.failedFiles.map((file) => file.path)} label={messages.rewindFailedFiles(result.failedFiles.length)} />
      </>}
    </div>
  </div>;
}

/**
 * Asks the main process what a rewind would do, says so in plain words (files restored and deleted,
 * files that changed since, what can never be undone), and only then rewinds. Cancel, Escape and a
 * click outside leave without touching anything; they are held back while a rewind is running.
 */
export function RewindDialog({ taskId, runId, messages, preview, execute, onRolledBack, onClose, onDialogKeyDown, initialState }: RewindDialogProps) {
  const [state, setState] = useState<RewindState>(initialState ?? REWIND_LOADING);
  const alive = useRef(true);
  const latest = useRef({ preview, onRolledBack });
  latest.current = { preview, onRolledBack };
  const titleId = useId();
  const bodyId = useId();

  const loadPreview = useCallback(() => {
    setState(REWIND_LOADING);
    void loadRewindPreview(() => latest.current.preview()).then((next) => { if (alive.current) setState(next); });
  }, []);

  useEffect(() => {
    alive.current = true;
    if (initialState === undefined) loadPreview();
    return () => { alive.current = false; };
  }, [initialState, loadPreview]);

  const rewound = state.phase === "done";
  const dismiss = () => { if (canDismiss(state)) onClose(rewound); };

  async function confirm() {
    if (state.phase !== "ready" || !canConfirm(state)) return;
    setState(beginSubmit(state));
    const { next, rolledBack } = await confirmRewind(taskId, state, execute);
    if (rolledBack !== undefined) latest.current.onRolledBack(rolledBack);
    if (alive.current) setState(next);
  }

  const ready = state.phase === "ready" ? state : undefined;
  const filesOnly = ready !== undefined && ready.plan.scope === "files_only";
  const submitting = ready?.submitting === true;
  return <div className="guild-dialog-backdrop" role="presentation" onPointerDown={dismiss} data-run-id={runId}>
    <div
      className="guild-dialog guild-rewind"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      aria-busy={state.phase === "loading" || submitting || undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => onDialogKeyDown(event, dismiss)}
    >
      <div className="guild-dialog-header"><strong id={titleId}>{messages.rewindTitle}</strong></div>
      <div className="guild-dialog-body guild-rewind-body" id={bodyId}>
        {state.phase === "loading" && <p className="guild-rewind-plain loading" role="status"><SpinnerGap size={14} className="guild-spin" aria-hidden="true" />{messages.rewindLoading}</p>}
        {state.phase === "refused" && <p className="guild-rewind-alert block" role="alert"><WarningCircle size={15} aria-hidden="true" />{messages.rewindRefused(state.reason)}</p>}
        {state.phase === "failed" && <p className="guild-rewind-alert block" role="alert"><WarningCircle size={15} aria-hidden="true" />{messages.rewindFailed}</p>}
        {ready !== undefined && <ReadyBody state={ready} messages={messages} onToggleOverwrite={() => setState(toggleOverwrite(state))} />}
        {state.phase === "done" && <DoneBody result={state.result} messages={messages} />}
      </div>
      <div className="guild-dialog-footer">
        {state.phase === "done" ? (
          <>
            <span />
            <button autoFocus type="button" className="primary" onClick={() => onClose(true)}>{messages.rewindDone}</button>
          </>
        ) : (
          <>
            <button autoFocus type="button" disabled={submitting} onClick={dismiss}>{messages.cancel}</button>
            {state.phase === "failed" && <button type="button" onClick={loadPreview}>{messages.rewindRetry}</button>}
            {ready !== undefined && (
              <button
                type="button"
                className="danger"
                disabled={!canConfirm(ready)}
                aria-busy={submitting || undefined}
                onClick={() => void confirm()}
              >{submitting
                ? <><SpinnerGap size={14} className="guild-spin" aria-hidden="true" />{messages.rewindWorking}</>
                : filesOnly ? messages.rewindConfirmFilesOnly : messages.rewindConfirm}</button>
            )}
          </>
        )}
      </div>
    </div>
  </div>;
}
