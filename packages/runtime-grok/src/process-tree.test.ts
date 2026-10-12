import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { describe, it } from "node:test";
import {
  MAX_DESCENDANTS,
  descendantsOutsideGroup,
  parseProcessTable,
  snapshotDescendants,
  terminateDescendants,
  type ProcessTableRow,
} from "./process-tree.js";

const row = (pid: number, ppid: number, pgid: number, startedAt = "Mon Oct 12 15:08:42 2026"): ProcessTableRow =>
  Object.freeze({ pid, ppid, pgid, startedAt });

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
    assert.deepEqual(descendantsOutsideGroup(rows, 100, 100).map((entry) => entry.pid), [102, 103, 104]);
  });

  it("attributes nothing when the engine is gone, the root is unusable or the set is implausible", () => {
    const rows = [row(102, 1, 102), row(103, 102, 102)];
    assert.deepEqual(descendantsOutsideGroup(rows, 100, 100), [], "the engine is not in the table: its helpers were re-parented");
    assert.deepEqual(descendantsOutsideGroup([row(1, 0, 1), row(5, 1, 5)], 1, 1), [], "pid 1 is never a root");
    const crowd = [row(100, 1, 100), ...Array.from({ length: MAX_DESCENDANTS + 1 }, (_value, index) => row(1_000 + index, 100, 1_000 + index))];
    assert.deepEqual(descendantsOutsideGroup(crowd, 100, 100), []);
  });

  it("never selects Guild's own process, even as a table row below the root", () => {
    const rows = [row(100, 1, 100), row(process.pid, 100, 555)];
    assert.deepEqual(descendantsOutsideGroup(rows, 100, 100), []);
  });

  it("snapshots a real helper in its own session, ends it with its recorded identity, and leaves a changed one alone", { skip: process.platform === "win32" }, async () => {
    // The test process stands in for the engine: it is the root of the tree.
    const helper = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });
    const reused = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, stdio: "ignore" });
    helper.unref();
    reused.unref();
    try {
      const snapshot = await snapshotDescendants(process.pid, process.pid);
      const found = snapshot.filter((entry) => entry.pid === helper.pid || entry.pid === reused.pid);
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

  it("returns quietly for an empty snapshot and for processes that are already gone", async () => {
    assert.equal(await terminateDescendants([]), 0);
    assert.equal(await terminateDescendants([row(4_194_001, 1, 4_194_001)]), 0);
    assert.equal(await stillListed(process.pid), true, "sanity: the ps used here lists this process");
  });
});

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
