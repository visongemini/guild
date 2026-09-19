import type { AcpToolKind, GuildTaskActivity, TimelineItemProjection } from "@guild/contracts";

export type TimelineGroup =
  | { readonly type: "activity"; readonly items: readonly TimelineItemProjection[] }
  | { readonly type: "single"; readonly item: TimelineItemProjection };

export type ActivityGroupState =
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Markdown treats a reply such as `+` or `>` as empty structure instead of authored text. */
export function isBareSymbolReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed)) return false;
  return /^[\p{P}\p{S}\s]+$/u.test(trimmed);
}

/** Consecutive runtime activity stays in one disclosure until authored content interrupts it. */
export function groupTimeline(items: readonly TimelineItemProjection[]): readonly TimelineGroup[] {
  const groups: ({ type: "activity"; items: TimelineItemProjection[] } |
    { type: "single"; item: TimelineItemProjection })[] = [];
  const restoredIncidentIds = new Set(items.flatMap((item) =>
    item.kind === "notice" &&
      item.noticeType === "session_restored" &&
      item.incidentId !== undefined
      ? [item.incidentId]
      : []));
  for (const item of items) {
    // Once recovery succeeds, its single recovery card replaces the transient
    // transport-error paragraph. The durable error remains in persistence and
    // diagnostics; only duplicate presentation is suppressed.
    if (
      item.kind === "error" &&
      item.incidentId !== undefined &&
      restoredIncidentIds.has(item.incidentId)
    ) continue;
    const type = item.kind === "thought" || item.kind === "tool" ? "activity" : "single";
    const previous = groups.at(-1);
    if (
      type === "activity" &&
      previous?.type === "activity" &&
      previous.items.at(-1)?.runId === item.runId
    ) {
      previous.items.push(item);
    } else if (type === "single") {
      groups.push({ type: "single", item });
    } else {
      groups.push({ type: "activity", items: [item] });
    }
  }
  return Object.freeze(groups.map((group) => group.type === "activity"
    ? Object.freeze({ ...group, items: Object.freeze(group.items) })
    : Object.freeze(group)));
}

/** A terminal Run always wins over stale item/tool flags from that Run. */
export function activityGroupState(
  items: readonly TimelineItemProjection[],
): ActivityGroupState {
  if (items.some((item) => item.status === "interrupted")) return "interrupted";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "cancelled")) return "cancelled";
  if (items.some((item) =>
    item.status === "streaming" ||
    (item.kind === "tool" &&
      (item.toolStatus === "pending" || item.toolStatus === "in_progress")))) {
    return "streaming";
  }
  return "completed";
}

/** Unique tool kinds in first-use order keep the collapsed activity summary compact. */
export function activityToolKinds(
  items: readonly TimelineItemProjection[],
): readonly AcpToolKind[] {
  const kinds: AcpToolKind[] = [];
  for (const item of items) {
    if (item.kind === "tool" && !kinds.includes(item.toolKind)) kinds.push(item.toolKind);
  }
  return Object.freeze(kinds);
}

/** Current activity is derived only from official ACP item kind/status, never from authored text. */
export function streamingActivity(
  items: readonly TimelineItemProjection[],
): GuildTaskActivity {
  let planActive = false;
  for (const item of [...items].reverse()) {
    if (
      item.kind !== "tool" ||
      (item.toolStatus !== "pending" && item.toolStatus !== "in_progress")
    ) continue;
    if (item.runtimeReplayKind === "plan") {
      planActive = true;
      continue;
    }
    switch (item.toolKind) {
      case "read": return "reading";
      case "edit": return "editing";
      case "delete": return "deleting";
      case "move": return "moving";
      case "search": return "searching";
      case "execute": return "executing";
      case "think": return "thinking";
      case "fetch": return "fetching";
      case "switch_mode": return "switching_mode";
      case "other": return "working";
    }
  }
  if (planActive) return "planning";
  return items.some((item) => item.kind === "thought" && item.status === "streaming")
    ? "thinking"
    : "working";
}
