import type { TimelineItemProjection } from "@guild/contracts";
import type { TimelineGroup } from "./timeline.js";

/*
 * Runs that a rewind undid stay in the timeline for audit, but they should not compete with the live
 * conversation. Consecutive rolled-back groups fold into one collapsed block; everything else renders as before.
 */

export type TimelineRow = Readonly<{ group: TimelineGroup; index: number }>;

export type RolledBackSegment = Readonly<{
  type: "rolled";
  rows: readonly TimelineRow[];
  /** Distinct runs folded into the block. */
  runCount: number;
  /** The prompt that was undone, for the one-line summary. */
  prompt: string | undefined;
  firstSequence: number;
}>;
export type RowSegment = Readonly<{ type: "row"; row: TimelineRow }>;
export type TimelineSegment = RowSegment | RolledBackSegment;

export function groupEntries(group: TimelineGroup): readonly TimelineItemProjection[] {
  return group.type === "activity" ? group.items : [group.item];
}

export function isRolledBackGroup(group: TimelineGroup): boolean {
  const entries = groupEntries(group);
  return entries.length > 0 && entries.every((entry) => entry.rolledBack === true);
}

export function segmentTimeline(groups: readonly TimelineGroup[]): readonly TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let pending: TimelineRow[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const entries = pending.flatMap((row) => groupEntries(row.group));
    const runs = new Set(entries.flatMap((entry) => entry.runId === undefined ? [] : [entry.runId]));
    const prompt = entries.find((entry) => entry.kind === "user");
    segments.push(Object.freeze({
      type: "rolled" as const,
      rows: Object.freeze(pending),
      runCount: Math.max(1, runs.size),
      prompt: prompt?.kind === "user" ? prompt.text : undefined,
      firstSequence: entries[0]!.sequence,
    }));
    pending = [];
  };
  groups.forEach((group, index) => {
    if (isRolledBackGroup(group)) {
      pending.push(Object.freeze({ group, index }));
      return;
    }
    flush();
    segments.push(Object.freeze({ type: "row" as const, row: Object.freeze({ group, index }) }));
  });
  flush();
  return Object.freeze(segments);
}
