import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  captureCheckpoint,
  captureCurrentTree,
  checkpointRef,
  isCheckpointRef,
  isSafeRelativePath,
  planFileRewind,
  readFileDiff,
  restoreFromCheckpoint,
  safeRefSegment,
  setGitExecutableForTests,
  summarizeDiff,
} from "./git-checkpoints.js";

const cleanup: string[] = [];

afterEach(() => {
  setGitExecutableForTests(undefined);
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `guild-gc-${label}-`));
  cleanup.push(path);
  // macOS tmpdir is a symlink; git reports real paths.
  return execFileSync("node", ["-e", "console.log(require('fs').realpathSync(process.argv[1]))", path])
    .toString().trim();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Owner",
      GIT_AUTHOR_EMAIL: "owner@example.test",
      GIT_COMMITTER_NAME: "Owner",
      GIT_COMMITTER_EMAIL: "owner@example.test",
    },
  });
}

function write(root: string, path: string, content: string | Buffer): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

function repository(label: string, files: Record<string, string> = {
  "a.txt": "alpha\nbeta\ngamma\n",
  "b.txt": "bravo\n",
  "keep.txt": "keep me\n",
  ".gitignore": "ignored.log\nbuild/\n",
}): string {
  const root = temporaryDirectory(label);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Owner");
  git(root, "config", "user.email", "owner@example.test");
  git(root, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

/** Everything about the repository a checkpoint must not disturb. */
function userState(root: string): Readonly<Record<"indexBytes" | "staged" | "cachedDiff" | "status" | "head" | "branches" | "stash" | "reflogHead" | "lock", string>> {
  const indexFile = join(root, ".git", "index");
  return {
    indexBytes: existsSync(indexFile)
      ? createHash("sha256").update(readFileSync(indexFile)).digest("hex")
      : "no-index",
    staged: git(root, "ls-files", "-s"),
    cachedDiff: git(root, "diff", "--cached"),
    status: git(root, "status", "--porcelain=v2", "--untracked-files=all"),
    head: git(root, "rev-parse", "HEAD").trim(),
    branches: git(root, "for-each-ref", "refs/heads", "refs/tags", "refs/stash", "refs/remotes"),
    stash: git(root, "stash", "list"),
    reflogHead: existsSync(join(root, ".git", "logs", "HEAD"))
      ? readFileSync(join(root, ".git", "logs", "HEAD"), "utf8")
      : "",
    lock: existsSync(join(root, ".git", "index.lock")) ? "locked" : "free",
  };
}

function checkpointDirectories(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("guild-checkpoint-")).sort();
}

describe("git checkpoints [F2]", () => {
  it("captures tracked edits, untracked files and deletions but not ignored files, and leaves the user's git state untouched", async () => {
    const root = repository("capture");
    // The user's own work in progress: a staged new file, a partly staged edit, a stash.
    write(root, "c.txt", "stash me\n");
    git(root, "add", "c.txt");
    git(root, "stash", "push", "-q", "-m", "owner stash");
    write(root, "staged-new.txt", "staged by the user\n");
    git(root, "add", "staged-new.txt");
    write(root, "a.txt", "alpha\nBETA\ngamma\n");
    git(root, "add", "a.txt");
    write(root, "a.txt", "alpha\nBETA\ngamma\nunstaged tail\n");
    // The agent's work: an untracked file, a deletion, an ignored file.
    write(root, "fresh/new.txt", "brand new\n");
    git(root, "rm", "-q", "--cached", "b.txt");
    rmSync(join(root, "b.txt"));
    write(root, "ignored.log", "noise\n");
    write(root, "build/out.js", "generated\n");

    const before = userState(root);
    const directoriesBefore = checkpointDirectories();
    const captured = await captureCheckpoint({ cwd: root, taskId: "task-1", ordinal: 1 });
    assert.equal(captured.status, "captured");
    if (captured.status !== "captured") return;
    assert.equal(captured.ref, "refs/guild/checkpoints/task-1/1");

    const files = git(root, "ls-tree", "-r", "--name-only", captured.ref).split("\n").filter(Boolean);
    assert.deepEqual(files.sort(), [".gitignore", "a.txt", "fresh/new.txt", "keep.txt", "staged-new.txt"]);
    assert.equal(git(root, "show", `${captured.ref}:a.txt`), "alpha\nBETA\ngamma\nunstaged tail\n",
      "the checkpoint holds the working tree, not the index");
    assert.equal(git(root, "log", "-1", "--format=%an <%ae> | %cn <%ce> | %P", captured.ref).trim(),
      "Guild <guild@localhost> | Guild <guild@localhost> |");

    const after = userState(root);
    assert.deepEqual(after, before, "index bytes, staged content, status, HEAD, branches, tags, stash and reflog are unchanged");
    assert.equal(git(root, "stash", "list").includes("owner stash"), true);
    assert.deepEqual(
      git(root, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean).filter((name) => name.startsWith("refs/guild/")),
      ["refs/guild/checkpoints/task-1/1"],
    );
    assert.deepEqual(checkpointDirectories(), directoriesBefore, "the private index directory is removed");
  });

  it("sees an edit that keeps a file's size and lands within the second git last recorded for it", async () => {
    // git's stat cache can miss such an edit; the copied index is dated so git re-reads the content.
    for (let round = 0; round < 12; round += 1) {
      const root = repository(`racy-${round}`, { "dir/c.txt": "c original\n", "a.txt": "a original\n" });
      const start = await captureCheckpoint({ cwd: root, taskId: "racy", ordinal: 1 });
      write(root, "user-staged.txt", "staged\n");
      git(root, "add", "user-staged.txt");
      await captureCheckpoint({ cwd: root, taskId: "racy", ordinal: 2 });
      write(root, "dir/c.txt", "c by run 2\n");
      const end = await captureCheckpoint({ cwd: root, taskId: "racy", ordinal: 3 });
      if (start.status !== "captured" || end.status !== "captured") return assert.fail("capture");
      const summary = await summarizeDiff({ cwd: root, fromRef: start.ref, toRef: end.ref });
      assert.deepEqual(summary.status === "ok" && summary.summary.files.map((file) => file.path).sort(),
        ["dir/c.txt", "user-staged.txt"], `round ${round}`);
    }
  });

  it("captures an unborn repository, a repository during an index.lock, and parallel captures", async () => {
    const unborn = temporaryDirectory("unborn");
    git(unborn, "init", "-q", "-b", "main");
    write(unborn, "first.txt", "hello\n");
    const first = await captureCheckpoint({ cwd: unborn, taskId: "t", ordinal: 1 });
    assert.equal(first.status, "captured");
    if (first.status === "captured") {
      assert.deepEqual(git(unborn, "ls-tree", "-r", "--name-only", first.ref).trim().split("\n"), ["first.txt"]);
    }

    const root = repository("lock");
    writeFileSync(join(root, ".git", "index.lock"), "");
    const locked = await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 1 });
    assert.equal(locked.status, "captured", "a capture needs no lock on the user's index");
    assert.equal(existsSync(join(root, ".git", "index.lock")), true, "and never removes a lock it did not take");
    rmSync(join(root, ".git", "index.lock"));

    write(root, "p.txt", "parallel\n");
    const results = await Promise.all([1, 2, 3, 4].map((ordinal) =>
      captureCheckpoint({ cwd: root, taskId: "t", ordinal })));
    assert.deepEqual(results.map((result) => result.status), ["captured", "captured", "captured", "captured"]);
    assert.deepEqual(
      git(root, "for-each-ref", "--format=%(refname)", "refs/guild").split("\n").filter(Boolean).sort(),
      [1, 2, 3, 4].map((ordinal) => `refs/guild/checkpoints/t/${ordinal}`),
    );
  });

  it("reports unavailable for a folder that is not a git work tree, a missing git, and a timeout", async () => {
    const plain = temporaryDirectory("plain");
    write(plain, "x.txt", "x\n");
    assert.deepEqual(await captureCheckpoint({ cwd: plain, taskId: "t", ordinal: 1 }),
      { status: "unavailable", reason: "not_a_git_repo" });
    assert.deepEqual(await captureCheckpoint({ cwd: join(plain, "missing"), taskId: "t", ordinal: 1 }),
      { status: "unavailable", reason: "not_a_git_repo" });
    const root = repository("inside-dot-git");
    assert.deepEqual(await captureCheckpoint({ cwd: join(root, ".git"), taskId: "t", ordinal: 1 }),
      { status: "unavailable", reason: "not_a_git_repo" });

    setGitExecutableForTests(join(plain, "no-such-git"));
    assert.deepEqual(await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 1 }),
      { status: "unavailable", reason: "git_unavailable" });

    const marker = join(plain, "pid");
    const hang = join(plain, "git-hang.sh");
    writeFileSync(hang, `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 30\n`);
    chmodSync(hang, 0o755);
    setGitExecutableForTests(hang);
    const started = Date.now();
    const result = await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 1, limits: { timeoutMs: 1_500 } });
    assert.deepEqual(result, { status: "unavailable", reason: "timeout" });
    assert.equal(Date.now() - started < 8_000, true);
    for (let wait = 0; wait < 40 && !existsSync(marker); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pid = Number(readFileSync(marker, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), /ESRCH/u, "the hung git process was killed");
  });

  it("refuses to add too many or too large untracked files and creates no ref when it does", async () => {
    const root = repository("guards");
    for (let index = 0; index < 5; index += 1) write(root, `bulk/f${index}.txt`, "x\n");
    assert.deepEqual(
      await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 1, limits: { maxUntrackedFiles: 3 } }),
      { status: "unavailable", reason: "too_many_files" },
    );
    rmSync(join(root, "bulk"), { recursive: true });
    write(root, "big.bin", Buffer.alloc(4_096, 1));
    assert.deepEqual(
      await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 1, limits: { maxUntrackedFileBytes: 1_024 } }),
      { status: "unavailable", reason: "too_large" },
    );
    assert.deepEqual(
      await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 1, limits: { maxUntrackedBytes: 2_048 } }),
      { status: "unavailable", reason: "too_large" },
    );
    assert.equal(git(root, "for-each-ref", "refs/guild").trim(), "");
    // An ignored bulk directory costs nothing: the guard counts only what would be added.
    write(root, ".gitignore", "ignored.log\nbuild/\nbig.bin\n");
    assert.equal((await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 1, limits: { maxUntrackedFileBytes: 1_024 } })).status, "captured");
  });

  it("keeps task ids safe as ref segments and rejects bad ordinals and foreign refs", async () => {
    assert.equal(safeRefSegment("task-1b2c"), "task-1b2c");
    for (const odd of ["task with space", "a/b", "..", "x..y", "name.lock", ".hidden", "ünï", "a".repeat(101), "x:y"]) {
      const segment = safeRefSegment(odd);
      assert.match(segment ?? "", /^x-[0-9a-f]{32}$/u, odd);
      assert.equal(safeRefSegment(odd), segment, "stable");
    }
    assert.equal(safeRefSegment(""), undefined);
    assert.equal(checkpointRef("t", 0), undefined);
    assert.equal(checkpointRef("t", 1.5), undefined);
    assert.equal(checkpointRef("t", 7), "refs/guild/checkpoints/t/7");
    assert.equal(isCheckpointRef("refs/guild/checkpoints/t/7"), true);
    for (const foreign of ["refs/heads/main", "HEAD", "refs/guild/checkpoints/t/0", "refs/guild/checkpoints/t/7/x", "-p", "--output=/tmp/x", "refs/guild/checkpoints/../x/1"]) {
      assert.equal(isCheckpointRef(foreign), false, foreign);
    }
    const root = repository("odd-id");
    const captured = await captureCheckpoint({ cwd: root, taskId: "weird id/with slash", ordinal: 2 });
    assert.equal(captured.status, "captured");
    if (captured.status === "captured") assert.match(captured.ref, /^refs\/guild\/checkpoints\/x-[0-9a-f]{32}\/2$/u);
    assert.deepEqual(await captureCheckpoint({ cwd: root, taskId: "t", ordinal: 0 }),
      { status: "unavailable", reason: "unsafe_task_id" });
  });

  it("summarizes added, modified, deleted, renamed and binary files with totals and a capped list", async () => {
    const root = repository("summary", {
      "a.txt": "one\ntwo\nthree\nfour\n",
      "gone.txt": "bye\nbye\n",
      "old-name.txt": "stable content line 1\nstable content line 2\nstable content line 3\nstable content line 4\n",
      "keep.txt": "keep\n",
      "img.bin": "BIN\0\u0001\u0002",
      ".gitignore": "ignored.log\n",
    });
    const start = await captureCheckpoint({ cwd: root, taskId: "s", ordinal: 1 });
    write(root, "a.txt", "one\nTWO\nthree\nfour\nfive\n");
    rmSync(join(root, "gone.txt"));
    rmSync(join(root, "old-name.txt"));
    write(root, "renamed/new-name.txt", "stable content line 1\nstable content line 2\nstable content line 3\nstable content line 4\n");
    write(root, "added.txt", "a\nb\n");
    write(root, "img.bin", Buffer.from([0, 1, 2, 3, 4, 0, 5]));
    write(root, "ignored.log", "ignored\n");
    const end = await captureCheckpoint({ cwd: root, taskId: "s", ordinal: 2 });
    assert.equal(start.status === "captured" && end.status === "captured", true);
    if (start.status !== "captured" || end.status !== "captured") return;

    const summary = await summarizeDiff({ cwd: root, fromRef: start.ref, toRef: end.ref });
    assert.equal(summary.status, "ok");
    if (summary.status !== "ok") return;
    const byPath = Object.fromEntries(summary.summary.files.map((file) => [file.path, file]));
    assert.deepEqual(byPath["a.txt"], { path: "a.txt", status: "M", adds: 2, dels: 1 });
    assert.deepEqual(byPath["added.txt"], { path: "added.txt", status: "A", adds: 2, dels: 0 });
    assert.deepEqual(byPath["gone.txt"], { path: "gone.txt", status: "D", adds: 0, dels: 2 });
    assert.deepEqual(byPath["renamed/new-name.txt"], {
      path: "renamed/new-name.txt", oldPath: "old-name.txt", status: "R", adds: 0, dels: 0,
    });
    assert.deepEqual(byPath["img.bin"], { path: "img.bin", status: "M", adds: null, dels: null });
    assert.equal(byPath["ignored.log"], undefined);
    assert.equal(summary.summary.filesTotal, 5);
    assert.equal(summary.summary.adds, 4);
    assert.equal(summary.summary.dels, 3);
    assert.equal(summary.summary.truncated, false);

    const capped = await summarizeDiff({ cwd: root, fromRef: start.ref, toRef: end.ref, maxFiles: 2 });
    assert.equal(capped.status === "ok" && capped.summary.files.length, 2);
    assert.equal(capped.status === "ok" && capped.summary.truncated, true);
    assert.equal(capped.status === "ok" && capped.summary.filesTotal, 5);
    assert.equal(capped.status === "ok" && capped.summary.adds, 4, "totals cover every file, not just the listed ones");

    assert.equal((await summarizeDiff({ cwd: root, fromRef: "refs/heads/main", toRef: end.ref })).status, "unavailable");
    assert.equal((await summarizeDiff({ cwd: root, fromRef: "--output=/tmp/pwn", toRef: end.ref })).status, "unavailable");
  });

  it("scopes a checkpoint to the task folder inside a larger repository", async () => {
    const root = repository("subdir", { "top.txt": "top\n", "pkg/inner.txt": "inner\n", "other/x.txt": "x\n" });
    const cwd = join(root, "pkg");
    const start = await captureCheckpoint({ cwd, taskId: "sub", ordinal: 1 });
    write(root, "top.txt", "top changed outside the task folder\n");
    write(root, "pkg/inner.txt", "inner changed\n");
    write(root, "pkg/added.txt", "added\n");
    const end = await captureCheckpoint({ cwd, taskId: "sub", ordinal: 2 });
    assert.equal(start.status === "captured" && end.status === "captured", true);
    if (start.status !== "captured" || end.status !== "captured") return;
    const summary = await summarizeDiff({ cwd, fromRef: start.ref, toRef: end.ref });
    assert.equal(summary.status, "ok");
    if (summary.status !== "ok") return;
    assert.deepEqual(summary.summary.files.map((file) => [file.path, file.status]).sort(), [
      ["added.txt", "A"], ["inner.txt", "M"],
    ], "paths are relative to the task folder and the file outside it is not part of the Run");
  });

  it("returns a bounded unified diff for one file, flags binary and truncated output, and refuses unsafe paths", async () => {
    const root = repository("filediff", { "a.txt": "line1\nline2\nline3\n", "p.bin": "x" });
    const start = await captureCheckpoint({ cwd: root, taskId: "d", ordinal: 1 });
    write(root, "a.txt", `line1\nCHANGED\nline3\n${"padding\n".repeat(500)}`);
    write(root, "p.bin", Buffer.from([0, 255, 0, 255, 0]));
    const end = await captureCheckpoint({ cwd: root, taskId: "d", ordinal: 2 });
    if (start.status !== "captured" || end.status !== "captured") return assert.fail("capture");

    const diff = await readFileDiff({ cwd: root, fromRef: start.ref, toRef: end.ref, path: "a.txt" });
    assert.equal(diff.status, "ok");
    if (diff.status === "ok") {
      assert.match(diff.diff, /^diff --git a\/a\.txt b\/a\.txt/u);
      assert.match(diff.diff, /^-line2$/mu);
      assert.match(diff.diff, /^\+CHANGED$/mu);
      assert.equal(diff.binary, false);
      assert.equal(diff.truncated, false);
    }
    const small = await readFileDiff({ cwd: root, fromRef: start.ref, toRef: end.ref, path: "a.txt", maxBytes: 1_024 });
    assert.equal(small.status === "ok" && small.truncated, true);
    assert.equal(small.status === "ok" && small.diff.length <= 1_024, true);
    const binary = await readFileDiff({ cwd: root, fromRef: start.ref, toRef: end.ref, path: "p.bin" });
    assert.equal(binary.status === "ok" && binary.binary, true);
    for (const bad of ["../a.txt", "/etc/passwd", "a/../../x", "", "a\0b", "./a.txt"]) {
      const refused = await readFileDiff({ cwd: root, fromRef: start.ref, toRef: end.ref, path: bad });
      assert.deepEqual(refused, { status: "unavailable", reason: "invalid_path" }, JSON.stringify(bad));
    }
    // A path that looks like an option is only ever a pathspec after "--": it matches nothing.
    const optionLike = await readFileDiff({ cwd: root, fromRef: start.ref, toRef: end.ref, path: "--output=pwned" });
    assert.deepEqual(optionLike, { status: "ok", diff: "", binary: false, truncated: false });
    assert.equal(existsSync(join(root, "pwned")), false);
    assert.equal(isSafeRelativePath("sub/dir/file.txt"), true);
    assert.equal(isSafeRelativePath("sub//file.txt"), false);
  });

  it("plans and performs a restore of exactly the files the Runs changed, keeping everything else", async () => {
    const root = repository("rewind", {
      "a.txt": "a original\n",
      "b.txt": "b original\n",
      "keep.txt": "keep original\n",
      "dir/c.txt": "c original\n",
    });
    // Run 1 starts here.
    const start1 = await captureCheckpoint({ cwd: root, taskId: "r", ordinal: 1 });
    write(root, "a.txt", "a by run 1\n");
    rmSync(join(root, "b.txt"));
    write(root, "created/deep/new.txt", "created by run 1\n");
    write(root, "new-top.txt", "created by run 1\n");
    const end1 = await captureCheckpoint({ cwd: root, taskId: "r", ordinal: 2 });
    // The user works between Runs: an unrelated edit and a staged change that must survive.
    write(root, "keep.txt", "keep edited by the user\n");
    write(root, "user-staged.txt", "staged by the user\n");
    git(root, "add", "user-staged.txt");
    // Run 2 starts here.
    const start2 = await captureCheckpoint({ cwd: root, taskId: "r", ordinal: 3 });
    write(root, "a.txt", "a by run 2\n");
    write(root, "dir/c.txt", "c by run 2\n");
    write(root, "run2-only.txt", "run 2\n");
    const end2 = await captureCheckpoint({ cwd: root, taskId: "r", ordinal: 4 });
    // The user edits a file Run 1 created, after both Runs.
    write(root, "new-top.txt", "created by run 1, then edited by the user\n");
    if (start1.status !== "captured" || end1.status !== "captured" || start2.status !== "captured" || end2.status !== "captured") {
      return assert.fail("capture");
    }

    const planned = await planFileRewind({
      cwd: root,
      runs: [
        { startRef: start1.ref, endRef: end1.ref },
        { startRef: start2.ref, endRef: end2.ref },
      ],
    });
    assert.equal(planned.status, "ok");
    if (planned.status !== "ok") return;
    assert.deepEqual([...planned.plan.restore], ["a.txt", "b.txt", "dir/c.txt"]);
    assert.deepEqual([...planned.plan.remove], ["created/deep/new.txt", "new-top.txt", "run2-only.txt"]);
    assert.deepEqual(planned.plan.conflicts.map((conflict) => [conflict.path, conflict.reason]), [
      ["a.txt", "later_run"],
      ["dir/c.txt", "later_run"],
      ["new-top.txt", "modified_after_run"],
      ["run2-only.txt", "later_run"],
    ]);
    assert.equal(planned.plan.restore.includes("keep.txt"), false);
    assert.equal(planned.plan.restore.includes("user-staged.txt"), false);

    const before = userState(root);
    const result = await restoreFromCheckpoint({
      cwd: root,
      sourceRef: start1.ref,
      restore: planned.plan.restore,
      remove: planned.plan.remove,
    });
    assert.deepEqual(result.failed, []);
    assert.deepEqual([...result.restored].sort(), ["a.txt", "b.txt", "dir/c.txt"]);
    assert.deepEqual([...result.removed].sort(), ["created/deep/new.txt", "new-top.txt", "run2-only.txt"]);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a original\n");
    assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "b original\n");
    assert.equal(readFileSync(join(root, "dir/c.txt"), "utf8"), "c original\n");
    assert.equal(existsSync(join(root, "new-top.txt")), false);
    assert.equal(existsSync(join(root, "created")), false, "directories the Run created are removed once empty");
    assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "keep edited by the user\n", "unrelated user edits survive");
    assert.equal(readFileSync(join(root, "user-staged.txt"), "utf8"), "staged by the user\n");
    const after = userState(root);
    assert.equal(after.cachedDiff.includes("user-staged.txt"), true);
    assert.equal(after.staged.includes("user-staged.txt"), true, "the user's staged file stays staged");
    assert.equal(after.head, before.head);
    assert.equal(after.branches, before.branches);
    assert.equal(after.stash, before.stash);
    // The restored files show up as ordinary unstaged changes against the index, not as staged ones.
    assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "user-staged.txt");
  });

  it("plans no conflicts for an untouched tree and no work for a Run that changed nothing", async () => {
    const root = repository("quiet");
    const start = await captureCheckpoint({ cwd: root, taskId: "q", ordinal: 1 });
    write(root, "a.txt", "changed by the Run\n");
    const end = await captureCheckpoint({ cwd: root, taskId: "q", ordinal: 2 });
    if (start.status !== "captured" || end.status !== "captured") return assert.fail("capture");
    const plan = await planFileRewind({ cwd: root, runs: [{ startRef: start.ref, endRef: end.ref }] });
    assert.deepEqual(plan.status === "ok" && { restore: plan.plan.restore, remove: plan.plan.remove, conflicts: plan.plan.conflicts },
      { restore: ["a.txt"], remove: [], conflicts: [] });
    const unchanged = await planFileRewind({ cwd: root, runs: [{ startRef: start.ref, endRef: start.ref }] });
    assert.deepEqual(unchanged.status === "ok" && { restore: unchanged.plan.restore, remove: unchanged.plan.remove },
      { restore: [], remove: [] });
    // A change the user reverted by hand leaves nothing to do.
    write(root, "a.txt", "alpha\nbeta\ngamma\n");
    const reverted = await planFileRewind({ cwd: root, runs: [{ startRef: start.ref, endRef: end.ref }] });
    assert.deepEqual(reverted.status === "ok" && reverted.plan.restore, []);
    assert.equal((await planFileRewind({ cwd: root, runs: [] })).status, "unavailable");
  });

  it("never restores or deletes outside the task folder and reports per-file failures", async () => {
    const root = repository("escape");
    const outside = temporaryDirectory("outside");
    write(outside, "victim.txt", "must survive\n");
    symlinkSync(outside, join(root, "link"));
    const start = await captureCheckpoint({ cwd: root, taskId: "e", ordinal: 1 });
    if (start.status !== "captured") return assert.fail("capture");
    write(root, "plain.txt", "added\n");
    mkdirSync(join(root, "adir"));

    const result = await restoreFromCheckpoint({
      cwd: root,
      sourceRef: start.ref,
      restore: ["../outside.txt", "/etc/hosts", "does-not-exist.txt"],
      remove: ["link/victim.txt", "../x", "adir", "plain.txt", "ghost.txt"],
    });
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf8"), "must survive\n");
    const failures = Object.fromEntries(result.failed.map((failure) => [failure.path, failure.reason]));
    assert.equal(failures["../outside.txt"], "invalid_path");
    assert.equal(failures["/etc/hosts"], "invalid_path");
    assert.equal(failures["does-not-exist.txt"], "restore_failed");
    assert.equal(failures["link/victim.txt"], "invalid_path");
    assert.equal(failures["../x"], "invalid_path");
    assert.equal(failures["adir"], "is_directory");
    assert.deepEqual([...result.removed].sort(), ["ghost.txt", "plain.txt"]);
    assert.equal(existsSync(join(root, "plain.txt")), false);

    const badSource = await restoreFromCheckpoint({
      cwd: root, sourceRef: "refs/heads/main", restore: ["a.txt"], remove: [],
    });
    assert.deepEqual(badSource.failed, [{ path: "a.txt", reason: "invalid_source" }]);
  });

  it("captures the current tree without creating a ref", async () => {
    const root = repository("tree");
    write(root, "n.txt", "new\n");
    const tree = await captureCurrentTree({ cwd: root });
    assert.equal(tree.status, "captured");
    assert.equal(git(root, "for-each-ref", "refs/guild").trim(), "");
    assert.equal(tree.status === "captured" && git(root, "ls-tree", "--name-only", tree.tree).includes("n.txt"), true);
  });
});
