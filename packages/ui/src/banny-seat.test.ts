import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { TaskSummaryProjection, WorkspaceProjection } from "@guild/contracts";
import {
  BANNY_PLACEMENT_STORAGE_KEY,
  BANNY_SEAT_STORAGE_KEY,
  bannyPlacementFromDrop,
  readBannyPlacement,
  resolveBannySeatTaskId,
  writeBannyPlacement,
} from "./banny-seat.js";

describe("Banny placement", () => {
  it("renders home only in the empty-task slot instead of across populated conversations", async () => {
    const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
    assert.match(source, /const bannyFloatsInWindow = bannyPlacement\.kind === "free";/u);
    assert.doesNotMatch(source, /bannyHomeVisible/u);
  });

  it("resolves exactly one visible task and rejects archived or missing seats", () => {
    const active = task("task-active", false);
    const archived = task("task-archived", true);
    const workspace = Object.freeze({
      workspaceId: "workspace-1" as WorkspaceProjection["workspaceId"],
      name: "Project",
      archived: false,
      tasks: Object.freeze([active, archived]),
    });

    assert.equal(resolveBannySeatTaskId([workspace], { kind: "task", taskId: active.taskId }), active.taskId);
    assert.equal(resolveBannySeatTaskId([workspace], { kind: "task", taskId: archived.taskId }), undefined);
    assert.equal(resolveBannySeatTaskId([workspace], { kind: "task", taskId: "task-missing" }), undefined);
    assert.equal(resolveBannySeatTaskId([{ ...workspace, archived: true }], { kind: "task", taskId: active.taskId }), undefined);
    assert.equal(resolveBannySeatTaskId([workspace], { kind: "home" }), undefined);
  });

  it("persists home, task and bounded free placements and migrates the legacy seat", () => {
    const values = new Map<string, string>();
    const storage = mapStorage(values);

    assert.deepEqual(readBannyPlacement(storage), { kind: "home" });
    values.set(BANNY_SEAT_STORAGE_KEY, "task-legacy");
    assert.deepEqual(readBannyPlacement(storage), { kind: "task", taskId: "task-legacy" });

    writeBannyPlacement(storage, { kind: "free", x: 0.32, y: 0.77 });
    assert.deepEqual(readBannyPlacement(storage), { kind: "free", x: 0.32, y: 0.77 });
    assert.equal(values.has(BANNY_SEAT_STORAGE_KEY), false);
    assert.equal(values.has(BANNY_PLACEMENT_STORAGE_KEY), true);

    values.set(BANNY_PLACEMENT_STORAGE_KEY, JSON.stringify({ kind: "free", x: -1, y: 4 }));
    assert.deepEqual(readBannyPlacement(storage), { kind: "free", x: 0.04, y: 0.95 });
    writeBannyPlacement(storage, { kind: "home" });
    assert.deepEqual(readBannyPlacement(storage), { kind: "home" });
  });

  it("snaps a center drop home and keeps other window drops as normalized free seats", () => {
    const shell = { left: 100, top: 50, width: 1_000, height: 700 };
    const main = { left: 380, top: 100, width: 720, height: 560 };

    assert.deepEqual(bannyPlacementFromDrop(shell, main, 740, 380), { kind: "home" });
    assert.deepEqual(bannyPlacementFromDrop(shell, main, 1_040, 610), {
      kind: "free",
      x: 0.94,
      y: 0.8,
    });
    assert.deepEqual(bannyPlacementFromDrop(shell, main, -100, -100), {
      kind: "free",
      x: 0.04,
      y: 0.05,
    });
  });

  it("keeps storage failures decorative and harmless", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    assert.deepEqual(readBannyPlacement(blocked), { kind: "home" });
    assert.doesNotThrow(() => writeBannyPlacement(blocked, { kind: "task", taskId: "task-1" }));
  });
});

function mapStorage(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function task(taskId: string, archived: boolean): TaskSummaryProjection {
  return Object.freeze({
    taskId: taskId as TaskSummaryProjection["taskId"],
    workspaceId: "workspace-1" as WorkspaceProjection["workspaceId"],
    title: taskId,
    pinned: false,
    archived,
    updatedAtMs: 1,
    queuedTurnCount: 0,
  });
}
