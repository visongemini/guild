import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import * as runtimeRoot from "./index.js";
import {
  ExecutablePinError,
  pinExecutable,
  type PinnedExecutableCleanup,
} from "./executable-pin.js";
import { pinExecutableForTesting } from "./executable-pin-testing.js";
import {
  GROK_ACP_PRODUCTION_ARGV,
  GROK_ACP_PRODUCTION_PROFILE,
} from "./grok-acp-profile.js";
import {
  buildChildEnvironment,
  GrokProcessHost,
  GrokProcessHostError,
  PROCESS_ENVIRONMENT_POLICY_VERSION,
  type GrokProcessHostOptions,
  type ProcessHostEvent,
} from "./process-host.js";
import {
  createGrokProcessHostForTesting,
  type GrokProcessHostTestInstance,
  type ProcessHostTestConfiguration,
} from "./process-host-testing.js";

// @ts-expect-error The production root must never export the lifecycle test seam.
import type { ProcessHostLifecycleSeam } from "./index.js";
// @ts-expect-error The production root must never export the executable-pin test hook.
import type { ExecutablePinTestHooks } from "./index.js";

type Assert<Condition extends true> = Condition;
type _ProductionOptionsHaveNoArgv = Assert<"argv" extends keyof GrokProcessHostOptions ? false : true>;

type PreparedFixture = {
  readonly identity: string;
  readonly directory: string;
  readonly stagingRoot: string;
  readonly executablePath: string;
  readonly sha256: string;
  remove(): Promise<void>;
};

type TestHost = GrokProcessHost | GrokProcessHostTestInstance;
type OwnedGroup = {
  readonly processGroupId: number;
  readonly fixtureIdentity: string;
  readonly fixtureDirectory: string;
  readonly stagedExecutablePath: string;
};
type OwnedDescendant = {
  readonly pid: number;
  readonly ownerProcessGroupId: number;
  readonly fixtureIdentity: string;
  readonly fixtureDirectory: string;
};
type ProcessRow = { readonly pid: number; readonly processGroupId: number; readonly command: string };

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const registeredGroups = new Map<number, OwnedGroup>();
const registeredDescendants = new Map<number, OwnedDescendant>();
const registeredFixtureDirectories = new Set<string>();
const allFixtureDirectories = new Set<string>();
let processListToolDirectory: string | undefined;
let processListExecutable = "/bin/ps";

before(async () => {
  if (process.platform !== "darwin") return;
  // macOS rejects setuid executables inside sandbox-exec. The teardown only
  // needs this user's processes, so run a non-privileged copy of system ps.
  processListToolDirectory = await mkdtemp(join(packageRoot, ".runtime-grok-tools-"));
  processListExecutable = join(processListToolDirectory, "ps");
  await copyFile("/bin/ps", processListExecutable);
  await chmod(processListExecutable, 0o700);
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/codesign", ["--force", "--sign", "-", processListExecutable], (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
});


function registerGroup(started: Awaited<ReturnType<TestHost["start"]>>, fixture: PreparedFixture): number {
  const record: OwnedGroup = {
    processGroupId: started.processGroupId,
    fixtureIdentity: fixture.identity,
    fixtureDirectory: fixture.directory,
    stagedExecutablePath: started.executablePath,
  };
  assert.equal(registeredGroups.has(record.processGroupId), false, "owned PGID registered twice");
  registeredGroups.set(record.processGroupId, record);
  return record.processGroupId;
}

function registerDescendant(pid: number, ownerProcessGroupId: number, fixture: PreparedFixture): number {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "fixture returned an invalid descendant PID");
  assert.equal(registeredDescendants.has(pid), false, "owned descendant registered twice");
  registeredDescendants.set(pid, {
    pid,
    ownerProcessGroupId,
    fixtureIdentity: fixture.identity,
    fixtureDirectory: fixture.directory,
  });
  return pid;
}

async function prepareFixture(): Promise<PreparedFixture> {
  const directory = await mkdtemp(join(packageRoot, ".runtime-grok-test-"));
  const identity = randomBytes(18).toString("hex");
  registeredFixtureDirectories.add(directory);
  allFixtureDirectories.add(directory);
  const stagingRoot = join(directory, "staging");
  const agent = fileURLToPath(new URL("../src/fixtures/agent", import.meta.url));
  const executablePath = join(directory, "node");
  await mkdir(stagingRoot, { mode: 0o700 });
  await copyFile(agent, join(directory, "agent"));
  await chmod(join(directory, "agent"), 0o700);
  await copyFile(await realpath(process.execPath), executablePath);
  await chmod(executablePath, 0o700);
  const sha256 = sha256Of(await readFile(executablePath));
  return {
    identity,
    directory,
    stagingRoot,
    executablePath,
    sha256,
    remove: async () => {
      await rm(directory, { recursive: true, force: true });
      registeredFixtureDirectories.delete(directory);
    },
  };
}

function options(
  fixture: PreparedFixture,
  overrides: Partial<GrokProcessHostOptions> = {},
): GrokProcessHostOptions {
  return {
    executablePath: fixture.executablePath,
    expectedSha256: fixture.sha256,
    workingDirectory: fixture.directory,
    stagingRoot: fixture.stagingRoot,
    ...overrides,
  };
}

function testHost(
  fixture: PreparedFixture,
  fixtureArgs: readonly string[] = [],
  overrides: Partial<GrokProcessHostOptions> = {},
  configuration: ProcessHostTestConfiguration = {},
): GrokProcessHostTestInstance {
  return createGrokProcessHostForTesting(options(fixture, overrides), {
    ...configuration,
    fixtureArgs,
  });
}

async function startOwned(host: TestHost, fixture: PreparedFixture): Promise<Awaited<ReturnType<TestHost["start"]>>> {
  const started = await bounded(host.start(), FIXTURE_STARTUP_TIMEOUT_MS);
  registerGroup(started, fixture);
  return started;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A freshly staged executable may start slowly on macOS. This budget applies
// only to fixture startup; every product stop/reap deadline remains unchanged.
const FIXTURE_STARTUP_TIMEOUT_MS = 15_000;

async function bounded<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds} ms test bound`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function waitForEvent<T extends ProcessHostEvent["type"]>(
  host: TestHost,
  type: T,
): Promise<Extract<ProcessHostEvent, { type: T }>> {
  let unsubscribe = (): void => undefined;
  return new Promise((resolve) => {
    unsubscribe = host.onEvent((event) => {
      if (event.type === type) {
        unsubscribe();
        resolve(event as Extract<ProcessHostEvent, { type: T }>);
      }
    });
  });
}

function waitForStdout(host: TestHost, expected: string): Promise<string> {
  let text = "";
  let unsubscribe = (): void => undefined;
  return new Promise((resolve) => {
    unsubscribe = host.onEvent((event) => {
      if (event.type !== "stdout_data") {
        return;
      }
      text += Buffer.from(event.chunk).toString("utf8");
      if (text.includes(expected)) {
        unsubscribe();
        resolve(text);
      }
    });
  });
}

async function eventuallyGone(pidOrGroupId: number, group = false): Promise<void> {
  await bounded(new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const check = (): void => {
      try {
        process.kill(group ? -pidOrGroupId : pidOrGroupId, 0);
      } catch (cause: unknown) {
        if ((cause as { readonly code?: string }).code === "ESRCH") {
          resolve();
          return;
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error(`${group ? "process group" : "process"} ${pidOrGroupId} survived cleanup`));
        return;
      }
      setTimeout(check, 20);
    };
    check();
  }), 2_500);
}

async function processRows(): Promise<readonly ProcessRow[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(processListExecutable, ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }, (error, output) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(output);
    });
  });
  return stdout.split("\n").flatMap((line): ProcessRow[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match === null) {
      return [];
    }
    return [{
      pid: Number(match[1]),
      processGroupId: Number(match[2]),
      command: match[3] ?? "",
    }];
  });
}

async function matchingOwnedGroupProcesses(record: OwnedGroup): Promise<readonly ProcessRow[]> {
  return (await processRows()).filter((row) =>
    row.processGroupId === record.processGroupId && (
      row.command.includes(record.fixtureDirectory) || row.command.includes(record.stagedExecutablePath)
    ));
}

async function cleanupRegisteredGroup(record: OwnedGroup): Promise<void> {
  try {
    assertEsrch(record.processGroupId, true);
    registeredGroups.delete(record.processGroupId);
    return;
  } catch {
    // A live PGID must match the registered fixture before a last-resort signal.
  }
  const matching = await matchingOwnedGroupProcesses(record);
  if (matching.length === 0) {
    throw new Error(`refusing to SIGKILL stale or reused PGID ${record.processGroupId} for fixture ${record.fixtureIdentity}`);
  }
  process.kill(-record.processGroupId, "SIGKILL");
  await eventuallyGone(record.processGroupId, true);
  assertEsrch(record.processGroupId, true);
  registeredGroups.delete(record.processGroupId);
}

async function cleanupRegisteredDescendant(record: OwnedDescendant): Promise<void> {
  try {
    assertEsrch(record.pid);
    registeredDescendants.delete(record.pid);
    return;
  } catch {
    // A live PID must still carry both its owner PGID and fixture marker.
  }
  const row = (await processRows()).find((candidate) => candidate.pid === record.pid);
  if (
    row === undefined ||
    row.processGroupId !== record.ownerProcessGroupId ||
    !row.command.includes(record.fixtureDirectory)
  ) {
    throw new Error(`refusing to SIGKILL stale or reused descendant PID ${record.pid} for fixture ${record.fixtureIdentity}`);
  }
  process.kill(record.pid, "SIGKILL");
  await eventuallyGone(record.pid);
  assertEsrch(record.pid);
  registeredDescendants.delete(record.pid);
}

async function cleanup(host: TestHost | undefined, processGroupId?: number, descendant?: number): Promise<void> {
  try {
    if (host !== undefined && ["running", "starting", "stopping"].includes(host.state)) {
      await bounded(host.stop(), 3_000);
    }
  } catch {
    // Registered ownership is checked below before any last-resort signal.
  }
  if (processGroupId !== undefined) {
    const record = registeredGroups.get(processGroupId);
    assert.ok(record !== undefined, `successful start ${processGroupId} was not registered`);
    await cleanupRegisteredGroup(record);
  }
  if (descendant !== undefined) {
    const record = registeredDescendants.get(descendant);
    assert.ok(record !== undefined, `owned descendant ${descendant} was not registered`);
    await cleanupRegisteredDescendant(record);
  }
}

after(async () => {
  const failures: unknown[] = [];
  const collect = (results: readonly PromiseSettledResult<void>[]): void => {
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
  };
  collect(await Promise.allSettled([...registeredGroups.values()].map(cleanupRegisteredGroup)));
  collect(await Promise.allSettled([...registeredDescendants.values()].map(cleanupRegisteredDescendant)));
  collect(await Promise.allSettled([...registeredFixtureDirectories].map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
    registeredFixtureDirectories.delete(directory);
  })));

  if (registeredGroups.size !== 0) {
    failures.push(new Error(`owned process-group registry retained ${registeredGroups.size} entries`));
  }
  if (registeredDescendants.size !== 0) {
    failures.push(new Error(`owned descendant registry retained ${registeredDescendants.size} entries`));
  }
  if (registeredFixtureDirectories.size !== 0) {
    failures.push(new Error(`fixture-directory registry retained ${registeredFixtureDirectories.size} entries`));
  }
  const fixtureDirectories = (await readdir(packageRoot)).filter((entry) =>
    entry.startsWith(".runtime-grok-test-") || entry.startsWith(".runtime-grok-pin-"));
  if (fixtureDirectories.length !== 0) {
    failures.push(new Error(`fixture temp directories survived: ${fixtureDirectories.join(", ")}`));
  }
  const survivingOwnedProcesses = (await processRows()).filter((row) =>
    [...allFixtureDirectories].some((directory) => row.command.includes(directory)));
  if (survivingOwnedProcesses.length !== 0) {
    failures.push(new Error(`matching owned processes survived: ${JSON.stringify(survivingOwnedProcesses)}`));
  }
  if (failures.length !== 0) {
    throw new AggregateError(failures, "runtime-grok process-test ownership teardown failed");
  }
});

after(async () => {
  if (processListToolDirectory !== undefined) {
    await rm(processListToolDirectory, { recursive: true, force: true });
  }
});

function isFailure(type: GrokProcessHostError["failure"]["type"], code?: string): (cause: unknown) => boolean {
  return (cause) => cause instanceof GrokProcessHostError && cause.failure.type === type && (
    code === undefined || (cause.failure.type === "preflight_failure" && cause.failure.code === code)
  );
}

function stagedDirectories(root: string): Promise<string[]> {
  return import("node:fs/promises").then(({ readdir }) => readdir(root).then((entries) => entries.filter((entry) => entry.startsWith(".grok-pin-"))));
}

function realProbe(processGroupId: number): "already_gone" | "failed" | "present" {
  try {
    process.kill(-processGroupId, 0);
    return "present";
  } catch (cause: unknown) {
    return (cause as { readonly code?: string }).code === "ESRCH" ? "already_gone" : "failed";
  }
}

function createGate(): { readonly wait: Promise<void>; release(): void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

type DeadlineTimerAuditRecord = {
  readonly handle: NodeJS.Timeout;
  cleared: boolean;
  fired: boolean;
};

function installDeadlineTimerAudit(milliseconds: number): {
  readonly created: Promise<DeadlineTimerAuditRecord>;
  readonly records: readonly DeadlineTimerAuditRecord[];
  restore(): void;
} {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const records: DeadlineTimerAuditRecord[] = [];
  let resolveCreated!: (record: DeadlineTimerAuditRecord) => void;
  const created = new Promise<DeadlineTimerAuditRecord>((resolve) => {
    resolveCreated = resolve;
  });
  globalThis.setTimeout = ((callback: () => void, delayMs?: number) => {
    let record: DeadlineTimerAuditRecord | undefined;
    const handle = originalSetTimeout(() => {
      if (record !== undefined) {
        record.fired = true;
      }
      callback();
    }, delayMs);
    if (delayMs === milliseconds) {
      record = { handle, cleared: false, fired: false };
      records.push(record);
      resolveCreated(record);
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    const record = records.find((candidate) => candidate.handle === handle);
    if (record !== undefined) {
      record.cleared = true;
    }
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
  return {
    created,
    records,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function installOpenedHandleCloseFailure(targetOpenOrdinal: number): {
  readonly closeCalls: (openOrdinal: number) => number;
  readonly openCalls: () => number;
  restore(): void;
} {
  type OpenFunction = typeof import("node:fs/promises").open;
  const require = createRequire(import.meta.url);
  const fsPromises = require("node:fs/promises") as { open: OpenFunction };
  const originalOpen = fsPromises.open;
  const closeCalls = new Map<number, number>();
  let openCalls = 0;
  fsPromises.open = (async (...arguments_: Parameters<OpenFunction>) => {
    const handle = await originalOpen(...arguments_);
    const openOrdinal = ++openCalls;
    const originalClose = handle.close;
    handle.close = async (): Promise<void> => {
      const call = (closeCalls.get(openOrdinal) ?? 0) + 1;
      closeCalls.set(openOrdinal, call);
      if (openOrdinal === targetOpenOrdinal && call === 1) {
        throw new Error(`injected close failure for opened handle ${openOrdinal}`);
      }
      await originalClose.call(handle);
    };
    return handle;
  }) as OpenFunction;
  syncBuiltinESMExports();
  return {
    closeCalls: (openOrdinal) => closeCalls.get(openOrdinal) ?? 0,
    openCalls: () => openCalls,
    restore: () => {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    },
  };
}

function assertEsrch(pidOrGroupId: number, group = false): void {
  assert.throws(
    () => process.kill(group ? -pidOrGroupId : pidOrGroupId, 0),
    (cause: unknown) => (cause as { readonly code?: string }).code === "ESRCH",
  );
}

function instrumentDirectCloseAutomaticReap(host: GrokProcessHostTestInstance): {
  readonly entryCount: () => number;
  trigger(): void;
} {
  type TestInternals = {
    child?: { removeAllListeners(eventName: string): unknown };
    handleClose(code: number | null, signal: NodeJS.Signals | null): void;
    startAutomaticReap(): void;
  };
  const internals = host as unknown as TestInternals;
  const originalStartAutomaticReap = internals.startAutomaticReap.bind(host);
  let entries = 0;
  internals.startAutomaticReap = () => {
    entries += 1;
    originalStartAutomaticReap();
  };
  return {
    entryCount: () => entries,
    trigger: () => {
      assert.ok(internals.child !== undefined, "test host child must exist before direct-close injection");
      internals.child.removeAllListeners("close");
      internals.handleClose(null, null);
    },
  };
}

describe("runtime-grok production root boundary", { concurrency: false }, () => {
  it("does not export package-internal lifecycle or pin test seams", async () => {
    for (const internalName of [
      "createGrokProcessHostForTesting",
      "createInternalProcessHostForTesting",
      "pinExecutableForTesting",
      "pinExecutableInternal",
      "ProcessHostLifecycleSeam",
    ]) {
      assert.equal(internalName in runtimeRoot, false, `${internalName} leaked from the production root`);
    }
    const rootDeclaration = await readFile(fileURLToPath(new URL("./index.d.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(rootDeclaration, /InternalProcessHost|ProcessHostLifecycleSeam|ExecutablePinTestHooks/u);
  });
});

describe("GrokProcessHost independent executable pinning (PC-SEC-001, ADR D-008)", { concurrency: false }, () => {
  it("spawns the verified staged Node fixture when the original pathname is atomically replaced after pinning", async () => {
    const fixture = await prepareFixture();
    const replacement = join(fixture.directory, "replacement-false");
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      await copyFile("/usr/bin/false", replacement);
      await chmod(replacement, 0o700);
      host = testHost(fixture, ["argv", "staged-only"], {}, {
        afterPin: async () => rename(replacement, fixture.executablePath),
      });
      const output = waitForStdout(host, "agent|stdio|argv|staged-only");
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      assert.notEqual(started.executablePath, fixture.executablePath);
      assert.equal(started.executablePath.startsWith(join(fixture.stagingRoot, ".grok-pin-")), true);
      await bounded(output);
      await bounded(host.waitForTermination());
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("executes the independently verified staged Node fixture after source replacement", async () => {
    const directory = await mkdtemp(join(packageRoot, ".runtime-grok-pin-"));
    const stagingRoot = join(directory, "staging");
    const original = join(directory, "node-copy");
    const replacement = join(directory, "replacement");
    try {
      await mkdir(stagingRoot, { mode: 0o700 });
      await copyFile(await realpath(process.execPath), original);
      await copyFile("/usr/bin/false", replacement);
      await chmod(original, 0o700);
      await chmod(replacement, 0o700);
      const originalStats = await stat(original, { bigint: true });
      const originalHash = sha256Of(await readFile(original));
      const pinned = await pinExecutable(original, stagingRoot, originalHash);
      await rename(replacement, original);
      const replacementStats = await stat(original, { bigint: true });
      assert.notEqual(replacementStats.ino, originalStats.ino);
      const stagedStats = await stat(pinned.stagedExecutablePath, { bigint: true });
      assert.notEqual(stagedStats.ino, replacementStats.ino);
      assert.equal(sha256Of(await readFile(pinned.stagedExecutablePath)), originalHash);
      const agent = fileURLToPath(new URL("../src/fixtures/agent", import.meta.url));
      const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const child = spawn(pinned.stagedExecutablePath, [agent, "stdio", "immediate-exit"], { stdio: "ignore" });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(close, { code: 23, signal: null });
      await pinned.cleanup();
      await assert.rejects(access(pinned.stagedExecutablePath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a runtime-frozen pin with a non-overridable spawn verifier", async () => {
    const fixture = await prepareFixture();
    let cleanup: PinnedExecutableCleanup | undefined;
    try {
      const pinned = await pinExecutable(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
      assert.equal(Object.isFrozen(pinned), true);
      assert.equal(Object.isFrozen(pinned.verifyForSpawn), true);
      assert.deepEqual(Object.getOwnPropertyDescriptor(pinned, "verifyForSpawn"), {
        value: pinned.verifyForSpawn,
        writable: false,
        enumerable: true,
        configurable: false,
      });
      assert.equal(Reflect.set(pinned, "verifyForSpawn", async () => undefined), false);
      await pinned.verifyForSpawn();
      cleanup = await pinned.cleanup();
      assert.deepEqual(cleanup, {
        stageHandleClosed: true,
        stagingDirectoryRemoved: true,
        failure: "none",
      });
    } finally {
      assert.equal(cleanup?.failure, "none");
      await fixture.remove();
    }
  });

  it("makes writer close a pin-success condition and cleans every tracked resource", async () => {
    const fixture = await prepareFixture();
    let closeFailure: ReturnType<typeof installOpenedHandleCloseFailure> | undefined;
    try {
      closeFailure = installOpenedHandleCloseFailure(2);
      await assert.rejects(
        pinExecutable(fixture.executablePath, fixture.stagingRoot, fixture.sha256),
        (cause: unknown) => cause instanceof ExecutablePinError &&
          cause.code === "preflight_io_failure" &&
          cause.message === "staged executable writer could not be closed",
      );
      assert.equal(closeFailure.openCalls(), 2);
      assert.equal(closeFailure.closeCalls(1), 1, "source descriptor must be closed on writer failure");
      assert.equal(closeFailure.closeCalls(2), 2, "failed writer close must be retried during cleanup");
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
    } finally {
      closeFailure?.restore();
      await fixture.remove();
    }
  });

  it("treats source close failure as pre-return pin failure without leaking the stage", async () => {
    const fixture = await prepareFixture();
    let closeFailure: ReturnType<typeof installOpenedHandleCloseFailure> | undefined;
    try {
      closeFailure = installOpenedHandleCloseFailure(1);
      await assert.rejects(
        pinExecutable(fixture.executablePath, fixture.stagingRoot, fixture.sha256),
        (cause: unknown) => cause instanceof ExecutablePinError &&
          cause.code === "preflight_io_failure" &&
          cause.message === "source executable descriptor could not be closed",
      );
      assert.equal(closeFailure.openCalls(), 3);
      assert.equal(closeFailure.closeCalls(1), 2, "failed source close must be retried during cleanup");
      assert.equal(closeFailure.closeCalls(2), 1, "writer descriptor must close before verification succeeds");
      assert.equal(closeFailure.closeCalls(3), 1, "retained stage descriptor must close on source failure");
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
    } finally {
      closeFailure?.restore();
      await fixture.remove();
    }
  });

  it("preserves the primary pin error and audits an exact post-mkdir cleanup failure", async () => {
    const fixture = await prepareFixture();
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    const primary = new ExecutablePinError("executable_changed", "primary pin failure sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      await assert.rejects(
        pinExecutableForTesting(fixture.executablePath, fixture.stagingRoot, fixture.sha256, {
          afterDescriptorCopy: async () => {
            await chmod(fixture.stagingRoot, 0o500);
            throw primary;
          },
        }),
        (cause: unknown) => {
          assert.strictEqual(cause, primary);
          assert.equal(primary.code, "executable_changed");
          assert.equal(
            primary.message,
            "primary pin failure sentinel; pin failure cleanup incomplete: staging_directory_remove_failed",
          );
          return true;
        },
      );
      assert.equal((await stagedDirectories(fixture.stagingRoot)).length, 1);
      await access(sentinel);
    } finally {
      await chmod(fixture.stagingRoot, 0o700).catch(() => undefined);
      await fixture.remove();
    }
  });

  it("rejects a source pathname replacement after descriptor copy and removes only its private stage", async () => {
    const fixture = await prepareFixture();
    const replacement = join(fixture.directory, "replacement-false");
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      await copyFile("/usr/bin/false", replacement);
      await chmod(replacement, 0o700);
      await assert.rejects(
        pinExecutableForTesting(fixture.executablePath, fixture.stagingRoot, fixture.sha256, {
          afterDescriptorCopy: async () => rename(replacement, fixture.executablePath),
        }),
        (cause: unknown) => cause instanceof ExecutablePinError && cause.code === "executable_changed",
      );
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
      await access(sentinel);
    } finally {
      await fixture.remove();
    }
  });

  it("rejects private-stage pathname replacement immediately before spawn", async () => {
    const fixture = await prepareFixture();
    const replacement = join(fixture.directory, "replacement-false");
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      await copyFile("/usr/bin/false", replacement);
      await chmod(replacement, 0o500);
      const host = testHost(fixture, ["linger"], {}, {
        afterPin: async (pinned) => {
          await rename(pinned.stagedExecutablePath, `${pinned.stagedExecutablePath}.retained-inode`);
          await rename(replacement, pinned.stagedExecutablePath);
        },
      });
      await assert.rejects(host.start(), isFailure("preflight_failure", "executable_changed"));
      const termination = await bounded(host.waitForTermination());
      assert.equal(termination.type, "not_spawned");
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
      await access(sentinel);
    } finally {
      await fixture.remove();
    }
  });

  it("rejects private-stage mutation immediately before spawn", async () => {
    const fixture = await prepareFixture();
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      const host = testHost(fixture, ["linger"], {}, {
        afterPin: async (pinned) => {
          const mutated = Buffer.from(await readFile(pinned.stagedExecutablePath));
          mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 0xff;
          await chmod(pinned.stagedExecutablePath, 0o700);
          await writeFile(pinned.stagedExecutablePath, mutated);
          await chmod(pinned.stagedExecutablePath, 0o500);
        },
      });
      await assert.rejects(host.start(), isFailure("preflight_failure", "executable_changed"));
      const termination = await bounded(host.waitForTermination());
      assert.equal(termination.type, "not_spawned");
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
      await access(sentinel);
    } finally {
      await fixture.remove();
    }
  });

  it("rejects all required preflight cases before spawning", async () => {
    const fixture = await prepareFixture();
    const script = join(fixture.directory, "agent");
    const nonExecutable = join(fixture.directory, "non-executable-node");
    try {
      await copyFile(fixture.executablePath, nonExecutable);
      await chmod(nonExecutable, 0o600);
      const cases: readonly [string, GrokProcessHostOptions, string][] = [
        ["relative", { ...options(fixture), executablePath: "node" }, "path_not_absolute"],
        ["directory", { ...options(fixture), executablePath: fixture.directory }, "not_regular_file"],
        ["non-executable", { ...options(fixture), executablePath: nonExecutable, expectedSha256: sha256Of(await readFile(nonExecutable)) }, "not_executable"],
        ["hash mismatch", { ...options(fixture), expectedSha256: "0".repeat(64) }, "hash_mismatch"],
        ["script", { ...options(fixture), executablePath: script, expectedSha256: sha256Of(await readFile(script)) }, "not_macho"],
      ];
      for (const [name, input, code] of cases) {
        const host = new GrokProcessHost(input);
        await assert.rejects(host.start(), isFailure("preflight_failure", code), name);
        const termination = await bounded(host.waitForTermination());
        assert.equal(termination.type, "not_spawned");
      }
    } finally {
      await fixture.remove();
    }
  });
});

describe("GrokProcessHost execution policy and lifecycle (PC-TRN-001/002/003)", { concurrency: false }, () => {
  it("does not inherit an allowlisted parent proxy when no base environment is supplied", async () => {
    const fixture = await prepareFixture();
    const key = "HTTP_PROXY";
    const previous = process.env[key];
    const sentinel = `http://parent-proxy-${randomBytes(16).toString("hex")}.invalid`;
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      process.env[key] = sentinel;
      const events: ProcessHostEvent[] = [];
      host = testHost(fixture, ["environment"]);
      host.onEvent((event) => events.push(event));
      const output = waitForStdout(host, '"environment"');
      const termination = host.waitForTermination();
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      const observed = JSON.parse((await bounded(output)).trim()) as { readonly environment: Readonly<Record<string, string | undefined>> };
      const terminationEvidence = await bounded(termination);
      const serializedEvidence = JSON.stringify({ started, terminationEvidence, events, observed });
      assert.equal(observed.environment[key], undefined);
      assert.equal(serializedEvidence.includes(sentinel), false);
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("uses literal argv, a canonical cwd, and only the allowlisted frozen environment", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      const suppliedEnvironment: Record<string, string> = {
        PATH: "",
        HOME: "/wrong",
        LANG: "C",
        KEEP: "must-drop",
        DYLD_X: "must-drop",
        LD_X: "must-drop",
        NODE_OPTIONS: "must-drop",
        https_proxy: "http://proxy.invalid",
      };
      host = testHost(fixture, ["environment", "$(literal-not-a-shell)"], {
        baseEnvironment: suppliedEnvironment,
      });
      suppliedEnvironment.LANG = "mutated-after-construction";
      const environment = waitForStdout(host, '"cwd"');
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      assert.deepEqual(started.argv, ["agent", "stdio", "environment", "$(literal-not-a-shell)"]);
      assert.notEqual(started.executablePath, fixture.executablePath);
      assert.equal(started.workingDirectory, fixture.directory);
      assert.equal(started.environmentPolicyVersion, "macos-posix-v3");
      const observed = JSON.parse((await bounded(environment)).trim()) as Record<string, string | boolean | undefined>;
      assert.equal(observed.cwd, fixture.directory);
      assert.equal(observed.home, homedir());
      assert.equal(
        observed.path,
        `${homedir()}/.grok/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      );
      assert.equal(observed.lang, "C");
      assert.equal(observed.keep, false);
      assert.equal(observed.dyld, false);
      assert.equal(observed.ld, false);
      assert.equal(observed.nodeOptions, false);
      assert.equal(observed.lowerProxy, "http://proxy.invalid");
      const childEnvironment = observed.environment as unknown as Readonly<Record<string, string | undefined>>;
      assert.equal(childEnvironment.GROK_CLAUDE_AGENTS_ENABLED, "false");
      assert.equal(childEnvironment.GROK_CLAUDE_RULES_ENABLED, "false");
      assert.equal(childEnvironment.GROK_CURSOR_AGENTS_ENABLED, "false");
      assert.equal(childEnvironment.GROK_CURSOR_RULES_ENABLED, "false");
      await bounded(host.waitForTermination());
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("adds common Homebrew locations to a non-empty Finder-style PATH", () => {
    assert.equal(
      buildChildEnvironment({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }).PATH,
      `/usr/bin:/bin:/usr/sbin:/sbin:${homedir()}/.grok/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin`,
    );
  });

  it("disables external Claude and Cursor instruction imports without disabling their tools", () => {
    const environment = buildChildEnvironment({
      GROK_CLAUDE_AGENTS_ENABLED: "true",
      GROK_CLAUDE_RULES_ENABLED: "true",
      GROK_CURSOR_AGENTS_ENABLED: "true",
      GROK_CURSOR_RULES_ENABLED: "true",
      GROK_CLAUDE_SKILLS_ENABLED: "true",
      GROK_CLAUDE_MCPS_ENABLED: "true",
    });
    assert.equal(environment.GROK_CLAUDE_AGENTS_ENABLED, "false");
    assert.equal(environment.GROK_CLAUDE_RULES_ENABLED, "false");
    assert.equal(environment.GROK_CURSOR_AGENTS_ENABLED, "false");
    assert.equal(environment.GROK_CURSOR_RULES_ENABLED, "false");
    assert.equal(environment.GROK_CLAUDE_SKILLS_ENABLED, undefined);
    assert.equal(environment.GROK_CLAUDE_MCPS_ENABLED, undefined);
  });

  it("rejects invalid environment input before spawning without leaking values", async () => {
    const fixture = await prepareFixture();
    try {
      const invalid: readonly Readonly<Record<string, string>>[] = [
        { "": "secret-value" },
        { "A=B": "secret-value" },
        { ["A\0B"]: "secret-value" },
        { SAFE: "secret\0value" },
      ];
      for (const baseEnvironment of invalid) {
        const events: ProcessHostEvent[] = [];
        const host = new GrokProcessHost(options(fixture, { baseEnvironment }));
        host.onEvent((event) => events.push(event));
        await assert.rejects(host.start(), (cause: unknown) => {
          assert.ok(cause instanceof GrokProcessHostError);
          assert.equal(cause.failure.type, "preflight_failure");
          assert.equal(cause.message.includes("secret"), false);
          return true;
        });
        assert.equal(JSON.stringify(events).includes("secret"), false);
        assert.equal((await bounded(host.waitForTermination())).type, "not_spawned");
      }
    } finally {
      await fixture.remove();
    }
  });

  it("retains only its unique staging directory until confirmed group end", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      host = testHost(fixture, ["linger"]);
      const ready = waitForStdout(host, "READY\n");
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      assert.equal((await stagedDirectories(fixture.stagingRoot)).length, 1);
      await bounded(host.stop());
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
      await access(sentinel);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("preserves immediate-exit, stdout EOF, and direct-close evidence as separate ordered events", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      const events: ProcessHostEvent[] = [];
      host = testHost(fixture, ["stdout-eof"]);
      host.onEvent((event) => events.push(event));
      group = (await startOwned(host, fixture)).processGroupId;
      const termination = await bounded(host.waitForTermination());
      assert.equal(termination.type, "stop_reaped");
      if (termination.type === "stop_reaped") {
        assert.equal(termination.close.code, 7);
      }
      const types = events.map((event) => event.type);
      const stdoutEof = types.indexOf("stdout_eof");
      const processExit = types.indexOf("process_exit");
      const processClose = types.indexOf("process_close");
      assert.ok(stdoutEof >= 0 && processExit >= 0 && processClose >= 0);
      assert.ok(stdoutEof < processExit);
      assert.ok(processExit < processClose);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("uses only the immutable exact production argv and settles a true public-host immediate-exit race once", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      const executablePath = await realpath("/usr/bin/true");
      const injectedArgv = [
        "serve",
        "--bind",
        "0.0.0.0",
        "--secret",
        "shared",
        "--always-approve",
        "--permission-mode",
        "bypassPermissions",
      ];
      const productionInput = {
        ...options(fixture),
        executablePath,
        expectedSha256: sha256Of(await readFile(executablePath)),
        argv: injectedArgv,
      } as GrokProcessHostOptions & { readonly argv: string[] };
      const events: ProcessHostEvent[] = [];
      host = new GrokProcessHost(productionInput);
      injectedArgv.splice(0, injectedArgv.length, "mutated-after-construction");
      assert.equal(
        Reflect.set(GROK_ACP_PRODUCTION_ARGV as unknown as object, "0", "serve"),
        false,
      );
      assert.equal(
        Reflect.set(GROK_ACP_PRODUCTION_PROFILE as unknown as object, "argv", injectedArgv),
        false,
      );
      host.onEvent((event) => events.push(event));
      const termination = host.waitForTermination();
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      assert.deepEqual(started.argv, [
        "--permission-mode",
        "default",
        "--rules",
        GROK_ACP_PRODUCTION_PROFILE.rules,
        "agent",
        "--no-leader",
        "--model",
        "grok-4.6",
        "--reasoning-effort",
        "xhigh",
        "stdio",
      ]);
      assert.deepEqual(started.argv, GROK_ACP_PRODUCTION_ARGV);
      assert.equal(started.shell, false);
      assert.equal(Object.isFrozen(started.argv), true);
      const serializedArgv = JSON.stringify(started.argv).toLowerCase();
      for (const forbidden of [
        "serve",
        "bind",
        "secret",
        "always-approve",
        "always_approve",
        "alwaysapprove",
        "bypass",
        "bypasspermissions",
      ]) {
        assert.equal(serializedArgv.includes(forbidden), false, forbidden);
      }
      assert.throws(
        () => (started.argv as unknown as string[]).push("--secret"),
        TypeError,
      );
      const evidence = await bounded(termination);
      assert.equal(evidence.type, "stop_reaped");
      if (evidence.type === "stop_reaped") {
        assert.equal(evidence.close.code, 0);
        assert.strictEqual(await host.stop(), evidence);
      }
      assert.equal(events.filter((event) => event.type === "process_started").length, 1);
      assert.equal(events.filter((event) => event.type === "reaped").length, 1);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("derives a bounded production argv from official Grok runtime settings", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      const executablePath = await realpath("/usr/bin/true");
      host = new GrokProcessHost({
        ...options(fixture),
        executablePath,
        expectedSha256: sha256Of(await readFile(executablePath)),
        runtimeSettings: {
          model: "grok-4.5",
          reasoningEffort: "medium",
          permissionMode: "bypassPermissions",
        },
      });
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      assert.deepEqual(started.argv, [
        "--permission-mode",
        "bypassPermissions",
        "--rules",
        GROK_ACP_PRODUCTION_PROFILE.rules,
        "agent",
        "--no-leader",
        "--model",
        "grok-4.5",
        "--reasoning-effort",
        "medium",
        "stdio",
      ]);
      assert.equal(Object.isFrozen(started.argv), true);
      assert.equal((await bounded(host.waitForTermination())).type, "stop_reaped");
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("reports a deterministic closed-stdin write failure without a success receipt", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      const events: ProcessHostEvent[] = [];
      host = testHost(fixture, ["close-stdin"]);
      host.onEvent((event) => events.push(event));
      const ready = waitForStdout(host, "READY\n");
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      await assert.rejects(bounded(host.write(Buffer.alloc(1024 * 1024)), 2_000), isFailure("write_failure"));
      assert.equal(events.filter((event) => event.type === "write_failure").length, 1);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("enters the automatic reaper once and emits one terminal event for direct close", async () => {
    const fixture = await prepareFixture();
    let host: GrokProcessHostTestInstance | undefined;
    let group: number | undefined;
    try {
      const events: ProcessHostEvent[] = [];
      host = testHost(fixture, ["linger"]);
      host.onEvent((event) => events.push(event));
      const ready = waitForStdout(host, "READY\n");
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      const automaticReap = instrumentDirectCloseAutomaticReap(host);
      const termination = host.waitForTermination();
      automaticReap.trigger();
      const evidence = await bounded(termination, 4_000);
      assert.equal(evidence.type, "stop_reaped");
      assert.equal(automaticReap.entryCount(), 1);
      assert.equal(events.filter((event) => event.type === "process_close").length, 1);
      assert.equal(events.filter((event) => event.type === "reaped").length, 1);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("bounds and redacts stderr across chunks with exact capture accounting", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      const events: ProcessHostEvent[] = [];
      const chunks = ["Authorization: Bearer top-", "secret-token\npassword=hun", "ter2\nliteral=literal-", `secret-value\n${"x".repeat(160)}\n`];
      const sourceBytes = Buffer.byteLength(chunks.join(""));
      const limit = 100;
      host = testHost(fixture, ["stderr"], { maxStderrBytes: limit, redactValues: ["literal-secret-value"] });
      host.onEvent((event) => events.push(event));
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(host.waitForTermination());
      const diagnostics = events.filter((event): event is Extract<ProcessHostEvent, { type: "stderr_diagnostic" }> => event.type === "stderr_diagnostic");
      const eof = events.find((event): event is Extract<ProcessHostEvent, { type: "stderr_eof" }> => event.type === "stderr_eof");
      assert.ok(eof !== undefined);
      assert.equal(eof.capturedBytes, limit);
      assert.equal(eof.droppedBytes, sourceBytes - limit);
      assert.equal(diagnostics.some((event) => event.text === "[TRUNCATED STDERR LINE]"), true);
      const text = diagnostics.map((event) => event.text).join("");
      for (const secret of ["top-secret-token", "hunter2", "literal-secret-value"]) {
        assert.equal(text.includes(secret), false);
      }
      assert.equal(text.includes("[REDACTED]"), true);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("TERM-stops a direct linger process and KILL-stops a direct ignore-term process", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      host = testHost(fixture, ["linger"]);
      const ready = waitForStdout(host, "READY\n");
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      const termReceipt = await bounded(host.stop());
      assert.equal(termReceipt.groupTermSignalSent, true);
      assert.equal(termReceipt.groupKillSignalSent, false);
      assert.equal(termReceipt.groupGoneObserved, true);
      await cleanup(host, group);
      host = undefined;
      group = undefined;

      host = testHost(fixture, ["ignore-term"], { stopGraceMs: 40, killGraceMs: 1_000 });
      const ignoredReady = waitForStdout(host, "READY\n");
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(ignoredReady);
      const killReceipt = await bounded(host.stop());
      assert.equal(killReceipt.groupKillSignalSent, true);
      assert.equal(killReceipt.close.signal, "SIGKILL");
      await eventuallyGone(group, true);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("automatically reaps descendants only after direct leader exit evidence", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    let descendant: number | undefined;
    try {
      host = testHost(fixture, ["descendant-hold-stdio"], { stopGraceMs: 40, killGraceMs: 1_000 });
      const leaderExit = waitForEvent(host, "process_exit");
      const pidLine = waitForStdout(host, "DESCENDANT:");
      group = (await startOwned(host, fixture)).processGroupId;
      descendant = registerDescendant(Number(/DESCENDANT:(\d+)/u.exec(await bounded(pidLine))?.[1]), group, fixture);
      assert.ok(descendant > 0);
      await bounded(leaderExit);
      const activeDescendant = descendant as number;
      assert.doesNotThrow(() => process.kill(activeDescendant, 0));
      const receipt = await bounded(host.waitForTermination());
      assert.equal(receipt.type, "stop_reaped");
      assert.equal(receipt.stopRequested, false);
      await eventuallyGone(group, true);
      await eventuallyGone(descendant);
    } finally {
      await cleanup(host, group, descendant);
      await fixture.remove();
    }
  });

  it("does not make direct close host termination while a stdio-closed descendant remains", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    let descendant: number | undefined;
    const firstReaperDelayEntered = createGate();
    const releaseFirstReaperDelay = createGate();
    let delayCalls = 0;
    let terminationSettlements = 0;
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      const events: ProcessHostEvent[] = [];
      host = testHost(fixture, ["descendant-close-stdio"], {
        stopGraceMs: 1,
        killGraceMs: 1_000,
      }, {
        delay: async () => {
          delayCalls += 1;
          if (delayCalls === 1) {
            firstReaperDelayEntered.release();
            await releaseFirstReaperDelay.wait;
          }
        },
      });
      host.onEvent((event) => events.push(event));
      const termination = host.waitForTermination();
      void termination.then(
        () => { terminationSettlements += 1; },
        () => { terminationSettlements += 1; },
      );
      const directClose = waitForEvent(host, "process_close");
      const pidLine = waitForStdout(host, "DESCENDANT:");
      group = (await startOwned(host, fixture)).processGroupId;
      descendant = registerDescendant(Number(/DESCENDANT:(\d+)/u.exec(await bounded(pidLine))?.[1]), group, fixture);
      assert.ok(descendant > 0);
      await bounded(directClose);
      await bounded(firstReaperDelayEntered.wait);
      const activeDescendant = descendant as number;
      const activeGroup = group as number;
      assert.equal(terminationSettlements, 0);
      assert.equal(events.some((event) => event.type === "reaped"), false);
      assert.doesNotThrow(() => process.kill(activeDescendant, 0));
      assert.doesNotThrow(() => process.kill(-activeGroup, 0));
      assert.equal((await stagedDirectories(fixture.stagingRoot)).length, 1);
      await access(sentinel);
      releaseFirstReaperDelay.release();
      const receipt = await bounded(termination);
      assert.equal(receipt.type, "stop_reaped");
      await eventuallyGone(group, true);
      await eventuallyGone(descendant);
      assertEsrch(group, true);
      assertEsrch(descendant);
      assert.equal(terminationSettlements, 1);
      assert.equal(events.filter((event) => event.type === "reaped").length, 1);
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
      await access(sentinel);
    } finally {
      releaseFirstReaperDelay.release();
      await cleanup(host, group, descendant);
      await fixture.remove();
    }
  });

  it("caches identical stop promises during successful and failed starts", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      host = testHost(fixture, ["linger"]);
      const start = host.start();
      const first = host.stop();
      const second = host.stop();
      assert.strictEqual(first, second);
      const receipt = await bounded(first);
      const started = await bounded(start);
      group = registerGroup(started, fixture);
      assert.equal(receipt.processGroupId, started.processGroupId);
      assert.equal(receipt.stopRequested, true);
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }

    const failed = await prepareFixture();
    try {
      const host = new GrokProcessHost({
        ...options(failed),
        executablePath: join(failed.directory, "agent"),
        expectedSha256: sha256Of(await readFile(join(failed.directory, "agent"))),
      });
      const start = host.start();
      const first = host.stop();
      const second = host.stop();
      assert.strictEqual(first, second);
      await assert.rejects(bounded(start), isFailure("preflight_failure", "not_macho"));
      await assert.rejects(bounded(first), isFailure("preflight_failure", "not_macho"));
    } finally {
      await failed.remove();
    }
  });

  it("reserves automatic reaping before stop_requested listener re-entry", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    let descendant: number | undefined;
    try {
      const events: ProcessHostEvent[] = [];
      let listenerStop: Promise<unknown> | undefined;
      host = testHost(fixture, ["descendant-close-stdio"], { stopGraceMs: 40, killGraceMs: 1_000 });
      host.onEvent((event) => {
        events.push(event);
        if (event.type === "stop_requested") {
          listenerStop = host?.stop();
        }
      });
      const pidLine = waitForStdout(host, "DESCENDANT:");
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      descendant = registerDescendant(Number(/DESCENDANT:(\d+)/u.exec(await bounded(pidLine))?.[1]), group, fixture);
      const receipt = await bounded(host.waitForTermination());
      assert.equal(receipt.type, "stop_reaped");
      assert.ok(listenerStop !== undefined);
      assert.strictEqual(listenerStop, host.stop());
      assert.equal(events.filter((event) => event.type === "stop_requested").length, 1);
      assert.equal(events.filter((event) => event.type === "reaped").length, 1);
      if (receipt.type === "stop_reaped") {
        assert.equal(receipt.groupTermSignal.outcome, "sent");
        assert.deepEqual(receipt.groupKillSignal, { signal: "SIGKILL", outcome: "sent" });
      }
    } finally {
      await cleanup(host, group, descendant);
      await fixture.remove();
    }
  });

  it("caches irreversible group-gone evidence before direct close and does not KILL", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    try {
      let termRequests = 0;
      let killRequests = 0;
      let termRequested = false;
      const lifecycle: ProcessHostTestConfiguration = {
        signalGroup: (processGroupId, signal) => {
          if (signal === "SIGTERM") {
            termRequests += 1;
            termRequested = true;
            process.kill(-processGroupId, signal);
            return { signal, outcome: "sent" };
          }
          killRequests += 1;
          return { signal, outcome: "sent" };
        },
        probeGroup: (processGroupId) => termRequested ? "already_gone" : realProbe(processGroupId),
      };
      host = testHost(fixture, ["linger"], { stopGraceMs: 200, killGraceMs: 200 }, lifecycle);
      const ready = waitForStdout(host, "READY\n");
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      const receipt = await bounded(host.stop());
      assert.equal(termRequests, 1);
      assert.equal(killRequests, 0);
      assert.equal(receipt.groupGoneObserved, true);
      assert.equal(receipt.groupKillSignal, undefined);
      assert.equal(receipt.groupTermSignal.outcome, "sent");
    } finally {
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("clears the referenced cleanup deadline when cleanup completes first", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    let audit: ReturnType<typeof installDeadlineTimerAudit> | undefined;
    try {
      host = testHost(fixture, ["linger"], {}, { cleanupDeadlineMs: 137 });
      const ready = waitForStdout(host, "READY\n");
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      audit = installDeadlineTimerAudit(137);
      const stop = host.stop();
      const deadline = await bounded(audit.created, 4_000);
      const receipt = await bounded(stop, 4_000);
      assert.deepEqual(receipt.cleanup, {
        stageHandleClosed: true,
        stagingDirectoryRemoved: true,
        failure: "none",
      });
      assert.equal(audit.records.length, 1);
      assert.equal(deadline.cleared, true);
      assert.equal(deadline.fired, false);
    } finally {
      audit?.restore();
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("settles successful reap within the cleanup deadline when cleanup never resolves", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    let realCleanup: (() => Promise<PinnedExecutableCleanup>) | undefined;
    let audit: ReturnType<typeof installDeadlineTimerAudit> | undefined;
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      const events: ProcessHostEvent[] = [];
      host = testHost(fixture, ["linger"], {}, {
        cleanupDeadlineMs: 139,
        cleanupPinned: (pinned) => {
          realCleanup = () => pinned.cleanup();
          return new Promise<PinnedExecutableCleanup>(() => undefined);
        },
      });
      host.onEvent((event) => events.push(event));
      const ready = waitForStdout(host, "READY\n");
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      const termination = host.waitForTermination();
      audit = installDeadlineTimerAudit(139);
      const stop = host.stop();
      const deadline = await bounded(audit.created, 4_000);
      assert.equal(audit.records.length, 1);
      assert.equal(deadline.handle.hasRef(), true);
      assert.equal(deadline.cleared, false);
      assert.equal(deadline.fired, false);
      const [receipt, terminationEvidence] = await Promise.all([
        bounded(stop, 4_000),
        bounded(termination, 4_000),
      ]);
      assert.equal(deadline.fired, true);
      assert.equal(deadline.cleared, true);
      assert.strictEqual(receipt, terminationEvidence);
      assert.deepEqual(receipt.cleanup, {
        status: "timed_out",
        stageHandleClosed: "unknown",
        stagingDirectoryRemoved: "unknown",
        failure: "cleanup_pending",
      });
      assert.equal(events.filter((event) => event.type === "reaped").length, 1);
      assert.equal(events.filter((event) => event.type === "stop_failure").length, 0);
      assert.equal((await stagedDirectories(fixture.stagingRoot)).length, 1);
      await access(sentinel);
      assert.ok(realCleanup !== undefined);
      await realCleanup();
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
    } finally {
      audit?.restore();
      await realCleanup?.().catch(() => undefined);
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("emits one bounded late diagnostic when timed-out cleanup later completes", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    const cleanupGate = createGate();
    try {
      const events: ProcessHostEvent[] = [];
      host = testHost(fixture, ["linger"], {}, {
        cleanupDeadlineMs: 20,
        cleanupPinned: async (pinned) => {
          await cleanupGate.wait;
          return pinned.cleanup();
        },
      });
      host.onEvent((event) => events.push(event));
      const lateResult = waitForEvent(host, "cleanup_late_result");
      const ready = waitForStdout(host, "READY\n");
      group = (await startOwned(host, fixture)).processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      const receipt = await bounded(host.stop(), 4_000);
      assert.equal(receipt.cleanup.failure, "cleanup_pending");
      cleanupGate.release();
      const late = await bounded(lateResult, 500);
      assert.deepEqual(late.result, {
        stageHandleClosed: true,
        stagingDirectoryRemoved: true,
        failure: "none",
      });
      assert.equal(events.filter((event) => event.type === "cleanup_late_result").length, 1);
      assert.equal(events.filter((event) => event.type === "reaped").length, 1);
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
    } finally {
      cleanupGate.release();
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("shares one bounded reap-timeout error when cleanup never resolves", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    let realCleanup: (() => Promise<PinnedExecutableCleanup>) | undefined;
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      const signalRequests: string[] = [];
      const events: ProcessHostEvent[] = [];
      const lifecycle: ProcessHostTestConfiguration = {
        cleanupDeadlineMs: 20,
        cleanupPinned: (pinned) => {
          realCleanup = () => pinned.cleanup();
          return new Promise<PinnedExecutableCleanup>(() => undefined);
        },
        signalGroup: (processGroupId, signal) => {
          signalRequests.push(signal);
          if (signal === "SIGKILL") {
            // The lifecycle seam still reports the synthetic failure needed by
            // this test. Kill only the registered fixture group underneath it
            // so a failed assertion cannot strand a real child on a CI host.
            try {
              process.kill(-processGroupId, "SIGKILL");
            } catch (cause: unknown) {
              if ((cause as { readonly code?: string }).code !== "ESRCH") throw cause;
            }
          }
          return { signal, outcome: "failed", errorCode: "EPERM" };
        },
        probeGroup: () => "present",
      };
      host = testHost(fixture, ["ignore-term"], { stopGraceMs: 30, killGraceMs: 30 }, lifecycle);
      host.onEvent((event) => events.push(event));
      const ready = waitForStdout(host, "READY\n");
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      const termination = host.waitForTermination();
      const first = host.stop();
      const second = host.stop();
      assert.strictEqual(first, second);
      const [stopResult, terminationResult] = await Promise.allSettled([bounded(first, 1_000), bounded(termination, 1_000)]);
      assert.equal(stopResult.status, "rejected");
      assert.equal(terminationResult.status, "rejected");
      assert.strictEqual(stopResult.reason, terminationResult.reason);
      assert.ok(stopResult.reason instanceof GrokProcessHostError);
      assert.equal(stopResult.reason.failure.type, "reap_timeout");
      assert.equal(stopResult.reason.failure.timeoutMs, 60);
      assert.deepEqual(stopResult.reason.failure.groupTermSignal, { signal: "SIGTERM", outcome: "failed", errorCode: "EPERM" });
      assert.deepEqual(stopResult.reason.failure.groupKillSignal, { signal: "SIGKILL", outcome: "failed", errorCode: "EPERM" });
      assert.equal(host.state, "failed");
      assert.strictEqual(first, host.stop());
      assert.deepEqual(signalRequests, ["SIGTERM", "SIGKILL"]);
      const terminal = events.filter((event): event is Extract<ProcessHostEvent, { type: "stop_failure" }> => event.type === "stop_failure");
      assert.equal(terminal.length, 1);
      assert.deepEqual(terminal[0]?.cleanup, {
        status: "timed_out",
        stageHandleClosed: "unknown",
        stagingDirectoryRemoved: "unknown",
        failure: "cleanup_pending",
      });
      assert.equal(events.filter((event) => event.type === "reaped").length, 0);
      assert.equal((await stagedDirectories(fixture.stagingRoot)).length, 1);
      await access(sentinel);
      assert.ok(realCleanup !== undefined);
      await realCleanup();
      assert.deepEqual(await stagedDirectories(fixture.stagingRoot), []);
    } finally {
      await realCleanup?.().catch(() => undefined);
      await cleanup(host, group);
      await fixture.remove();
    }
  });

  it("keeps group-reaped evidence separate from an injected private-stage cleanup failure", async () => {
    const fixture = await prepareFixture();
    let host: TestHost | undefined;
    let group: number | undefined;
    const sentinel = join(fixture.stagingRoot, "sibling-sentinel");
    try {
      await mkdir(sentinel, { mode: 0o700 });
      host = testHost(fixture, ["linger"]);
      const ready = waitForStdout(host, "READY\n");
      const started = await startOwned(host, fixture);
      group = started.processGroupId;
      await bounded(ready, FIXTURE_STARTUP_TIMEOUT_MS);
      await chmod(fixture.stagingRoot, 0o500);
      const receipt = await bounded(host.stop());
      assert.equal(receipt.groupGoneObserved, true);
      assert.deepEqual(receipt.cleanup, {
        stageHandleClosed: true,
        stagingDirectoryRemoved: false,
        failure: "staging_directory_remove_failed",
      });
      assert.equal((await stagedDirectories(fixture.stagingRoot)).length, 1);
      await access(sentinel);
      await eventuallyGone(group, true);
    } finally {
      await chmod(fixture.stagingRoot, 0o700).catch(() => undefined);
      await cleanup(host, group);
      await fixture.remove();
    }
  });
});
