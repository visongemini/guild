/**
 * Orchestration of per-task git worktrees (F3) between the persistence rows (`task_worktrees`),
 * the git layer (git-worktrees.ts) and the projections: where a task works, how its worktree is
 * doing, and the preview / apply / discard operations behind the topbar chip.
 *
 * The caller (the live service, or the UI fixture) decides when an operation may run and holds its
 * own command queue around apply and discard; this module never starts or stops a Run. It is the
 * only writer of `task_worktrees`, so its in-memory copy of the rows stays coherent.
 */

import type {
  ApplyWorktreeResponse,
  DiscardWorktreeResponse,
  GuildWorktreeRefusalReason,
  GuildWorktreeStatus,
  PreviewWorktreeApplyResponse,
  TaskId,
  TaskWorktreeProjection,
  WorktreeBlockProjection,
  WorktreeChangeSummary,
} from "@guild/contracts";
import type { TaskWorktreeRecord, TaskWorktreeStatus } from "@guild/persistence";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  WORKTREES_DIRECTORY,
  findGitWorkTreeRootSync,
  taskWorktreeDirectory,
  worktreeBranchName,
  type GitWorktreePort,
  type WorktreeBlock,
  type WorktreeMergeSummary,
  type WorktreeTarget,
} from "./git-worktrees.js";

/** What the manager needs of the persistence store; `GuildPersistence` satisfies it as is. */
export interface WorktreeRowStore {
  createTaskWorktree(input: {
    readonly taskId: TaskId;
    readonly sourceWorkspaceId: string;
    readonly sourceRepoPath: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseCommit: string;
    readonly baseBranch?: string;
  }): TaskWorktreeRecord;
  listTaskWorktrees(): readonly TaskWorktreeRecord[];
  setTaskWorktreeStatus(input: {
    readonly taskId: TaskId;
    readonly status: TaskWorktreeStatus;
  }): TaskWorktreeRecord;
}

export type TaskWorktreeManagerOptions = Readonly<{
  store: WorktreeRowStore;
  git: GitWorktreePort;
  /** Guild's data directory; worktrees live under `<dataRoot>/worktrees`. */
  dataRoot: string;
  /** `run_active` while a Run, a queued turn or a send is in flight in the task. */
  runBlock: (taskId: TaskId) => "run_active" | undefined;
  /** Something a projection shows changed; the owner schedules a publish. */
  onChange: () => void;
  now?: () => number;
}>;

/** Minimum time between two background status refreshes of one task. */
const REFRESH_INTERVAL_MS = 30_000;
/** The workspace's "is it in a git work tree" answer is cached this long. */
const CAPABILITY_TTL_MS = 15_000;

type Measurement = Readonly<{
  ahead: number;
  behind: number;
  dirtyFiles: number;
  dirtyCapped: boolean;
  measuredAtMs: number;
}>;

type PreviewCore = Exclude<PreviewWorktreeApplyResponse, never>;
export type ApplyCore =
  | Exclude<ApplyWorktreeResponse, { readonly status: "applied" }>
  | (Omit<Extract<ApplyWorktreeResponse, { readonly status: "applied" }>, "task">);
export type DiscardCore = Exclude<DiscardWorktreeResponse, { readonly status: "discarded" }> | Readonly<{ status: "discarded" }>;

export interface TaskWorktreeManager {
  readonly worktreesRoot: string;
  /** True when `workspacePath` is inside a git work tree (a cheap hint; creation asks git). */
  isAvailableFor(workspacePath: string): boolean;
  /**
   * Creates the worktree, then runs `createTaskRow` (which makes the task row the worktree row
   * points at), then records the worktree. A failure after the worktree exists removes it again.
   * Refusals throw `Error("worktree_<reason>")`.
   */
  create(input: {
    taskId: TaskId;
    workspaceId: string;
    workspacePath: string;
    title: string;
    createTaskRow: () => void;
  }): Promise<TaskWorktreeRecord>;
  rowOf(taskId: TaskId): TaskWorktreeRecord | undefined;
  /** The folder the task's session runs in: the worktree (plus the workspace's sub-folder), or the workspace. */
  rootPathOf(taskId: TaskId, workspacePath: string): string;
  /** Sidebar flag. */
  statusOf(taskId: TaskId): GuildWorktreeStatus | undefined;
  projectionOf(taskId: TaskId): TaskWorktreeProjection | undefined;
  /** Throws when the task's worktree cannot host a session (discarded, outside Guild's root). */
  assertUsable(taskId: TaskId): Promise<void>;
  /**
   * Cheap, bounded status refresh. `force` skips the minimum interval, `minIntervalMs` shortens it
   * (the user opened the task). Resolves to whether a projection changed.
   */
  refresh(taskId: TaskId, options?: { force?: boolean; minIntervalMs?: number }): Promise<boolean>;
  /** Starts a background refresh when the task has none recent. Never throws, never waits. */
  noteViewed(taskId: TaskId): void;
  preview(taskId: TaskId): Promise<PreviewCore>;
  apply(taskId: TaskId, taskTitle: string): Promise<ApplyCore>;
  discard(taskId: TaskId): Promise<DiscardCore>;
  /** For an untouched new task: removes its worktree when nothing in it would be lost. */
  discardIfUntouched(taskId: TaskId): Promise<boolean>;
  /** The folder to show or open a terminal in; throws `worktree_unavailable` when there is none. */
  resourcePath(taskId: TaskId, workspacePath: string): Promise<string>;
  /** Task ids whose rows exist (for a startup sweep). */
  taskIds(): readonly TaskId[];
}

export function createTaskWorktreeManager(options: TaskWorktreeManagerOptions): TaskWorktreeManager {
  const { store, git } = options;
  const now = options.now ?? Date.now;
  const worktreesRoot = join(options.dataRoot, WORKTREES_DIRECTORY);
  let rows: Map<TaskId, TaskWorktreeRecord> | undefined;
  const measurements = new Map<TaskId, Measurement>();
  const attemptedAt = new Map<TaskId, number>();
  const inflight = new Map<TaskId, Promise<boolean>>();
  const capability = new Map<string, { readonly at: number; readonly available: boolean }>();

  function loaded(): Map<TaskId, TaskWorktreeRecord> {
    if (rows === undefined) rows = new Map(store.listTaskWorktrees().map((row) => [row.taskId, row]));
    return rows;
  }

  function setStatus(taskId: TaskId, status: TaskWorktreeStatus): TaskWorktreeRecord {
    const updated = store.setTaskWorktreeStatus({ taskId, status });
    loaded().set(taskId, updated);
    return updated;
  }

  function targetOf(row: TaskWorktreeRecord): WorktreeTarget {
    return {
      sourceRepoPath: row.sourceRepoPath,
      worktreePath: row.worktreePath,
      branch: row.branch,
      baseCommit: row.baseCommit,
      ...(row.baseBranch === undefined ? {} : { baseBranch: row.baseBranch }),
    };
  }

  function summaryOf(summary: WorktreeMergeSummary): WorktreeChangeSummary {
    return Object.freeze({
      branch: summary.branch,
      baseBranch: summary.baseBranch,
      commitsAhead: summary.commitsAhead,
      uncommittedFiles: summary.uncommittedFiles,
      files: Object.freeze(summary.files.map((file) => Object.freeze({
        path: file.path,
        ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
        status: file.status,
        adds: file.adds,
        dels: file.dels,
      }))),
      filesTotal: summary.filesTotal,
      adds: summary.adds,
      dels: summary.dels,
      filesTruncated: summary.filesTruncated,
    });
  }

  function blocksOf(blocking: readonly WorktreeBlock[]): readonly WorktreeBlockProjection[] {
    return Object.freeze(blocking.map((block) => Object.freeze({
      reason: block.reason,
      ...(block.currentBranch === undefined ? {} : { currentBranch: block.currentBranch }),
      ...(block.paths === undefined ? {} : { paths: block.paths }),
      ...(block.pathsTruncated === undefined ? {} : { pathsTruncated: block.pathsTruncated }),
    })));
  }

  function refusalOf(reason: "git_unavailable" | "git_too_old" | "timeout" | "git_failed" | "too_large"): GuildWorktreeRefusalReason {
    return reason === "too_large" ? "git_failed" : reason;
  }

  function gate(taskId: TaskId): TaskWorktreeRecord | GuildWorktreeRefusalReason {
    const row = loaded().get(taskId);
    if (row === undefined) return "no_worktree";
    if (row.status === "discarded") return "discarded";
    if (options.runBlock(taskId) !== undefined) return "run_active";
    return row;
  }

  function markMissing(taskId: TaskId): void {
    const row = loaded().get(taskId);
    if (row === undefined || row.status === "missing" || row.status === "discarded") return;
    setStatus(taskId, "missing");
    measurements.delete(taskId);
    options.onChange();
  }

  const manager: TaskWorktreeManager = {
    worktreesRoot,

    isAvailableFor(workspacePath) {
      const cached = capability.get(workspacePath);
      const at = now();
      if (cached !== undefined && at - cached.at < CAPABILITY_TTL_MS) return cached.available;
      const available = findGitWorkTreeRootSync(workspacePath) !== undefined;
      capability.set(workspacePath, { at, available });
      return available;
    },

    async create(input) {
      const created = await git.create({
        workspacePath: input.workspacePath,
        worktreePath: taskWorktreeDirectory(options.dataRoot, input.taskId),
        branch: worktreeBranchName(input.title, input.taskId),
      });
      if (created.status === "refused") throw new Error(`worktree_${created.reason}`);
      try {
        input.createTaskRow();
        const row = store.createTaskWorktree({
          taskId: input.taskId,
          sourceWorkspaceId: input.workspaceId,
          sourceRepoPath: created.sourceRepoPath,
          worktreePath: created.worktreePath,
          branch: created.branch,
          baseCommit: created.baseCommit,
          ...(created.baseBranch === undefined ? {} : { baseBranch: created.baseBranch }),
        });
        loaded().set(input.taskId, row);
        return row;
      } catch (cause) {
        // The task could not be recorded: take the worktree away again so nothing is orphaned.
        await git.discard({
          target: {
            sourceRepoPath: created.sourceRepoPath,
            worktreePath: created.worktreePath,
            branch: created.branch,
            baseCommit: created.baseCommit,
            ...(created.baseBranch === undefined ? {} : { baseBranch: created.baseBranch }),
          },
          worktreesRoot,
        }).catch(() => undefined);
        throw cause;
      }
    },

    rowOf: (taskId) => loaded().get(taskId),

    rootPathOf(taskId, workspacePath) {
      const row = loaded().get(taskId);
      if (row === undefined) return workspacePath;
      const sub = relative(row.sourceRepoPath, workspacePath);
      const inside = sub !== "" && !sub.startsWith("..") && !isAbsolute(sub);
      return inside ? join(row.worktreePath, sub) : row.worktreePath;
    },

    statusOf: (taskId) => loaded().get(taskId)?.status,

    projectionOf(taskId) {
      const row = loaded().get(taskId);
      if (row === undefined) return undefined;
      const measured = row.status === "discarded" || row.status === "missing" ? undefined : measurements.get(taskId);
      return Object.freeze({
        status: row.status,
        branch: row.branch,
        ...(row.baseBranch === undefined ? {} : { baseBranch: row.baseBranch }),
        ahead: measured?.ahead ?? 0,
        behind: measured?.behind ?? 0,
        dirtyFiles: measured?.dirtyFiles ?? 0,
        ...(measured?.dirtyCapped === true ? { dirtyFilesCapped: true as const } : {}),
        measured: measured !== undefined,
        ...(measured === undefined ? {} : { measuredAtMs: measured.measuredAtMs }),
      });
    },

    async assertUsable(taskId) {
      const row = loaded().get(taskId);
      if (row === undefined) return;
      if (row.status === "discarded") throw new Error("task_worktree_discarded");
      // The folder a session runs in must be Guild's own worktree, whatever a stored row says.
      let root: string;
      let real: string;
      try {
        [root, real] = await Promise.all([realpath(worktreesRoot), realpath(row.worktreePath)]);
      } catch {
        // A missing folder is reported by the caller's own existence check.
        return;
      }
      if (!real.startsWith(root + sep)) throw new Error("task_worktree_invalid");
    },

    async refresh(taskId, refreshOptions = {}) {
      const row = loaded().get(taskId);
      if (row === undefined || row.status === "discarded") return false;
      const running = inflight.get(taskId);
      if (running !== undefined) return running;
      const at = now();
      const interval = refreshOptions.minIntervalMs ?? REFRESH_INTERVAL_MS;
      if (refreshOptions.force !== true && at - (attemptedAt.get(taskId) ?? Number.NEGATIVE_INFINITY) < interval) {
        return false;
      }
      attemptedAt.set(taskId, at);
      const operation = (async () => {
        let changed = false;
        try {
          const inspection = await git.inspect({ target: targetOf(row) });
          const current = loaded().get(taskId);
          if (current === undefined || current.status === "discarded") return false;
          if (inspection.state === "present") {
            const previous = measurements.get(taskId);
            const next: Measurement = Object.freeze({
              ahead: inspection.ahead,
              behind: inspection.behind,
              dirtyFiles: inspection.dirtyFiles,
              dirtyCapped: inspection.dirtyCapped,
              measuredAtMs: now(),
            });
            measurements.set(taskId, next);
            changed = previous === undefined ||
              previous.ahead !== next.ahead || previous.behind !== next.behind ||
              previous.dirtyFiles !== next.dirtyFiles || previous.dirtyCapped !== next.dirtyCapped;
            // New work after a merge, or a folder that came back, makes the worktree active again.
            if (
              current.status === "missing" ||
              (current.status === "applied" && (inspection.ahead > 0 || inspection.dirtyFiles > 0))
            ) {
              setStatus(taskId, "active");
              changed = true;
            }
          } else if (inspection.state === "missing") {
            if (current.status !== "missing") {
              markMissing(taskId);
              changed = false;
            }
          }
          // "unavailable" (git slow or absent) keeps the last numbers and the status.
        } catch {
          // A status refresh never breaks the caller.
        }
        if (changed) options.onChange();
        return changed;
      })().finally(() => inflight.delete(taskId));
      inflight.set(taskId, operation);
      return operation;
    },

    noteViewed(taskId) {
      const row = loaded().get(taskId);
      if (row === undefined || row.status === "discarded" || inflight.has(taskId)) return;
      if (now() - (attemptedAt.get(taskId) ?? Number.NEGATIVE_INFINITY) < REFRESH_INTERVAL_MS) return;
      void manager.refresh(taskId).catch(() => undefined);
    },

    async preview(taskId) {
      const row = gate(taskId);
      if (typeof row === "string") return { status: "refused", reason: row };
      const result = await git.preview({ target: targetOf(row) });
      switch (result.status) {
        case "ready":
          return { status: "ready", summary: summaryOf(result.summary) };
        case "conflicts":
          return {
            status: "conflicts",
            summary: summaryOf(result.summary),
            conflicts: result.conflicts,
            ...(result.conflictsTruncated ? { conflictsTruncated: true as const } : {}),
          };
        case "blocked":
          return { status: "blocked", blocking: blocksOf(result.blocking) };
        case "worktree_missing":
          markMissing(taskId);
          return { status: "refused", reason: "worktree_missing" };
        case "unavailable":
          return { status: "refused", reason: refusalOf(result.reason) };
      }
    },

    async apply(taskId, taskTitle) {
      const row = gate(taskId);
      if (typeof row === "string") return { status: "refused", reason: row };
      const result = await git.apply({ target: targetOf(row), taskTitle });
      switch (result.status) {
        case "applied": {
          setStatus(taskId, "applied");
          // The numbers on the chip must already be the merged state when the dialog closes.
          await manager.refresh(taskId, { force: true });
          options.onChange();
          return {
            status: "applied",
            baseBranch: result.baseBranch,
            mergeCommit: result.mergeCommit.slice(0, 12),
            committedUncommitted: result.committedUncommitted,
            summary: summaryOf(result.summary),
          };
        }
        case "conflicts":
          return {
            status: "conflicts",
            conflicts: result.conflicts,
            ...(result.conflictsTruncated ? { conflictsTruncated: true as const } : {}),
          };
        case "blocked":
          return { status: "blocked", blocking: blocksOf(result.blocking) };
        case "worktree_missing":
          markMissing(taskId);
          return { status: "refused", reason: "worktree_missing" };
        case "failed":
          return {
            status: "failed",
            reason: result.reason === "repository_changed" ? "repository_changed"
              : result.reason === "timeout" ? "timeout"
              : "git_failed",
          };
      }
    },

    async discard(taskId) {
      const row = gate(taskId);
      if (typeof row === "string") return { status: "refused", reason: row };
      const result = await git.discard({ target: targetOf(row), worktreesRoot });
      if (result.status === "refused") return { status: "failed", reason: "git_failed" };
      if (result.status === "failed") {
        return { status: "failed", reason: result.reason === "timeout" ? "timeout" : "git_failed" };
      }
      setStatus(taskId, "discarded");
      measurements.delete(taskId);
      options.onChange();
      return { status: "discarded" };
    },

    async discardIfUntouched(taskId) {
      const row = loaded().get(taskId);
      if (row === undefined || row.status === "discarded") return true;
      if (row.status === "active" || row.status === "applied") {
        const inspection = await git.inspect({ target: targetOf(row) });
        if (inspection.state === "unavailable") return false;
        if (inspection.state === "present" && (inspection.ahead > 0 || inspection.dirtyFiles > 0)) return false;
      }
      const result = await git.discard({ target: targetOf(row), worktreesRoot });
      if (result.status !== "discarded") return false;
      setStatus(taskId, "discarded");
      measurements.delete(taskId);
      return true;
    },

    async resourcePath(taskId, workspacePath) {
      const row = loaded().get(taskId);
      if (row === undefined || row.status === "discarded" || row.status === "missing") {
        throw new Error("worktree_unavailable");
      }
      const path = manager.rootPathOf(taskId, workspacePath);
      try {
        const [root, real] = await Promise.all([realpath(worktreesRoot), realpath(path)]);
        if (!real.startsWith(root + sep)) throw new Error("worktree_unavailable");
        return real;
      } catch {
        throw new Error("worktree_unavailable");
      }
    },

    taskIds: () => [...loaded().keys()],
  };
  return manager;
}
