import assert from "node:assert/strict";
import test from "node:test";
import type { RunPhaseProjection, TimelineItemProjection } from "@guild/contracts";
import { messageSizePx } from "./appearance.js";
import { messagesFor } from "./locales.js";
import { officialPriceMultiplier } from "./model-picker.js";
import {
  advanceRunPhaseHistory,
  describeRunPhaseTrail,
  RUN_PHASE_TRAIL_LIMIT,
  startRunPhaseHistory,
} from "./run-phase-display.js";
import {
  activityDurationMs,
  activityStepTotal,
  activityToolCounts,
  itemDurationMs,
  turnDurationsByRun,
} from "./timeline.js";

function item(patch: Record<string, unknown>): TimelineItemProjection {
  return { entryId: "e", taskId: "t", sequence: 1, createdAtMs: 0, updatedAtMs: 0, status: "completed", ...patch } as TimelineItemProjection;
}
const tool = (id: string, toolKind: string, createdAtMs: number, updatedAtMs: number) =>
  item({ entryId: id, runId: "r", kind: "tool", title: id, toolKind, toolStatus: "completed", content: [], locations: [], createdAtMs, updatedAtMs });

test("activity counts tool kinds in first-use order and counts steps as tool calls only", () => {
  const items = [
    item({ kind: "thought", text: "x", startedAtMs: 0, elapsedMs: 5_000 }),
    tool("a", "read", 0, 1), tool("b", "execute", 0, 1), tool("c", "read", 0, 1),
  ];
  assert.deepEqual(activityToolCounts(items), [{ kind: "read", count: 2 }, { kind: "execute", count: 1 }]);
  assert.equal(activityStepTotal(items), 3);
  assert.equal(activityStepTotal([item({ kind: "thought", text: "x", startedAtMs: 0, elapsedMs: 1 })]), 0);
});

test("durations come from the projection's own stamps and vanish under a second", () => {
  assert.equal(itemDurationMs(tool("a", "read", 1_000, 7_500)), 6_500);
  assert.equal(itemDurationMs(tool("a", "read", 1_000, 1_999)), undefined);
  assert.equal(activityDurationMs([tool("a", "read", 1_000, 2_000), tool("b", "read", 5_000, 65_000)]), 64_000);
  assert.equal(activityDurationMs([]), undefined);
  assert.equal(activityDurationMs([tool("a", "read", 1_000, 1_400)]), undefined);
});

test("a turn's duration spans its first entry to its last update, per run, in one pass", () => {
  const user = item({ entryId: "u", runId: "r1", kind: "user", text: "go", createdAtMs: 10_000, updatedAtMs: 10_000 });
  const answer = item({ entryId: "a", runId: "r1", kind: "assistant", text: "done", createdAtMs: 200_000, updatedAtMs: 262_000 });
  const notice = item({ entryId: "n", runId: "r1", kind: "notice", text: "later", createdAtMs: 900_000, updatedAtMs: 900_000 });
  const live = item({ entryId: "l", runId: "r2", kind: "assistant", text: "...", status: "streaming", createdAtMs: 1, updatedAtMs: 99_999 });
  const quick = item({ entryId: "q", runId: "r3", kind: "user", text: "hi", createdAtMs: 5, updatedAtMs: 500 });
  const bare = item({ entryId: "b", kind: "user", text: "no run", createdAtMs: 0, updatedAtMs: 90_000 });
  const durations = turnDurationsByRun([user, answer, notice, live, quick, bare]);
  assert.equal(durations.get("r1"), 252_000);
  assert.equal(durations.has("r2"), false, "a streaming turn has no duration yet");
  assert.equal(durations.has("r3"), false, "under a second adds nothing");
  assert.equal(durations.size, 1);
});

test("a price tag appears only when the official description states a premium multiple", () => {
  assert.equal(officialPriceMultiplier("Fast variant. 2x the price."), "2");
  assert.equal(officialPriceMultiplier("Costs 1.5x pricing of the base model"), "1.5");
  assert.equal(officialPriceMultiplier("回得更快，2 倍价格"), "2");
  assert.equal(officialPriceMultiplier("Twice the price of Grok 4.7"), "2");
  assert.equal(officialPriceMultiplier("SpaceXAI's latest frontier model"), undefined);
  assert.equal(officialPriceMultiplier("Fast. Context 2x larger"), undefined);
  assert.equal(officialPriceMultiplier("Half price: 0.5x the price"), undefined, "a discount is not a premium tag");
  assert.equal(officialPriceMultiplier("Up to 10x cheaper than before"), undefined);
  assert.equal(officialPriceMultiplier("2x usage limits for subscribers"), undefined);
  assert.equal(officialPriceMultiplier("Delivers 3x cost savings"), undefined);
  assert.equal(officialPriceMultiplier("Roughly 2x credits included"), undefined);
  assert.equal(officialPriceMultiplier(undefined), undefined);
  assert.equal(messagesFor("zh-CN").modelPriceTag("2"), "2 倍价格");
  assert.equal(messagesFor("en-US").modelPriceTag("2"), "2x price");
});

const phase = (name: RunPhaseProjection["phase"], turn: number, started: number, extra: Partial<RunPhaseProjection> = {}): RunPhaseProjection =>
  ({ phase: name, turnStartedAtMs: turn, phaseStartedAtMs: started, ...extra });

test("the phase trail records only transitions this view saw, with exact durations", () => {
  let history = startRunPhaseHistory(phase("waiting_for_model", 1_000, 4_000));
  assert.deepEqual(history.trail, []);
  history = advanceRunPhaseHistory(history, phase("thinking", 1_000, 7_500));
  history = advanceRunPhaseHistory(history, phase("running_tool", 1_000, 20_000, { toolName: "Read" }));
  assert.deepEqual(history.trail.map((entry) => [entry.projection.phase, entry.durationMs]), [["waiting_for_model", 3_500], ["thinking", 12_500]]);
  const en = messagesFor("en-US");
  assert.deepEqual(describeRunPhaseTrail(history, en).map((entry) => entry.text), ["Waiting for model 3s", "Thinking 12s"]);
});

test("the trail ignores detail updates of one phase, resets on a new turn and stays short", () => {
  let history = startRunPhaseHistory(phase("running_tool", 1_000, 5_000, { toolName: "Read" }));
  const sameStart = phase("running_tool", 1_000, 5_000, { toolName: "Edit" });
  history = advanceRunPhaseHistory(history, sameStart);
  assert.equal(history.trail.length, 0);
  assert.equal(history.last, sameStart);
  const names = ["thinking", "running_tool", "thinking", "running_tool", "thinking"] as const;
  names.forEach((name, index) => { history = advanceRunPhaseHistory(history, phase(name, 1_000, 10_000 + index * 5_000)); });
  assert.equal(history.trail.length, RUN_PHASE_TRAIL_LIMIT);
  history = advanceRunPhaseHistory(history, phase("starting_runtime", 99_000, 99_000));
  assert.equal(history.trail.length, 0);
});

test("a phase shorter than a second is left off the visible trail", () => {
  let history = startRunPhaseHistory(phase("running_hooks", 0, 1_000));
  history = advanceRunPhaseHistory(history, phase("thinking", 0, 1_400));
  assert.equal(history.trail.length, 1);
  assert.deepEqual(describeRunPhaseTrail(history, messagesFor("en-US")), []);
});

test("stored text-size ids keep their meaning: standard follows the 15 px scale, large stays 18 px", () => {
  assert.equal(messageSizePx(16), 15);
  assert.equal(messageSizePx(18), 18, "large text never gets smaller than it was");
});

test("the refresh strings exist in both catalogs and format their arguments", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const m = messagesFor(locale);
    for (const text of [
      m.activityDone(38), m.activityRunning(5), m.activityStepCount(3), m.activityKindShort("execute"), m.activityOtherCount(2),
      m.stepRunning, m.stepPending, m.stepFailed, m.turnTook("4 min"), m.copyShort, m.copiedShort, m.branchShort, m.taskMetaPermission,
      m.taskMetaUnread, m.hintSend, m.hintNewline, m.hintCommands, m.hintQueue, m.modelPickerFootnote, m.newTaskShortcut, m.searchShortcut,
    ]) {
      assert.ok(text.length > 0 && !text.includes("undefined"), `${locale}: ${text}`);
    }
  }
  assert.equal(messagesFor("zh-CN").activityDone(38), "已完成 38 步");
  assert.equal(messagesFor("zh-CN").activityRunning(5), "进行中 · 第 5 步");
  assert.equal(messagesFor("zh-CN").activityKindShort("execute"), "命令");
  assert.equal(messagesFor("zh-CN").activityKindShort("edit"), "修改");
});
