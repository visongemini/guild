import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { describe, it } from "node:test";
import {
  MAX_DESCENDANTS,
  descendantsOutsideGroup,
  parseProcessTable,
  readChildIdentity,
  snapshotDescendants,
  terminateDescendants,
  type ProcessIdentity,
  type ProcessTableRow,
} from "./process-tree.js";

const STARTED = "Mon Oct 12 15:08:42 2026";
const row = (pid: number, ppid: number, pgid: number, startedAt = STARTED): ProcessTableRow =>
  Object.freeze({ pid, ppid, pgid, startedAt });
const identity = (pid: number, startedAt = STARTED): ProcessIdentity => Object.freeze({ pid, startedAt });

describe("engine process tree (PC-ENG-001)", () => {
  it("parses ps rows with the start time and skips anything else", () => {
    const rows = parseProcessTable([
      "  100     1   100 Mon Oct 12 15:08:42 2026",
      "  101   100   100 Mon Oct 12 15:08:43 2026",
      "garbage line",
      "  x   y   z not numeric",
      "",
    ].join("\n"));
    assert.deepEqual(rows, [row(100, 1, 100), row(101, 100, 100, "Mon Oct 12 15:08:43 2026")]);
  });

  it("selects the descendants outside the engine's group and nothing else", () => {
    const rows = [
      row(100, 1, 100), // the engine
      row(101, 100, 100), // its group member
      row(102, 101, 102), // a helper in a group of its own, below a group member
      row(103, 102, 102), // the helper's own child
      row(104, 103, 104), // and its child in yet another group
      row(200, 1, 200), // unrelated
      row(201, 200, 200), // unrelated child
      row(300, 1, 100), // re-parented to launchd, same group: not a descendant
    ];
    const snapshot = descendantsOutsideGroup(rows, identity(100), 100);
    assert.equal(snapshot.rootVerified, true);
    assert.deepEqual(snapshot.records.map((entry) => entry.pid), [102, 103, 104]);
  });

  it("attributes nothing when the engine is gone, the root is unusable or the set is implausible", () => {
    const rows = [row(102, 1, 102), row(103, 102, 102)];
    const gone = descendantsOutsideGroup(rows, identity(100), 100);
    assert.deepEqual(gone.records, [], "the engine is not in the table: its helpers were re-parented");
    assert.equal(gone.rootVerified, false);
    const init = descendantsOutsideGroup([row(1, 0, 1), row(5, 1, 5)], identity(1), 1);
    assert.deepEqual(init.records, [], "pid 1 is never a root");
    assert.equal(init.rootVerified, false);
    const crowd = [row(100, 1, 100), ...Array.from({ length: MAX_DESCENDANTS + 1 }, (_value, index) => row(1_000 + index, 100, 1_000 + index))];
    assert.deepEqual(descendantsOutsideGroup(crowd, identity(100), 100).records, []);
  });

  it("discards the snapshot when the root pid carries another start time, so a reused pid owns nothing [PC-ENG-001]", () => {
    // The engine exited and its pid was handed to an unrelated process that has children of its own.
    const rows = [
      row(100, 1, 100, "Tue Oct 13 09:00:00 2026"),
      row(101, 100, 101, "Tue Oct 13 09:00:01 2026"),
      row(102, 101, 101, "Tue Oct 13 09:00:02 2026"),
    ];
    const snapshot = descendantsOutsideGroup(rows, identity(100), 100);
    assert.equal(snapshot.rootVerified, false);
    assert.deepEqual(snapshot.records, []);
    // The same rows with the matching start time are attributed.
    const matching = descendantsOutsideGroup(rows, identity(100, "Tue Oct 13 09:00:00 2026"), 100);
    assert.equal(matching.rootVerified, true);
    assert.deepEqual(matching.records.map((entry) => entry.pid), [101, 102]);
  });

  it("yields only the escaped descendants of a root whose start time matches, never its neighbours [PC-ENG-001]", () => {
    const rows = [
      row(100, 1, 100),
      row(101, 100, 100), // in the engine's group: the group signal's business
      row(102, 100, 102), // escaped helper
      row(103, 102, 102), // the helper's child
      row(200, 1, 200), // a neighbour that is not below the root
      row(201, 200, 201), // and its own escaped child
    ];
    const snapshot = descendantsOutsideGroup(rows, identity(100), 100);
    assert.equal(snapshot.rootVerified, true);
    assert.deepEqual(snapshot.records.map((entry) => entry.pid), [102, 103]);
  });

  it("never selects Guild's own process, even as a table row below the root", () => {
    const rows = [row(100, 1, 100), row(process.pid, 100, 555)];
    assert.deepEqual(descendantsOutsideGroup(rows, identity(100), 100).records, []);
  });

  it("snapshots a real helper in its own session, ends it with its recorded identity, and leaves a changed one alone", { skip: process.platform === "win32" }, async () => {
    // The test process stands in for the engine: it is the root of the tree.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });
    const reused = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });
    helper.unref();
    reused.unref();
    try {
      const self = await tableRow(process.pid);
      const snapshot = await snapshotDescendants(identity(process.pid, self.startedAt), process.pid);
      assert.equal(snapshot.rootVerified, true);
      const found = snapshot.records.filter((entry) => entry.pid === helper.pid || entry.pid === reused.pid);
      assert.equal(found.length, 2, "both helpers sit outside this process's group and below it");
      const helperRecord = found.find((entry) => entry.pid === helper.pid)!;
      const reusedRecord = found.find((entry) => entry.pid === reused.pid)!;

      // A record whose start time no longer matches stands for a reused pid: it is not signalled.
      const changed = { ...reusedRecord, startedAt: "Thu Jan  1 00:00:00 1970" };
      assert.equal(await terminateDescendants([helperRecord, changed]), 1);
      await gone(helper.pid!);
      assert.doesNotThrow(() => process.kill(reused.pid!, 0), "the process that did not match is still running");
    } finally {
      for (const child of [helper, reused]) {
        try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("snapshots nothing from a real table whose root has another start time, and leaves the helper alone [PC-ENG-001]", { skip: process.platform === "win32" }, async () => {
    const helper = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });
    helper.unref();
    try {
      const self = await tableRow(process.pid);
      const other = "Thu Jan  1 00:00:00 1970";
      assert.notEqual(self.startedAt, other, "sanity: the tampered start time really differs");
      const snapshot = await snapshotDescendants(identity(process.pid, other), process.pid);
      assert.equal(snapshot.rootVerified, false);
      assert.deepEqual(snapshot.records, []);
      assert.doesNotThrow(() => process.kill(helper.pid!, 0), "nothing was signalled");
    } finally {
      try { process.kill(helper.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("reads the identity of a child of this process and of nothing else", { skip: process.platform === "win32" }, async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    try {
      const read = await readChildIdentity(child.pid!);
      assert.deepEqual(read, { pid: child.pid, startedAt: (await tableRow(child.pid!)).startedAt });
      assert.equal(await readChildIdentity(process.pid), undefined, "this process is not its own child");
      assert.equal(await readChildIdentity(process.ppid), undefined, "a parent is not a child");
      assert.equal(await readChildIdentity(1), undefined);
      assert.equal(await readChildIdentity(4_194_001), undefined, "a pid with no process has no identity");
    } finally {
      try { process.kill(child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("returns quietly for an empty snapshot and for processes that are already gone", async () => {
    assert.equal(await terminateDescendants([]), 0);
    assert.equal(await terminateDescendants([row(4_194_001, 1, 4_194_001)]), 0);
    assert.equal(await stillListed(process.pid), true, "sanity: the ps used here lists this process");
  });
});

function tableRow(pid: number): Promise<ProcessTableRow> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8" }, (error, stdout) => {
      const found = parseProcessTable(stdout)[0];
      if (found === undefined) reject(error ?? new Error(`no ps row for ${pid}`));
      else resolve(found);
    });
  });
}

async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} survived`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function stillListed(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8" }, (_error, stdout) => {
      resolve(stdout.trim() === String(pid));
    });
  });
}
