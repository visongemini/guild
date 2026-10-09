/**
 * Hidden git checkpoints of a task folder (F2): capture the working tree at Run start and Run end
 * as commits under `refs/guild/checkpoints/<task>/<n>`, summarize what a Run changed, show one
 * file's diff, plan and perform a restore of the files a Run (and later Runs) changed.
 *
 * Safety contract, enforced by construction and covered by git-checkpoints.test.ts:
 *  - The user's index, HEAD, branches, tags, stash and reflogs are never written. Every capture
 *    runs against a private temporary `GIT_INDEX_FILE` seeded from a copy of the real index (dated
 *    to the epoch so git re-reads every tracked file rather than trusting stat data that a
 *    same-size edit within one second would fool; see `maxVerifiedIndexBytes`); `git add -A`
 *    respects .gitignore, so ignored files are not captured and untracked files are. The only
 *    repository writes are new objects plus the one ref being created.
 *  - Reads run with GIT_OPTIONAL_LOCKS=0 so git does not refresh the real index behind the user.
 *  - The restore step uses `git restore --source=<ref> --worktree`: the index is not a target, so
 *    a change the user staged stays staged. Files a Run added are deleted by this module (checked
 *    to stay inside the task folder); every other file is left alone.
 *  - Every git process has a deadline and is killed when it passes; output is size-capped.
 *  - A folder that is not a git work tree, a missing git, a timeout or a size guard all yield an
 *    `unavailable` result with a reason code; nothing here throws for those.
 *  - Hooks (`core.hooksPath`), fsmonitor, auto-gc, commit signing and credential prompts are
 *    switched off for the commands Guild runs. Clean/smudge filters still apply, because the
 *    tree must hold what git itself would store.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, readdir, realpath, rm, rmdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CHECKPOINT_REF_ROOT = "refs/guild/checkpoints";

export type CheckpointFailureReason =
  | "not_a_git_repo"
  | "git_unavailable"
  | "timeout"
  | "too_many_files"
  | "too_large"
  | "git_failed"
  | "unsafe_task_id";

export type GitCheckpointLimits = Readonly<{
  /** Wall-clock budget for one operation, shared by all of its git processes. */
  timeoutMs: number;
  /** Untracked, not-ignored files a capture may add. */
  maxUntrackedFiles: number;
  /** Total size of those files. */
  maxUntrackedBytes: number;
  /** Size of the largest one. */
  maxUntrackedFileBytes: number;
  /**
   * Index size up to which every tracked file is re-read on capture. Above it git's stat cache is
   * trusted, which can miss an edit that keeps a file's size and lands in the same second as the
   * stat git last recorded.
   */
  maxVerifiedIndexBytes: number;
}>;

export const DEFAULT_CHECKPOINT_LIMITS: GitCheckpointLimits = Object.freeze({
  timeoutMs: 10_000,
  maxUntrackedFiles: 20_000,
  maxUntrackedBytes: 512 * 1024 * 1024,
  maxUntrackedFileBytes: 64 * 1024 * 1024,
  maxVerifiedIndexBytes: 3 * 1024 * 1024,
});

export type GitChangeStatus = "A" | "M" | "D" | "R";

export type GitChangedFile = Readonly<{
  path: string;
  oldPath?: string;
  status: GitChangeStatus;
  /** `null` for a binary file. */
  adds: number | null;
  dels: number | null;
}>;

export type GitDiffSummary = Readonly<{
  /** At most `maxFiles` entries; the totals below cover every changed file. */
  files: readonly GitChangedFile[];
  filesTotal: number;
  adds: number;
  dels: number;
  truncated: boolean;
}>;

export type CheckpointCapture =
  | Readonly<{ status: "captured"; ref: string; commit: string; tree: string }>
  | Readonly<{ status: "unavailable"; reason: CheckpointFailureReason }>;

export type TreeSnapshot =
  | Readonly<{ status: "captured"; tree: string }>
  | Readonly<{ status: "unavailable"; reason: CheckpointFailureReason }>;

export type DiffSummaryResult =
  | Readonly<{ status: "ok"; summary: GitDiffSummary }>
  | Readonly<{ status: "unavailable"; reason: CheckpointFailureReason }>;

export type FileDiffResult =
  | Readonly<{ status: "ok"; diff: string; binary: boolean; truncated: boolean }>
  | Readonly<{ status: "unavailable"; reason: CheckpointFailureReason | "invalid_path" }>;

/** One earlier or later Run, as two checkpoint refs. */
export type RunRefs = Readonly<{ startRef: string; endRef: string }>;

export type RewindConflict = Readonly<{
  path: string;
  reason: "later_run" | "modified_after_run";
}>;

export type RewindFilePlan = Readonly<{
  /** Exist in the target start checkpoint; restored from it. */
  restore: readonly string[];
  /** Absent from the target start checkpoint; deleted. */
  remove: readonly string[];
  conflicts: readonly RewindConflict[];
}>;

export type RewindPlanResult =
  | Readonly<{ status: "ok"; plan: RewindFilePlan }>
  | Readonly<{ status: "unavailable"; reason: CheckpointFailureReason }>;

export type RestoreResult = Readonly<{
  restored: readonly string[];
  removed: readonly string[];
  failed: readonly Readonly<{ path: string; reason: string }>[];
}>;

/** The surface the live service uses; tests substitute a fake. */
export interface GitCheckpointPort {
  capture(input: {
    cwd: string;
    taskId: string;
    ordinal: number;
    limits?: Partial<GitCheckpointLimits>;
  }): Promise<CheckpointCapture>;
  summarize(input: {
    cwd: string;
    fromRef: string;
    toRef: string;
    maxFiles?: number;
    timeoutMs?: number;
  }): Promise<DiffSummaryResult>;
  fileDiff(input: {
    cwd: string;
    fromRef: string;
    toRef: string;
    path: string;
    oldPath?: string;
    maxBytes?: number;
    timeoutMs?: number;
  }): Promise<FileDiffResult>;
  planRewind(input: {
    cwd: string;
    /** The Run being rewound to its start, then every later Run in order. */
    runs: readonly RunRefs[];
    limits?: Partial<GitCheckpointLimits>;
  }): Promise<RewindPlanResult>;
  restore(input: {
    cwd: string;
    sourceRef: string;
    restore: readonly string[];
    remove: readonly string[];
    timeoutMs?: number;
  }): Promise<RestoreResult>;
}

// ---------------------------------------------------------------------------------------------
// git process runner
// ---------------------------------------------------------------------------------------------

type GitOutcome = Readonly<{
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** stdout reached `maxStdoutBytes` and the process was killed. */
  truncated: boolean;
  timedOut: boolean;
  missing: boolean;
}>;

type GitRun = Readonly<{
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxStdoutBytes?: number;
}>;

const GIT_CONFIG_FLAGS: readonly string[] = Object.freeze([
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "commit.gpgsign=false",
  "-c", "advice.addEmbeddedRepo=false",
  "-c", "advice.detachedHead=false",
  "--literal-pathspecs",
]);

const INHERITED_GIT_VARIABLES = Object.freeze([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_COMMON_DIR", "GIT_PREFIX",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
]);

function gitEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of INHERITED_GIT_VARIABLES) delete environment[name];
  return {
    ...environment,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_PAGER: "cat",
    LC_ALL: "C",
    ...extra,
  };
}

let gitExecutable = "git";

/** Test hook: run a different executable (for example a script that hangs). */
export function setGitExecutableForTests(path: string | undefined): void {
  gitExecutable = path ?? "git";
}

function runGit(args: readonly string[], run: GitRun, stdin?: Buffer | string): Promise<GitOutcome> {
  return new Promise<GitOutcome>((resolveOutcome) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let collected = 0;
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const finish = (outcome: Omit<GitOutcome, "stdout" | "stderr" | "truncated" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(Object.freeze({
        ...outcome,
        stdout: Buffer.concat(chunks),
        stderr: stderr.slice(0, 4_000),
        truncated,
        timedOut,
      }));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGKILL");
    }, Math.max(1, run.timeoutMs));
    timer.unref?.();
    try {
      child = spawn(gitExecutable, [...GIT_CONFIG_FLAGS, ...args], {
        cwd: run.cwd,
        env: gitEnvironment(run.env),
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch {
      finish({ code: null, missing: true });
      return;
    }
    child.on("error", (cause: NodeJS.ErrnoException) => {
      finish({ code: null, missing: cause.code === "ENOENT" });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (run.maxStdoutBytes !== undefined && collected + chunk.length > run.maxStdoutBytes) {
        const room = Math.max(0, run.maxStdoutBytes - collected);
        if (room > 0) chunks.push(chunk.subarray(0, room));
        collected = run.maxStdoutBytes;
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      collected += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      finish({ code, missing: false });
    });
    if (stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    }
  });
}

function failureOf(outcome: GitOutcome): CheckpointFailureReason {
  if (outcome.missing) return "git_unavailable";
  if (outcome.timedOut) return "timeout";
  return "git_failed";
}

/** A deadline shared by the git processes of one operation. */
function deadlineIn(timeoutMs: number): () => number {
  const end = Date.now() + timeoutMs;
  return () => end - Date.now();
}

function text(outcome: GitOutcome): string {
  return outcome.stdout.toString("utf8");
}

// ---------------------------------------------------------------------------------------------
// Repository detection and refs
// ---------------------------------------------------------------------------------------------

type RepositoryInfo = Readonly<{ indexPath: string; hasHead: boolean }>;

async function inspectRepository(
  cwd: string,
  remaining: () => number,
): Promise<RepositoryInfo | CheckpointFailureReason> {
  try {
    if (!(await stat(cwd)).isDirectory()) return "not_a_git_repo";
  } catch {
    return "not_a_git_repo";
  }
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: remaining() });
  if (inside.missing) return "git_unavailable";
  if (inside.timedOut) return "timeout";
  if (inside.code !== 0 || text(inside).trim() !== "true") return "not_a_git_repo";
  const index = await runGit(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
    cwd,
    timeoutMs: Math.max(1, remaining()),
  });
  if (index.code !== 0) return failureOf(index);
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
    cwd,
    timeoutMs: Math.max(1, remaining()),
  });
  if (head.timedOut) return "timeout";
  return Object.freeze({ indexPath: text(index).trim(), hasHead: head.code === 0 });
}

const SAFE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

/** A task id as one git ref path segment; anything unusual becomes a stable hash. */
export function safeRefSegment(taskId: string): string | undefined {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 4_096) return undefined;
  if (
    SAFE_REF_SEGMENT.test(taskId) &&
    !taskId.includes("..") &&
    !taskId.endsWith(".lock") &&
    !taskId.endsWith(".")
  ) {
    return taskId;
  }
  return `x-${createHash("sha256").update(taskId, "utf8").digest("hex").slice(0, 32)}`;
}

export function checkpointRef(taskId: string, ordinal: number): string | undefined {
  const segment = safeRefSegment(taskId);
  if (segment === undefined || !Number.isSafeInteger(ordinal) || ordinal < 1) return undefined;
  return `${CHECKPOINT_REF_ROOT}/${segment}/${ordinal}`;
}

const CHECKPOINT_REF_PATTERN = /^refs\/guild\/checkpoints\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[1-9][0-9]{0,9}$/u;

/** Only refs this module created may be passed to a git revision argument. */
export function isCheckpointRef(ref: string): boolean {
  return typeof ref === "string" && CHECKPOINT_REF_PATTERN.test(ref);
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

const AUTHOR_ENVIRONMENT = Object.freeze({
  GIT_AUTHOR_NAME: "Guild",
  GIT_AUTHOR_EMAIL: "guild@localhost",
  GIT_COMMITTER_NAME: "Guild",
  GIT_COMMITTER_EMAIL: "guild@localhost",
});

async function untrackedGuard(
  cwd: string,
  limits: GitCheckpointLimits,
  remaining: () => number,
): Promise<CheckpointFailureReason | undefined> {
  // The list is read through a size cap: a runaway untracked tree stops the listing, not the app.
  const listing = await runGit(
    ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
    { cwd, timeoutMs: Math.max(1, remaining()), maxStdoutBytes: limits.maxUntrackedFiles * 1_100 },
  );
  if (listing.timedOut) return "timeout";
  if (listing.missing) return "git_unavailable";
  if (listing.code !== 0 && !listing.truncated) return "git_failed";
  if (listing.truncated) return "too_many_files";
  const paths = text(listing).split("\0").filter((entry) => entry.length > 0);
  if (paths.length > limits.maxUntrackedFiles) return "too_many_files";
  let total = 0;
  let cursor = 0;
  while (cursor < paths.length) {
    if (remaining() <= 0) return "timeout";
    const batch = paths.slice(cursor, cursor + 256);
    cursor += batch.length;
    const sizes = await Promise.all(batch.map(async (entry) => {
      try {
        const info = await lstat(join(cwd, entry));
        return info.isFile() ? info.size : 0;
      } catch {
        return 0;
      }
    }));
    for (const size of sizes) {
      if (size > limits.maxUntrackedFileBytes) return "too_large";
      total += size;
      if (total > limits.maxUntrackedBytes) return "too_large";
    }
  }
  return undefined;
}

function resolveLimits(partial: Partial<GitCheckpointLimits> | undefined): GitCheckpointLimits {
  return Object.freeze({ ...DEFAULT_CHECKPOINT_LIMITS, ...(partial ?? {}) });
}

/**
 * The working tree of `cwd` as a git tree object, built in a private temporary index. Nothing but
 * new objects is written to the repository.
 */
async function snapshotTree(
  cwd: string,
  limits: GitCheckpointLimits,
  remaining: () => number,
): Promise<TreeSnapshot> {
  const repository = await inspectRepository(cwd, remaining);
  if (typeof repository === "string") return unavailable(repository);
  const guard = await untrackedGuard(cwd, limits, remaining);
  if (guard !== undefined) return unavailable(guard);
  let privateDirectory: string | undefined;
  try {
    privateDirectory = await mkdtemp(join(tmpdir(), "guild-checkpoint-"));
    const indexFile = join(privateDirectory, "index");
    const environment = { GIT_INDEX_FILE: indexFile };
    for (const seed of ["copy", "head"] as const) {
      if (remaining() <= 0) return unavailable("timeout");
      await rm(indexFile, { force: true });
      if (seed === "copy") {
        // A copy keeps git's stat cache, so only files that changed since the user's last refresh
        // are re-read. The real index is only ever read.
        try {
          await copyFile(repository.indexPath, indexFile);
          // Git trusts a stat entry unless the file is at least as new as the index file. An edit
          // that keeps the size and lands in the same second as the recorded stat would then be
          // missed, so the copy is dated to the epoch: every entry counts as possibly stale and
          // git re-reads its content. The user's own index file is never touched.
          if ((await stat(indexFile)).size <= limits.maxVerifiedIndexBytes) {
            await utimes(indexFile, 1, 1);
          }
        } catch {
          // No index yet (a fresh repository): git starts from an empty one.
        }
      } else if (repository.hasHead) {
        const seeded = await runGit(["read-tree", "HEAD"], {
          cwd, env: environment, timeoutMs: Math.max(1, remaining()),
        });
        if (seeded.code !== 0) return unavailable(failureOf(seeded));
      } else {
        break;
      }
      const added = await runGit(["add", "-A", "--", "."], {
        cwd, env: environment, timeoutMs: Math.max(1, remaining()),
      });
      if (added.timedOut) return unavailable("timeout");
      if (added.missing) return unavailable("git_unavailable");
      if (added.code !== 0) continue;
      const tree = await runGit(["write-tree"], {
        cwd, env: environment, timeoutMs: Math.max(1, remaining()),
      });
      if (tree.timedOut) return unavailable("timeout");
      if (tree.code === 0 && /^[0-9a-f]{40,64}$/u.test(text(tree).trim())) {
        return Object.freeze({ status: "captured", tree: text(tree).trim() });
      }
    }
    return unavailable("git_failed");
  } catch {
    return unavailable("git_failed");
  } finally {
    if (privateDirectory !== undefined) {
      await rm(privateDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function unavailable(reason: CheckpointFailureReason): { status: "unavailable"; reason: CheckpointFailureReason } {
  return { status: "unavailable", reason };
}

export async function captureCheckpoint(input: {
  cwd: string;
  taskId: string;
  ordinal: number;
  limits?: Partial<GitCheckpointLimits>;
}): Promise<CheckpointCapture> {
  const ref = checkpointRef(input.taskId, input.ordinal);
  if (ref === undefined) return unavailable("unsafe_task_id");
  const limits = resolveLimits(input.limits);
  const remaining = deadlineIn(limits.timeoutMs);
  const snapshot = await snapshotTree(input.cwd, limits, remaining);
  if (snapshot.status !== "captured") return snapshot;
  const commit = await runGit(
    ["commit-tree", snapshot.tree, "-m", `guild checkpoint ${ref}`],
    { cwd: input.cwd, env: AUTHOR_ENVIRONMENT, timeoutMs: Math.max(1, remaining()) },
  );
  const commitSha = text(commit).trim();
  if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/u.test(commitSha)) return unavailable(failureOf(commit));
  const updated = await runGit(["update-ref", ref, commitSha], {
    cwd: input.cwd,
    timeoutMs: Math.max(1, remaining()),
  });
  if (updated.code !== 0) return unavailable(failureOf(updated));
  return Object.freeze({ status: "captured", ref, commit: commitSha, tree: snapshot.tree });
}

/** The current working tree as a tree id, without creating a ref (used to compare with a checkpoint). */
export async function captureCurrentTree(input: {
  cwd: string;
  limits?: Partial<GitCheckpointLimits>;
}): Promise<TreeSnapshot> {
  const limits = resolveLimits(input.limits);
  return snapshotTree(input.cwd, limits, deadlineIn(limits.timeoutMs));
}

// ---------------------------------------------------------------------------------------------
// Diff summary
// ---------------------------------------------------------------------------------------------

const MAX_SUMMARY_BYTES = 8 * 1024 * 1024;

function revisionArgument(value: string): string | undefined {
  if (isCheckpointRef(value) || /^[0-9a-f]{40,64}$/u.test(value)) return value;
  return undefined;
}

type RawChange = { path: string; oldPath?: string; status: GitChangeStatus };

async function nameStatus(
  cwd: string,
  from: string,
  to: string,
  remaining: () => number,
  renames: boolean,
): Promise<readonly RawChange[] | CheckpointFailureReason> {
  const outcome = await runGit(
    ["diff", "--name-status", "-z", renames ? "-M" : "--no-renames", "--no-ext-diff", "--no-textconv",
      "--relative", from, to, "--"],
    { cwd, timeoutMs: Math.max(1, remaining()), maxStdoutBytes: MAX_SUMMARY_BYTES },
  );
  if (outcome.code !== 0 || outcome.truncated) return outcome.truncated ? "too_large" : failureOf(outcome);
  const fields = text(outcome).split("\0");
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (code === undefined || code === "") break;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (oldPath === undefined || path === undefined) break;
      changes.push({ path, oldPath, status: code.startsWith("R") ? "R" : "A" });
    } else {
      const path = fields[index++];
      if (path === undefined) break;
      const status: GitChangeStatus = code === "A" ? "A" : code === "D" ? "D" : "M";
      changes.push({ path, status });
    }
  }
  return changes;
}

type NumstatEntry = { adds: number | null; dels: number | null };

async function numstat(
  cwd: string,
  from: string,
  to: string,
  remaining: () => number,
): Promise<ReadonlyMap<string, NumstatEntry> | CheckpointFailureReason> {
  const outcome = await runGit(
    ["diff", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--relative", from, to, "--"],
    { cwd, timeoutMs: Math.max(1, remaining()), maxStdoutBytes: MAX_SUMMARY_BYTES },
  );
  if (outcome.code !== 0 || outcome.truncated) return outcome.truncated ? "too_large" : failureOf(outcome);
  const fields = text(outcome).split("\0");
  const result = new Map<string, NumstatEntry>();
  for (let index = 0; index < fields.length;) {
    const head = fields[index++];
    if (head === undefined || head === "") break;
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(head);
    if (match === null) continue;
    const entry: NumstatEntry = {
      adds: match[1] === "-" ? null : Number(match[1]),
      dels: match[2] === "-" ? null : Number(match[2]),
    };
    const named = match[3] ?? "";
    if (named === "") {
      // A rename or copy: the old and new paths follow as separate fields.
      index += 1;
      const path = fields[index++];
      if (path !== undefined) result.set(path, entry);
    } else {
      result.set(named, entry);
    }
  }
  return result;
}

export async function summarizeDiff(input: {
  cwd: string;
  fromRef: string;
  toRef: string;
  maxFiles?: number;
  timeoutMs?: number;
}): Promise<DiffSummaryResult> {
  const from = revisionArgument(input.fromRef);
  const to = revisionArgument(input.toRef);
  if (from === undefined || to === undefined) return unavailable("git_failed");
  const remaining = deadlineIn(input.timeoutMs ?? DEFAULT_CHECKPOINT_LIMITS.timeoutMs);
  const [statuses, counts] = await Promise.all([
    nameStatus(input.cwd, from, to, remaining, true),
    numstat(input.cwd, from, to, remaining),
  ]);
  if (typeof statuses === "string") return unavailable(statuses);
  if (typeof counts === "string") return unavailable(counts);
  const maxFiles = Math.max(1, input.maxFiles ?? 200);
  let adds = 0;
  let dels = 0;
  const files: GitChangedFile[] = [];
  for (const change of statuses) {
    const count = counts.get(change.path) ?? { adds: 0, dels: 0 };
    adds += count.adds ?? 0;
    dels += count.dels ?? 0;
    if (files.length < maxFiles) {
      files.push(Object.freeze({
        path: change.path,
        ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
        status: change.status,
        adds: count.adds,
        dels: count.dels,
      }));
    }
  }
  return Object.freeze({
    status: "ok",
    summary: Object.freeze({
      files: Object.freeze(files),
      filesTotal: statuses.length,
      adds,
      dels,
      truncated: statuses.length > files.length,
    }),
  });
}

/** Relative, normalized, inside the folder: the only paths Guild hands to git or the filesystem. */
export function isSafeRelativePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 4_096 || path.includes("\0")) {
    return false;
  }
  if (isAbsolute(path) || path.startsWith("\\") || /^[A-Za-z]:/u.test(path)) return false;
  return !path.split(/[\\/]/u).some((segment) => segment === ".." || segment === "." || segment === "");
}

export async function readFileDiff(input: {
  cwd: string;
  fromRef: string;
  toRef: string;
  path: string;
  oldPath?: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<FileDiffResult> {
  const from = revisionArgument(input.fromRef);
  const to = revisionArgument(input.toRef);
  if (from === undefined || to === undefined) return unavailable("git_failed");
  if (!isSafeRelativePath(input.path) || (input.oldPath !== undefined && !isSafeRelativePath(input.oldPath))) {
    return { status: "unavailable", reason: "invalid_path" };
  }
  const maxBytes = Math.max(1_024, input.maxBytes ?? 256 * 1024);
  const outcome = await runGit(
    ["diff", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--relative", from, to, "--",
      ...(input.oldPath === undefined ? [input.path] : [input.oldPath, input.path])],
    {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? DEFAULT_CHECKPOINT_LIMITS.timeoutMs,
      maxStdoutBytes: maxBytes,
    },
  );
  if (!outcome.truncated && outcome.code !== 0) return unavailable(failureOf(outcome));
  const diff = text(outcome);
  return Object.freeze({
    status: "ok",
    diff,
    binary: /^Binary files .* differ$/mu.test(diff) || diff.includes("\nGIT binary patch"),
    truncated: outcome.truncated,
  });
}

// ---------------------------------------------------------------------------------------------
// Rewind: plan and restore
// ---------------------------------------------------------------------------------------------

async function changedPaths(
  cwd: string,
  from: string,
  to: string,
  remaining: () => number,
): Promise<ReadonlySet<string> | CheckpointFailureReason> {
  const changes = await nameStatus(cwd, from, to, remaining, false);
  if (typeof changes === "string") return changes;
  return new Set(changes.map((change) => change.path));
}

/**
 * What undoing a Run and every later one means for the files:
 *  - the paths the Runs themselves changed (each Run's start to end checkpoint) are the only
 *    candidates, so anything the user changed between Runs is never touched;
 *  - a candidate that exists in the first Run's start checkpoint is restored from it, one that
 *    does not (the Runs added it) is deleted, one that already matches is skipped;
 *  - a candidate whose current content differs from the first Run's end checkpoint is a conflict:
 *    `later_run` when a later Run changed it, `modified_after_run` otherwise.
 */
export async function planFileRewind(input: {
  cwd: string;
  runs: readonly RunRefs[];
  limits?: Partial<GitCheckpointLimits>;
}): Promise<RewindPlanResult> {
  const limits = resolveLimits(input.limits);
  const remaining = deadlineIn(limits.timeoutMs);
  const first = input.runs[0];
  if (first === undefined) return unavailable("git_failed");
  const refs = input.runs.flatMap((run) => [run.startRef, run.endRef]);
  if (refs.some((ref) => revisionArgument(ref) === undefined)) return unavailable("git_failed");

  const candidates = new Set<string>();
  const laterRunPaths = new Set<string>();
  for (const [index, run] of input.runs.entries()) {
    const paths = await changedPaths(input.cwd, run.startRef, run.endRef, remaining);
    if (typeof paths === "string") return unavailable(paths);
    for (const path of paths) {
      candidates.add(path);
      if (index > 0) laterRunPaths.add(path);
    }
  }
  if (candidates.size === 0) {
    return Object.freeze({ status: "ok", plan: Object.freeze({ restore: [], remove: [], conflicts: [] }) });
  }
  const current = await snapshotTree(input.cwd, limits, remaining);
  if (current.status !== "captured") return current;
  const sinceStart = await nameStatus(input.cwd, first.startRef, current.tree, remaining, false);
  if (typeof sinceStart === "string") return unavailable(sinceStart);
  const sinceEnd = await changedPaths(input.cwd, first.endRef, current.tree, remaining);
  if (typeof sinceEnd === "string") return unavailable(sinceEnd);

  const restore: string[] = [];
  const remove: string[] = [];
  for (const change of sinceStart) {
    if (!candidates.has(change.path)) continue;
    // start -> now: "A" means it did not exist at the start, so the Runs added it.
    if (change.status === "A") remove.push(change.path);
    else restore.push(change.path);
  }
  const conflicts: RewindConflict[] = [];
  for (const path of [...restore, ...remove].sort()) {
    if (!sinceEnd.has(path)) continue;
    conflicts.push(Object.freeze({
      path,
      reason: laterRunPaths.has(path) ? "later_run" as const : "modified_after_run" as const,
    }));
  }
  return Object.freeze({
    status: "ok",
    plan: Object.freeze({
      restore: Object.freeze(restore.sort()),
      remove: Object.freeze(remove.sort()),
      conflicts: Object.freeze(conflicts),
    }),
  });
}

async function insideFolder(root: string, path: string): Promise<string | undefined> {
  if (!isSafeRelativePath(path)) return undefined;
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  // No parent directory may be a symlink that leaves the folder.
  try {
    const parent = await realpath(dirname(absolute));
    const realRoot = await realpath(root);
    if (parent !== realRoot && !parent.startsWith(realRoot + sep)) return undefined;
  } catch {
    // A missing parent just means there is nothing to delete.
    return absolute;
  }
  return absolute;
}

async function removeEmptyParents(root: string, start: string): Promise<void> {
  const realRoot = await realpath(root).catch(() => root);
  let directory = dirname(start);
  for (let depth = 0; depth < 64; depth += 1) {
    const rel = relative(root, directory);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
    if ((await realpath(directory).catch(() => realRoot)) === realRoot) return;
    try {
      if ((await readdir(directory)).length > 0) return;
      await rmdir(directory);
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}

export async function restoreFromCheckpoint(input: {
  cwd: string;
  sourceRef: string;
  restore: readonly string[];
  remove: readonly string[];
  timeoutMs?: number;
}): Promise<RestoreResult> {
  const source = revisionArgument(input.sourceRef);
  const failed: { path: string; reason: string }[] = [];
  const restored: string[] = [];
  const removed: string[] = [];
  if (source === undefined) {
    return Object.freeze({
      restored,
      removed,
      failed: [...input.restore, ...input.remove].map((path) => ({ path, reason: "invalid_source" })),
    });
  }
  const remaining = deadlineIn(input.timeoutMs ?? 60_000);
  const restorable: string[] = [];
  for (const path of input.restore) {
    if ((await insideFolder(input.cwd, path)) === undefined) failed.push({ path, reason: "invalid_path" });
    else restorable.push(path);
  }
  for (let offset = 0; offset < restorable.length; offset += 100) {
    const batch = restorable.slice(offset, offset + 100);
    const outcome = await runGit(
      ["restore", `--source=${source}`, "--worktree", "--", ...batch],
      { cwd: input.cwd, timeoutMs: Math.max(1, remaining()) },
    );
    if (outcome.code === 0) {
      restored.push(...batch);
      continue;
    }
    // One bad path fails the whole command; retry one by one to keep the rest.
    for (const path of batch) {
      const single = await runGit(
        ["restore", `--source=${source}`, "--worktree", "--", path],
        { cwd: input.cwd, timeoutMs: Math.max(1, remaining()) },
      );
      if (single.code === 0) restored.push(path);
      else failed.push({ path, reason: single.timedOut ? "timeout" : "restore_failed" });
    }
  }
  for (const path of input.remove) {
    const absolute = await insideFolder(input.cwd, path);
    if (absolute === undefined) {
      failed.push({ path, reason: "invalid_path" });
      continue;
    }
    try {
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        failed.push({ path, reason: "is_directory" });
        continue;
      }
      await rm(absolute, { force: true });
      removed.push(path);
      await removeEmptyParents(input.cwd, absolute);
    } catch (cause: unknown) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") removed.push(path);
      else failed.push({ path, reason: "remove_failed" });
    }
  }
  return Object.freeze({ restored, removed, failed });
}

export const gitCheckpoints: GitCheckpointPort = Object.freeze({
  capture: captureCheckpoint,
  summarize: summarizeDiff,
  fileDiff: readFileDiff,
  planRewind: planFileRewind,
  restore: restoreFromCheckpoint,
});
