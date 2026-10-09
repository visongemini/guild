import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createFrameScheduler,
  FRAME_FALLBACK_MS,
  type FrameSchedulerEnvironment,
} from "./frame-scheduler.js";

function fakeEnvironment() {
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const environment: FrameSchedulerEnvironment = {
    requestFrame: (callback) => { const handle = nextHandle++; frames.set(handle, callback); return handle; },
    cancelFrame: (handle) => { frames.delete(handle); },
    setTimer: (callback, delayMs) => { const handle = nextHandle++; timers.set(handle, { callback, delayMs }); return handle; },
    clearTimer: (handle) => { timers.delete(handle); },
  };
  return {
    environment,
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
    fireFrame: () => { const [handle, callback] = [...frames][0] ?? []; if (handle !== undefined) { frames.delete(handle); callback!(); } },
    fireTimer: () => { const [handle, entry] = [...timers][0] ?? []; if (handle !== undefined) { timers.delete(handle); entry!.callback(); } },
    timerDelay: () => [...timers.values()][0]?.delayMs,
  };
}

test("repeated requests before a frame coalesce into one run", () => {
  const fake = fakeEnvironment();
  let runs = 0;
  const scheduler = createFrameScheduler(() => { runs += 1; }, fake.environment);
  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  assert.equal(scheduler.pending(), true);
  assert.equal(fake.pendingFrames(), 1);
  fake.fireFrame();
  assert.equal(runs, 1);
  assert.equal(scheduler.pending(), false);
  assert.equal(fake.pendingTimers(), 0, "the fallback timer is cancelled once the frame ran");
});

test("a window that never produces a frame still delivers through the timer fallback", () => {
  const fake = fakeEnvironment();
  let runs = 0;
  const scheduler = createFrameScheduler(() => { runs += 1; }, fake.environment);
  scheduler.schedule();
  assert.equal(fake.timerDelay(), FRAME_FALLBACK_MS);
  fake.fireTimer();
  assert.equal(runs, 1);
  assert.equal(fake.pendingFrames(), 0, "the unused frame request is cancelled");
  // A late frame callback from an already-cancelled request cannot run it twice.
  scheduler.schedule();
  fake.fireFrame();
  assert.equal(runs, 2);
});

test("flush runs a pending request immediately and exactly once", () => {
  const fake = fakeEnvironment();
  let runs = 0;
  const scheduler = createFrameScheduler(() => { runs += 1; }, fake.environment);
  scheduler.flush();
  assert.equal(runs, 0, "nothing pending, nothing to run");
  scheduler.schedule();
  scheduler.flush();
  scheduler.flush();
  assert.equal(runs, 1);
  assert.equal(fake.pendingFrames() + fake.pendingTimers(), 0);
});

test("cancel drops the pending run and a request made during a run schedules the next one", () => {
  const fake = fakeEnvironment();
  let runs = 0;
  const scheduler = createFrameScheduler(() => {
    runs += 1;
    if (runs === 1) scheduler.schedule();
  }, fake.environment);
  scheduler.schedule();
  scheduler.cancel();
  assert.equal(scheduler.pending(), false);
  assert.equal(fake.pendingFrames() + fake.pendingTimers(), 0);
  scheduler.schedule();
  fake.fireFrame();
  assert.equal(runs, 1);
  assert.equal(scheduler.pending(), true, "scheduled again from inside the run");
  fake.fireFrame();
  assert.equal(runs, 2);
});

test("projection delivery in the renderer goes through the scheduler, not a bare animation frame", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("let latestProjection: DesktopBootstrapProjection | undefined;");
  const end = source.indexOf("}, [api, setProjection, streamOverlay]);", start);
  assert.ok(start >= 0 && end > start);
  const subscription = source.slice(start, end);
  assert.match(subscription, /createFrameScheduler\(/u);
  assert.match(subscription, /api\.onProjectionChanged/u);
  assert.match(subscription, /api\.onStreamDelta/u);
  assert.doesNotMatch(subscription, /requestAnimationFrame\(/u);
  const scheduler = await readFile(new URL("../src/frame-scheduler.ts", import.meta.url), "utf8");
  assert.match(scheduler, /environment\.setTimer\(fire, fallbackMs\)/u);
});
