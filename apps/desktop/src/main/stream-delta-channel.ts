import {
  DESKTOP_IPC_CHANNELS,
  parseStreamDeltaEvent,
  type StreamDeltaEvent,
} from "@guild/contracts";

/** The only parts of the registered Guild window that stream delivery may touch. */
export type StreamDeltaTarget = Readonly<{
  isDestroyed(): boolean;
  webContents: Readonly<{
    isDestroyed(): boolean;
    send(channel: string, payload: StreamDeltaEvent): void;
  }>;
}>;

/**
 * Binds delivery to one registered window and its original web contents. Every event is
 * revalidated against the closed schema right before it leaves main, so a malformed or
 * oversized event can never reach the renderer, and a destroyed or replaced window gets nothing.
 */
export function createStreamDeltaForwarder(
  window: StreamDeltaTarget,
): (candidate: unknown) => boolean {
  const boundContents = window.webContents;
  return (candidate) => {
    if (
      window.isDestroyed() ||
      window.webContents !== boundContents ||
      boundContents.isDestroyed()
    ) return false;
    let delta: StreamDeltaEvent;
    try {
      delta = parseStreamDeltaEvent(candidate);
    } catch {
      return false;
    }
    boundContents.send(DESKTOP_IPC_CHANNELS.streamDelta, delta);
    return true;
  };
}
