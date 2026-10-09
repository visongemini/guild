/**
 * Renderer-facing shapes for F3, the per-task git worktree. A task created with `isolation:
 * "worktree"` works in `<Guild data>/worktrees/<taskId>`, a linked git worktree on its own
 * `guild/...` branch, so its changes stay out of the user's checkout until the user merges them
 * back. Everything here is plain data crossing the IPC boundary. The renderer never receives a
 * filesystem path of the worktree and never names a branch, ref or revision in a request: main
 * owns every decision and every git argument.
 */

import type { TaskViewProjection } from "./desktop-ipc.js";
import type { TaskId } from "./ids.js";

/** The only isolation `createTask` accepts besides leaving it out. */
export const GUILD_TASK_ISOLATIONS = Object.freeze(["worktree"] as const);
export type GuildTaskIsolation = (typeof GUILD_TASK_ISOLATIONS)[number];

export const GUILD_WORKTREE_STATUSES = Object.freeze([
  /** The worktree exists and the task works in it. */
  "active",
  /** Merged back into the base branch. The worktree and branch are kept until it is discarded. */
  "applied",
  /** Removed by the user. The task stays readable but cannot send prompts. */
  "discarded",
  /** The directory (or the source repository) is gone. */
  "missing",
] as const);
export type GuildWorktreeStatus = (typeof GUILD_WORKTREE_STATUSES)[number];

/** Why `createTask` with `isolation: "worktree"` was refused. Thrown as `worktree_<reason>`. */
export const GUILD_WORKTREE_CREATE_REFUSAL_REASONS = Object.freeze([
  "not_a_git_repo",
  "no_commits",
  "git_unavailable",
  "timeout",
  "git_failed",
  "workspace_not_in_commit",
] as const);
export type GuildWorktreeCreateRefusalReason =
  (typeof GUILD_WORKTREE_CREATE_REFUSAL_REASONS)[number];

/** The status line of a task's worktree: what the topbar chip shows. No path, no revision. */
export type TaskWorktreeProjection = {
  readonly status: GuildWorktreeStatus;
  /** The task's own branch, always `guild/...`. */
  readonly branch: string;
  /** The branch the worktree was cut from; absent when the checkout was on a detached HEAD. */
  readonly baseBranch?: string;
  /** Commits on the task branch that the base does not have. */
  readonly ahead: number;
  /** Commits on the base branch that the task branch does not have. */
  readonly behind: number;
  /** Changed, added or deleted files not committed yet (capped by main; `dirtyFilesCapped` says so). */
  readonly dirtyFiles: number;
  readonly dirtyFilesCapped?: true;
  /** False until git has answered once; the numbers are then placeholders. */
  readonly measured: boolean;
  readonly measuredAtMs?: number;
};

/** Why an operation on a worktree was refused before git was asked to change anything. */
export const GUILD_WORKTREE_REFUSAL_REASONS = Object.freeze([
  /** The task has no worktree. */
  "no_worktree",
  /** The worktree was discarded already. */
  "discarded",
  /** A Run (or a queued turn) is active in the task. */
  "run_active",
  /** The directory is gone; only a discard can clean up. */
  "worktree_missing",
  "git_unavailable",
  /** `git merge-tree --write-tree` needs git 2.38 or newer. */
  "git_too_old",
  "timeout",
  "git_failed",
] as const);
export type GuildWorktreeRefusalReason = (typeof GUILD_WORKTREE_REFUSAL_REASONS)[number];

export const GUILD_WORKTREE_BLOCK_REASONS = Object.freeze([
  /** No commit ahead and nothing uncommitted: merging would change nothing. */
  "nothing_to_merge",
  /** The worktree was cut from a detached HEAD, so there is no branch to merge into. */
  "no_base_branch",
  /** The base branch no longer exists in the source repository. */
  "base_branch_missing",
  /** The source repository is gone or no longer the one the worktree came from. */
  "source_missing",
  /** The source checkout is on another branch (see `currentBranch`) or on a detached HEAD. */
  "source_not_on_base_branch",
  /** A merge, rebase, cherry-pick or revert is in progress in the source checkout. */
  "source_operation_in_progress",
  /** The source checkout has staged changes; git would fold them into the merge. */
  "source_has_staged_changes",
  /** The source checkout has uncommitted changes in files the merge would change (see `paths`). */
  "source_dirty_in_touched_paths",
] as const);
export type GuildWorktreeBlockReason = (typeof GUILD_WORKTREE_BLOCK_REASONS)[number];

export const GUILD_WORKTREE_PATH_LIST_LIMIT = 50;

export type WorktreeBlockProjection = {
  readonly reason: GuildWorktreeBlockReason;
  /** For `source_not_on_base_branch`: the branch the source checkout is on; absent when detached. */
  readonly currentBranch?: string;
  /** For the dirty / staged reasons: repository-relative paths, at most `GUILD_WORKTREE_PATH_LIST_LIMIT`. */
  readonly paths?: readonly string[];
  readonly pathsTruncated?: true;
};

export type WorktreeChangedFileProjection = {
  /** Relative to the repository root. */
  readonly path: string;
  readonly oldPath?: string;
  readonly status: "A" | "M" | "D" | "R";
  /** `null` for a binary file. */
  readonly adds: number | null;
  readonly dels: number | null;
};

export const GUILD_WORKTREE_FILE_LIST_LIMIT = 200;

/** What merging the task branch into its base would change in the base branch. */
export type WorktreeChangeSummary = {
  readonly branch: string;
  readonly baseBranch: string;
  readonly commitsAhead: number;
  /** Uncommitted files Apply will commit first (0 when the worktree is clean). */
  readonly uncommittedFiles: number;
  readonly files: readonly WorktreeChangedFileProjection[];
  readonly filesTotal: number;
  readonly adds: number;
  readonly dels: number;
  readonly filesTruncated: boolean;
};

export type PreviewWorktreeApplyRequest = { readonly taskId: TaskId };
export type ApplyWorktreeRequest = { readonly taskId: TaskId };
export type DiscardWorktreeRequest = { readonly taskId: TaskId };
export type OpenWorktreeResourceRequest = {
  readonly taskId: TaskId;
  readonly action: "folder" | "terminal";
};

export type PreviewWorktreeApplyResponse =
  /** The merge would be clean and nothing blocks it. */
  | { readonly status: "ready"; readonly summary: WorktreeChangeSummary }
  /** The merge would conflict in these files (nothing was changed to find out). */
  | {
      readonly status: "conflicts";
      readonly summary: WorktreeChangeSummary;
      readonly conflicts: readonly string[];
      readonly conflictsTruncated?: true;
    }
  | { readonly status: "blocked"; readonly blocking: readonly WorktreeBlockProjection[] }
  | { readonly status: "refused"; readonly reason: GuildWorktreeRefusalReason };

export type ApplyWorktreeResponse =
  /** Merged with `git merge --no-ff`. The task view carries the refreshed worktree status. */
  | {
      readonly status: "applied";
      readonly baseBranch: string;
      /** Abbreviated id of the merge commit. */
      readonly mergeCommit: string;
      readonly committedUncommitted: boolean;
      readonly summary: WorktreeChangeSummary;
      readonly task: TaskViewProjection;
    }
  /** The merge conflicted at the last moment; it was aborted and the source checkout restored. */
  | { readonly status: "conflicts"; readonly conflicts: readonly string[]; readonly conflictsTruncated?: true }
  | { readonly status: "blocked"; readonly blocking: readonly WorktreeBlockProjection[] }
  | { readonly status: "refused"; readonly reason: GuildWorktreeRefusalReason }
  | { readonly status: "failed"; readonly reason: "git_failed" | "timeout" | "repository_changed" };

export type DiscardWorktreeResponse =
  | { readonly status: "discarded"; readonly task: TaskViewProjection }
  | { readonly status: "refused"; readonly reason: GuildWorktreeRefusalReason }
  | { readonly status: "failed"; readonly reason: "git_failed" | "timeout" };
