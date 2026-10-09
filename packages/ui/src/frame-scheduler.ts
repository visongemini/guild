/**
 * Runs a callback at most once per animation frame, with a timer fallback.
 * A hidden or occluded window pauses requestAnimationFrame, so background delivery
 * (task state, notifications, the next visible frame) must never depend on a frame alone.
 */

export type FrameSchedulerEnvironment = Readonly<{
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (handle: number) => void;
}>;

export const FRAME_FALLBACK_MS = 80;

export type FrameScheduler = Readonly<{
  /** Requests a run; repeated requests before the run coalesce into one. */
  schedule: () => void;
  /** Runs now if a run is pending. */
  flush: () => void;
  cancel: () => void;
  readonly pending: () => boolean;
}>;

export function browserFrameEnvironment(): FrameSchedulerEnvironment {
  return {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
  };
}

export function createFrameScheduler(
  run: () => void,
  environment: FrameSchedulerEnvironment = browserFrameEnvironment(),
  fallbackMs = FRAME_FALLBACK_MS,
): FrameScheduler {
  let frameHandle: number | undefined;
  let timerHandle: number | undefined;

  const clear = (): void => {
    if (frameHandle !== undefined) environment.cancelFrame(frameHandle);
    if (timerHandle !== undefined) environment.clearTimer(timerHandle);
    frameHandle = undefined;
    timerHandle = undefined;
  };
  const fire = (): void => {
    if (frameHandle === undefined && timerHandle === undefined) return;
    clear();
    run();
  };

  return Object.freeze({
    schedule: () => {
      if (frameHandle !== undefined || timerHandle !== undefined) return;
      frameHandle = environment.requestFrame(fire);
      timerHandle = environment.setTimer(fire, fallbackMs);
    },
    flush: fire,
    cancel: clear,
    pending: () => frameHandle !== undefined || timerHandle !== undefined,
  });
}
