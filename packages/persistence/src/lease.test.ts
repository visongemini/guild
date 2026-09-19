import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import {
  acquireDatabaseLease,
  type DatabaseLeaseErrorCode,
} from "./lease.js";

type WorkerMessage =
  | {
      readonly type: "acquired";
      readonly canonicalDatabasePath: string;
      readonly recoveredStaleOwner: boolean;
    }
  | {
      readonly type: "error";
      readonly code: DatabaseLeaseErrorCode | "unknown";
    }
  | {
      readonly type: "released";
      readonly requestId: string;
      readonly released: boolean;
    };

const WORKER_SOURCE = String.raw`
const { acquireDatabaseLease } = await import(process.env.GUILD_LEASE_MODULE_URL);

function send(message, callback) {
  if (typeof process.send !== "function") throw new Error("ipc unavailable");
  process.send(message, callback);
}

try {
  const lease = acquireDatabaseLease(process.env.GUILD_LEASE_DATABASE_PATH);
  send({
    type: "acquired",
    canonicalDatabasePath: lease.canonicalDatabasePath,
    recoveredStaleOwner: lease.recoveredStaleOwner,
  });
  process.on("message", (message) => {
    if (message?.action === "release") {
      send({
        type: "released",
        requestId: message.requestId,
        released: lease.release(),
      });
    } else if (message?.action === "exit") {
      process.exit(0);
    }
  });
} catch (error) {
  send(
    {
      type: "error",
      code:
        error && typeof error === "object" && typeof error.code === "string"
          ? error.code
          : "unknown",
    },
    () => process.exit(23),
  );
}
`;

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "guild-lease-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function spawnLeaseWorker(databasePath: string, t: TestContext): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", WORKER_SOURCE],
    {
      env: {
        ...process.env,
        GUILD_LEASE_DATABASE_PATH: databasePath,
        GUILD_LEASE_MODULE_URL: new URL("./lease.js", import.meta.url).href,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  return child;
}

function childDiagnostics(child: ChildProcess): Promise<() => string> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return Promise.resolve(() => `stdout=${stdout}\nstderr=${stderr}`);
}

function waitForMessage(
  child: ChildProcess,
  predicate: (message: WorkerMessage) => boolean,
  diagnostics: () => string,
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child message\n${diagnostics()}`));
    }, 8_000);

    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        !predicate(message as WorkerMessage)
      ) {
        return;
      }
      cleanup();
      resolve(message as WorkerMessage);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `child exited before expected message (code=${String(code)}, signal=${String(signal)})\n${diagnostics()}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function releaseWorkerLease(
  child: ChildProcess,
  diagnostics: () => string,
): Promise<boolean> {
  const requestId = randomUUID();
  const response = waitForMessage(
    child,
    (message) =>
      message.type === "released" && message.requestId === requestId,
    diagnostics,
  );
  child.send({ action: "release", requestId });
  const message = await response;
  assert.equal(message.type, "released");
  return message.released;
}

async function stopWorker(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.send({ action: "exit" });
  await waitForExit(child);
}

describe("cross-process database writer lease", () => {
  it("keeps the authoritative database locked after a denied same-process acquisition", async (t) => {
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const holder = acquireDatabaseLease(databasePath);
    if (process.platform !== "win32") {
      assert.equal(statSync(holder.canonicalDatabasePath).mode & 0o777, 0o600);
      assert.equal(
        statSync(
          `${holder.canonicalDatabasePath}.guild-writer-guard.sqlite3`,
        ).mode & 0o777,
        0o600,
      );
    }

    assert.throws(
      () => acquireDatabaseLease(databasePath),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "database_lease_held",
    );

    const duplicateModuleUrl = new URL("./lease.js", import.meta.url);
    duplicateModuleUrl.searchParams.set("duplicate", randomUUID());
    const duplicateModule = await import(duplicateModuleUrl.href) as {
      readonly acquireDatabaseLease: typeof acquireDatabaseLease;
    };
    assert.throws(
      () => duplicateModule.acquireDatabaseLease(databasePath),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "database_lease_held",
    );

    const externalContender = spawnLeaseWorker(databasePath, t);
    const diagnostics = await childDiagnostics(externalContender);
    const denied = await waitForMessage(
      externalContender,
      (message) => message.type === "error",
      diagnostics,
    );
    assert.deepEqual(denied, {
      type: "error",
      code: "database_lease_held",
    });
    await waitForExit(externalContender);
    assert.equal(holder.release(), true);
  });

  it("denies a concurrent process and releases idempotently", async (t) => {
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const holder = spawnLeaseWorker(databasePath, t);
    const holderDiagnostics = await childDiagnostics(holder);
    const acquired = await waitForMessage(
      holder,
      (message) => message.type === "acquired",
      holderDiagnostics,
    );
    assert.equal(acquired.type, "acquired");
    assert.equal(acquired.recoveredStaleOwner, false);
    assert.equal(existsSync(databasePath), true);

    const contender = spawnLeaseWorker(databasePath, t);
    const contenderDiagnostics = await childDiagnostics(contender);
    const denied = await waitForMessage(
      contender,
      (message) => message.type === "error",
      contenderDiagnostics,
    );
    assert.deepEqual(denied, {
      type: "error",
      code: "database_lease_held",
    });
    await waitForExit(contender);

    assert.equal(await releaseWorkerLease(holder, holderDiagnostics), true);
    assert.equal(await releaseWorkerLease(holder, holderDiagnostics), false);
    await stopWorker(holder);

    const successor = spawnLeaseWorker(databasePath, t);
    const successorDiagnostics = await childDiagnostics(successor);
    const successorAcquired = await waitForMessage(
      successor,
      (message) => message.type === "acquired",
      successorDiagnostics,
    );
    assert.equal(successorAcquired.type, "acquired");
    assert.equal(successorAcquired.recoveredStaleOwner, false);
    assert.equal(await releaseWorkerLease(successor, successorDiagnostics), true);
    await stopWorker(successor);
    assert.equal(existsSync(databasePath), true);
  });

  it("recovers the stale lease after its owning process is killed", async (t) => {
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const holder = spawnLeaseWorker(databasePath, t);
    const holderDiagnostics = await childDiagnostics(holder);
    await waitForMessage(
      holder,
      (message) => message.type === "acquired",
      holderDiagnostics,
    );
    assert.equal(holder.kill("SIGKILL"), true);
    await waitForExit(holder);

    const recovery = spawnLeaseWorker(databasePath, t);
    const recoveryDiagnostics = await childDiagnostics(recovery);
    const recovered = await waitForMessage(
      recovery,
      (message) => message.type === "acquired",
      recoveryDiagnostics,
    );
    assert.equal(recovered.type, "acquired");
    assert.equal(recovered.recoveredStaleOwner, true);
    assert.equal(await releaseWorkerLease(recovery, recoveryDiagnostics), true);
    await stopWorker(recovery);
    assert.equal(existsSync(databasePath), true);
  });

  it("elects exactly one winner when two processes recover the same stale owner", async (t) => {
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const holder = spawnLeaseWorker(databasePath, t);
    const holderDiagnostics = await childDiagnostics(holder);
    await waitForMessage(
      holder,
      (message) => message.type === "acquired",
      holderDiagnostics,
    );
    assert.equal(holder.kill("SIGKILL"), true);
    await waitForExit(holder);

    const first = spawnLeaseWorker(databasePath, t);
    const second = spawnLeaseWorker(databasePath, t);
    const firstDiagnostics = await childDiagnostics(first);
    const secondDiagnostics = await childDiagnostics(second);
    const [firstResult, secondResult] = await Promise.all([
      waitForMessage(first, () => true, firstDiagnostics),
      waitForMessage(second, () => true, secondDiagnostics),
    ]);
    const results = [firstResult, secondResult];
    assert.equal(
      results.filter((message) => message.type === "acquired").length,
      1,
    );
    const recoveredWinner = results.find(
      (message) => message.type === "acquired",
    );
    assert.equal(recoveredWinner?.type, "acquired");
    assert.equal(
      recoveredWinner?.type === "acquired"
        ? recoveredWinner.recoveredStaleOwner
        : undefined,
      true,
    );
    assert.equal(
      results.filter(
        (message) =>
          message.type === "error" &&
          message.code === "database_lease_held",
      ).length,
      1,
    );

    const winner = firstResult.type === "acquired" ? first : second;
    const winnerDiagnostics =
      firstResult.type === "acquired" ? firstDiagnostics : secondDiagnostics;
    const loser = winner === first ? second : first;
    assert.equal(await releaseWorkerLease(winner, winnerDiagnostics), true);
    await stopWorker(winner);
    await waitForExit(loser);
    assert.equal(existsSync(databasePath), true);
  });

  it("collides through a symlinked parent on one canonical database", async (t) => {
    const directory = temporaryDirectory(t);
    const realParent = join(directory, "real");
    const aliasParent = join(directory, "alias");
    mkdirSync(realParent);
    try {
      symlinkSync(
        realParent,
        aliasParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "EACCES" || code === "EPERM") {
        t.skip("directory symlinks are unavailable for this user");
        return;
      }
      throw error;
    }

    const realDatabasePath = join(realParent, "guild.sqlite3");
    const aliasDatabasePath = join(aliasParent, "guild.sqlite3");
    const expectedCanonicalPath = join(
      realpathSync.native(realParent),
      "guild.sqlite3",
    );

    const holder = spawnLeaseWorker(realDatabasePath, t);
    const holderDiagnostics = await childDiagnostics(holder);
    const acquired = await waitForMessage(
      holder,
      (message) => message.type === "acquired",
      holderDiagnostics,
    );
    assert.deepEqual(acquired, {
      type: "acquired",
      canonicalDatabasePath: expectedCanonicalPath,
      recoveredStaleOwner: false,
    });

    const contender = spawnLeaseWorker(aliasDatabasePath, t);
    const contenderDiagnostics = await childDiagnostics(contender);
    const denied = await waitForMessage(
      contender,
      (message) => message.type === "error",
      contenderDiagnostics,
    );
    assert.deepEqual(denied, {
      type: "error",
      code: "database_lease_held",
    });
    await waitForExit(contender);
    assert.equal(await releaseWorkerLease(holder, holderDiagnostics), true);
    await stopWorker(holder);

    const aliasHolder = spawnLeaseWorker(aliasDatabasePath, t);
    const aliasDiagnostics = await childDiagnostics(aliasHolder);
    const aliasAcquired = await waitForMessage(
      aliasHolder,
      (message) => message.type === "acquired",
      aliasDiagnostics,
    );
    assert.deepEqual(aliasAcquired, {
      type: "acquired",
      canonicalDatabasePath: expectedCanonicalPath,
      recoveredStaleOwner: false,
    });
    assert.equal(await releaseWorkerLease(aliasHolder, aliasDiagnostics), true);
    await stopWorker(aliasHolder);
    assert.equal(existsSync(realDatabasePath), true);
    assert.equal(existsSync(aliasDatabasePath), true);
  });

  it("checks the owner token before release", (t) => {
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const lease = acquireDatabaseLease(databasePath);
    const ownerPath = `${lease.canonicalDatabasePath}.guild-writer-lease/owner.json`;
    const originalOwner = readFileSync(ownerPath, "utf8");
    const changedOwner = JSON.parse(originalOwner) as Record<string, unknown>;
    changedOwner["ownerToken"] = randomUUID();
    writeFileSync(ownerPath, `${JSON.stringify(changedOwner)}\n`, "utf8");

    assert.equal(lease.release(), false);
    assert.equal(existsSync(ownerPath), true);
    assert.equal(lease.release(), false);
    assert.equal(existsSync(databasePath), true);

    const successor = acquireDatabaseLease(databasePath);
    assert.equal(successor.recoveredStaleOwner, true);
    assert.equal(successor.release(), true);
  });

  it("rejects a dangling final-component symlink instead of leasing its alias path", (t) => {
    const directory = temporaryDirectory(t);
    const missingTarget = join(directory, "missing", "guild.sqlite3");
    const databasePath = join(directory, "guild.sqlite3");
    try {
      symlinkSync(missingTarget, databasePath, "file");
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "EACCES" || code === "EPERM") {
        t.skip("file symlinks are unavailable for this user");
        return;
      }
      throw error;
    }

    assert.throws(
      () => acquireDatabaseLease(databasePath),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "database_path_invalid",
    );
    assert.equal(
      existsSync(`${databasePath}.guild-writer-lease`),
      false,
    );
    assert.equal(existsSync(missingTarget), false);
  });

  it("rejects pre-existing hard-link aliases for one database inode", (t) => {
    const directory = temporaryDirectory(t);
    const firstPath = join(directory, "first.sqlite3");
    const aliasPath = join(directory, "alias.sqlite3");
    writeFileSync(firstPath, "", { encoding: "utf8", mode: 0o600 });
    linkSync(firstPath, aliasPath);
    assert.equal(statSync(firstPath).ino, statSync(aliasPath).ino);

    for (const path of [firstPath, aliasPath]) {
      assert.throws(
        () => acquireDatabaseLease(path),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "database_path_invalid",
      );
    }
  });

  it("rejects a hard-link alias added after the writer is already live", async (t) => {
    const directory = temporaryDirectory(t);
    const databasePath = join(directory, "guild.sqlite3");
    const aliasPath = join(directory, "alias.sqlite3");
    const holder = acquireDatabaseLease(databasePath);
    linkSync(databasePath, aliasPath);

    const contender = spawnLeaseWorker(aliasPath, t);
    const diagnostics = await childDiagnostics(contender);
    const denied = await waitForMessage(
      contender,
      (message) => message.type === "error",
      diagnostics,
    );
    assert.deepEqual(denied, {
      type: "error",
      code: "database_path_invalid",
    });
    await waitForExit(contender);
    assert.equal(holder.release(), true);
  });

  it("retains one Guild lock if an unrelated descriptor closes either SQLite file", async (t) => {
    for (const target of ["database", "guard"] as const) {
      const databasePath = join(
        temporaryDirectory(t),
        `${target}.sqlite3`,
      );
      const holder = acquireDatabaseLease(databasePath);
      const descriptor = openSync(
        target === "database"
          ? holder.canonicalDatabasePath
          : `${holder.canonicalDatabasePath}.guild-writer-guard.sqlite3`,
        "r",
      );
      closeSync(descriptor);

      const contender = spawnLeaseWorker(databasePath, t);
      const diagnostics = await childDiagnostics(contender);
      const denied = await waitForMessage(
        contender,
        (message) => message.type === "error",
        diagnostics,
      );
      assert.deepEqual(denied, {
        type: "error",
        code: "database_lease_held",
      });
      await waitForExit(contender);
      assert.equal(holder.release(), true);
    }
  });

  it("keeps the same database inode locked after its path is renamed", async (t) => {
    const directory = temporaryDirectory(t);
    const originalPath = join(directory, "guild.sqlite3");
    const renamedPath = join(directory, "renamed.sqlite3");
    const holder = spawnLeaseWorker(originalPath, t);
    const holderDiagnostics = await childDiagnostics(holder);
    await waitForMessage(
      holder,
      (message) => message.type === "acquired",
      holderDiagnostics,
    );

    renameSync(originalPath, renamedPath);
    writeFileSync(originalPath, "", { encoding: "utf8", mode: 0o600 });

    const originalContender = spawnLeaseWorker(originalPath, t);
    const originalDiagnostics = await childDiagnostics(originalContender);
    const originalDenied = await waitForMessage(
      originalContender,
      (message) => message.type === "error",
      originalDiagnostics,
    );
    assert.deepEqual(originalDenied, {
      type: "error",
      code: "database_lease_held",
    });
    await waitForExit(originalContender);

    const contender = spawnLeaseWorker(renamedPath, t);
    const contenderDiagnostics = await childDiagnostics(contender);
    const denied = await waitForMessage(
      contender,
      (message) => message.type === "error",
      contenderDiagnostics,
    );
    assert.deepEqual(denied, {
      type: "error",
      code: "database_lease_held",
    });
    await waitForExit(contender);

    assert.equal(await releaseWorkerLease(holder, holderDiagnostics), true);
    await stopWorker(holder);
    const successor = spawnLeaseWorker(renamedPath, t);
    const successorDiagnostics = await childDiagnostics(successor);
    const acquired = await waitForMessage(
      successor,
      (message) => message.type === "acquired",
      successorDiagnostics,
    );
    assert.equal(acquired.type, "acquired");
    assert.equal(await releaseWorkerLease(successor, successorDiagnostics), true);
    await stopWorker(successor);
  });

  it("keeps the authoritative inode locked after the path guard is renamed", async (t) => {
    const directory = temporaryDirectory(t);
    const databasePath = join(directory, "guild.sqlite3");
    const holder = spawnLeaseWorker(databasePath, t);
    const holderDiagnostics = await childDiagnostics(holder);
    await waitForMessage(
      holder,
      (message) => message.type === "acquired",
      holderDiagnostics,
    );

    const guardPath = `${databasePath}.guild-writer-guard.sqlite3`;
    renameSync(guardPath, `${guardPath}.moved`);
    const contender = spawnLeaseWorker(databasePath, t);
    const contenderDiagnostics = await childDiagnostics(contender);
    const denied = await waitForMessage(
      contender,
      (message) => message.type === "error",
      contenderDiagnostics,
    );
    assert.deepEqual(denied, {
      type: "error",
      code: "database_lease_held",
    });
    await waitForExit(contender);
    assert.equal(await releaseWorkerLease(holder, holderDiagnostics), true);
    await stopWorker(holder);

    const successor = spawnLeaseWorker(databasePath, t);
    const successorDiagnostics = await childDiagnostics(successor);
    const acquired = await waitForMessage(
      successor,
      (message) => message.type === "acquired",
      successorDiagnostics,
    );
    assert.equal(acquired.type, "acquired");
    assert.equal(await releaseWorkerLease(successor, successorDiagnostics), true);
    await stopWorker(successor);
  });

  it("rejects a Worker realm before it can create either lease file", async (t) => {
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        import(workerData.moduleUrl).then(({ acquireDatabaseLease }) => {
          try {
            acquireDatabaseLease(workerData.databasePath);
            parentPort.postMessage({ acquired: true });
          } catch (error) {
            parentPort.postMessage({
              acquired: false,
              code: error && typeof error === "object" ? error.code : undefined,
            });
          }
        }).catch((error) => parentPort.postMessage({
          acquired: false,
          importError: String(error),
        }));
      `,
      {
        eval: true,
        workerData: {
          databasePath,
          moduleUrl: new URL("./lease.js", import.meta.url).href,
        },
      },
    );
    t.after(() => worker.terminate());
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      },
    );
    assert.deepEqual(result, {
      acquired: false,
      code: "database_lease_io_failed",
    });
    assert.equal(existsSync(databasePath), false);
    assert.equal(
      existsSync(`${databasePath}.guild-writer-guard.sqlite3`),
      false,
    );
  });

  it("relinquishes a published lease and preserves recovery evidence when post-publish scanning fails", (t) => {
    const directory = temporaryDirectory(t);
    const databasePath = join(directory, "guild.sqlite3");
    chmodSync(directory, 0o300);
    try {
      assert.throws(
        () => acquireDatabaseLease(databasePath),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "database_lease_io_failed",
      );
      assert.equal(
        existsSync(`${databasePath}.guild-writer-lease`),
        false,
      );
    } finally {
      chmodSync(directory, 0o700);
    }

    const successor = acquireDatabaseLease(databasePath);
    assert.equal(successor.recoveredStaleOwner, true);
    assert.equal(successor.release(), true);
  });

  it("closes both connections when owner metadata cannot be read during release", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX permission injection");
      return;
    }
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const lease = acquireDatabaseLease(databasePath);
    const lockPath =
      `${lease.canonicalDatabasePath}.guild-writer-lease`;
    chmodSync(lockPath, 0o000);
    try {
      assert.throws(
        () => lease.release(),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "database_lease_io_failed",
      );
    } finally {
      chmodSync(lockPath, 0o700);
    }

    const successor = acquireDatabaseLease(databasePath);
    assert.equal(successor.recoveredStaleOwner, true);
    assert.equal(successor.release(), true);
  });

  it("closes both connections when its exact owner directory cannot be renamed", (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX permission injection");
      return;
    }
    const directory = temporaryDirectory(t);
    const databasePath = join(directory, "guild.sqlite3");
    const lease = acquireDatabaseLease(databasePath);
    chmodSync(directory, 0o500);
    try {
      assert.throws(
        () => lease.release(),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "database_lease_io_failed",
      );
    } finally {
      chmodSync(directory, 0o700);
    }

    const successor = acquireDatabaseLease(databasePath);
    assert.equal(successor.recoveredStaleOwner, true);
    assert.equal(successor.release(), true);
  });

  it("cleans only recovery evidence observed by this lease and never later evidence", async (t) => {
    const databasePath = join(temporaryDirectory(t), "guild.sqlite3");
    const crashedOwner = spawnLeaseWorker(databasePath, t);
    const crashedDiagnostics = await childDiagnostics(crashedOwner);
    await waitForMessage(
      crashedOwner,
      (message) => message.type === "acquired",
      crashedDiagnostics,
    );
    assert.equal(crashedOwner.kill("SIGKILL"), true);
    await waitForExit(crashedOwner);

    const recovery = acquireDatabaseLease(databasePath);
    assert.equal(recovery.recoveredStaleOwner, true);

    // Model recovery evidence published after this owner took its acquisition
    // snapshot. A clean release may remove inherited evidence, but not this.
    const laterToken = randomUUID();
    const laterEvidence =
      `${recovery.canonicalDatabasePath}.guild-writer-lease.stale-${laterToken}`;
    mkdirSync(laterEvidence, { mode: 0o700 });
    writeFileSync(
      join(laterEvidence, "owner.json"),
      `${JSON.stringify({
        canonicalDatabasePath: recovery.canonicalDatabasePath,
        createdAtEpochMs: Date.now(),
        ownerPid: process.pid,
        ownerToken: laterToken,
        version: 2,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    assert.equal(recovery.release(), true);
    assert.equal(existsSync(laterEvidence), true);

    const successor = acquireDatabaseLease(databasePath);
    assert.equal(successor.recoveredStaleOwner, true);
    assert.equal(successor.release(), true);
    assert.equal(existsSync(laterEvidence), false);
  });

  it("recovers a stale owner even when its PID now belongs to a live unrelated process", (t) => {
    const directory = temporaryDirectory(t);
    const canonicalDatabasePath = join(
      realpathSync.native(directory),
      "guild.sqlite3",
    );
    const staleOwnerToken = randomUUID();
    const staleLockPath =
      `${canonicalDatabasePath}.guild-writer-lease`;
    mkdirSync(staleLockPath, { mode: 0o700 });
    writeFileSync(
      join(staleLockPath, "owner.json"),
      `${JSON.stringify({
        canonicalDatabasePath,
        createdAtEpochMs: 1,
        ownerPid: process.pid,
        ownerToken: staleOwnerToken,
        version: 2,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const recovered = acquireDatabaseLease(canonicalDatabasePath);
    assert.equal(recovered.recoveredStaleOwner, true);
    assert.equal(recovered.release(), true);
  });
});
