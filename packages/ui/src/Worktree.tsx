/**
 * The per-task git worktree (F3) in the interface: the new-task option, the topbar chip and its
 * menu, the sidebar glyph, the merge-back and discard dialogs, and the hook that wires them to the
 * renderer API. The views are plain components of their props so they render to static markup in
 * tests; `useWorktreeUi` holds the state and talks to the main process.
 */

import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { FolderSimpleIcon as FolderSimple } from "@phosphor-icons/react/FolderSimple";
import { GitBranchIcon as GitBranch } from "@phosphor-icons/react/GitBranch";
import { GitMergeIcon as GitMerge } from "@phosphor-icons/react/GitMerge";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { TerminalWindowIcon as TerminalWindow } from "@phosphor-icons/react/TerminalWindow";
import { TrashIcon as Trash } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SetStateAction } from "react";
import type {
  ApplyWorktreeResponse,
  DesktopBootstrapProjection,
  GuildLocale,
  GuildRendererApi,
  GuildWorktreeStatus,
  PreviewWorktreeApplyResponse,
  TaskId,
  TaskViewProjection,
  TaskWorktreeProjection,
  WorktreeBlockProjection,
  WorktreeChangeSummary,
  WorkspaceProjection,
} from "@guild/contracts";
import { worktreeMessagesFor, type WorktreeMessages } from "./worktree-messages.js";
import {
  readWorktreePreferences,
  worktreeChipParts,
  worktreeCreateRefusalOf,
  worktreeDiscardFacts,
  worktreeMenuState,
  worktreeRefusalIsLasting,
  writeWorktreePreference,
  type WorktreeDiscardFacts,
} from "./worktree-state.js";

const stopPointer = (event: { stopPropagation: () => void }): void => event.stopPropagation();

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

/** The branch mark in a sidebar row whose task works in a worktree and is otherwise idle. */
export function WorktreeGlyph({ status, messages }: {
  readonly status: GuildWorktreeStatus;
  readonly messages: WorktreeMessages;
}) {
  return (
    <GitBranch
      size={12}
      className={`guild-worktree-glyph ${status}`}
      aria-label={messages.sidebarTitle(status)}
      role="img"
    />
  );
}

/** Topbar chip: the task's branch, how far ahead it is and how much is uncommitted. */
export function WorktreeChip({ worktree, messages, open, onToggle }: {
  readonly worktree: TaskWorktreeProjection;
  readonly messages: WorktreeMessages;
  readonly open: boolean;
  readonly onToggle: (anchor: { readonly left: number; readonly bottom: number }) => void;
}) {
  const parts = worktreeChipParts(worktree, messages);
  const menu = worktreeMenuState(worktree, false);
  return (
    <button
      type="button"
      className={`guild-worktree-chip ${worktree.status} ${open ? "open" : ""}`}
      aria-label={messages.chipAria(worktree.branch, worktree.baseBranch, worktree.status)}
      aria-haspopup={menu.interactive ? "menu" : undefined}
      aria-expanded={menu.interactive ? open : undefined}
      disabled={!menu.interactive}
      title={messages.menuBranchLine(worktree.branch, worktree.baseBranch)}
      onPointerDown={stopPointer}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onToggle({ left: rect.left, bottom: rect.bottom });
      }}
    >
      {worktree.status === "missing"
        ? <WarningCircle size={12} aria-hidden="true" />
        : <GitBranch size={12} aria-hidden="true" />}
      <span className="guild-worktree-branch">{worktree.branch}</span>
      {parts.map((part) => (
        <span key={part.kind} className="guild-worktree-stat-group">
          <span className="guild-worktree-sep" aria-hidden="true">·</span>
          <span className={`guild-worktree-stat ${part.kind}`}>{part.text}</span>
        </span>
      ))}
    </button>
  );
}

export const WORKTREE_MENU_WIDTH = 288;
export const WORKTREE_MENU_HEIGHT = 292;

export function WorktreeMenu({ worktree, messages, running, x, y, onMerge, onDiscard, onFolder, onTerminal }: {
  readonly worktree: TaskWorktreeProjection;
  readonly messages: WorktreeMessages;
  readonly running: boolean;
  readonly x: number;
  readonly y: number;
  readonly onMerge: () => void;
  readonly onDiscard: () => void;
  readonly onFolder: () => void;
  readonly onTerminal: () => void;
}) {
  const state = worktreeMenuState(worktree, running);
  return (
    <div
      className="guild-context-menu guild-worktree-menu"
      role="menu"
      aria-label={messages.menuAria}
      style={{ left: x, top: y }}
      onPointerDown={stopPointer}
    >
      <p className="guild-worktree-menu-branch"><GitBranch size={13} aria-hidden="true" /><span>{messages.menuBranchLine(worktree.branch, worktree.baseBranch)}</span></p>
      <button type="button" role="menuitem" autoFocus disabled={!state.canMerge} onClick={onMerge}>
        <GitMerge size={16} />{messages.menuMerge(worktree.baseBranch)}
      </button>
      <button type="button" role="menuitem" className="danger" disabled={!state.canDiscard} onClick={onDiscard}>
        <Trash size={16} />{messages.menuDiscard}
      </button>
      {state.blockedByRun && <p className="guild-context-blocked">{messages.menuRunning}</p>}
      <div className="guild-context-divider" />
      <button type="button" role="menuitem" disabled={!state.canOpen} onClick={onFolder}>
        <FolderSimple size={16} />{messages.menuFinder}
      </button>
      <button type="button" role="menuitem" disabled={!state.canOpen} onClick={onTerminal}>
        <TerminalWindow size={16} />{messages.menuTerminal}
      </button>
      <p className="guild-worktree-note">{messages.menuNote}</p>
    </div>
  );
}

/** On a task that has no message yet: choose whether it works in an isolated worktree. */
export function WorktreeStartOption({ checked, busy, notice, messages, onChange }: {
  readonly checked: boolean;
  readonly busy: boolean;
  readonly notice: string | undefined;
  readonly messages: WorktreeMessages;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="guild-worktree-option">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={busy}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <GitBranch size={15} aria-hidden="true" />
        <span>{messages.startOption}</span>
      </label>
      <small>{busy ? messages.startOptionPreparing : messages.startOptionHelp}</small>
      {notice !== undefined && <small className="guild-worktree-notice" role="status">{notice}</small>}
    </div>
  );
}

/** Above the composer when the task can no longer send because of its worktree. */
export function WorktreeBanner({ worktree, messages }: {
  readonly worktree: TaskWorktreeProjection | undefined;
  readonly messages: WorktreeMessages;
}) {
  if (worktree === undefined || (worktree.status !== "discarded" && worktree.status !== "missing")) return null;
  return (
    <div className={`guild-worktree-banner ${worktree.status}`} role="status">
      {worktree.status === "missing" ? <WarningCircle size={15} aria-hidden="true" /> : <GitBranch size={15} aria-hidden="true" />}
      <span>{worktree.status === "missing" ? messages.bannerMissing : messages.bannerDiscarded}</span>
    </div>
  );
}

export type WorktreeApplyViewState =
  | { readonly phase: "checking" }
  | { readonly phase: "preview"; readonly result: PreviewWorktreeApplyResponse }
  | { readonly phase: "merging"; readonly summary: WorktreeChangeSummary }
  | { readonly phase: "done"; readonly result: Extract<ApplyWorktreeResponse, { readonly status: "applied" }> }
  | { readonly phase: "result"; readonly result: Exclude<ApplyWorktreeResponse, { readonly status: "applied" }> }
  | { readonly phase: "error" };

function FileList({ summary, messages }: { readonly summary: WorktreeChangeSummary; readonly messages: WorktreeMessages }) {
  return (
    <>
      <p className="guild-wt-summary">
        {summary.filesTotal === 0 ? messages.applyNoFiles : messages.applyFiles(summary.filesTotal, summary.adds, summary.dels)}
      </p>
      {summary.files.length > 0 && (
        <ul className="guild-wt-files">
          {summary.files.map((file) => (
            <li key={`${file.status}:${file.oldPath ?? ""}:${file.path}`}>
              <span className={`guild-wt-status ${file.status}`} aria-hidden="true">{file.status}</span>
              <span className="guild-wt-path" title={file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}>{file.path}</span>
              <span className="guild-wt-counts">
                {file.adds === null ? "—" : <span className="add">+{file.adds}</span>}
                {file.dels === null ? null : <span className="del">−{file.dels}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {summary.filesTruncated && <p className="guild-wt-more">{messages.applyMoreFiles(summary.filesTotal - summary.files.length)}</p>}
    </>
  );
}

function PathList({ paths, truncated, messages }: {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  readonly messages: WorktreeMessages;
}) {
  return (
    <ul className="guild-wt-paths">
      {paths.map((path) => <li key={path}>{path}</li>)}
      {truncated && <li className="more">{messages.applyPathsMore}</li>}
    </ul>
  );
}

function BlockList({ blocking, baseBranch, messages }: {
  readonly blocking: readonly WorktreeBlockProjection[];
  readonly baseBranch: string | undefined;
  readonly messages: WorktreeMessages;
}) {
  return (
    <div className="guild-wt-blocks">
      {blocking.map((block) => (
        <div key={block.reason} className="guild-wt-block">
          <p>{messages.applyBlock(block.reason, baseBranch, block.currentBranch)}</p>
          {block.paths !== undefined && block.paths.length > 0 && (
            <PathList paths={block.paths} truncated={block.pathsTruncated === true} messages={messages} />
          )}
        </div>
      ))}
    </div>
  );
}

/** Body and primary action of the merge-back dialog for one view state. Pure, for tests and the dialog. */
export function worktreeApplyView(
  state: WorktreeApplyViewState,
  baseBranch: string | undefined,
  messages: WorktreeMessages,
): { readonly body: ReactNode; readonly canConfirm: boolean; readonly working: boolean; readonly finished: boolean; readonly baseBranch: string | undefined } {
  switch (state.phase) {
    case "checking":
      return { body: <p className="guild-wt-working"><SpinnerGap size={14} className="guild-spin" />{messages.applyChecking}</p>, canConfirm: false, working: true, finished: false, baseBranch };
    case "merging":
      return {
        body: (<>
          <p className="guild-wt-working"><SpinnerGap size={14} className="guild-spin" />{messages.applyWorking}</p>
          <FileList summary={state.summary} messages={messages} />
        </>),
        canConfirm: false, working: true, finished: false, baseBranch: state.summary.baseBranch,
      };
    case "error":
      return { body: <p className="guild-wt-problem" role="alert">{messages.applyUnexpected}</p>, canConfirm: false, working: false, finished: true, baseBranch };
    case "done": {
      const { result } = state;
      return {
        body: (<>
          <p className="guild-wt-done"><Check size={15} weight="bold" aria-hidden="true" />{messages.applyDoneTitle(result.baseBranch)}</p>
          <p className="guild-wt-summary">{messages.applyDoneBody(result.mergeCommit, result.committedUncommitted)}</p>
          <FileList summary={result.summary} messages={messages} />
          <p className="guild-wt-more">{messages.applyDoneKept}</p>
        </>),
        canConfirm: false, working: false, finished: true, baseBranch: result.baseBranch,
      };
    }
    case "result": {
      const { result } = state;
      if (result.status === "conflicts") {
        return {
          body: (<>
            <p className="guild-wt-problem" role="alert">{messages.applyConflictsRaced}</p>
            <PathList paths={result.conflicts} truncated={result.conflictsTruncated === true} messages={messages} />
          </>),
          canConfirm: false, working: false, finished: true, baseBranch,
        };
      }
      if (result.status === "blocked") {
        return {
          body: (<>
            <p className="guild-wt-problem" role="alert">{messages.applyBlockedTitle}</p>
            <BlockList blocking={result.blocking} baseBranch={baseBranch} messages={messages} />
          </>),
          canConfirm: false, working: false, finished: true, baseBranch,
        };
      }
      return {
        body: <p className="guild-wt-problem" role="alert">{result.status === "refused" ? messages.applyRefusal(result.reason) : messages.applyFailed(result.reason)}</p>,
        canConfirm: false, working: false, finished: true, baseBranch,
      };
    }
    case "preview": {
      const { result } = state;
      if (result.status === "ready") {
        const { summary } = result;
        return {
          body: (<>
            {(summary.commitsAhead > 0 || summary.uncommittedFiles > 0) && (
              <ul className="guild-wt-facts">
                {summary.commitsAhead > 0 && <li>{messages.applyCommits(summary.commitsAhead)}</li>}
                {summary.uncommittedFiles > 0 && <li>{messages.applyUncommitted(summary.uncommittedFiles)}</li>}
              </ul>
            )}
            <FileList summary={summary} messages={messages} />
            <p className="guild-wt-more">{messages.applyReady(summary.baseBranch)}</p>
          </>),
          canConfirm: true, working: false, finished: false, baseBranch: summary.baseBranch,
        };
      }
      if (result.status === "conflicts") {
        return {
          body: (<>
            <p className="guild-wt-problem" role="alert"><WarningCircle size={15} aria-hidden="true" />{messages.applyConflictsTitle}</p>
            <p className="guild-wt-more">{messages.applyConflictsHelp}</p>
            <PathList paths={result.conflicts} truncated={result.conflictsTruncated === true} messages={messages} />
          </>),
          canConfirm: false, working: false, finished: true, baseBranch: result.summary.baseBranch,
        };
      }
      if (result.status === "blocked") {
        return {
          body: (<>
            <p className="guild-wt-problem" role="alert"><WarningCircle size={15} aria-hidden="true" />{messages.applyBlockedTitle}</p>
            <BlockList blocking={result.blocking} baseBranch={baseBranch} messages={messages} />
          </>),
          canConfirm: false, working: false, finished: true, baseBranch,
        };
      }
      return {
        body: <p className="guild-wt-problem" role="alert">{messages.applyRefusal(result.reason)}</p>,
        canConfirm: false, working: false, finished: true, baseBranch,
      };
    }
  }
}

export function WorktreeApplyDialog({ state, branch, baseBranch, messages, closeLabel, cancelLabel, onConfirm, onClose }: {
  readonly state: WorktreeApplyViewState;
  readonly branch: string | undefined;
  readonly baseBranch: string | undefined;
  readonly messages: WorktreeMessages;
  /** "Close" for a finished state; the main catalog's strings, passed in to keep one source of truth. */
  readonly closeLabel: string;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const view = worktreeApplyView(state, baseBranch, messages);
  return (
    <div className="guild-dialog-backdrop" role="presentation" onPointerDown={() => { if (!view.working) onClose(); }}>
      <div
        className="guild-dialog guild-worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.applyTitle(view.baseBranch)}
        aria-busy={view.working || undefined}
        onPointerDown={stopPointer}
        onKeyDown={(event) => trapDialogKeys(event, () => { if (!view.working) onClose(); })}
      >
        <div className="guild-dialog-header">
          <strong>{messages.applyTitle(view.baseBranch)}</strong>
          {branch !== undefined && <span className="guild-wt-branch-label"><GitBranch size={12} aria-hidden="true" />{branch}</span>}
        </div>
        <div className="guild-dialog-body">{view.body}</div>
        <div className="guild-dialog-footer">
          <button type="button" disabled={view.working} autoFocus={!view.canConfirm} onClick={onClose}>
            {state.phase === "done" ? messages.done : view.finished ? closeLabel : cancelLabel}
          </button>
          {view.canConfirm && (
            <button type="button" className="primary" autoFocus onClick={onConfirm}>{messages.applyConfirm(view.baseBranch)}</button>
          )}
        </div>
      </div>
    </div>
  );
}

export type WorktreeDiscardViewState =
  | { readonly phase: "confirm" }
  | { readonly phase: "working" }
  | { readonly phase: "failed"; readonly message: string };

export function WorktreeDiscardDialog({ state, facts, messages, cancelLabel, onConfirm, onClose }: {
  readonly state: WorktreeDiscardViewState;
  /** Known for the open task; absent when the dialog was opened for another task from the sidebar menu. */
  readonly facts: WorktreeDiscardFacts | undefined;
  readonly messages: WorktreeMessages;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const working = state.phase === "working";
  return (
    <div className="guild-dialog-backdrop" role="presentation" onPointerDown={() => { if (!working) onClose(); }}>
      <div
        className="guild-confirm-card guild-worktree-discard"
        role="alertdialog"
        aria-modal="true"
        aria-label={messages.discardTitle}
        aria-busy={working || undefined}
        onPointerDown={stopPointer}
        onKeyDown={(event) => trapDialogKeys(event, () => { if (!working) onClose(); })}
      >
        <strong>{messages.discardTitle}</strong>
        <p>{messages.discardIntro}</p>
        <ul className="guild-wt-facts destructive">
          <li>{messages.discardFolder}
            {facts !== undefined && facts.dirtyFiles > 0 && <em>{messages.discardDirty(facts.dirtyFiles, facts.dirtyCapped)}</em>}
          </li>
          {facts !== undefined && <li>{messages.discardBranch(facts.branch, facts.ahead)}</li>}
        </ul>
        {facts?.mergedAndClean === true && <p className="guild-wt-more">{messages.discardMergedNote}</p>}
        <p>{messages.discardKeeps}</p>
        {state.phase === "failed" && <p className="guild-wt-problem" role="alert">{state.message}</p>}
        <div className="guild-confirm-actions">
          <button type="button" disabled={working} autoFocus onClick={onClose}>{cancelLabel}</button>
          <button type="button" className="danger" disabled={working} onClick={onConfirm}>
            {working ? <SpinnerGap size={14} className="guild-spin" /> : <Trash size={14} />}
            {working ? messages.discardWorking : messages.discardConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Escape closes, Tab stays inside the dialog. */
function trapDialogKeys(event: ReactKeyboardEvent<HTMLElement>, onEscape: () => void): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onEscape();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// ---------------------------------------------------------------------------------------------
// State and wiring
// ---------------------------------------------------------------------------------------------

type ApplyDialog = Readonly<{
  taskId: TaskId;
  branch: string | undefined;
  baseBranch: string | undefined;
  state: WorktreeApplyViewState;
}>;

type DiscardDialog = Readonly<{
  taskId: TaskId;
  facts: WorktreeDiscardFacts | undefined;
  state: WorktreeDiscardViewState;
}>;

type WorktreeApi = Pick<
  GuildRendererApi,
  "createTask" | "previewWorktreeApply" | "applyWorktree" | "discardWorktree" | "openWorktreeResource"
>;

export function useWorktreeUi(input: {
  readonly api: WorktreeApi;
  readonly locale: GuildLocale;
  readonly workspaces: readonly WorkspaceProjection[];
  readonly setProjection: (update: SetStateAction<DesktopBootstrapProjection | undefined>) => void;
  readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly cancelLabel: string;
  readonly closeLabel: string;
}) {
  const { api, locale, workspaces, setProjection, storage } = input;
  const messages = useMemo(() => worktreeMessagesFor(locale), [locale]);
  const [preferences, setPreferences] = useState(() => storage === undefined ? new Map<string, boolean>() : readWorktreePreferences(storage));
  const [menu, setMenu] = useState<{ readonly left: number; readonly bottom: number }>();
  const [apply, setApply] = useState<ApplyDialog>();
  const [discard, setDiscard] = useState<DiscardDialog>();
  const [notice, setNotice] = useState<string>();
  const [preparing, setPreparing] = useState(false);

  const menuOpen = menu !== undefined;
  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = () => setMenu(undefined);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const remember = useCallback((workspaceId: string, value: boolean) => {
    setPreferences(storage === undefined
      ? (current) => new Map(current).set(workspaceId, value)
      : writeWorktreePreference(storage, workspaceId, value));
  }, [storage]);

  const adoptTask = useCallback((task: TaskViewProjection) => {
    setProjection((current) => current === undefined || current.activeTask?.task.taskId !== task.task.taskId
      ? current
      : { ...current, activeTask: task });
  }, [setProjection]);

  /**
   * Creates a task. `explicit` is the user's choice on the new-task option; without it the remembered
   * choice for the workspace decides. A refused worktree falls back to an ordinary task and says why.
   */
  const createTask = useCallback(async (workspaceId: string, explicit?: boolean): Promise<TaskViewProjection> => {
    const available = workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.worktreeAvailable === true;
    const wanted = available && (explicit ?? preferences.get(workspaceId) === true);
    const request = { workspaceId: workspaceId as WorkspaceProjection["workspaceId"] };
    setNotice(undefined);
    if (explicit !== undefined && available) remember(workspaceId, explicit);
    if (!wanted) return api.createTask(request);
    setPreparing(true);
    try {
      return await api.createTask({ ...request, isolation: "worktree" });
    } catch (cause) {
      const reason = worktreeCreateRefusalOf(cause);
      if (reason === undefined) throw cause;
      if (worktreeRefusalIsLasting(reason)) remember(workspaceId, false);
      setNotice(messages.startFallback(messages.createRefusal(reason)));
      return api.createTask(request);
    } finally {
      setPreparing(false);
    }
  }, [api, messages, preferences, remember, workspaces]);

  const openApply = useCallback((taskId: TaskId, worktree: TaskWorktreeProjection | undefined) => {
    setMenu(undefined);
    setApply({ taskId, branch: worktree?.branch, baseBranch: worktree?.baseBranch, state: { phase: "checking" } });
    const settle = (next: WorktreeApplyViewState) => setApply((current) =>
      current === undefined || current.taskId !== taskId || current.state.phase !== "checking"
        ? current
        : { ...current, state: next });
    void api.previewWorktreeApply({ taskId }).then(
      (result) => settle({ phase: "preview", result }),
      () => settle({ phase: "error" }),
    );
  }, [api]);

  const confirmApply = useCallback(async () => {
    const current = apply;
    if (current === undefined || current.state.phase !== "preview" || current.state.result.status !== "ready") return;
    setApply({ ...current, state: { phase: "merging", summary: current.state.result.summary } });
    try {
      const result = await api.applyWorktree({ taskId: current.taskId });
      if (result.status === "applied") {
        adoptTask(result.task);
        setApply({ ...current, state: { phase: "done", result } });
      } else {
        setApply({ ...current, state: { phase: "result", result } });
      }
    } catch {
      setApply({ ...current, state: { phase: "error" } });
    }
  }, [adoptTask, api, apply]);

  const openDiscard = useCallback((taskId: TaskId, worktree: TaskWorktreeProjection | undefined) => {
    setMenu(undefined);
    setDiscard({ taskId, facts: worktree === undefined ? undefined : worktreeDiscardFacts(worktree), state: { phase: "confirm" } });
  }, []);

  const confirmDiscard = useCallback(async () => {
    const current = discard;
    if (current === undefined || current.state.phase === "working") return;
    setDiscard({ ...current, state: { phase: "working" } });
    try {
      const result = await api.discardWorktree({ taskId: current.taskId });
      if (result.status === "discarded") {
        adoptTask(result.task);
        setDiscard(undefined);
      } else {
        setDiscard({
          ...current,
          state: {
            phase: "failed",
            message: result.status === "refused" ? messages.discardRefusal(result.reason) : messages.discardFailed,
          },
        });
      }
    } catch {
      setDiscard({ ...current, state: { phase: "failed", message: messages.discardFailed } });
    }
  }, [adoptTask, api, discard, messages]);

  const openResource = useCallback((taskId: TaskId, action: "folder" | "terminal") => {
    setMenu(undefined);
    void api.openWorktreeResource({ taskId, action }).catch(() => undefined);
  }, [api]);

  const workspaceOf = (workspaceId: string) => workspaces.find((workspace) => workspace.workspaceId === workspaceId);

  return {
    messages,
    createTask,
    openApply,
    openDiscard,
    isRemembered: (workspaceId: string) => preferences.get(workspaceId) === true,

    /** The chip for the open task, or nothing for a task without a worktree. */
    renderChip(task: TaskViewProjection | undefined): ReactNode {
      const worktree = task?.worktree;
      if (worktree === undefined) return null;
      return (
        <WorktreeChip
          worktree={worktree}
          messages={messages}
          open={menuOpen}
          onToggle={(anchor) => setMenu((current) => current === undefined ? anchor : undefined)}
        />
      );
    },

    /** The new-task option for a task without messages in a workspace that is a git repository. */
    renderStartOption(task: TaskViewProjection | undefined, pristine: boolean, busy: boolean, onChange: (checked: boolean) => void): ReactNode {
      if (task === undefined || !pristine || workspaceOf(task.task.workspaceId)?.worktreeAvailable !== true) return null;
      return (
        <WorktreeStartOption
          checked={task.worktree !== undefined && task.worktree.status !== "discarded"}
          busy={busy || preparing}
          notice={notice}
          messages={messages}
          onChange={onChange}
        />
      );
    },

    renderBanner(task: TaskViewProjection | undefined): ReactNode {
      return <WorktreeBanner worktree={task?.worktree} messages={messages} />;
    },

    /** The chip menu and both dialogs, for the root of the window. */
    renderOverlays(task: TaskViewProjection | undefined, running: boolean): ReactNode {
      const worktree = task?.worktree;
      const box = menu === undefined ? undefined : clampMenu(menu, input.viewport);
      return (
        <>
          {task !== undefined && worktree !== undefined && box !== undefined && (
            <WorktreeMenu
              worktree={worktree}
              messages={messages}
              running={running}
              x={box.x}
              y={box.y}
              onMerge={() => openApply(task.task.taskId, worktree)}
              onDiscard={() => openDiscard(task.task.taskId, worktree)}
              onFolder={() => openResource(task.task.taskId, "folder")}
              onTerminal={() => openResource(task.task.taskId, "terminal")}
            />
          )}
          {apply !== undefined && (
            <WorktreeApplyDialog
              state={apply.state}
              branch={apply.branch}
              baseBranch={apply.baseBranch}
              messages={messages}
              cancelLabel={input.cancelLabel}
              closeLabel={input.closeLabel}
              onConfirm={() => void confirmApply()}
              onClose={() => setApply(undefined)}
            />
          )}
          {discard !== undefined && (
            <WorktreeDiscardDialog
              state={discard.state}
              facts={discard.facts}
              messages={messages}
              cancelLabel={input.cancelLabel}
              onConfirm={() => void confirmDiscard()}
              onClose={() => setDiscard(undefined)}
            />
          )}
        </>
      );
    },
  };
}

export function clampMenu(
  anchor: { readonly left: number; readonly bottom: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const x = Math.max(8, Math.min(anchor.left, viewport.width - WORKTREE_MENU_WIDTH - 8));
  const y = Math.max(8, Math.min(anchor.bottom + 4, viewport.height - WORKTREE_MENU_HEIGHT - 8));
  return { x, y };
}
