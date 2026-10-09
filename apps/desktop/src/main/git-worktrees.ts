/**
 * Per-task git worktrees (F3): create a linked worktree on its own `guild/...` branch, read its
 * status, preview and perform the merge back into the branch it was cut from, and discard it.
 *
 * Why Guild runs git itself: the official runtime's `_x.ai/git/worktree/apply` failed both live
 * tests (docs/19) and has no merge command, so these operations are plain local git.
 *
 * Safety contract, enforced by construction and covered by git-worktrees.test.ts:
 *  - Every git process is the bounded, hook-free runner of git-checkpoints.ts: hooks
 *    (`core.hooksPath`), fsmonitor, auto-gc, commit signing and credential prompts are off, there
 *    is a deadline on every process and stdout is size-capped.
 *  - Nothing here pushes, fetches, rebases, resets, stashes or checks out in the user's checkout,
 *    and no branch is touched other than the `guild/...` branch Guild created for the task.
 *  - Status, preview and the dry run read the user's checkout only (`GIT_OPTIONAL_LOCKS=0`, no
 *    index refresh) and write nothing but new objects. The one change Apply makes to the user's
 *    checkout is `git merge --no-ff` of the task branch into the branch the worktree was cut from,
 *    and only after a read-only conflict check (`git merge-tree --write-tree`) and these refusals:
 *    the checkout is not on that branch, a merge / rebase / cherry-pick / revert is in progress,
 *    it has staged changes (git would fold them into the merge), or it has uncommitted changes in
 *    a file the merge changes.
 *  - A merge that still conflicts (the checkout changed after the check) is aborted with
 *    `git merge --abort` and verified to have restored HEAD; the checkout is never left mid-merge.
 *  - Discard removes exactly the registered worktree directory (which must live under Guild's own
 *    worktrees root) and the one `guild/...` branch recorded for the task.
 *  - Failures are returned as typed results, never thrown for git being absent, slow or unhappy.
 */

import { createHash, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  captureCurrentTree,
  deadlineIn,
  gitOutputText,
  runGit,
  safeRefSegment,
  summarizeDiff,
  type GitChangedFile,
  type GitOutcome,
} from "./git-checkpoints.js";

export const WORKTREE_BRANCH_PREFIX = "guild/";
/** Folder under Guild's data directory that holds every task worktree. */
export const WORKTREES_DIRECTORY = "worktrees";

export type GitWorktreeLimits = Readonly<{
  createTimeoutMs: number;
  /** One status refresh (counts only). */
  statusTimeoutMs: number;
  /** The read-only conflict check. */
  previewTimeoutMs: number;
  /** Commit plus merge, including the checks that precede them. */
  applyTimeoutMs: number;
  discardTimeoutMs: number;
  /** stdout cap of a `git status` listing. */
  maxStatusBytes: number;
}>;

export const DEFAULT_WORKTREE_LIMITS: GitWorktreeLimits = Object.freeze({
  createTimeoutMs: 60_000,
  statusTimeoutMs: 5_000,
  previewTimeoutMs: 30_000,
  applyTimeoutMs: 90_000,
  discardTimeoutMs: 120_000,
  maxStatusBytes: 4 * 1024 * 1024,
});

export type WorktreeFailureReason =
  | "git_unavailable"
  | "git_too_old"
  | "timeout"
  | "git_failed"
  | "too_large";

export type WorktreeCreateRefusal =
  | "not_a_git_repo"
  | "no_commits"
  | "workspace_not_in_commit"
  | WorktreeFailureReason;

/** The identity of a task's worktree, as stored in `task_worktrees`. */
export type WorktreeTarget = Readonly<{
  sourceRepoPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  /** Absent when the source checkout was on a detached HEAD. */
  baseBranch?: string | undefined;
}>;

export type CreateWorktreeResult =
  | Readonly<{
      status: "created";
      /** Top level of the source repository (a realpath). */
      sourceRepoPath: string;
      worktreePath: string;
      /** Usually the requested branch; a short suffix is added when that name was taken. */
      branch: string;
      baseCommit: string;
      baseBranch?: string;
      /** Workspace folder relative to the repository root; empty when they are the same. */
      subdirectory: string;
    }>
  | Readonly<{ status: "refused"; reason: WorktreeCreateRefusal }>;

export type WorktreeInspection =
  | Readonly<{
      state: "present";
      ahead: number;
      behind: number;
      dirtyFiles: number;
      dirtyCapped: boolean;
    }>
  /** The directory, the branch or the repository is gone. */
  | Readonly<{ state: "missing"; reason: "worktree_directory" | "not_a_worktree" | "branch" }>
  | Readonly<{ state: "unavailable"; reason: WorktreeFailureReason }>;

export type WorktreeBlockReason =
  | "nothing_to_merge"
  | "no_base_branch"
  | "base_branch_missing"
  | "source_missing"
  | "source_not_on_base_branch"
  | "source_operation_in_progress"
  | "source_has_staged_changes"
  | "source_dirty_in_touched_paths";

export type WorktreeBlock = Readonly<{
  reason: WorktreeBlockReason;
  currentBranch?: string;
  paths?: readonly string[];
  pathsTruncated?: true;
}>;

export const WORKTREE_PATH_LIST_LIMIT = 50;
export const WORKTREE_FILE_LIST_LIMIT = 200;

export type WorktreeMergeSummary = Readonly<{
  branch: string;
  baseBranch: string;
  commitsAhead: number;
  uncommittedFiles: number;
  files: readonly GitChangedFile[];
  filesTotal: number;
  adds: number;
  dels: number;
  filesTruncated: boolean;
}>;

export type WorktreeMergeEvaluation =
  | Readonly<{ status: "ready"; summary: WorktreeMergeSummary }>
  | Readonly<{
      status: "conflicts";
      summary: WorktreeMergeSummary;
      conflicts: readonly string[];
      conflictsTruncated: boolean;
    }>
  | Readonly<{ status: "blocked"; blocking: readonly WorktreeBlock[] }>
  | Readonly<{ status: "worktree_missing" }>
  | Readonly<{ status: "unavailable"; reason: WorktreeFailureReason }>;

export type WorktreeApplyResult =
  | Readonly<{
      status: "applied";
      baseBranch: string;
      /** Full id of the merge commit. */
      mergeCommit: string;
      committedUncommitted: boolean;
      summary: WorktreeMergeSummary;
    }>
  | Readonly<{ status: "conflicts"; conflicts: readonly string[]; conflictsTruncated: boolean }>
  | Readonly<{ status: "blocked"; blocking: readonly WorktreeBlock[] }>
  | Readonly<{ status: "worktree_missing" }>
  | Readonly<{
      status: "failed";
      reason: WorktreeFailureReason | "repository_changed";
    }>;

export type WorktreeDiscardResult =
  | Readonly<{ status: "discarded"; removedWorktree: boolean; removedBranch: boolean }>
  | Readonly<{ status: "refused"; reason: "invalid_target" }>
  | Readonly<{ status: "failed"; reason: WorktreeFailureReason }>;

/** The surface the live service uses; tests substitute a fake. */
export interface GitWorktreePort {
  create(input: {
    workspacePath: string;
    worktreePath: string;
    branch: string;
    limits?: Partial<GitWorktreeLimits>;
  }): Promise<CreateWorktreeResult>;
  inspect(input: {
    target: WorktreeTarget;
    limits?: Partial<GitWorktreeLimits>;
  }): Promise<WorktreeInspection>;
  preview(input: {
    target: WorktreeTarget;
    limits?: Partial<GitWorktreeLimits>;
  }): Promise<WorktreeMergeEvaluation>;
  apply(input: {
    target: WorktreeTarget;
    taskTitle: string;
    limits?: Partial<GitWorktreeLimits>;
  }): Promise<WorktreeApplyResult>;
  discard(input: {
    target: WorktreeTarget;
    /** The directory every task worktree must live under. */
    worktreesRoot: string;
    limits?: Partial<GitWorktreeLimits>;
  }): Promise<WorktreeDiscardResult>;
}

// ---------------------------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------------------------

/** ASCII slug of a task title for the branch name; `task` when nothing usable is left. */
export function worktreeBranchSlug(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24)
    .replace(/-+$/gu, "");
  // The placeholder titles of an untouched new task say nothing about the work.
  return ascii === "" || ascii === "new-task" ? "task" : ascii;
}

/** `guild/<slug>-<short id>`; the short id is a stable hash of the task id. */
export function worktreeBranchName(title: string, taskId: string, extra = 0): string {
  const hash = createHash("sha256").update(taskId, "utf8").digest("hex");
  return `${WORKTREE_BRANCH_PREFIX}${worktreeBranchSlug(title)}-${hash.slice(0, 8 + extra)}`;
}

const SAFE_BRANCH = /^guild\/[a-z0-9][a-z0-9._-]{0,150}$/u;
const SAFE_BASE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/+@#%=,-]{1,255}$/u;

/** Only branches of this exact shape are ever created or deleted by Guild. */
export function isGuildBranchName(branch: string): boolean {
  return SAFE_BRANCH.test(branch) && !branch.endsWith(".lock") && !branch.endsWith(".") && !branch.includes("..");
}

function isUsableBaseBranch(name: string | undefined): name is string {
  return name !== undefined && SAFE_BASE_BRANCH.test(name) && !name.endsWith(".lock") && !name.endsWith("/");
}

/** `<data root>/worktrees/<task id>` with an unusual task id replaced by a stable hash. */
export function taskWorktreeDirectory(dataRoot: string, taskId: string): string {
  return join(dataRoot, WORKTREES_DIRECTORY, safeRefSegment(taskId) ?? "task");
}

/**
 * The nearest folder at or above `path` that holds a `.git` entry (a directory, or the file a
 * linked worktree or submodule has). A cheap hint for the UI; creation asks git for the truth.
 */
export function findGitWorkTreeRootSync(path: string): string | undefined {
  let directory = path;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      statSync(join(directory, ".git"));
      return directory;
    } catch {
      // Not here: try the parent.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------------------------

const GUILD_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "Guild",
  GIT_AUTHOR_EMAIL: "guild@localhost",
  GIT_COMMITTER_NAME: "Guild",
  GIT_COMMITTER_EMAIL: "guild@localhost",
});

const FULL_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

function limitsOf(partial: Partial<GitWorktreeLimits> | undefined): GitWorktreeLimits {
  return Object.freeze({ ...DEFAULT_WORKTREE_LIMITS, ...(partial ?? {}) });
}

function failureOf(outcome: GitOutcome): WorktreeFailureReason {
  if (outcome.missing) return "git_unavailable";
  if (outcome.timedOut) return "timeout";
  if (outcome.truncated) return "too_large";
  return "git_failed";
}

type Remaining = () => number;

function git(
  cwd: string,
  args: readonly string[],
  remaining: Remaining,
  options: { env?: Readonly<Record<string, string>>; maxStdoutBytes?: number } = {},
): Promise<GitOutcome> {
  return runGit(args, {
    cwd,
    timeoutMs: Math.max(1, remaining()),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: options.maxStdoutBytes }),
  });
}

async function revParse(
  cwd: string,
  revision: string,
  remaining: Remaining,
): Promise<string | undefined | WorktreeFailureReason> {
  const outcome = await git(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], remaining);
  if (outcome.missing || outcome.timedOut) return failureOf(outcome);
  const id = gitOutputText(outcome).trim();
  return outcome.code === 0 && FULL_ID.test(id) ? id : undefined;
}

function isFailureReason(value: unknown): value is WorktreeFailureReason {
  return value === "git_unavailable" || value === "git_too_old" || value === "timeout" ||
    value === "git_failed" || value === "too_large";
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function sameOrInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

type StatusEntry = Readonly<{ staged: boolean; unmerged: boolean; untracked: boolean; path: string }>;

/** `git status --porcelain=v1 -z --no-renames`: every entry is `XY path`. */
function parseStatus(outcome: GitOutcome): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const field of gitOutputText(outcome).split("\0")) {
    if (field.length < 4 || field[2] !== " ") continue;
    const x = field[0] ?? " ";
    const y = field[1] ?? " ";
    if (x === "!" && y === "!") continue;
    const unmerged = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    entries.push({
      staged: x !== " " && x !== "?" && x !== "!",
      unmerged,
      untracked: x === "?" && y === "?",
      path: field.slice(3),
    });
  }
  return entries;
}

function statusArguments(): readonly string[] {
  // runGit sets GIT_OPTIONAL_LOCKS=0, so a status never refreshes (writes) an index.
  return ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"];
}

function capPaths(paths: readonly string[]): { paths: readonly string[]; truncated: boolean } {
  const sorted = [...new Set(paths)].sort();
  return {
    paths: Object.freeze(sorted.slice(0, WORKTREE_PATH_LIST_LIMIT)),
    truncated: sorted.length > WORKTREE_PATH_LIST_LIMIT,
  };
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export async function createGitWorktree(input: {
  workspacePath: string;
  worktreePath: string;
  branch: string;
  limits?: Partial<GitWorktreeLimits>;
}): Promise<CreateWorktreeResult> {
  const limits = limitsOf(input.limits);
  const remaining = deadlineIn(limits.createTimeoutMs);
  const refuse = (reason: WorktreeCreateRefusal): CreateWorktreeResult => ({ status: "refused", reason });
  if (!isAbsolute(input.worktreePath) || !isGuildBranchName(input.branch)) return refuse("git_failed");

  const workspace = await canonical(input.workspacePath);
  if (workspace === undefined || !(await isDirectory(workspace))) return refuse("not_a_git_repo");

  const top = await git(workspace, ["rev-parse", "--show-toplevel"], remaining);
  if (top.missing || top.timedOut) return refuse(failureOf(top));
  const topText = gitOutputText(top).trim();
  if (top.code !== 0 || topText === "") return refuse("not_a_git_repo");
  const repoRoot = await canonical(topText);
  if (repoRoot === undefined || !sameOrInside(repoRoot, workspace)) return refuse("not_a_git_repo");
  const subdirectory = relative(repoRoot, workspace);

  const baseCommit = await revParse(repoRoot, "HEAD", remaining);
  if (isFailureReason(baseCommit)) return refuse(baseCommit);
  if (baseCommit === undefined) return refuse("no_commits");

  const symbolic = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], remaining);
  if (symbolic.missing || symbolic.timedOut) return refuse(failureOf(symbolic));
  const headBranch = symbolic.code === 0 ? gitOutputText(symbolic).trim() : "";
  const baseBranch = isUsableBaseBranch(headBranch) ? headBranch : undefined;

  try {
    await mkdir(dirname(input.worktreePath), { recursive: true, mode: 0o700 });
    if (await canonical(input.worktreePath) !== undefined) return refuse("git_failed");
  } catch {
    return refuse("git_failed");
  }

  let branch = input.branch;
  let added = await git(
    repoRoot,
    ["worktree", "add", "--quiet", "-b", branch, input.worktreePath, baseCommit],
    remaining,
  );
  if (added.code !== 0 && !added.missing && !added.timedOut && /already (exists|used|checked)/iu.test(added.stderr)) {
    // The name is taken (an older worktree of the same task id, or a coincidence): one longer try.
    branch = `${input.branch}-${randomBytes(3).toString("hex")}`;
    added = await git(
      repoRoot,
      ["worktree", "add", "--quiet", "-b", branch, input.worktreePath, baseCommit],
      remaining,
    );
  }
  if (added.code !== 0) return refuse(failureOf(added));

  const worktreePath = await canonical(input.worktreePath);
  if (worktreePath === undefined) return refuse("git_failed");
  if (subdirectory !== "" && !(await isDirectory(join(worktreePath, subdirectory)))) {
    // The workspace folder is not part of the commit (for example it is untracked): the worktree
    // would start the task in a folder that does not exist. Undo the creation.
    await removeWorktreeAndBranch({ repoRoot, worktreePath, branch, remaining: deadlineIn(30_000) });
    return refuse("workspace_not_in_commit");
  }
  return Object.freeze({
    status: "created",
    sourceRepoPath: repoRoot,
    worktreePath,
    branch,
    baseCommit,
    ...(baseBranch === undefined ? {} : { baseBranch }),
    subdirectory,
  });
}

// ---------------------------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------------------------

export async function inspectGitWorktree(input: {
  target: WorktreeTarget;
  limits?: Partial<GitWorktreeLimits>;
}): Promise<WorktreeInspection> {
  const { target } = input;
  const limits = limitsOf(input.limits);
  const remaining = deadlineIn(limits.statusTimeoutMs);
  if (!isGuildBranchName(target.branch)) return { state: "unavailable", reason: "git_failed" };
  if (!(await isDirectory(target.worktreePath))) return { state: "missing", reason: "worktree_directory" };

  const [top, branchTip] = await Promise.all([
    git(target.worktreePath, ["rev-parse", "--show-toplevel"], remaining),
    revParse(target.worktreePath, `refs/heads/${target.branch}`, remaining),
  ]);
  if (top.missing || top.timedOut) return { state: "unavailable", reason: failureOf(top) };
  if (isFailureReason(branchTip)) return { state: "unavailable", reason: branchTip };
  const topPath = top.code === 0 ? await canonical(gitOutputText(top).trim()) : undefined;
  const expected = await canonical(target.worktreePath);
  if (topPath === undefined || expected === undefined || topPath !== expected) {
    return { state: "missing", reason: "not_a_worktree" };
  }
  if (branchTip === undefined) return { state: "missing", reason: "branch" };

  let baseRef: string = target.baseCommit;
  if (isUsableBaseBranch(target.baseBranch)) {
    const tip = await revParse(target.worktreePath, `refs/heads/${target.baseBranch}`, remaining);
    if (isFailureReason(tip)) return { state: "unavailable", reason: tip };
    if (tip !== undefined) baseRef = tip;
  }
  if (!FULL_ID.test(baseRef)) return { state: "unavailable", reason: "git_failed" };

  const [counts, status] = await Promise.all([
    git(target.worktreePath, ["rev-list", "--left-right", "--count", `${baseRef}...${branchTip}`], remaining),
    git(target.worktreePath, statusArguments(), remaining, { maxStdoutBytes: limits.maxStatusBytes }),
  ]);
  if (counts.code !== 0) return { state: "unavailable", reason: failureOf(counts) };
  const match = /^(\d+)\s+(\d+)\s*$/u.exec(gitOutputText(counts));
  if (match === null) return { state: "unavailable", reason: "git_failed" };
  if (status.code !== 0 && !status.truncated) return { state: "unavailable", reason: failureOf(status) };
  return Object.freeze({
    state: "present",
    behind: Number(match[1]),
    ahead: Number(match[2]),
    dirtyFiles: parseStatus(status).length,
    dirtyCapped: status.truncated,
  });
}

// ---------------------------------------------------------------------------------------------
// Merge evaluation (read-only)
// ---------------------------------------------------------------------------------------------

type MergePlan = Readonly<{
  baseBranch: string;
  baseTip: string;
  branchTip: string;
  /** The commit whose content is merged: the branch tip, or a snapshot commit that adds the uncommitted files. */
  mergeHead: string;
  mergeBase: string;
  mergedTree: string;
  conflicts: readonly string[];
  commitsAhead: number;
  uncommittedFiles: number;
  summary: WorktreeMergeSummary;
}>;

type PlanOutcome =
  | Readonly<{ status: "planned"; plan: MergePlan }>
  | Exclude<WorktreeMergeEvaluation, Readonly<{ status: "ready" | "conflicts" }>>;

const OPERATION_MARKERS = Object.freeze([
  "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG",
]);

async function operationInProgress(repo: string, remaining: Remaining): Promise<boolean | WorktreeFailureReason> {
  const dir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"], remaining);
  if (dir.code !== 0) return failureOf(dir);
  const gitDir = gitOutputText(dir).trim();
  if (gitDir === "") return "git_failed";
  for (const marker of OPERATION_MARKERS) {
    try {
      await stat(join(gitDir, marker));
      return true;
    } catch {
      // Absent.
    }
  }
  return false;
}

async function planMerge(
  target: WorktreeTarget,
  limits: GitWorktreeLimits,
  remaining: Remaining,
): Promise<PlanOutcome> {
  if (!isGuildBranchName(target.branch)) return { status: "unavailable", reason: "git_failed" };
  if (!isUsableBaseBranch(target.baseBranch)) {
    return { status: "blocked", blocking: [{ reason: "no_base_branch" }] };
  }
  const baseBranch = target.baseBranch;
  if (!(await isDirectory(target.worktreePath))) return { status: "worktree_missing" };

  const source = await canonical(target.sourceRepoPath);
  if (source === undefined || !(await isDirectory(source))) {
    return { status: "blocked", blocking: [{ reason: "source_missing" }] };
  }
  const sourceTop = await git(source, ["rev-parse", "--show-toplevel"], remaining);
  if (sourceTop.missing || sourceTop.timedOut) return { status: "unavailable", reason: failureOf(sourceTop) };
  if (sourceTop.code !== 0 || (await canonical(gitOutputText(sourceTop).trim())) !== source) {
    return { status: "blocked", blocking: [{ reason: "source_missing" }] };
  }

  const [branchTip, baseTip] = await Promise.all([
    revParse(target.worktreePath, `refs/heads/${target.branch}`, remaining),
    revParse(source, `refs/heads/${baseBranch}`, remaining),
  ]);
  if (isFailureReason(branchTip)) return { status: "unavailable", reason: branchTip };
  if (isFailureReason(baseTip)) return { status: "unavailable", reason: baseTip };
  if (branchTip === undefined) return { status: "worktree_missing" };
  if (baseTip === undefined) return { status: "blocked", blocking: [{ reason: "base_branch_missing" }] };

  const [worktreeStatus, aheadOutcome] = await Promise.all([
    git(target.worktreePath, statusArguments(), remaining, { maxStdoutBytes: limits.maxStatusBytes }),
    git(source, ["rev-list", "--count", `${baseTip}..${branchTip}`], remaining),
  ]);
  if (worktreeStatus.code !== 0) return { status: "unavailable", reason: failureOf(worktreeStatus) };
  if (aheadOutcome.code !== 0) return { status: "unavailable", reason: failureOf(aheadOutcome) };
  const uncommittedFiles = parseStatus(worktreeStatus).length;
  const commitsAhead = Number(gitOutputText(aheadOutcome).trim());
  if (!Number.isSafeInteger(commitsAhead)) return { status: "unavailable", reason: "git_failed" };
  if (commitsAhead === 0 && uncommittedFiles === 0) {
    return { status: "blocked", blocking: [{ reason: "nothing_to_merge" }] };
  }

  // What would be merged: the branch tip, or (uncommitted files) a commit object that adds them.
  // The snapshot is built in a private index, so the worktree's own index, HEAD and files are
  // not touched; only objects are written.
  let mergeHead: string = branchTip;
  if (uncommittedFiles > 0) {
    const snapshot = await captureCurrentTree({
      cwd: target.worktreePath,
      limits: { timeoutMs: Math.max(1, remaining()) },
    });
    if (snapshot.status !== "captured") {
      return {
        status: "unavailable",
        reason: snapshot.reason === "timeout" ? "timeout"
          : snapshot.reason === "git_unavailable" ? "git_unavailable"
          : snapshot.reason === "too_large" || snapshot.reason === "too_many_files" ? "too_large"
          : "git_failed",
      };
    }
    const commit = await git(
      target.worktreePath,
      ["commit-tree", snapshot.tree, "-p", branchTip, "-m", "guild snapshot"],
      remaining,
      { env: GUILD_IDENTITY },
    );
    const commitId = gitOutputText(commit).trim();
    if (commit.code !== 0 || !FULL_ID.test(commitId)) return { status: "unavailable", reason: failureOf(commit) };
    mergeHead = commitId;
  }

  // Source checkout state, read without refreshing its index.
  const blocking: WorktreeBlock[] = [];
  const currentBranchOutcome = await git(source, ["symbolic-ref", "--quiet", "--short", "HEAD"], remaining);
  if (currentBranchOutcome.missing || currentBranchOutcome.timedOut) {
    return { status: "unavailable", reason: failureOf(currentBranchOutcome) };
  }
  const currentBranch = currentBranchOutcome.code === 0 ? gitOutputText(currentBranchOutcome).trim() : undefined;
  if (currentBranch !== baseBranch) {
    blocking.push({
      reason: "source_not_on_base_branch",
      ...(currentBranch === undefined || currentBranch === "" ? {} : { currentBranch }),
    });
  }
  const inProgress = await operationInProgress(source, remaining);
  if (typeof inProgress === "string") return { status: "unavailable", reason: inProgress };
  if (inProgress) blocking.push({ reason: "source_operation_in_progress" });

  // The merge itself, computed without touching anything: `merge-tree --write-tree` needs git 2.38.
  const mergeTree = await git(
    source,
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", baseTip, mergeHead],
    remaining,
    { maxStdoutBytes: 8 * 1024 * 1024 },
  );
  if (mergeTree.missing || mergeTree.timedOut) return { status: "unavailable", reason: failureOf(mergeTree) };
  if (mergeTree.code !== 0 && mergeTree.code !== 1) {
    return {
      status: "unavailable",
      reason: mergeTree.code === 129 || /unknown option|usage:/iu.test(mergeTree.stderr) ? "git_too_old" : failureOf(mergeTree),
    };
  }
  const fields = gitOutputText(mergeTree).split("\0");
  const mergedTree = fields[0] ?? "";
  if (!FULL_ID.test(mergedTree)) return { status: "unavailable", reason: "git_failed" };
  const conflicts = mergeTree.code === 1
    ? fields.slice(1).filter((entry) => entry.length > 0)
    : [];

  const mergeBaseOutcome = await git(source, ["merge-base", baseTip, mergeHead], remaining);
  const mergeBase = gitOutputText(mergeBaseOutcome).trim();
  if (mergeBaseOutcome.code !== 0 || !FULL_ID.test(mergeBase)) {
    return { status: "unavailable", reason: failureOf(mergeBaseOutcome) };
  }

  // What the merge changes in the base branch (or, with conflicts, what the branch changes).
  const touchedOutcome = await git(
    source,
    ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseTip, mergedTree, "--"],
    remaining,
    { maxStdoutBytes: 8 * 1024 * 1024 },
  );
  if (touchedOutcome.code !== 0) return { status: "unavailable", reason: failureOf(touchedOutcome) };
  const touched = new Set(gitOutputText(touchedOutcome).split("\0").filter((entry) => entry.length > 0));
  for (const path of conflicts) touched.add(path);

  const sourceStatus = await git(source, statusArguments(), remaining, { maxStdoutBytes: 8 * 1024 * 1024 });
  if (sourceStatus.code !== 0) return { status: "unavailable", reason: failureOf(sourceStatus) };
  const sourceEntries = parseStatus(sourceStatus);
  const staged = sourceEntries.filter((entry) => entry.staged || entry.unmerged).map((entry) => entry.path);
  if (staged.length > 0) {
    const capped = capPaths(staged);
    blocking.push({
      reason: "source_has_staged_changes",
      paths: capped.paths,
      ...(capped.truncated ? { pathsTruncated: true as const } : {}),
    });
  }
  const dirtyTouched = sourceEntries
    .filter((entry) => !entry.staged && !entry.unmerged && touched.has(entry.path))
    .map((entry) => entry.path);
  if (dirtyTouched.length > 0) {
    const capped = capPaths(dirtyTouched);
    blocking.push({
      reason: "source_dirty_in_touched_paths",
      paths: capped.paths,
      ...(capped.truncated ? { pathsTruncated: true as const } : {}),
    });
  }

  const summaryResult = await summarizeDiff({
    cwd: source,
    fromRef: conflicts.length > 0 ? mergeBase : baseTip,
    toRef: conflicts.length > 0 ? mergeHead : mergedTree,
    maxFiles: WORKTREE_FILE_LIST_LIMIT,
    timeoutMs: Math.max(1, remaining()),
  });
  if (summaryResult.status !== "ok") {
    return {
      status: "unavailable",
      reason: summaryResult.reason === "timeout" ? "timeout"
        : summaryResult.reason === "git_unavailable" ? "git_unavailable"
        : summaryResult.reason === "too_large" ? "too_large"
        : "git_failed",
    };
  }
  const summary: WorktreeMergeSummary = Object.freeze({
    branch: target.branch,
    baseBranch,
    commitsAhead,
    uncommittedFiles,
    files: summaryResult.summary.files,
    filesTotal: summaryResult.summary.filesTotal,
    adds: summaryResult.summary.adds,
    dels: summaryResult.summary.dels,
    filesTruncated: summaryResult.summary.truncated,
  });
  if (blocking.length > 0) return { status: "blocked", blocking: Object.freeze(blocking) };
  return {
    status: "planned",
    plan: Object.freeze({
      baseBranch, baseTip, branchTip, mergeHead, mergeBase, mergedTree,
      conflicts: Object.freeze(conflicts),
      commitsAhead, uncommittedFiles, summary,
    }),
  };
}

function conflictList(conflicts: readonly string[]): { conflicts: readonly string[]; conflictsTruncated: boolean } {
  const sorted = [...new Set(conflicts)].sort();
  return {
    conflicts: Object.freeze(sorted.slice(0, WORKTREE_PATH_LIST_LIMIT)),
    conflictsTruncated: sorted.length > WORKTREE_PATH_LIST_LIMIT,
  };
}

export async function previewWorktreeMerge(input: {
  target: WorktreeTarget;
  limits?: Partial<GitWorktreeLimits>;
}): Promise<WorktreeMergeEvaluation> {
  const limits = limitsOf(input.limits);
  const planned = await planMerge(input.target, limits, deadlineIn(limits.previewTimeoutMs));
  if (planned.status !== "planned") return planned;
  const { plan } = planned;
  if (plan.conflicts.length > 0) {
    return Object.freeze({ status: "conflicts", summary: plan.summary, ...conflictList(plan.conflicts) });
  }
  return Object.freeze({ status: "ready", summary: plan.summary });
}

// ---------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------

function singleLine(value: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return [...cleaned].slice(0, limit).join("");
}

/**
 * `git merge --no-ff` of the task branch into the checkout, which must be on the base branch.
 * A merge that stops (conflict, or git refusing) is aborted and the checkout verified to be back
 * at `expectedHead`. Exported for tests; Apply calls it after its own checks.
 */
export async function mergeBranchIntoCheckout(input: {
  checkout: string;
  branch: string;
  expectedHead: string;
  message: string;
  remaining: Remaining;
}): Promise<
  | Readonly<{ status: "merged"; mergeCommit: string }>
  | Readonly<{ status: "conflicts"; conflicts: readonly string[]; conflictsTruncated: boolean }>
  | Readonly<{ status: "failed"; reason: WorktreeFailureReason | "repository_changed" }>
> {
  const { checkout, branch, expectedHead, remaining } = input;
  // The merge commit is the user's: their own identity when git has one, Guild's otherwise.
  const [name, email] = await Promise.all([
    git(checkout, ["config", "--get", "user.name"], remaining),
    git(checkout, ["config", "--get", "user.email"], remaining),
  ]);
  const hasIdentity = gitOutputText(name).trim() !== "" && gitOutputText(email).trim() !== "";
  const merge = await git(
    checkout,
    ["merge", "--no-ff", "--no-edit", "--no-verify", "--no-gpg-sign", "--no-autostash", "-m", input.message,
      `refs/heads/${branch}`],
    remaining,
    { env: hasIdentity ? { GIT_MERGE_AUTOEDIT: "no" } : { ...GUILD_IDENTITY, GIT_MERGE_AUTOEDIT: "no" } },
  );
  if (merge.code === 0) {
    const head = await revParse(checkout, "HEAD", remaining);
    if (typeof head !== "string" || head === expectedHead) return { status: "failed", reason: "repository_changed" };
    const parents = await git(checkout, ["rev-list", "--parents", "-n", "1", head], remaining);
    const ids = gitOutputText(parents).trim().split(/\s+/u);
    if (ids.length !== 3 || ids[1] !== expectedHead) return { status: "failed", reason: "repository_changed" };
    return { status: "merged", mergeCommit: head };
  }
  // Stopped (conflict, git refusing, or killed at the deadline): find out what conflicted, then
  // put the checkout back. The abort gets its own time budget so a slow merge cannot leave the
  // repository mid-merge.
  const cleanup = deadlineIn(30_000);
  const unmerged = await git(checkout, ["diff", "--name-only", "--diff-filter=U", "-z"], cleanup);
  const conflictedPaths = unmerged.code === 0
    ? gitOutputText(unmerged).split("\0").filter((entry) => entry.length > 0)
    : [];
  const inProgress = await operationInProgress(checkout, cleanup);
  if (inProgress === true) {
    const aborted = await git(checkout, ["merge", "--abort"], cleanup);
    if (aborted.code !== 0) return { status: "failed", reason: failureOf(aborted) };
  }
  const head = await revParse(checkout, "HEAD", cleanup);
  if (head !== expectedHead) return { status: "failed", reason: "repository_changed" };
  if (conflictedPaths.length > 0) return { status: "conflicts", ...conflictList(conflictedPaths) };
  return { status: "failed", reason: merge.timedOut ? "timeout" : merge.missing ? "git_unavailable" : "git_failed" };
}

export async function applyWorktreeMerge(input: {
  target: WorktreeTarget;
  taskTitle: string;
  limits?: Partial<GitWorktreeLimits>;
}): Promise<WorktreeApplyResult> {
  const { target } = input;
  const limits = limitsOf(input.limits);
  const remaining = deadlineIn(limits.applyTimeoutMs);
  const planned = await planMerge(target, limits, remaining);
  if (planned.status === "worktree_missing" || planned.status === "blocked") return planned;
  if (planned.status === "unavailable") return { status: "failed", reason: planned.reason };
  const { plan } = planned;
  if (plan.conflicts.length > 0) return { status: "conflicts", ...conflictList(plan.conflicts) };

  const source = await canonical(target.sourceRepoPath);
  if (source === undefined) return { status: "blocked", blocking: [{ reason: "source_missing" }] };
  const title = singleLine(input.taskTitle, 80);

  // 1. Commit the uncommitted files on the task branch (inside the worktree, never the checkout).
  let committed = false;
  if (plan.uncommittedFiles > 0) {
    const added = await git(target.worktreePath, ["add", "-A"], remaining);
    if (added.code !== 0) return { status: "failed", reason: failureOf(added) };
    const commit = await git(
      target.worktreePath,
      ["commit", "--no-verify", "--no-gpg-sign", "-m",
        title === "" ? "Guild task changes" : `Guild task changes: ${title}`],
      remaining,
      { env: GUILD_IDENTITY },
    );
    if (commit.code !== 0) {
      // "Nothing to commit" (everything was ignored) is not a failure; anything else is.
      if (!/nothing (added )?to commit/iu.test(`${gitOutputText(commit)}${commit.stderr}`)) {
        return { status: "failed", reason: failureOf(commit) };
      }
    } else {
      committed = true;
    }
  }

  // 2. Merge into the checkout.
  const message = title === ""
    ? `Merge Guild task branch ${target.branch}`
    : `Merge Guild task: ${title} (${target.branch})`;
  const merged = await mergeBranchIntoCheckout({
    checkout: source,
    branch: target.branch,
    expectedHead: plan.baseTip,
    message,
    remaining,
  });
  if (merged.status === "conflicts") return merged;
  if (merged.status === "failed") return merged;
  return Object.freeze({
    status: "applied",
    baseBranch: plan.baseBranch,
    mergeCommit: merged.mergeCommit,
    committedUncommitted: committed,
    summary: plan.summary,
  });
}

// ---------------------------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------------------------

async function removeWorktreeAndBranch(input: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  remaining: Remaining;
}): Promise<{ removedWorktree: boolean; removedBranch: boolean; failure?: WorktreeFailureReason }> {
  const { repoRoot, worktreePath, branch, remaining } = input;
  let removedWorktree = false;
  let removed = await git(repoRoot, ["worktree", "remove", "--force", worktreePath], remaining);
  if (removed.missing || removed.timedOut) return { removedWorktree: false, removedBranch: false, failure: failureOf(removed) };
  if (removed.code === 0) removedWorktree = true;
  // Whatever directory git left behind is Guild's own (the caller checked it lives under the
  // worktrees root). Once it is gone git can drop its stale record of it.
  if (await canonical(worktreePath) !== undefined) {
    try {
      await rm(worktreePath, { recursive: true, force: true });
      removedWorktree = true;
    } catch {
      return { removedWorktree, removedBranch: false, failure: "git_failed" };
    }
    if (removed.code !== 0) {
      removed = await git(repoRoot, ["worktree", "remove", "--force", worktreePath], remaining);
    }
  }
  if (removed.code !== 0 && !/is not a working tree/iu.test(removed.stderr)) {
    return { removedWorktree, removedBranch: false, failure: failureOf(removed) };
  }
  let removedBranch = false;
  if (isGuildBranchName(branch)) {
    const exists = await revParse(repoRoot, `refs/heads/${branch}`, remaining);
    if (isFailureReason(exists)) return { removedWorktree, removedBranch, failure: exists };
    if (exists !== undefined) {
      const deleted = await git(repoRoot, ["branch", "-D", "--", branch], remaining);
      if (deleted.code !== 0) return { removedWorktree, removedBranch, failure: failureOf(deleted) };
      removedBranch = true;
    }
  }
  return { removedWorktree, removedBranch };
}

export async function discardGitWorktree(input: {
  target: WorktreeTarget;
  worktreesRoot: string;
  limits?: Partial<GitWorktreeLimits>;
}): Promise<WorktreeDiscardResult> {
  const { target } = input;
  const limits = limitsOf(input.limits);
  const remaining = deadlineIn(limits.discardTimeoutMs);
  // Only a Guild branch, and only a directory directly under Guild's own worktrees root.
  const root = await canonical(input.worktreesRoot);
  if (
    root === undefined ||
    !isGuildBranchName(target.branch) ||
    !isAbsolute(target.worktreePath) ||
    (dirname(target.worktreePath) !== input.worktreesRoot && dirname(target.worktreePath) !== root)
  ) {
    return { status: "refused", reason: "invalid_target" };
  }
  const resolvedWorktree = (await canonical(target.worktreePath)) ?? target.worktreePath;
  if (!resolvedWorktree.startsWith(root + sep) || resolvedWorktree === root) {
    return { status: "refused", reason: "invalid_target" };
  }

  const repoRoot = await canonical(target.sourceRepoPath);
  if (repoRoot === undefined || !(await isDirectory(repoRoot))) {
    // The repository is gone: the worktree directory is an orphan inside Guild's own root.
    try {
      await rm(resolvedWorktree, { recursive: true, force: true });
    } catch {
      return { status: "failed", reason: "git_failed" };
    }
    return { status: "discarded", removedWorktree: true, removedBranch: false };
  }
  const outcome = await removeWorktreeAndBranch({
    repoRoot,
    worktreePath: resolvedWorktree,
    branch: target.branch,
    remaining,
  });
  if (outcome.failure !== undefined) return { status: "failed", reason: outcome.failure };
  return { status: "discarded", removedWorktree: outcome.removedWorktree, removedBranch: outcome.removedBranch };
}

export const gitWorktrees: GitWorktreePort = Object.freeze({
  create: createGitWorktree,
  inspect: inspectGitWorktree,
  preview: previewWorktreeMerge,
  apply: applyWorktreeMerge,
  discard: discardGitWorktree,
});
