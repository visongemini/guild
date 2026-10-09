/**
 * Pure rules of the per-task worktree UI (F3): what the topbar chip says, which menu entries are
 * live, what the discard dialog lists, which new-task choice is remembered for a workspace, and
 * how a refused creation is recognised. No React and no DOM, so each rule has a plain test.
 */

// The runtime list comes from the subpath: the renderer bundle must not pull in the contracts root (it reaches node:crypto).
import { GUILD_WORKTREE_CREATE_REFUSAL_REASONS } from "@guild/contracts/worktrees";
import type { GuildWorktreeCreateRefusalReason, TaskWorktreeProjection } from "@guild/contracts";
import type { WorktreeMessages } from "./worktree-messages.js";

export type WorktreeChipPartKind = "ahead" | "dirty" | "applied" | "missing" | "discarded";
export type WorktreeChipPart = Readonly<{ kind: WorktreeChipPartKind; text: string }>;

/**
 * What follows the branch name on the chip: commits ahead and uncommitted files while the
 * worktree is in use, "merged" once everything is merged back, a warning when the folder is gone.
 * Nothing is shown for numbers git has not reported yet.
 */
export function worktreeChipParts(
  worktree: TaskWorktreeProjection,
  messages: WorktreeMessages,
): readonly WorktreeChipPart[] {
  if (worktree.status === "discarded") return [{ kind: "discarded", text: messages.chipDiscarded }];
  if (worktree.status === "missing") return [{ kind: "missing", text: messages.chipMissing }];
  if (worktree.status === "applied") return [{ kind: "applied", text: messages.chipApplied }];
  if (!worktree.measured) return [];
  const parts: WorktreeChipPart[] = [];
  if (worktree.ahead > 0) parts.push({ kind: "ahead", text: messages.chipAhead(worktree.ahead) });
  if (worktree.dirtyFiles > 0) {
    parts.push({ kind: "dirty", text: messages.chipDirty(worktree.dirtyFiles, worktree.dirtyFilesCapped === true) });
  }
  return parts;
}

export type WorktreeMenuState = Readonly<{
  /** The chip opens a menu at all. */
  interactive: boolean;
  canMerge: boolean;
  canDiscard: boolean;
  canOpen: boolean;
  /** A Run is why merge and discard are off. */
  blockedByRun: boolean;
}>;

export function worktreeMenuState(worktree: TaskWorktreeProjection, running: boolean): WorktreeMenuState {
  const live = worktree.status === "active" || worktree.status === "applied";
  return Object.freeze({
    interactive: worktree.status !== "discarded",
    canMerge: live && !running,
    canDiscard: (live || worktree.status === "missing") && !running,
    canOpen: live,
    blockedByRun: running && worktree.status !== "discarded",
  });
}

export type WorktreeDiscardFacts = Readonly<{
  branch: string;
  dirtyFiles: number;
  dirtyCapped: boolean;
  ahead: number;
  /** Everything is merged back and nothing is uncommitted: discarding only cleans up. */
  mergedAndClean: boolean;
}>;

export function worktreeDiscardFacts(worktree: TaskWorktreeProjection): WorktreeDiscardFacts {
  const measured = worktree.measured && worktree.status !== "missing";
  return Object.freeze({
    branch: worktree.branch,
    dirtyFiles: measured ? worktree.dirtyFiles : 0,
    dirtyCapped: measured && worktree.dirtyFilesCapped === true,
    ahead: measured ? worktree.ahead : 0,
    mergedAndClean: worktree.status === "applied" && measured && worktree.ahead === 0 && worktree.dirtyFiles === 0,
  });
}

// ---------------------------------------------------------------------------------------------
// The remembered new-task choice
// ---------------------------------------------------------------------------------------------

export const WORKTREE_PREFERENCE_KEY = "guild.worktree-isolation.v1";
const MAX_REMEMBERED_WORKSPACES = 200;

export type WorktreePreferences = ReadonlyMap<string, boolean>;

/** Per workspace: did the user last start a task in an isolated worktree? Local UI state only. */
export function readWorktreePreferences(storage: Pick<Storage, "getItem">): WorktreePreferences {
  try {
    const raw = storage.getItem(WORKTREE_PREFERENCE_KEY);
    if (raw === null) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const entries: Array<[string, boolean]> = [];
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (typeof value === "boolean" && workspaceId.length > 0 && workspaceId.length <= 512) {
        entries.push([workspaceId, value]);
      }
    }
    return new Map(entries.slice(-MAX_REMEMBERED_WORKSPACES));
  } catch {
    return new Map();
  }
}

export function writeWorktreePreference(
  storage: Pick<Storage, "getItem" | "setItem">,
  workspaceId: string,
  value: boolean,
): WorktreePreferences {
  const next = new Map(readWorktreePreferences(storage));
  next.delete(workspaceId);
  next.set(workspaceId, value);
  const trimmed = new Map([...next].slice(-MAX_REMEMBERED_WORKSPACES));
  try {
    storage.setItem(WORKTREE_PREFERENCE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Storage can be full or blocked; the choice then lasts for this window only.
  }
  return trimmed;
}

/** `createTask` refusals reach the renderer as an error whose message is `worktree_<reason>`. */
export function worktreeCreateRefusalOf(cause: unknown): GuildWorktreeCreateRefusalReason | undefined {
  const text = cause instanceof Error ? `${cause.message} ${String(cause.cause ?? "")}` : String(cause);
  const match = /\bworktree_([a-z_]{1,48})\b/u.exec(text);
  const reason = match?.[1];
  return (GUILD_WORKTREE_CREATE_REFUSAL_REASONS as readonly string[]).includes(reason ?? "")
    ? reason as GuildWorktreeCreateRefusalReason
    : undefined;
}

/** A refusal that will not change on a second try, so the remembered choice is dropped. */
export function worktreeRefusalIsLasting(reason: GuildWorktreeCreateRefusalReason): boolean {
  return reason === "not_a_git_repo" || reason === "no_commits" || reason === "workspace_not_in_commit";
}
