import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { setGitExecutableForTests } from "./git-checkpoints.js";
import {
  applyWorktreeMerge,
  createGitWorktree,
  discardGitWorktree,
  findGitWorkTreeRootSync,
  inspectGitWorktree,
  isGuildBranchName,
  mergeBranchIntoCheckout,
  previewWorktreeMerge,
  taskWorktreeDirectory,
  worktreeBranchName,
  worktreeBranchSlug,
  type WorktreeTarget,
} from "./git-worktrees.js";
import { deadlineIn } from "./git-checkpoints.js";

const cleanup: string[] = [];
const savedEnvironment: Record<string, string | undefined> = {};

before(() => {
  // The owner's global git configuration (hooks, merge settings, signing) must not change a result.
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
    savedEnvironment[name] = process.env[name];
  }
  process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  process.env["GIT_CONFIG_SYSTEM"] = "/dev/null";
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});

after(() => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  setGitExecutableForTests(undefined);
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(label: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `guild-wt-${label}-`)));
  cleanup.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Owner",
      GIT_AUTHOR_EMAIL: "owner@example.test",
      GIT_COMMITTER_NAME: "Owner",
      GIT_COMMITTER_EMAIL: "owner@example.test",
    },
  });
}

function tryGit(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (cause) {
    return { ok: false, out: String((cause as { stderr?: unknown }).stderr ?? cause) };
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Everything about a checkout that Guild promises not to change except through the one merge. */
function snapshot(repo: string) {
  const gitDir = git(repo, "rev-parse", "--absolute-git-dir").trim();
  const indexPath = join(gitDir, "index");
  return {
    head: git(repo, "rev-parse", "HEAD").trim(),
    headRef: tryGit(repo, "symbolic-ref", "-q", "HEAD").out.trim(),
    index: existsSync(indexPath) ? sha256(readFileSync(indexPath)) : "",
    refs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    stash: git(repo, "stash", "list"),
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    mergeHead: existsSync(join(gitDir, "MERGE_HEAD")),
  };
}

type Fixture = Readonly<{ root: string; repo: string; dataRoot: string; worktrees: string }>;

function makeRepo(label: string, files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n", "b.txt": "b\n" }): Fixture {
  const root = temporaryDirectory(label);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Owner");
  git(repo, "config", "user.email", "owner@example.test");
  git(repo, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot);
  return { root, repo, dataRoot, worktrees: join(dataRoot, "worktrees") };
}

async function newWorktree(fixture: Fixture, taskId = "task-11111111-aaaa", title = "Fix things"): Promise<WorktreeTarget> {
  const created = await createGitWorktree({
    workspacePath: fixture.repo,
    worktreePath: taskWorktreeDirectory(fixture.dataRoot, taskId),
    branch: worktreeBranchName(title, taskId),
  });
  assert.equal(created.status, "created", JSON.stringify(created));
  if (created.status !== "created") throw new Error("unreachable");
  return {
    sourceRepoPath: created.sourceRepoPath,
    worktreePath: created.worktreePath,
    branch: created.branch,
    baseCommit: created.baseCommit,
    ...(created.baseBranch === undefined ? {} : { baseBranch: created.baseBranch }),
  };
}

function commitInWorktree(target: WorktreeTarget, file: string, content: string, message = "work"): void {
  mkdirSync(join(target.worktreePath, file, ".."), { recursive: true });
  writeFileSync(join(target.worktreePath, file), content);
  git(target.worktreePath, "add", "-A");
  git(target.worktreePath, "commit", "-q", "-m", message);
}

describe("branch and path names", () => {
  it("builds guild/<slug>-<short id> branches from ASCII titles and falls back to task", () => {
    assert.equal(worktreeBranchSlug("Fix the Login Bug!"), "fix-the-login-bug");
    assert.equal(worktreeBranchSlug("修复登录问题"), "task");
    assert.equal(worktreeBranchSlug("New task"), "task");
    assert.equal(worktreeBranchSlug("  --  "), "task");
    assert.equal(worktreeBranchSlug("a".repeat(80)).length <= 24, true);
    assert.equal(worktreeBranchSlug("Déjà vu: café"), "deja-vu-cafe");
    const branch = worktreeBranchName("Fix login", "task-abc");
    assert.match(branch, /^guild\/fix-login-[0-9a-f]{8}$/u);
    assert.equal(worktreeBranchName("Fix login", "task-abc"), branch, "stable per task");
    assert.notEqual(worktreeBranchName("Fix login", "task-abd"), branch);
    assert.equal(isGuildBranchName(branch), true);
    for (const rejected of ["main", "guild/", "guild/..", "guild/a..b", "guild/-x", "guild/x y", "guild/x.lock", "feature/guild/x", "guild/X", "guild/a/../b"]) {
      assert.equal(isGuildBranchName(rejected), false, rejected);
    }
  });

  it("keeps every worktree directly under <data>/worktrees and hashes an unusual task id", () => {
    assert.equal(taskWorktreeDirectory("/data", "task-1"), "/data/worktrees/task-1");
    const odd = taskWorktreeDirectory("/data", "../../etc");
    assert.match(odd, /^\/data\/worktrees\/x-[0-9a-f]{32}$/u);
  });

  it("finds a git work tree from a nested folder and nothing outside one", () => {
    const fixture = makeRepo("find");
    mkdirSync(join(fixture.repo, "deep", "er"), { recursive: true });
    assert.equal(findGitWorkTreeRootSync(join(fixture.repo, "deep", "er")), fixture.repo);
    const plain = temporaryDirectory("plain");
    assert.equal(findGitWorkTreeRootSync(plain), undefined);
  });
});

describe("createGitWorktree", () => {
  it("adds a linked worktree on a new guild branch at the current commit and leaves the checkout alone", async () => {
    const fixture = makeRepo("create");
    writeFileSync(join(fixture.repo, "untracked.txt"), "not committed\n");
    writeFileSync(join(fixture.repo, ".gitignore"), "ignored.log\n");
    writeFileSync(join(fixture.repo, "ignored.log"), "ignored\n");
    git(fixture.repo, "add", ".gitignore");
    git(fixture.repo, "commit", "-q", "-m", "ignore");
    writeFileSync(join(fixture.repo, "ignored.log"), "ignored\n");
    git(fixture.repo, "stash", "list");
    const before = snapshot(fixture.repo);
    const head = git(fixture.repo, "rev-parse", "HEAD").trim();

    const created = await createGitWorktree({
      workspacePath: fixture.repo,
      worktreePath: join(fixture.worktrees, "task-1"),
      branch: "guild/task-1a2b3c4d",
    });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    assert.equal(created.sourceRepoPath, fixture.repo);
    assert.equal(created.worktreePath, join(fixture.worktrees, "task-1"));
    assert.equal(created.branch, "guild/task-1a2b3c4d");
    assert.equal(created.baseCommit, head);
    assert.equal(created.baseBranch, "main");
    assert.equal(created.subdirectory, "");

    // Only committed files exist in the new worktree: no untracked file, no ignored file.
    assert.equal(readFileSync(join(created.worktreePath, "a.txt"), "utf8"), "one\ntwo\nthree\n");
    assert.equal(existsSync(join(created.worktreePath, "untracked.txt")), false);
    assert.equal(existsSync(join(created.worktreePath, "ignored.log")), false);
    assert.equal(git(created.worktreePath, "rev-parse", "HEAD").trim(), head);
    assert.equal(git(created.worktreePath, "symbolic-ref", "--short", "HEAD").trim(), "guild/task-1a2b3c4d");
    assert.match(git(fixture.repo, "worktree", "list"), /task-1/u);

    // The checkout: same HEAD, index bytes, status and stash. Only one ref appeared (the branch).
    const after = snapshot(fixture.repo);
    assert.equal(after.head, before.head);
    assert.equal(after.index, before.index);
    assert.equal(after.status, before.status);
    assert.equal(after.stash, before.stash);
    assert.equal(
      after.refs.split("\n").filter((line) => !before.refs.includes(line) && line !== "").join("\n"),
      `refs/heads/guild/task-1a2b3c4d ${head}`,
    );
  });

  it("never runs a hook, neither the repository's own nor one set through core.hooksPath", async () => {
    const fixture = makeRepo("hooks");
    const marker = join(fixture.root, "hook-ran");
    const hook = `#!/bin/sh\necho ran >> "${marker}"\n`;
    mkdirSync(join(fixture.repo, ".git", "hooks"), { recursive: true });
    writeFileSync(join(fixture.repo, ".git", "hooks", "post-checkout"), hook);
    chmodSync(join(fixture.repo, ".git", "hooks", "post-checkout"), 0o755);
    const customHooks = join(fixture.root, "custom-hooks");
    mkdirSync(customHooks);
    for (const name of ["post-checkout", "pre-commit", "commit-msg", "pre-merge-commit", "post-merge"]) {
      writeFileSync(join(customHooks, name), hook);
      chmodSync(join(customHooks, name), 0o755);
    }
    git(fixture.repo, "config", "core.hooksPath", customHooks);

    const target = await newWorktree(fixture);
    assert.equal(existsSync(marker), false, "post-checkout must not run while creating");
    writeFileSync(join(target.worktreePath, "c.txt"), "c\n");
    const applied = await applyWorktreeMerge({ target, taskTitle: "hooks" });
    assert.equal(applied.status, "applied");
    assert.equal(existsSync(marker), false, "no commit, merge or checkout hook may run");
  });

  it("records a detached checkout without a base branch", async () => {
    const fixture = makeRepo("detached");
    git(fixture.repo, "checkout", "-q", "--detach", "HEAD");
    const target = await newWorktree(fixture);
    assert.equal(target.baseBranch, undefined);
    const preview = await previewWorktreeMerge({ target });
    assert.deepEqual(preview, { status: "blocked", blocking: [{ reason: "no_base_branch" }] });
  });

  it("refuses a folder that is not in a git repository, a repository without commits and a bare repository", async () => {
    const plain = temporaryDirectory("plain");
    const refusedPlain = await createGitWorktree({
      workspacePath: plain, worktreePath: join(plain, "..", "wt-out"), branch: "guild/x-12345678",
    });
    assert.deepEqual(refusedPlain, { status: "refused", reason: "not_a_git_repo" });

    const unborn = temporaryDirectory("unborn");
    git(unborn, "init", "-q", "-b", "main");
    const refusedUnborn = await createGitWorktree({
      workspacePath: unborn, worktreePath: join(temporaryDirectory("o"), "wt"), branch: "guild/x-12345678",
    });
    assert.deepEqual(refusedUnborn, { status: "refused", reason: "no_commits" });

    const fixture = makeRepo("bare");
    const bare = join(fixture.root, "bare.git");
    git(fixture.root, "clone", "-q", "--bare", fixture.repo, bare);
    const refusedBare = await createGitWorktree({
      workspacePath: bare, worktreePath: join(fixture.root, "wt-bare"), branch: "guild/x-12345678",
    });
    assert.deepEqual(refusedBare, { status: "refused", reason: "not_a_git_repo" });

    assert.deepEqual(
      await createGitWorktree({ workspacePath: join(plain, "missing"), worktreePath: join(plain, "wt"), branch: "guild/x-12345678" }),
      { status: "refused", reason: "not_a_git_repo" },
    );
  });

  it("maps a workspace sub-folder to the same sub-folder of the worktree and refuses an untracked one", async () => {
    const fixture = makeRepo("sub", { "pkg/app/main.ts": "x\n", "README.md": "r\n" });
    const created = await createGitWorktree({
      workspacePath: join(fixture.repo, "pkg", "app"),
      worktreePath: join(fixture.worktrees, "task-sub"),
      branch: "guild/sub-12345678",
    });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    assert.equal(created.sourceRepoPath, fixture.repo);
    assert.equal(created.subdirectory, join("pkg", "app"));
    assert.equal(existsSync(join(created.worktreePath, "pkg", "app", "main.ts")), true);

    mkdirSync(join(fixture.repo, "scratch"));
    writeFileSync(join(fixture.repo, "scratch", "n.txt"), "n\n");
    const refused = await createGitWorktree({
      workspacePath: join(fixture.repo, "scratch"),
      worktreePath: join(fixture.worktrees, "task-scratch"),
      branch: "guild/scratch-12345678",
    });
    assert.deepEqual(refused, { status: "refused", reason: "workspace_not_in_commit" });
    assert.equal(existsSync(join(fixture.worktrees, "task-scratch")), false, "the half-made worktree is removed");
    assert.equal(tryGit(fixture.repo, "rev-parse", "--verify", "-q", "refs/heads/guild/scratch-12345678").ok, false);
  });

  it("picks another branch name when the first is taken and never overwrites an existing directory", async () => {
    const fixture = makeRepo("taken");
    git(fixture.repo, "branch", "guild/taken-12345678");
    const created = await createGitWorktree({
      workspacePath: fixture.repo,
      worktreePath: join(fixture.worktrees, "task-taken"),
      branch: "guild/taken-12345678",
    });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;
    assert.match(created.branch, /^guild\/taken-12345678-[0-9a-f]{6}$/u);
    assert.equal(git(fixture.repo, "rev-parse", "refs/heads/guild/taken-12345678").trim(), created.baseCommit, "the older branch is untouched");

    const occupied = join(fixture.worktrees, "task-occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "keep.txt"), "mine\n");
    const again = await createGitWorktree({
      workspacePath: fixture.repo, worktreePath: occupied, branch: "guild/occupied-12345678",
    });
    assert.deepEqual(again, { status: "refused", reason: "git_failed" });
    assert.equal(readFileSync(join(occupied, "keep.txt"), "utf8"), "mine\n");
  });

  it("refuses a branch that is not a guild branch or a relative worktree path", async () => {
    const fixture = makeRepo("names");
    for (const branch of ["main", "feature/x", "guild/"]) {
      assert.deepEqual(
        await createGitWorktree({ workspacePath: fixture.repo, worktreePath: join(fixture.worktrees, "t"), branch }),
        { status: "refused", reason: "git_failed" },
        branch,
      );
    }
    assert.deepEqual(
      await createGitWorktree({ workspacePath: fixture.repo, worktreePath: "relative/path", branch: "guild/x-12345678" }),
      { status: "refused", reason: "git_failed" },
    );
  });

  it("reports a missing git and a git that outlives its deadline without throwing", async () => {
    const fixture = makeRepo("limits");
    setGitExecutableForTests(join(fixture.root, "no-such-git"));
    assert.deepEqual(
      await createGitWorktree({ workspacePath: fixture.repo, worktreePath: join(fixture.worktrees, "a"), branch: "guild/a-12345678" }),
      { status: "refused", reason: "git_unavailable" },
    );
    const hang = join(fixture.root, "hang-git");
    // Not `exec`: the sleeping grandchild keeps git's pipes open after git itself is killed.
    writeFileSync(hang, "#!/bin/sh\nsleep 30\n");
    chmodSync(hang, 0o755);
    setGitExecutableForTests(hang);
    const started = Date.now();
    assert.deepEqual(
      await createGitWorktree({
        workspacePath: fixture.repo, worktreePath: join(fixture.worktrees, "b"), branch: "guild/b-12345678",
        limits: { createTimeoutMs: 250 },
      }),
      { status: "refused", reason: "timeout" },
    );
    assert.ok(Date.now() - started < 5_000, "the deadline kills the process");
  });
});

describe("inspectGitWorktree", () => {
  it("counts commits ahead and behind and uncommitted files", async () => {
    const fixture = makeRepo("inspect");
    const target = await newWorktree(fixture);
    assert.deepEqual(await inspectGitWorktree({ target }), {
      state: "present", ahead: 0, behind: 0, dirtyFiles: 0, dirtyCapped: false,
    });

    commitInWorktree(target, "new.txt", "n\n");
    commitInWorktree(target, "more.txt", "m\n");
    writeFileSync(join(target.worktreePath, "a.txt"), "changed\n");
    writeFileSync(join(target.worktreePath, "untracked-a.txt"), "u\n");
    writeFileSync(join(target.worktreePath, "untracked-b.txt"), "u\n");
    rmSync(join(target.worktreePath, "b.txt"));
    // The base branch moved on by one commit.
    writeFileSync(join(fixture.repo, "base-only.txt"), "x\n");
    git(fixture.repo, "add", "-A");
    git(fixture.repo, "commit", "-q", "-m", "base moves");

    assert.deepEqual(await inspectGitWorktree({ target }), {
      state: "present", ahead: 2, behind: 1, dirtyFiles: 4, dirtyCapped: false,
    });
  });

  it("falls back to the base commit when the base branch is gone or was never recorded", async () => {
    const fixture = makeRepo("inspect-base");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "x.txt", "x\n");
    const { baseBranch: _kept, ...detached } = target;
    assert.deepEqual(await inspectGitWorktree({ target: detached }), {
      state: "present", ahead: 1, behind: 0, dirtyFiles: 0, dirtyCapped: false,
    });
    assert.deepEqual(await inspectGitWorktree({ target: { ...target, baseBranch: "renamed-away" } }), {
      state: "present", ahead: 1, behind: 0, dirtyFiles: 0, dirtyCapped: false,
    });
  });

  it("is read-only: the worktree's index and the checkout's index stay byte for byte the same", async () => {
    const fixture = makeRepo("inspect-readonly");
    const target = await newWorktree(fixture);
    writeFileSync(join(target.worktreePath, "a.txt"), "touched\n");
    const worktreeBefore = snapshot(target.worktreePath);
    const checkoutBefore = snapshot(fixture.repo);
    await inspectGitWorktree({ target });
    assert.deepEqual(snapshot(target.worktreePath), worktreeBefore);
    assert.deepEqual(snapshot(fixture.repo), checkoutBefore);
  });

  it("reports a deleted directory, a directory that is not a worktree and a deleted branch as missing", async () => {
    const gone = makeRepo("inspect-gone");
    const goneTarget = await newWorktree(gone);
    rmSync(goneTarget.worktreePath, { recursive: true, force: true });
    assert.deepEqual(await inspectGitWorktree({ target: goneTarget }), { state: "missing", reason: "worktree_directory" });

    const hollow = makeRepo("inspect-hollow");
    const hollowTarget = await newWorktree(hollow);
    rmSync(join(hollowTarget.worktreePath, ".git"), { force: true });
    assert.deepEqual(await inspectGitWorktree({ target: hollowTarget }), { state: "missing", reason: "not_a_worktree" });

    const branchless = makeRepo("inspect-branchless");
    const branchlessTarget = await newWorktree(branchless);
    git(branchlessTarget.worktreePath, "checkout", "-q", "--detach");
    git(branchless.repo, "branch", "-D", branchlessTarget.branch);
    assert.deepEqual(await inspectGitWorktree({ target: branchlessTarget }), { state: "missing", reason: "branch" });
  });

  it("caps an enormous change list and says so", async () => {
    const fixture = makeRepo("inspect-cap");
    const target = await newWorktree(fixture);
    for (let index = 0; index < 400; index += 1) writeFileSync(join(target.worktreePath, `f-${index}.txt`), "x\n");
    const capped = await inspectGitWorktree({ target, limits: { maxStatusBytes: 1_024 } });
    assert.equal(capped.state, "present");
    if (capped.state === "present") {
      assert.equal(capped.dirtyCapped, true);
      assert.ok(capped.dirtyFiles > 0 && capped.dirtyFiles < 400);
    }
  });
});

describe("previewWorktreeMerge", () => {
  it("shows what a clean merge would change without writing anything to either checkout", async () => {
    const fixture = makeRepo("preview");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "feature.txt", "a\nb\n");
    writeFileSync(join(target.worktreePath, "a.txt"), "one\nTWO\nthree\n");
    git(target.worktreePath, "commit", "-q", "-am", "edit a");
    // The checkout is dirty in an unrelated file: that must not block.
    writeFileSync(join(fixture.repo, "b.txt"), "b edited by the owner\n");
    const checkoutBefore = snapshot(fixture.repo);
    const worktreeBefore = snapshot(target.worktreePath);

    const preview = await previewWorktreeMerge({ target });
    assert.equal(preview.status, "ready");
    if (preview.status !== "ready") return;
    assert.equal(preview.summary.baseBranch, "main");
    assert.equal(preview.summary.branch, target.branch);
    assert.equal(preview.summary.commitsAhead, 2);
    assert.equal(preview.summary.uncommittedFiles, 0);
    assert.deepEqual(
      preview.summary.files.map((file) => `${file.status} ${file.path} +${file.adds} -${file.dels}`).sort(),
      ["A feature.txt +2 -0", "M a.txt +1 -1"],
    );
    assert.equal(preview.summary.filesTotal, 2);
    assert.deepEqual(snapshot(fixture.repo), checkoutBefore, "the checkout is read, not changed");
    assert.deepEqual(snapshot(target.worktreePath), worktreeBefore, "so is the worktree");
  });

  it("includes uncommitted worktree files without committing, staging or touching the worktree", async () => {
    const fixture = makeRepo("preview-dirty");
    const target = await newWorktree(fixture);
    writeFileSync(join(target.worktreePath, "a.txt"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(target.worktreePath, "fresh.txt"), "fresh\n");
    const tipBefore = git(target.worktreePath, "rev-parse", "HEAD").trim();
    const worktreeBefore = snapshot(target.worktreePath);

    const preview = await previewWorktreeMerge({ target });
    assert.equal(preview.status, "ready");
    if (preview.status !== "ready") return;
    assert.equal(preview.summary.commitsAhead, 0);
    assert.equal(preview.summary.uncommittedFiles, 2);
    assert.deepEqual(preview.summary.files.map((file) => `${file.status} ${file.path}`).sort(), ["A fresh.txt", "M a.txt"]);
    assert.equal(git(target.worktreePath, "rev-parse", "HEAD").trim(), tipBefore, "no commit was made");
    assert.deepEqual(snapshot(target.worktreePath), worktreeBefore);
    assert.equal(git(target.worktreePath, "log", "--oneline").trim().split("\n").length, 1);
  });

  it("lists the files a merge would conflict in", async () => {
    const fixture = makeRepo("preview-conflict");
    const target = await newWorktree(fixture);
    writeFileSync(join(target.worktreePath, "a.txt"), "one\nFROM WORKTREE\nthree\n");
    git(target.worktreePath, "commit", "-q", "-am", "worktree edit");
    writeFileSync(join(fixture.repo, "a.txt"), "one\nFROM MAIN\nthree\n");
    git(fixture.repo, "commit", "-q", "-am", "main edit");
    const checkoutBefore = snapshot(fixture.repo);

    const preview = await previewWorktreeMerge({ target });
    assert.equal(preview.status, "conflicts");
    if (preview.status !== "conflicts") return;
    assert.deepEqual(preview.conflicts, ["a.txt"]);
    assert.equal(preview.conflictsTruncated, false);
    assert.equal(preview.summary.filesTotal, 1);
    assert.deepEqual(snapshot(fixture.repo), checkoutBefore);
  });

  it("reports a merge that would change nothing", async () => {
    const fixture = makeRepo("preview-nothing");
    const target = await newWorktree(fixture);
    assert.deepEqual(await previewWorktreeMerge({ target }), { status: "blocked", blocking: [{ reason: "nothing_to_merge" }] });
  });

  it("blocks when the checkout is on another branch, with the branch name", async () => {
    const fixture = makeRepo("preview-branch");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "x.txt", "x\n");
    git(fixture.repo, "checkout", "-q", "-b", "elsewhere");
    const before = snapshot(fixture.repo);
    assert.deepEqual(await previewWorktreeMerge({ target }), {
      status: "blocked",
      blocking: [{ reason: "source_not_on_base_branch", currentBranch: "elsewhere" }],
    });
    git(fixture.repo, "checkout", "-q", "--detach");
    assert.deepEqual(await previewWorktreeMerge({ target }), {
      status: "blocked",
      blocking: [{ reason: "source_not_on_base_branch" }],
    });
    assert.equal(snapshot(fixture.repo).head, git(fixture.repo, "rev-parse", "HEAD").trim());
    assert.equal(before.head, git(fixture.repo, "rev-parse", "elsewhere").trim());
  });

  it("blocks when the base branch was deleted or the source repository is gone", async () => {
    const fixture = makeRepo("preview-base");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "x.txt", "x\n");
    git(fixture.repo, "checkout", "-q", "-b", "other");
    git(fixture.repo, "branch", "-D", "main");
    assert.deepEqual(await previewWorktreeMerge({ target }), { status: "blocked", blocking: [{ reason: "base_branch_missing" }] });

    const gone = makeRepo("preview-gone");
    const goneTarget = await newWorktree(gone);
    commitInWorktree(goneTarget, "x.txt", "x\n");
    const moved = join(gone.root, "repo-moved");
    execFileSync("mv", [gone.repo, moved]);
    assert.deepEqual(await previewWorktreeMerge({ target: goneTarget }), { status: "blocked", blocking: [{ reason: "source_missing" }] });
  });

  it("blocks while a merge, rebase or cherry-pick is in progress in the checkout", async () => {
    const fixture = makeRepo("preview-progress");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "x.txt", "x\n");
    // Leave a merge half done in the checkout.
    git(fixture.repo, "checkout", "-q", "-b", "side");
    writeFileSync(join(fixture.repo, "b.txt"), "side\n");
    git(fixture.repo, "commit", "-q", "-am", "side");
    git(fixture.repo, "checkout", "-q", "main");
    writeFileSync(join(fixture.repo, "b.txt"), "main\n");
    git(fixture.repo, "commit", "-q", "-am", "main");
    assert.equal(tryGit(fixture.repo, "merge", "side").ok, false);
    const preview = await previewWorktreeMerge({ target });
    assert.equal(preview.status, "blocked");
    if (preview.status !== "blocked") return;
    assert.ok(preview.blocking.some((block) => block.reason === "source_operation_in_progress"));
  });

  it("blocks on staged changes (git would fold them into the merge) and on dirty files the merge changes", async () => {
    const fixture = makeRepo("preview-dirty-source");
    const target = await newWorktree(fixture);
    writeFileSync(join(target.worktreePath, "a.txt"), "one\ntwo\nthree\nWORKTREE\n");
    commitInWorktree(target, "new.txt", "n\n");

    // Unstaged edit of a file the merge changes.
    writeFileSync(join(fixture.repo, "a.txt"), "one\ntwo\nthree\nOWNER\n");
    // An untracked file the merge would create.
    writeFileSync(join(fixture.repo, "new.txt"), "owner's own\n");
    const dirty = await previewWorktreeMerge({ target });
    assert.deepEqual(dirty, {
      status: "blocked",
      blocking: [{ reason: "source_dirty_in_touched_paths", paths: ["a.txt", "new.txt"] }],
    });

    // Staged change in an unrelated file.
    git(fixture.repo, "checkout", "--", "a.txt");
    rmSync(join(fixture.repo, "new.txt"));
    writeFileSync(join(fixture.repo, "b.txt"), "staged\n");
    git(fixture.repo, "add", "b.txt");
    const indexBefore = snapshot(fixture.repo).index;
    assert.deepEqual(await previewWorktreeMerge({ target }), {
      status: "blocked",
      blocking: [{ reason: "source_has_staged_changes", paths: ["b.txt"] }],
    });
    assert.equal(snapshot(fixture.repo).index, indexBefore, "the owner's staged change is left exactly as it was");
  });

  it("answers git_too_old for a git without merge-tree --write-tree and unavailable for a missing or hanging git", async () => {
    const fixture = makeRepo("preview-limits");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "x.txt", "x\n");
    const wrapper = join(fixture.root, "old-git");
    writeFileSync(wrapper, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "merge-tree" ]; then echo "usage: git merge-tree <base-tree> <branch1> <branch2>" >&2; exit 129; fi
done
exec git "$@"
`);
    chmodSync(wrapper, 0o755);
    // The wrapper execs the first `git` on PATH, which is the real one.
    setGitExecutableForTests(wrapper);
    assert.deepEqual(await previewWorktreeMerge({ target }), { status: "unavailable", reason: "git_too_old" });

    setGitExecutableForTests(join(fixture.root, "absent"));
    assert.deepEqual(await previewWorktreeMerge({ target }), { status: "unavailable", reason: "git_unavailable" });

    const hang = join(fixture.root, "hang");
    writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(hang, 0o755);
    setGitExecutableForTests(hang);
    const started = Date.now();
    assert.deepEqual(
      await previewWorktreeMerge({ target, limits: { previewTimeoutMs: 250 } }),
      { status: "unavailable", reason: "timeout" },
    );
    assert.ok(Date.now() - started < 5_000);
  });

  it("reports a missing worktree directory", async () => {
    const fixture = makeRepo("preview-missing");
    const target = await newWorktree(fixture);
    rmSync(target.worktreePath, { recursive: true, force: true });
    assert.deepEqual(await previewWorktreeMerge({ target }), { status: "worktree_missing" });
  });
});

describe("applyWorktreeMerge", () => {
  it("merges the task branch with a merge commit, keeps the branch and worktree and leaves unrelated state alone", async () => {
    const fixture = makeRepo("apply");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "feature.txt", "feature\n", "add feature");
    // Owner state that must survive: an unstaged edit elsewhere, an untracked file and a stash.
    writeFileSync(join(fixture.repo, "b.txt"), "b edited\n");
    git(fixture.repo, "stash", "-q");
    writeFileSync(join(fixture.repo, "b.txt"), "b edited again\n");
    writeFileSync(join(fixture.repo, "owner-note.txt"), "mine\n");
    const before = snapshot(fixture.repo);
    const baseTip = before.head;

    const result = await applyWorktreeMerge({ target, taskTitle: "Add feature" });
    assert.equal(result.status, "applied");
    if (result.status !== "applied") return;
    assert.equal(result.baseBranch, "main");
    assert.equal(result.committedUncommitted, false);
    assert.equal(result.summary.filesTotal, 1);

    const parents = git(fixture.repo, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ");
    assert.equal(parents[0], result.mergeCommit);
    assert.equal(parents.length, 3, "a real merge commit, not a fast-forward");
    assert.equal(parents[1], baseTip);
    assert.equal(parents[2], git(fixture.repo, "rev-parse", target.branch).trim());
    assert.match(git(fixture.repo, "log", "-1", "--format=%s"), /Add feature/u);
    assert.equal(git(fixture.repo, "log", "-1", "--format=%an <%ae>").trim(), "Owner <owner@example.test>");
    assert.equal(readFileSync(join(fixture.repo, "feature.txt"), "utf8"), "feature\n");

    const after = snapshot(fixture.repo);
    assert.equal(after.stash, before.stash, "the stash is untouched");
    assert.equal(readFileSync(join(fixture.repo, "b.txt"), "utf8"), "b edited again\n", "unrelated unstaged edit survives");
    assert.equal(readFileSync(join(fixture.repo, "owner-note.txt"), "utf8"), "mine\n");
    assert.equal(after.headRef, "refs/heads/main");
    // Branch and worktree are kept; nothing was pushed or deleted.
    assert.equal(existsSync(target.worktreePath), true);
    assert.equal(tryGit(fixture.repo, "rev-parse", "--verify", "-q", `refs/heads/${target.branch}`).ok, true);
    assert.deepEqual(await inspectGitWorktree({ target }), {
      state: "present", ahead: 0, behind: 1, dirtyFiles: 0, dirtyCapped: false,
    });
    // Applying again finds nothing left to merge.
    assert.deepEqual(await applyWorktreeMerge({ target, taskTitle: "Add feature" }), {
      status: "blocked", blocking: [{ reason: "nothing_to_merge" }],
    });
  });

  it("commits uncommitted worktree files as Guild first, with the task title in the message", async () => {
    const fixture = makeRepo("apply-dirty");
    const target = await newWorktree(fixture);
    writeFileSync(join(target.worktreePath, "a.txt"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(target.worktreePath, "created.txt"), "created\n");
    rmSync(join(target.worktreePath, "b.txt"));
    const result = await applyWorktreeMerge({ target, taskTitle: "Tidy\nthe\u0000 files" });
    assert.equal(result.status, "applied");
    if (result.status !== "applied") return;
    assert.equal(result.committedUncommitted, true);
    assert.equal(result.summary.uncommittedFiles, 3);

    const branchCommit = git(fixture.repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", target.branch).trim();
    assert.equal(branchCommit, "Guild <guild@localhost>|Guild <guild@localhost>|Guild task changes: Tidy the files");
    assert.equal(git(target.worktreePath, "status", "--porcelain").trim(), "", "the worktree is clean after the auto-commit");
    assert.equal(readFileSync(join(fixture.repo, "created.txt"), "utf8"), "created\n");
    assert.equal(existsSync(join(fixture.repo, "b.txt")), false);
    assert.equal(git(fixture.repo, "show", "-s", "--format=%P", "HEAD").trim().split(" ").length, 2);
  });

  it("uses Guild as the merge committer only when the checkout has no identity of its own", async () => {
    const fixture = makeRepo("apply-identity");
    git(fixture.repo, "config", "--unset", "user.name");
    git(fixture.repo, "config", "--unset", "user.email");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "f.txt", "f\n");
    const result = await applyWorktreeMerge({ target, taskTitle: "No identity" });
    assert.equal(result.status, "applied");
    assert.equal(git(fixture.repo, "log", "-1", "--format=%cn <%ce>").trim(), "Guild <guild@localhost>");
  });

  it("refuses a conflicting merge before changing anything and leaves the worktree changes uncommitted", async () => {
    const fixture = makeRepo("apply-conflict");
    const target = await newWorktree(fixture);
    writeFileSync(join(target.worktreePath, "a.txt"), "one\nFROM WORKTREE\nthree\n");
    writeFileSync(join(fixture.repo, "a.txt"), "one\nFROM MAIN\nthree\n");
    git(fixture.repo, "commit", "-q", "-am", "main edit");
    const before = snapshot(fixture.repo);
    const worktreeBefore = snapshot(target.worktreePath);

    const result = await applyWorktreeMerge({ target, taskTitle: "Conflict" });
    assert.deepEqual(result, { status: "conflicts", conflicts: ["a.txt"], conflictsTruncated: false });
    assert.deepEqual(snapshot(fixture.repo), before);
    assert.deepEqual(snapshot(target.worktreePath), worktreeBefore, "the worktree's uncommitted change was not committed");
  });

  it("aborts a merge that conflicts at the last moment and restores the checkout exactly", async () => {
    const fixture = makeRepo("apply-race");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "a.txt", "one\nFROM WORKTREE\nthree\n");
    writeFileSync(join(fixture.repo, "a.txt"), "one\nFROM MAIN\nthree\n");
    git(fixture.repo, "commit", "-q", "-am", "main edit");
    writeFileSync(join(fixture.repo, "b.txt"), "unrelated unstaged edit\n");
    const before = snapshot(fixture.repo);
    const stagedBefore = git(fixture.repo, "ls-files", "--stage");
    const treeBefore = readFileSync(join(fixture.repo, "a.txt"), "utf8");

    // The conflict check passed earlier, then the checkout changed: call the merge step directly.
    const result = await mergeBranchIntoCheckout({
      checkout: fixture.repo,
      branch: target.branch,
      expectedHead: before.head,
      message: "Merge Guild task: race",
      remaining: deadlineIn(30_000),
    });
    assert.deepEqual(result, { status: "conflicts", conflicts: ["a.txt"], conflictsTruncated: false });
    const after = snapshot(fixture.repo);
    assert.equal(after.mergeHead, false, "never left mid-merge");
    assert.equal(after.head, before.head);
    // git rewrites the stat cache of the index file on abort, so compare what is staged, not bytes.
    assert.equal(git(fixture.repo, "ls-files", "--stage"), stagedBefore);
    assert.equal(git(fixture.repo, "diff", "--cached", "--name-only").trim(), "");
    assert.equal(after.status, before.status);
    assert.equal(after.stash, before.stash);
    assert.equal(readFileSync(join(fixture.repo, "a.txt"), "utf8"), treeBefore, "no conflict markers remain");
  });

  it("refuses with staged changes, with a dirty touched file, and on another branch, without touching the checkout", async () => {
    const fixture = makeRepo("apply-blocked");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "a.txt", "one\ntwo\nthree\nfour\n");

    writeFileSync(join(fixture.repo, "b.txt"), "staged by the owner\n");
    git(fixture.repo, "add", "b.txt");
    let before = snapshot(fixture.repo);
    let result = await applyWorktreeMerge({ target, taskTitle: "x" });
    assert.deepEqual(result, { status: "blocked", blocking: [{ reason: "source_has_staged_changes", paths: ["b.txt"] }] });
    assert.deepEqual(snapshot(fixture.repo), before);

    git(fixture.repo, "restore", "--staged", "b.txt");
    git(fixture.repo, "checkout", "--", "b.txt");
    writeFileSync(join(fixture.repo, "a.txt"), "owner edit\n");
    before = snapshot(fixture.repo);
    result = await applyWorktreeMerge({ target, taskTitle: "x" });
    assert.deepEqual(result, { status: "blocked", blocking: [{ reason: "source_dirty_in_touched_paths", paths: ["a.txt"] }] });
    assert.deepEqual(snapshot(fixture.repo), before);

    git(fixture.repo, "checkout", "--", "a.txt");
    git(fixture.repo, "checkout", "-q", "-b", "feature-x");
    before = snapshot(fixture.repo);
    result = await applyWorktreeMerge({ target, taskTitle: "x" });
    assert.deepEqual(result, {
      status: "blocked", blocking: [{ reason: "source_not_on_base_branch", currentBranch: "feature-x" }],
    });
    assert.deepEqual(snapshot(fixture.repo), before);
    assert.equal(tryGit(fixture.repo, "rev-parse", "--verify", "-q", "refs/heads/main").ok, true);
  });

  it("does not commit the worktree when the merge is refused", async () => {
    const fixture = makeRepo("apply-nocommit");
    const target = await newWorktree(fixture);
    writeFileSync(join(target.worktreePath, "c.txt"), "c\n");
    git(fixture.repo, "checkout", "-q", "-b", "elsewhere");
    const tip = git(target.worktreePath, "rev-parse", "HEAD").trim();
    const result = await applyWorktreeMerge({ target, taskTitle: "x" });
    assert.equal(result.status, "blocked");
    assert.equal(git(target.worktreePath, "rev-parse", "HEAD").trim(), tip);
    assert.equal(existsSync(join(target.worktreePath, "c.txt")), true);
    assert.match(git(target.worktreePath, "status", "--porcelain"), /c\.txt/u);
  });

  it("returns failed(timeout) instead of throwing when git hangs, and a missing worktree as such", async () => {
    const fixture = makeRepo("apply-limits");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "x.txt", "x\n");
    const hang = join(fixture.root, "hang");
    writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(hang, 0o755);
    setGitExecutableForTests(hang);
    assert.deepEqual(
      await applyWorktreeMerge({ target, taskTitle: "x", limits: { applyTimeoutMs: 250 } }),
      { status: "failed", reason: "timeout" },
    );
    setGitExecutableForTests(undefined);
    rmSync(target.worktreePath, { recursive: true, force: true });
    assert.deepEqual(await applyWorktreeMerge({ target, taskTitle: "x" }), { status: "worktree_missing" });
  });
});

describe("discardGitWorktree", () => {
  it("removes the worktree, even with uncommitted files, and only the recorded guild branch", async () => {
    const fixture = makeRepo("discard");
    const target = await newWorktree(fixture);
    commitInWorktree(target, "kept-only-in-branch.txt", "x\n");
    writeFileSync(join(target.worktreePath, "dirty.txt"), "dirty\n");
    // Branches that must survive: a user's own guild-looking branch and a normal one.
    git(fixture.repo, "branch", "guild/made-by-the-owner");
    git(fixture.repo, "branch", "feature/keep");
    const before = snapshot(fixture.repo);

    const result = await discardGitWorktree({ target, worktreesRoot: fixture.worktrees });
    assert.deepEqual(result, { status: "discarded", removedWorktree: true, removedBranch: true });
    assert.equal(existsSync(target.worktreePath), false);
    assert.doesNotMatch(git(fixture.repo, "worktree", "list"), /task-11111111/u);
    const refs = git(fixture.repo, "for-each-ref", "--format=%(refname)", "refs/heads").trim().split("\n").sort();
    assert.deepEqual(refs, ["refs/heads/feature/keep", "refs/heads/guild/made-by-the-owner", "refs/heads/main"]);
    const after = snapshot(fixture.repo);
    assert.equal(after.head, before.head);
    assert.equal(after.index, before.index);
    assert.equal(after.stash, before.stash);
    assert.equal(after.status, before.status);
  });

  it("cleans up after the owner deleted the directory by hand", async () => {
    const fixture = makeRepo("discard-missing");
    const target = await newWorktree(fixture);
    rmSync(target.worktreePath, { recursive: true, force: true });
    const result = await discardGitWorktree({ target, worktreesRoot: fixture.worktrees });
    assert.deepEqual(result, { status: "discarded", removedWorktree: true, removedBranch: true });
    assert.doesNotMatch(git(fixture.repo, "worktree", "list"), /task-11111111/u);
    assert.equal(tryGit(fixture.repo, "rev-parse", "--verify", "-q", `refs/heads/${target.branch}`).ok, false);
  });

  it("does not prune worktrees the owner made", async () => {
    const fixture = makeRepo("discard-others");
    const target = await newWorktree(fixture);
    const mine = join(fixture.root, "my-own-worktree");
    git(fixture.repo, "worktree", "add", "-q", "-b", "mine", mine);
    // Pretend the owner's worktree is on an unplugged drive: its folder is missing.
    const stash = join(fixture.root, "unplugged");
    execFileSync("mv", [mine, stash]);
    rmSync(target.worktreePath, { recursive: true, force: true });
    await discardGitWorktree({ target, worktreesRoot: fixture.worktrees });
    assert.match(git(fixture.repo, "worktree", "list"), /my-own-worktree/u, "git worktree prune would have dropped it");
    assert.equal(tryGit(fixture.repo, "rev-parse", "--verify", "-q", "refs/heads/mine").ok, true);
  });

  it("refuses a branch that is not a guild branch and a directory outside the worktrees root", async () => {
    const fixture = makeRepo("discard-refuse");
    const target = await newWorktree(fixture);
    assert.deepEqual(
      await discardGitWorktree({ target: { ...target, branch: "main" }, worktreesRoot: fixture.worktrees }),
      { status: "refused", reason: "invalid_target" },
    );
    const outside = temporaryDirectory("outside");
    writeFileSync(join(outside, "precious.txt"), "do not delete\n");
    assert.deepEqual(
      await discardGitWorktree({ target: { ...target, worktreePath: outside }, worktreesRoot: fixture.worktrees }),
      { status: "refused", reason: "invalid_target" },
    );
    assert.deepEqual(
      await discardGitWorktree({ target: { ...target, worktreePath: fixture.worktrees }, worktreesRoot: fixture.worktrees }),
      { status: "refused", reason: "invalid_target" },
    );
    assert.deepEqual(
      await discardGitWorktree({ target: { ...target, worktreePath: fixture.repo }, worktreesRoot: fixture.worktrees }),
      { status: "refused", reason: "invalid_target" },
    );
    // A symlink inside the root that points out of it.
    const link = join(fixture.worktrees, "sneaky");
    symlinkSync(outside, link);
    assert.deepEqual(
      await discardGitWorktree({ target: { ...target, worktreePath: link }, worktreesRoot: fixture.worktrees }),
      { status: "refused", reason: "invalid_target" },
    );
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "do not delete\n");
    assert.equal(existsSync(target.worktreePath), true, "the real worktree was not touched either");
    assert.equal(tryGit(fixture.repo, "rev-parse", "--verify", "-q", `refs/heads/${target.branch}`).ok, true);
  });

  it("removes an orphaned worktree directory when the source repository is gone", async () => {
    const fixture = makeRepo("discard-orphan");
    const target = await newWorktree(fixture);
    rmSync(fixture.repo, { recursive: true, force: true });
    const result = await discardGitWorktree({ target, worktreesRoot: fixture.worktrees });
    assert.deepEqual(result, { status: "discarded", removedWorktree: true, removedBranch: false });
    assert.equal(existsSync(target.worktreePath), false);
    assert.equal(existsSync(fixture.worktrees), true, "only the task's own directory goes");
  });

  it("returns a failure instead of throwing when git is not available", async () => {
    const fixture = makeRepo("discard-nogit");
    const target = await newWorktree(fixture);
    setGitExecutableForTests(join(fixture.root, "absent"));
    assert.deepEqual(
      await discardGitWorktree({ target, worktreesRoot: fixture.worktrees }),
      { status: "failed", reason: "git_unavailable" },
    );
    assert.equal(existsSync(target.worktreePath), true, "nothing was removed behind git's back");
  });
});
