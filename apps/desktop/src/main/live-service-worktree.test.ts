import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, after, describe, it } from "node:test";
import type {
  DesktopBootstrapProjection,
  GuildGrokModel,
  GuildGrokReasoningEffort,
  RuntimeConfigOption,
  RuntimePromptTerminalPayload,
  TaskViewProjection,
} from "@guild/contracts";
import type {
  AcpV1AdapterSession,
  AcpV1AdapterSink,
  AcpV1DecodedUpdate,
  AcpV1InitializeResult,
  JsonRpcWriteReceipt,
  JsonValue,
  XaiExtensionOutcome,
} from "@guild/runtime-grok";
import {
  createLiveDesktopService,
  type RuntimeAdapterPort,
  type RuntimeFactory,
} from "./live-service.js";
import { toDesktopIpcFailure } from "./workspace-folder.js";

const services: { close(): Promise<void> }[] = [];
const cleanup: string[] = [];
const savedEnvironment: Record<string, string | undefined> = {};

before(() => {
  for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) savedEnvironment[name] = process.env[name];
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

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  // A git process the service started just before it closed can still be writing; retry the removal.
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(15);
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** What a scripted prompt may do: write into the folder the session runs in, or wait for the test. */
type PromptContext = Readonly<{ text: string; cwd: string; gate: Promise<void> }>;
type PromptScript = (context: PromptContext) => Promise<void>;

type Harness = Awaited<ReturnType<typeof startHarness>>;

async function startHarness(input: { git?: boolean; script?: PromptScript } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-live-worktree-")));
  cleanup.push(root);
  const workspace = join(root, "Workspace");
  await mkdir(workspace);
  if (input.git !== false) {
    git(workspace, "init", "-q", "-b", "main");
    git(workspace, "config", "user.name", "Owner");
    git(workspace, "config", "user.email", "owner@example.test");
    await writeFile(join(workspace, "a.txt"), "alpha\nbeta\n");
    await writeFile(join(workspace, "b.txt"), "bravo\n");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "initial");
  }
  const adapters: ScriptedAdapter[] = [];
  const factoryDirectories: string[] = [];
  const opened: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const options = {
    appVersion: "2.2.0-test",
    databasePath: join(root, "guild.sqlite3"),
    stagingRoot: join(root, "staging"),
    initialLocale: "en-US" as const,
    chooseWorkspace: async () => workspace,
    openWorkspaceFolder: async (path: string) => { opened.push(`folder:${path}`); },
    openWorkspaceTerminal: async (path: string) => { opened.push(`terminal:${path}`); },
    runtimeFactory: scriptedRuntimeFactory(input.script ?? (async () => undefined), gate, adapters, factoryDirectories),
  };
  let service = createLiveDesktopService(options);
  services.push(service);
  const selected = await service.chooseWorkspace();
  const workspaceId = selected.workspaces[0]!.workspaceId;
  return {
    root,
    workspace,
    workspaceId,
    options,
    adapters,
    factoryDirectories,
    opened,
    release,
    get service() { return service; },
    reopen: async () => {
      await service.close();
      services.splice(services.indexOf(service), 1);
      service = createLiveDesktopService(options);
      services.push(service);
      return service;
    },
    worktreePath: (taskId: string) => join(root, "worktrees", taskId),
    view: async (): Promise<TaskViewProjection> => (await service.bootstrap()).activeTask!,
    bootstrap: (): Promise<DesktopBootstrapProjection> => service.bootstrap(),
  };
}

async function isolatedTask(harness: Harness): Promise<TaskViewProjection> {
  const task = await harness.service.createTask(harness.workspaceId, "worktree");
  assert.ok(task.worktree !== undefined, "an isolated task has a worktree projection");
  return task;
}

async function runToCompletion(harness: Harness, taskId: string, text: string): Promise<void> {
  await harness.service.sendMessage(taskId as never, text);
  await until(async () => {
    const view = await harness.view();
    return view.task.activeRunState === "completed" && view.worktree?.measured === true;
  }, "the Run to finish");
  // The end checkpoint and the status refresh follow the terminal state.
  await pause(120);
}

function snapshot(repo: string) {
  const gitDir = git(repo, "rev-parse", "--absolute-git-dir").trim();
  return {
    head: git(repo, "rev-parse", "HEAD").trim(),
    index: createHash("sha256").update(readFileSync(join(gitDir, "index"))).digest("hex"),
    branches: git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
    stash: git(repo, "stash", "list"),
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

describe("live desktop service per-task worktrees [F3]", () => {
  it("runs an isolated task in its own worktree and leaves the workspace folder alone", async () => {
    const harness = await startHarness();
    const before = snapshot(harness.workspace);
    const task = await isolatedTask(harness);
    const taskId = task.task.taskId;

    const projection = task.worktree!;
    assert.equal(projection.status, "active");
    assert.match(projection.branch, /^guild\/task-[0-9a-f]{8}$/u);
    assert.equal(projection.baseBranch, "main");
    assert.equal(projection.measured, true, "the first projection already carries the numbers");
    assert.deepEqual([projection.ahead, projection.behind, projection.dirtyFiles], [0, 0, 0]);
    assert.equal(task.task.worktreeStatus, "active");

    await runToCompletion(harness, taskId, "hello");
    const worktree = harness.worktreePath(taskId);
    assert.deepEqual(harness.factoryDirectories, [worktree], "the process starts in the worktree");
    assert.deepEqual(harness.adapters[0]?.sessionFolders, [worktree], "and so does the session");
    assert.ok(existsSync(join(worktree, "a.txt")));
    assert.equal(git(worktree, "symbolic-ref", "--short", "HEAD").trim(), projection.branch);

    const sidebar = (await harness.bootstrap()).workspaces[0]!;
    assert.equal(sidebar.worktreeAvailable, true);
    assert.equal(sidebar.tasks.find((candidate) => candidate.taskId === taskId)?.worktreeStatus, "active");
    const after = snapshot(harness.workspace);
    assert.equal(after.head, before.head);
    assert.equal(after.index, before.index);
    assert.equal(after.stash, before.stash);
    assert.equal(after.status, before.status);
    // The only new thing in the repository is the task's branch.
    assert.deepEqual(
      after.branches.split("\n").filter((line) => line !== "" && !before.branches.includes(line)),
      [`refs/heads/${projection.branch} ${before.head}`],
    );
  });

  it("does not offer a worktree for a folder that is not a git repository, and refuses to make one", async () => {
    const harness = await startHarness({ git: false });
    assert.equal((await harness.bootstrap()).workspaces[0]!.worktreeAvailable, undefined);
    const before = (await harness.bootstrap()).workspaces[0]!.tasks.length;
    await assert.rejects(harness.service.createTask(harness.workspaceId, "worktree"), /^Error: worktree_not_a_git_repo$/u);
    assert.equal((await harness.bootstrap()).workspaces[0]!.tasks.length, before, "no task was left behind");
    assert.equal(existsSync(join(harness.root, "worktrees")), false);
    // The reason survives the IPC boundary; any other message is hidden.
    assert.equal(toDesktopIpcFailure(new Error("worktree_not_a_git_repo")).message, "worktree_not_a_git_repo");
    assert.equal(toDesktopIpcFailure(new Error("worktree_no_commits")).message, "worktree_no_commits");
    assert.equal(toDesktopIpcFailure(new Error("fatal: /Users/me/secret")).message, "guild_operation_failed");
    assert.equal(toDesktopIpcFailure(new Error("worktree_../../x")).message, "guild_operation_failed");
    // A normal task still works in the same folder.
    const plain = await harness.service.createTask(harness.workspaceId);
    assert.equal(plain.worktree, undefined);
  });

  it("refuses a repository without commits", async () => {
    const harness = await startHarness({ git: false });
    git(harness.workspace, "init", "-q", "-b", "main");
    await assert.rejects(harness.service.createTask(harness.workspaceId, "worktree"), /^Error: worktree_no_commits$/u);
  });

  it("shows the edits of a Run on the chip and keeps them out of the workspace folder", async () => {
    const harness = await startHarness({
      script: async ({ cwd }) => {
        await writeFile(join(cwd, "a.txt"), "alpha\nbeta\nedited by the agent\n");
        await writeFile(join(cwd, "new.txt"), "new\n");
      },
    });
    const task = await isolatedTask(harness);
    await runToCompletion(harness, task.task.taskId, "edit things");
    // The end checkpoint is captured asynchronously after the terminal; under load it can lag.
    let view = await harness.view();
    for (const deadline = Date.now() + 5_000; view.runCheckpoints?.[0]?.status === "capturing" && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      view = await harness.view();
    }
    assert.equal(view.worktree?.dirtyFiles, 2);
    assert.equal(view.worktree?.ahead, 0);
    assert.equal(readFileSync(join(harness.workspace, "a.txt"), "utf8"), "alpha\nbeta\n");
    assert.equal(existsSync(join(harness.workspace, "new.txt")), false);
    assert.equal(git(harness.workspace, "status", "--porcelain").trim(), "");
    // The Run's changed-file summary reads the worktree too.
    const checkpoint = view.runCheckpoints?.[0];
    assert.equal(checkpoint?.status, "captured");
    assert.deepEqual(checkpoint?.files?.map((file) => `${file.status} ${file.path}`).sort(), ["A new.txt", "M a.txt"]);
  });

  it("previews, then merges back with a merge commit once the Run has ended, and refuses while it runs", async () => {
    const harness = await startHarness({
      script: async ({ cwd, text, gate }) => {
        await writeFile(join(cwd, "feature.txt"), "feature\n");
        if (text === "hold") await gate;
      },
    });
    const task = await isolatedTask(harness);
    const taskId = task.task.taskId;
    await harness.service.sendMessage(taskId, "hold");
    await until(async () => (await harness.view()).task.activeRunState === "running", "a running Run");
    assert.deepEqual(await harness.service.previewWorktreeApply(taskId), { status: "refused", reason: "run_active" });
    assert.deepEqual(await harness.service.applyWorktree(taskId), { status: "refused", reason: "run_active" });
    assert.deepEqual(await harness.service.discardWorktree(taskId), { status: "refused", reason: "run_active" });
    assert.equal(git(harness.workspace, "log", "--oneline").trim().split("\n").length, 1, "nothing was merged");
    assert.ok(existsSync(harness.worktreePath(taskId)));

    harness.release();
    await until(async () => (await harness.view()).task.activeRunState === "completed", "the Run to end");
    await pause(150);

    const preview = await harness.service.previewWorktreeApply(taskId);
    assert.equal(preview.status, "ready");
    if (preview.status !== "ready") return;
    assert.equal(preview.summary.baseBranch, "main");
    assert.equal(preview.summary.uncommittedFiles, 1);
    assert.deepEqual(preview.summary.files.map((file) => `${file.status} ${file.path}`), ["A feature.txt"]);
    assert.equal(existsSync(join(harness.workspace, "feature.txt")), false, "a preview changes nothing");

    const applied = await harness.service.applyWorktree(taskId);
    assert.equal(applied.status, "applied");
    if (applied.status !== "applied") return;
    assert.equal(applied.baseBranch, "main");
    assert.equal(applied.committedUncommitted, true);
    assert.equal(applied.task.worktree?.status, "applied");
    assert.equal(applied.task.worktree?.dirtyFiles, 0);
    assert.equal(applied.task.worktree?.ahead, 0);
    assert.equal(readFileSync(join(harness.workspace, "feature.txt"), "utf8"), "feature\n");
    const parents = git(harness.workspace, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ");
    assert.equal(parents.length, 3);
    assert.match(applied.mergeCommit, /^[0-9a-f]{12}$/u);
    assert.equal(parents[0]?.startsWith(applied.mergeCommit), true);
    // The task keeps its worktree and can carry on; new work makes it active again.
    assert.equal((await harness.bootstrap()).workspaces[0]!.tasks[0]!.worktreeStatus, "applied");
  });

  it("returns conflicts and blocking reasons without changing the workspace", async () => {
    const harness = await startHarness({
      script: async ({ cwd }) => { await writeFile(join(cwd, "a.txt"), "alpha\nFROM AGENT\n"); },
    });
    const task = await isolatedTask(harness);
    const taskId = task.task.taskId;
    await runToCompletion(harness, taskId, "edit");
    await writeFile(join(harness.workspace, "a.txt"), "alpha\nFROM OWNER\n");
    git(harness.workspace, "commit", "-q", "-am", "owner edit");
    const before = snapshot(harness.workspace);

    const conflicted = await harness.service.previewWorktreeApply(taskId);
    assert.equal(conflicted.status, "conflicts");
    if (conflicted.status === "conflicts") assert.deepEqual(conflicted.conflicts, ["a.txt"]);
    const applied = await harness.service.applyWorktree(taskId);
    assert.deepEqual(applied, { status: "conflicts", conflicts: ["a.txt"] });
    assert.deepEqual(snapshot(harness.workspace), before);

    git(harness.workspace, "checkout", "-q", "-b", "other");
    const blocked = await harness.service.applyWorktree(taskId);
    assert.deepEqual(blocked, {
      status: "blocked", blocking: [{ reason: "source_not_on_base_branch", currentBranch: "other" }],
    });
    assert.equal(git(harness.workspace, "symbolic-ref", "--short", "HEAD").trim(), "other");
    assert.equal((await harness.view()).worktree?.status, "active");
  });

  it("discards after confirmation: the folder and the Guild branch go, the task stays readable and cannot send", async () => {
    const harness = await startHarness({
      script: async ({ cwd }) => { await writeFile(join(cwd, "scratch.txt"), "scratch\n"); },
    });
    const task = await isolatedTask(harness);
    const taskId = task.task.taskId;
    const branch = task.worktree!.branch;
    git(harness.workspace, "branch", "guild/owner-own-branch");
    await runToCompletion(harness, taskId, "write scratch");
    const before = snapshot(harness.workspace);

    const discarded = await harness.service.discardWorktree(taskId);
    assert.equal(discarded.status, "discarded");
    if (discarded.status !== "discarded") return;
    assert.equal(discarded.task.worktree?.status, "discarded");
    assert.equal(discarded.task.canSend, false);
    assert.ok(discarded.task.timeline.length > 0, "the conversation stays readable");
    assert.equal(existsSync(harness.worktreePath(taskId)), false);
    assert.equal(git(harness.workspace, "branch", "--list", branch).trim(), "");
    assert.match(git(harness.workspace, "branch", "--list", "guild/owner-own-branch"), /guild\/owner-own-branch/u);
    const after = snapshot(harness.workspace);
    assert.equal(after.head, before.head);
    assert.equal(after.index, before.index);
    assert.equal(after.stash, before.stash);
    assert.equal(after.status, before.status);

    await assert.rejects(harness.service.sendMessage(taskId, "more"), /task_worktree_discarded/u);
    assert.deepEqual(await harness.service.applyWorktree(taskId), { status: "refused", reason: "discarded" });
    assert.deepEqual(await harness.service.previewWorktreeApply(taskId), { status: "refused", reason: "discarded" });
    assert.equal((await harness.bootstrap()).workspaces[0]!.tasks[0]!.worktreeStatus, "discarded");
    await assert.rejects(harness.service.openWorktreeResource(taskId, "folder"), /worktree_unavailable/u);
  });

  it("reports a folder deleted by hand as missing, cannot send into it, and still lets the user clean up", async () => {
    const harness = await startHarness();
    const task = await isolatedTask(harness);
    const taskId = task.task.taskId;
    const branch = task.worktree!.branch;
    await runToCompletion(harness, taskId, "hello");
    await rm(harness.worktreePath(taskId), { recursive: true, force: true });
    await pause(1_100);
    await harness.service.openTask(taskId);
    await until(async () => (await harness.view()).worktree?.status === "missing", "the missing status");
    assert.equal((await harness.view()).worktree?.measured, false);
    assert.equal((await harness.view()).canSend, false);
    await assert.rejects(harness.service.sendMessage(taskId, "again"), /workspace_folder_missing/u);
    assert.deepEqual(await harness.service.previewWorktreeApply(taskId), { status: "refused", reason: "worktree_missing" });
    await assert.rejects(harness.service.openWorktreeResource(taskId, "terminal"), /worktree_unavailable/u);

    const discarded = await harness.service.discardWorktree(taskId);
    assert.equal(discarded.status, "discarded");
    assert.equal(git(harness.workspace, "branch", "--list", branch).trim(), "");
    assert.doesNotMatch(git(harness.workspace, "worktree", "list"), /worktrees/u);
  });

  it("removes the fresh worktree of an untouched task when the user starts another, and keeps one with work in it", async () => {
    const harness = await startHarness();
    const first = await isolatedTask(harness);
    const firstBranch = first.worktree!.branch;
    assert.ok(existsSync(harness.worktreePath(first.task.taskId)));
    const second = await isolatedTask(harness);
    assert.equal(existsSync(harness.worktreePath(first.task.taskId)), false, "the untouched worktree is gone");
    assert.equal(git(harness.workspace, "branch", "--list", firstBranch).trim(), "");
    assert.ok(existsSync(harness.worktreePath(second.task.taskId)));

    // The second task holds an uncommitted file: starting a third task must not delete it.
    await writeFile(join(harness.worktreePath(second.task.taskId), "mine.txt"), "important\n");
    const third = await harness.service.createTask(harness.workspaceId);
    assert.equal(third.worktree, undefined);
    assert.equal(readFileSync(join(harness.worktreePath(second.task.taskId), "mine.txt"), "utf8"), "important\n");
    assert.match(git(harness.workspace, "branch", "--list", second.worktree!.branch), /guild\/task-/u);
    const sidebar = (await harness.bootstrap()).workspaces[0]!.tasks;
    assert.equal(
      sidebar.find((candidate) => candidate.taskId === second.task.taskId)?.title,
      second.worktree!.branch,
      "the kept task is visible, titled with its branch",
    );
  });

  it("keeps working in the same worktree after a restart", async () => {
    const harness = await startHarness();
    const task = await isolatedTask(harness);
    const taskId = task.task.taskId;
    await runToCompletion(harness, taskId, "first");
    const reopened = await harness.reopen();
    const view = await reopened.openTask(taskId);
    assert.equal(view.worktree?.branch, task.worktree!.branch);
    assert.equal(view.worktree?.status, "active");
    await reopened.sendMessage(taskId, "second");
    await until(async () => harness.factoryDirectories.length === 2, "a second process");
    assert.deepEqual(harness.factoryDirectories, [harness.worktreePath(taskId), harness.worktreePath(taskId)]);
    assert.ok(harness.adapters[1]?.sessionFolders.every((folder) => folder === harness.worktreePath(taskId)));
  });

  it("opens the worktree folder or a terminal in it, and only that", async () => {
    const harness = await startHarness();
    const task = await isolatedTask(harness);
    const taskId = task.task.taskId;
    // A task with a message is a real task; starting another one leaves it open to come back to.
    await runToCompletion(harness, taskId, "hi");
    await harness.service.openWorktreeResource(taskId, "folder");
    await harness.service.openWorktreeResource(taskId, "terminal");
    assert.deepEqual(harness.opened, [`folder:${harness.worktreePath(taskId)}`, `terminal:${harness.worktreePath(taskId)}`]);
    const plain = await harness.service.createTask(harness.workspaceId);
    await assert.rejects(harness.service.openWorktreeResource(plain.task.taskId, "folder"), /worktree_unavailable/u);
    // The existing workbench buttons follow the task's folder too.
    await harness.service.openTask(taskId);
    harness.opened.length = 0;
    await harness.service.openTaskResource(taskId, "folder");
    assert.deepEqual(harness.opened, [`folder:${harness.worktreePath(taskId)}`]);
  });

  it("scopes a workspace sub-folder to the same sub-folder of the worktree", async () => {
    const harness = await startHarness({ git: false });
    git(harness.workspace, "init", "-q", "-b", "main");
    git(harness.workspace, "config", "user.name", "Owner");
    git(harness.workspace, "config", "user.email", "owner@example.test");
    await mkdir(join(harness.workspace, "pkg", "app"), { recursive: true });
    await writeFile(join(harness.workspace, "pkg", "app", "main.ts"), "export {};\n");
    git(harness.workspace, "add", "-A");
    git(harness.workspace, "commit", "-q", "-m", "initial");
    const sub = join(harness.workspace, "pkg", "app");
    const selected = await createLiveDesktopService({
      ...harness.options,
      databasePath: join(harness.root, "second.sqlite3"),
      chooseWorkspace: async () => sub,
    });
    services.push(selected);
    const workspaceId = (await selected.chooseWorkspace()).workspaces[0]!.workspaceId;
    const task = await selected.createTask(workspaceId, "worktree");
    await selected.sendMessage(task.task.taskId, "hi");
    await until(() => harness.factoryDirectories.length === 1, "the process");
    assert.deepEqual(harness.factoryDirectories, [join(harness.worktreePath(task.task.taskId), "pkg", "app")]);
  });
});

function scriptedRuntimeFactory(
  script: PromptScript,
  gate: Promise<void>,
  adapters: ScriptedAdapter[],
  directories: string[],
): RuntimeFactory {
  return async ({ adapterEpoch, sink, workingDirectory }) => {
    directories.push(workingDirectory);
    const adapter = new ScriptedAdapter(adapterEpoch, sink, script, gate, workingDirectory);
    adapters.push(adapter);
    return { runtimeVersion: "Scripted Grok 1.0", adapter };
  };
}

class ScriptedAdapter implements RuntimeAdapterPort {
  state = "created";
  readonly sessionFolders: string[] = [];
  private promptSequence = 0;
  private readonly sessionId = "scripted-session";

  constructor(
    private readonly adapterEpoch: number,
    private readonly sink: AcpV1AdapterSink,
    private readonly script: PromptScript,
    private readonly gate: Promise<void>,
    private readonly cwd: string,
  ) {}

  async start(): Promise<AcpV1InitializeResult> {
    this.state = "ready";
    return Object.freeze({
      protocolVersion: 1,
      agentCapabilities: Object.freeze({
        loadSession: false,
        resumeSession: true,
        prompt: Object.freeze({ image: false, audio: false, embeddedContent: false }),
      }),
      authMethods: Object.freeze([]),
      agentInfo: Object.freeze({ name: "Scripted Grok", version: "1.0" }),
    }) as unknown as AcpV1InitializeResult;
  }
  async authenticate(): Promise<void> {}
  async officialBilling() { return Object.freeze({ creditUsagePercent: 0 }); }
  async setModel(_session: AcpV1AdapterSession, _model: GuildGrokModel): Promise<void> {}
  async setMode(_session: AcpV1AdapterSession, _model: GuildGrokModel, _effort: GuildGrokReasoningEffort): Promise<void> {}
  async setConfigOption(): Promise<readonly RuntimeConfigOption[]> { return Object.freeze([]); }
  async newSession(cwd?: string): Promise<AcpV1AdapterSession> {
    this.sessionFolders.push(cwd ?? "");
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "new",
      state: {},
    });
    return this.makeSession("new");
  }
  async resumeSession(_sessionId: string, cwd?: string): Promise<AcpV1AdapterSession> {
    this.sessionFolders.push(cwd ?? "");
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "resume",
      state: {},
    });
    return this.makeSession("resume");
  }
  async loadSession(): Promise<AcpV1AdapterSession> { throw new Error("not supported"); }
  async cancel(): Promise<JsonRpcWriteReceipt> { return writeReceipt(); }
  async close(): Promise<void> { this.state = "closed"; }
  async probeLiveness(): Promise<boolean> { return this.state === "ready"; }
  async sendExtensionRequest(): Promise<XaiExtensionOutcome<JsonValue>> {
    return Object.freeze({ status: "unsupported" as const });
  }

  async prompt(session: AcpV1AdapterSession, text: string) {
    this.promptSequence += 1;
    const promptSequence = this.promptSequence;
    const identity = {
      adapterEpoch: this.adapterEpoch,
      sessionId: session.sessionId,
      promptSequence,
    };
    await this.sink.commitPromptAccepted({ identity, write: writeReceipt() });
    await this.script({ text, cwd: this.cwd, gate: this.gate });
    await this.sink.commitUpdate({
      identity,
      ingestMode: "live",
      promptSequence,
      update: {
        type: "turn",
        payload: {
          sessionId: session.sessionId,
          received: received(),
          type: "agent_text_chunk",
          messageId: "m1",
          text: "done",
        },
      } as unknown as AcpV1DecodedUpdate,
    });
    const terminal = Object.freeze({
      type: "prompt_terminal",
      sessionId: session.sessionId,
      stopReason: "end_turn",
      classification: "completed",
      received: received(),
    }) as RuntimePromptTerminalPayload;
    await this.sink.commitPromptTerminal({ identity, terminal });
    return terminal;
  }

  private makeSession(establishedBy: "new" | "resume"): AcpV1AdapterSession {
    return Object.freeze({
      adapterEpoch: this.adapterEpoch,
      sessionId: this.sessionId,
      establishedBy,
    });
  }
}

function received() {
  return Object.freeze({ wallClockIso: new Date().toISOString(), monotonicMs: performance.now() });
}

function writeReceipt(): JsonRpcWriteReceipt {
  return Object.freeze({
    type: "write_completed",
    messageType: "request",
    requestId: 1,
    bytes: 1,
    evidence: "local_writer_completion",
    remoteAcceptance: "not_evidenced",
  });
}
