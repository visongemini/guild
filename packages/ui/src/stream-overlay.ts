import type { StreamDeltaEvent, TimelineItemProjection } from "@guild/contracts";

/**
 * Live text for entries that are still streaming. Deltas arrive faster than full projections,
 * so the renderer keeps the suffix they carry beside the last projection and shows
 * `snapshot + suffix`. A projection that has caught up simply supersedes the suffix, so the
 * overlay can never leave the screen different from what main persisted.
 */
export type StreamOverlayRecord = Readonly<{
  taskId: string;
  kind: "assistant" | "thought";
  /** UTF-16 offset in the entry text at which `text` begins. */
  startOffset: number;
  text: string;
  revision: number;
}>;

export const MAX_OVERLAY_ENTRIES = 16;

/** Text to display for a streaming entry given the last projected text and any overlay. */
export function mergeStreamText(
  snapshotText: string,
  overlay: StreamOverlayRecord | undefined,
): string {
  if (overlay === undefined) return snapshotText;
  const end = overlay.startOffset + overlay.text.length;
  // The projection already holds everything the deltas carried.
  if (snapshotText.length >= end) return snapshotText;
  // The deltas begin after text the projection does not have yet; show the projection until it catches up.
  if (snapshotText.length < overlay.startOffset) return snapshotText;
  return snapshotText + overlay.text.slice(snapshotText.length - overlay.startOffset);
}

export type StreamOverlaySnapshotView = (entryId: string) => StreamOverlayRecord | undefined;

/**
 * External store for stream overlays. `apply` accumulates privately and `flush` publishes,
 * so a frame scheduler can bound React updates to one per animation frame.
 */
export class StreamOverlayStore {
  private committed = new Map<string, StreamOverlayRecord>();
  private pending = new Map<string, StreamOverlayRecord>();
  private readonly listeners = new Set<() => void>();
  private observedTaskId: string | undefined;
  private version = 0;

  /** `resolveActiveTask` reads the task the user is viewing; deltas for any other task are late or foreign. */
  constructor(private readonly resolveActiveTask: () => string | undefined) {}

  /** Returns true when the delta changed the pending overlay. */
  apply(delta: StreamDeltaEvent): boolean {
    this.followActiveTask();
    if (
      delta.taskId !== this.observedTaskId ||
      typeof delta.entryId !== "string" ||
      delta.entryId.length === 0 ||
      (delta.kind !== "assistant" && delta.kind !== "thought") ||
      typeof delta.appendText !== "string" ||
      delta.appendText.length === 0 ||
      !Number.isSafeInteger(delta.offset) ||
      delta.offset < 0 ||
      !Number.isSafeInteger(delta.revision)
    ) return false;
    const current = this.pending.get(delta.entryId) ?? this.committed.get(delta.entryId);
    let next: StreamOverlayRecord;
    if (current === undefined) {
      next = {
        taskId: delta.taskId,
        kind: delta.kind,
        startOffset: delta.offset,
        text: delta.appendText,
        revision: delta.revision,
      };
    } else {
      if (delta.revision <= current.revision || current.kind !== delta.kind) return false;
      const end = current.startOffset + current.text.length;
      const deltaEnd = delta.offset + delta.appendText.length;
      if (deltaEnd <= end) return false;
      if (delta.offset <= end) {
        next = {
          ...current,
          text: current.text + delta.appendText.slice(end - delta.offset),
          revision: delta.revision,
        };
      } else {
        // A gap: the text between cannot be bridged, so restart from this delta.
        next = {
          taskId: delta.taskId,
          kind: delta.kind,
          startOffset: delta.offset,
          text: delta.appendText,
          revision: delta.revision,
        };
      }
    }
    // Map insertion order doubles as recency.
    this.pending.delete(delta.entryId);
    this.pending.set(delta.entryId, next);
    this.evictOldest();
    return true;
  }

  /** Publishes accumulated deltas to subscribers. */
  flush(): void {
    if (this.pending.size === 0) return;
    for (const [entryId, record] of this.pending) {
      this.committed.delete(entryId);
      this.committed.set(entryId, record);
    }
    this.pending = new Map();
    this.notify();
  }

  /** Drops overlays that a newer projection has superseded or that no longer stream. */
  reconcile(timeline: readonly TimelineItemProjection[]): void {
    this.followActiveTask();
    if (this.committed.size === 0 && this.pending.size === 0) return;
    const byId = new Map<string, TimelineItemProjection>();
    for (const item of timeline) byId.set(item.entryId, item);
    for (const records of [this.committed, this.pending]) {
      for (const [entryId, record] of records) {
        const item = byId.get(entryId);
        if (item === undefined) continue;
        if (
          item.status !== "streaming" ||
          !("text" in item) ||
          item.text.length >= record.startOffset + record.text.length
        ) records.delete(entryId);
      }
    }
  }

  get(entryId: string): StreamOverlayRecord | undefined {
    const record = this.committed.get(entryId);
    return record !== undefined && record.taskId === this.resolveActiveTask() ? record : undefined;
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A task switch discards every overlay of the previous task. */
  private followActiveTask(): void {
    const taskId = this.resolveActiveTask();
    if (taskId === this.observedTaskId) return;
    this.observedTaskId = taskId;
    this.committed = new Map();
    this.pending = new Map();
  }

  private notify(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }

  private evictOldest(): void {
    while (this.pending.size + this.committed.size > MAX_OVERLAY_ENTRIES) {
      const oldest = this.committed.keys().next().value ?? this.pending.keys().next().value;
      if (oldest === undefined) return;
      if (!this.committed.delete(oldest)) this.pending.delete(oldest);
    }
  }
}
