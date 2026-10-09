import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseTaskId, type TaskId } from "@guild/contracts";
import type { TaskWorktreeRecord, TaskWorktreeStatus } from "@guild/persistence";
import type {
  CreateWorktreeResult,
  GitWorktreePort,
  WorktreeApplyResult,
  WorktreeDiscardResult,
  WorktreeInspection,
  WorktreeMergeEvaluation,
} from "./git-worktrees.js";
import { createTaskWorktreeManager, type TaskWorktreeManager, type WorktreeRowStore } from "./task-worktrees.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const taskId = (value: string): TaskId => {
  const parsed = parseTaskId(value);
  if (!parsed.ok) throw new Error("bad id");
  return parsed.value;
};

class MemoryRows implements WorktreeRowStore {
  readonly rows = new Map<string, TaskWorktreeRecord>();
  createTaskWorktree(input: Parameters<WorktreeRowStore["createTaskWorktree"]>[0]): TaskWorktreeRecord {
    const row: TaskWorktreeRecord = Object.freeze({
      ...input, status: "active" as const, createdAtMs: 1, updatedAtMs: 1,
    });
    this.rows.set(input.taskId, row);
    return row;
  }
  listTaskWorktrees(): readonly TaskWorktreeRecord[] {
    return [...this.rows.values()];
  }
  setTaskWorktreeStatus(input: { readonly taskId: TaskId; readonly status: TaskWorktreeStatus }): TaskWorktreeRecord {
    const existing = this.rows.get(input.taskId);
    if (existing === undefined) throw new Error("missing row");
    const updated = Object.freeze({ ...existing, status: input.status });
    this.rows.set(input.taskId, updated);
    return updated;
  }
}

class FakeGit implements GitWorktreePort {
  readonly calls: string[] = [];
  created: CreateWorktreeResult = {
    status: "created", sourceRepoPath: "/repo", worktreePath: "/data/worktrees/task-1", branch: "guild/task-abcdef12",
    baseCommit: "a".repeat(40), baseBranch: "main", subdirectory: "",
  };
  inspection: WorktreeInspection = { state: "present", ahead: 0, behind: 0, dirtyFiles: 0, dirtyCapped: false };
  evaluation: WorktreeMergeEvaluation = { status: "blocked", blocking: [{ reason: "nothing_to_merge" }] };
  applied: WorktreeApplyResult = { status: "failed", reason: "git_failed" };
  discarded: WorktreeDiscardResult = { status: "discarded", removedWorktree: true, removedBranch: true };
  async create(input: Parameters<GitWorktreePort["create"]>[0]): Promise<CreateWorktreeResult> {
    this.calls.push(`create:${input.branch}:${input.worktreePath}`);
    return this.created;
  }
  async inspect(): Promise<WorktreeInspection> {
    this.calls.push("inspect");
    return this.inspection;
  }
  async preview(): Promise<WorktreeMergeEvaluation> {
    this.calls.push("preview");
    return this.evaluation;
  }
  async apply(input: Parameters<GitWorktreePort["apply"]>[0]): Promise<WorktreeApplyResult> {
    this.calls.push(`apply:${input.taskTitle}`);
    return this.applied;
  }
  async discard(input: Parameters<GitWorktreePort["discard"]>[0]): Promise<WorktreeDiscardResult> {
    this.calls.push(`discard:${input.target.branch}`);
    return this.discarded;
  }
}

function setup(options: { runBlock?: () => "run_active" | undefined } = {}) {
  const git = new FakeGit();
  const rows = new MemoryRows();
  let changes = 0;
  let clock = 1_000_000;
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "guild-twm-")));
  cleanup.push(dataRoot);
  const manager: TaskWorktreeManager = createTaskWorktreeManager({
    store: rows, git, dataRoot,
    runBlock: options.runBlock ?? (() => undefined),
    onChange: () => { changes += 1; },
    now: () => clock,
  });
  return {
    git, rows, manager, dataRoot,
    changes: () => changes,
    advance: (ms: number) => { clock += ms; },
  };
}

async function created(context: ReturnType<typeof setup>, id = "task-1") {
  return context.manager.create({
    taskId: taskId(id), workspaceId: "workspace-1", workspacePath: "/repo", title: "New task",
    createTaskRow: () => { context.git.calls.push("task-row"); },
  });
}

describe("task worktree manager", () => {
  it("creates the worktree first, then the task row, then records it", async () => {
    const context = setup();
    const row = await created(context);
    assert.equal(row.status, "active");
    assert.equal(context.git.calls[0]?.startsWith("create:guild/task-"), true);
    assert.match(context.git.calls[0] ?? "", /worktrees\/task-1$/u);
    assert.equal(context.git.calls[1], "task-row");
    assert.equal(context.manager.statusOf(taskId("task-1")), "active");
    assert.equal(context.manager.rowOf(taskId("task-1"))?.branch, "guild/task-abcdef12");
  });

  it("throws worktree_<reason> for a refusal and creates no task row", async () => {
    const context = setup();
    context.git.created = { status: "refused", reason: "not_a_git_repo" };
    await assert.rejects(created(context), /^Error: worktree_not_a_git_repo$/u);
    assert.deepEqual(context.git.calls.filter((call) => call === "task-row"), []);
    assert.equal(context.manager.rowOf(taskId("task-1")), undefined);
  });

  it("removes the worktree again when the task row cannot be made", async () => {
    const context = setup();
    await assert.rejects(context.manager.create({
      taskId: taskId("task-1"), workspaceId: "workspace-1", workspacePath: "/repo", title: "New task",
      createTaskRow: () => { throw new Error("db full"); },
    }), /db full/u);
    assert.ok(context.git.calls.includes("discard:guild/task-abcdef12"));
    assert.equal(context.manager.rowOf(taskId("task-1")), undefined);
  });

  it("scopes the session folder to the worktree plus the workspace's sub-folder", async () => {
    const context = setup();
    await created(context);
    assert.equal(context.manager.rootPathOf(taskId("task-1"), "/repo"), "/data/worktrees/task-1");
    assert.equal(context.manager.rootPathOf(taskId("task-1"), "/repo/pkg/app"), "/data/worktrees/task-1/pkg/app");
    assert.equal(context.manager.rootPathOf(taskId("task-1"), "/elsewhere"), "/data/worktrees/task-1");
    assert.equal(context.manager.rootPathOf(taskId("task-other"), "/repo/pkg"), "/repo/pkg", "a task without a worktree keeps its workspace");
  });

  it("projects branch, numbers and measured only after git answered, and keeps the last numbers when git is unavailable", async () => {
    const context = setup();
    await created(context);
    assert.deepEqual(context.manager.projectionOf(taskId("task-1")), {
      status: "active", branch: "guild/task-abcdef12", baseBranch: "main", ahead: 0, behind: 0, dirtyFiles: 0, measured: false,
    });
    context.git.inspection = { state: "present", ahead: 2, behind: 1, dirtyFiles: 3, dirtyCapped: false };
    assert.equal(await context.manager.refresh(taskId("task-1")), true);
    const measured = context.manager.projectionOf(taskId("task-1"));
    assert.deepEqual(
      { ahead: measured?.ahead, behind: measured?.behind, dirty: measured?.dirtyFiles, measured: measured?.measured },
      { ahead: 2, behind: 1, dirty: 3, measured: true },
    );
    assert.equal(context.changes(), 1);

    context.git.inspection = { state: "unavailable", reason: "timeout" };
    assert.equal(await context.manager.refresh(taskId("task-1"), { force: true }), false);
    assert.equal(context.manager.projectionOf(taskId("task-1"))?.ahead, 2, "the last numbers stay");
    assert.equal(context.manager.statusOf(taskId("task-1")), "active");
  });

  it("refreshes at most once per interval unless forced, and never in parallel", async () => {
    const context = setup();
    await created(context);
    context.git.inspection = { state: "present", ahead: 1, behind: 0, dirtyFiles: 0, dirtyCapped: false };
    await Promise.all([context.manager.refresh(taskId("task-1")), context.manager.refresh(taskId("task-1"))]);
    assert.equal(context.git.calls.filter((call) => call === "inspect").length, 1);
    await context.manager.refresh(taskId("task-1"));
    assert.equal(context.git.calls.filter((call) => call === "inspect").length, 1, "too soon");
    context.advance(31_000);
    await context.manager.refresh(taskId("task-1"));
    assert.equal(context.git.calls.filter((call) => call === "inspect").length, 2);
    await context.manager.refresh(taskId("task-1"), { force: true });
    assert.equal(context.git.calls.filter((call) => call === "inspect").length, 3);
    context.manager.noteViewed(taskId("task-1"));
    assert.equal(context.git.calls.filter((call) => call === "inspect").length, 3, "viewing right after a refresh does not start another");
  });

  it("marks a vanished folder missing and brings it back when it returns", async () => {
    const context = setup();
    await created(context);
    context.git.inspection = { state: "missing", reason: "worktree_directory" };
    await context.manager.refresh(taskId("task-1"), { force: true });
    assert.equal(context.manager.statusOf(taskId("task-1")), "missing");
    assert.equal(context.manager.projectionOf(taskId("task-1"))?.measured, false);
    context.git.inspection = { state: "present", ahead: 0, behind: 0, dirtyFiles: 0, dirtyCapped: false };
    await context.manager.refresh(taskId("task-1"), { force: true });
    assert.equal(context.manager.statusOf(taskId("task-1")), "active");
  });

  it("previews with the Run gate, the git result and a missing worktree", async () => {
    let block: "run_active" | undefined;
    const context = setup({ runBlock: () => block });
    await created(context);
    context.git.evaluation = {
      status: "ready",
      summary: {
        branch: "guild/task-abcdef12", baseBranch: "main", commitsAhead: 1, uncommittedFiles: 2,
        files: [{ path: "a.txt", status: "M", adds: 1, dels: 0 }], filesTotal: 1, adds: 1, dels: 0, filesTruncated: false,
      },
    };
    const ready = await context.manager.preview(taskId("task-1"));
    assert.equal(ready.status, "ready");
    block = "run_active";
    assert.deepEqual(await context.manager.preview(taskId("task-1")), { status: "refused", reason: "run_active" });
    assert.equal(context.git.calls.filter((call) => call === "preview").length, 1, "git is not asked while a Run is active");
    block = undefined;
    assert.deepEqual(await context.manager.preview(taskId("task-none")), { status: "refused", reason: "no_worktree" });
    context.git.evaluation = { status: "worktree_missing" };
    assert.deepEqual(await context.manager.preview(taskId("task-1")), { status: "refused", reason: "worktree_missing" });
    assert.equal(context.manager.statusOf(taskId("task-1")), "missing");
    context.git.evaluation = { status: "unavailable", reason: "too_large" };
    assert.deepEqual(await context.manager.preview(taskId("task-1")), { status: "refused", reason: "git_failed" });
    context.git.evaluation = { status: "unavailable", reason: "git_too_old" };
    assert.deepEqual(await context.manager.preview(taskId("task-1")), { status: "refused", reason: "git_too_old" });
  });

  it("maps conflicts and blocking reasons, capping nothing it should not", async () => {
    const context = setup();
    await created(context);
    const summary = {
      branch: "guild/task-abcdef12", baseBranch: "main", commitsAhead: 1, uncommittedFiles: 0,
      files: [], filesTotal: 0, adds: 0, dels: 0, filesTruncated: false,
    };
    context.git.evaluation = { status: "conflicts", summary, conflicts: ["a.txt"], conflictsTruncated: true };
    const conflicts = await context.manager.preview(taskId("task-1"));
    assert.equal(conflicts.status, "conflicts");
    if (conflicts.status === "conflicts") {
      assert.deepEqual(conflicts.conflicts, ["a.txt"]);
      assert.equal(conflicts.conflictsTruncated, true);
    }
    context.git.evaluation = {
      status: "blocked",
      blocking: [
        { reason: "source_not_on_base_branch", currentBranch: "dev" },
        { reason: "source_dirty_in_touched_paths", paths: ["a.txt"], pathsTruncated: true },
      ],
    };
    assert.deepEqual(await context.manager.preview(taskId("task-1")), {
      status: "blocked",
      blocking: [
        { reason: "source_not_on_base_branch", currentBranch: "dev" },
        { reason: "source_dirty_in_touched_paths", paths: ["a.txt"], pathsTruncated: true },
      ],
    });
  });

  it("applies: status becomes applied, numbers refresh, the merge commit is abbreviated", async () => {
    const context = setup();
    await created(context);
    context.git.applied = {
      status: "applied", baseBranch: "main", mergeCommit: "f".repeat(40), committedUncommitted: true,
      summary: {
        branch: "guild/task-abcdef12", baseBranch: "main", commitsAhead: 0, uncommittedFiles: 2,
        files: [], filesTotal: 2, adds: 4, dels: 1, filesTruncated: false,
      },
    };
    context.git.inspection = { state: "present", ahead: 0, behind: 1, dirtyFiles: 0, dirtyCapped: false };
    const result = await context.manager.apply(taskId("task-1"), "Add feature");
    assert.equal(result.status, "applied");
    if (result.status === "applied") {
      assert.equal(result.mergeCommit, "f".repeat(12));
      assert.equal(result.committedUncommitted, true);
      assert.equal(result.summary.filesTotal, 2);
    }
    assert.ok(context.git.calls.includes("apply:Add feature"));
    assert.equal(context.manager.statusOf(taskId("task-1")), "applied");
    assert.equal(context.manager.projectionOf(taskId("task-1"))?.measured, true);

    // New work in the worktree makes it active again.
    context.git.inspection = { state: "present", ahead: 0, behind: 1, dirtyFiles: 2, dirtyCapped: false };
    await context.manager.refresh(taskId("task-1"), { force: true });
    assert.equal(context.manager.statusOf(taskId("task-1")), "active");
  });

  it("passes conflicts, blocks and failures of an apply through without changing the status", async () => {
    const context = setup();
    await created(context);
    context.git.applied = { status: "conflicts", conflicts: ["a.txt"], conflictsTruncated: false };
    assert.deepEqual(await context.manager.apply(taskId("task-1"), "x"), { status: "conflicts", conflicts: ["a.txt"] });
    context.git.applied = { status: "blocked", blocking: [{ reason: "source_has_staged_changes", paths: ["b"] }] };
    assert.deepEqual(await context.manager.apply(taskId("task-1"), "x"), {
      status: "blocked", blocking: [{ reason: "source_has_staged_changes", paths: ["b"] }],
    });
    context.git.applied = { status: "failed", reason: "repository_changed" };
    assert.deepEqual(await context.manager.apply(taskId("task-1"), "x"), { status: "failed", reason: "repository_changed" });
    context.git.applied = { status: "failed", reason: "too_large" };
    assert.deepEqual(await context.manager.apply(taskId("task-1"), "x"), { status: "failed", reason: "git_failed" });
    assert.equal(context.manager.statusOf(taskId("task-1")), "active");
  });

  it("refuses apply and discard while a Run is active, and after a discard", async () => {
    let block: "run_active" | undefined = "run_active";
    const context = setup({ runBlock: () => block });
    await created(context);
    assert.deepEqual(await context.manager.apply(taskId("task-1"), "x"), { status: "refused", reason: "run_active" });
    assert.deepEqual(await context.manager.discard(taskId("task-1")), { status: "refused", reason: "run_active" });
    assert.equal(context.git.calls.some((call) => call.startsWith("apply") || call.startsWith("discard")), false);
    block = undefined;
    assert.deepEqual(await context.manager.discard(taskId("task-1")), { status: "discarded" });
    assert.equal(context.manager.statusOf(taskId("task-1")), "discarded");
    assert.deepEqual(await context.manager.apply(taskId("task-1"), "x"), { status: "refused", reason: "discarded" });
    assert.deepEqual(await context.manager.discard(taskId("task-1")), { status: "refused", reason: "discarded" });
    await assert.rejects(context.manager.assertUsable(taskId("task-1")), /task_worktree_discarded/u);
    assert.equal(await context.manager.refresh(taskId("task-1"), { force: true }), false, "a discarded worktree is never inspected again");
  });

  it("reports a failed discard and leaves the row alone", async () => {
    const context = setup();
    await created(context);
    context.git.discarded = { status: "failed", reason: "timeout" };
    assert.deepEqual(await context.manager.discard(taskId("task-1")), { status: "failed", reason: "timeout" });
    context.git.discarded = { status: "refused", reason: "invalid_target" };
    assert.deepEqual(await context.manager.discard(taskId("task-1")), { status: "failed", reason: "git_failed" });
    assert.equal(context.manager.statusOf(taskId("task-1")), "active");
  });

  it("removes an untouched worktree and keeps one that holds work", async () => {
    const context = setup();
    await created(context);
    context.git.inspection = { state: "present", ahead: 0, behind: 0, dirtyFiles: 1, dirtyCapped: false };
    assert.equal(await context.manager.discardIfUntouched(taskId("task-1")), false);
    context.git.inspection = { state: "present", ahead: 1, behind: 0, dirtyFiles: 0, dirtyCapped: false };
    assert.equal(await context.manager.discardIfUntouched(taskId("task-1")), false);
    context.git.inspection = { state: "unavailable", reason: "timeout" };
    assert.equal(await context.manager.discardIfUntouched(taskId("task-1")), false, "when in doubt nothing is deleted");
    assert.equal(context.git.calls.some((call) => call.startsWith("discard")), false);
    context.git.inspection = { state: "present", ahead: 0, behind: 0, dirtyFiles: 0, dirtyCapped: false };
    assert.equal(await context.manager.discardIfUntouched(taskId("task-1")), true);
    assert.equal(context.manager.statusOf(taskId("task-1")), "discarded");
    assert.equal(await context.manager.discardIfUntouched(taskId("task-none")), true, "no worktree, nothing to do");
  });

  it("resolves a resource path only inside its own worktrees root", async () => {
    const context = setup();
    const worktree = join(context.dataRoot, "worktrees", "task-1");
    mkdirSync(worktree, { recursive: true });
    context.git.created = { ...(context.git.created as Extract<CreateWorktreeResult, { status: "created" }>), worktreePath: worktree };
    await created(context);
    assert.equal(await context.manager.resourcePath(taskId("task-1"), "/repo"), worktree);

    const outside = realpathSync(mkdtempSync(join(tmpdir(), "guild-twm-out-")));
    cleanup.push(outside);
    context.rows.rows.set(taskId("task-1"), Object.freeze({
      ...context.rows.rows.get(taskId("task-1"))!, worktreePath: outside,
    }));
    const tampered = createTaskWorktreeManager({
      store: context.rows, git: context.git, dataRoot: context.dataRoot, runBlock: () => undefined, onChange: () => undefined,
    });
    await assert.rejects(tampered.resourcePath(taskId("task-1"), "/repo"), /worktree_unavailable/u);
    await assert.rejects(tampered.assertUsable(taskId("task-1")), /task_worktree_invalid/u);
    await assert.rejects(context.manager.resourcePath(taskId("task-none"), "/repo"), /worktree_unavailable/u);
    await context.manager.discard(taskId("task-1"));
    await assert.rejects(context.manager.resourcePath(taskId("task-1"), "/repo"), /worktree_unavailable/u);
  });

  it("answers the git-workspace hint from a cached filesystem look", () => {
    const context = setup();
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "guild-twm-repo-")));
    cleanup.push(repo);
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "nested"));
    assert.equal(context.manager.isAvailableFor(join(repo, "nested")), true);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "guild-twm-plain-")));
    cleanup.push(plain);
    assert.equal(context.manager.isAvailableFor(plain), false);
  });
});
