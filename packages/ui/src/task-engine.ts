import type { GuildEngine, TaskSummaryProjection, TaskViewProjection, WorkspaceProjection } from "@guild/contracts";

/*
 * Which engine a task runs on and whether that is already decided (PC-ENG-001). A task keeps the
 * engine of its first turn for life: until a Run exists the model picker may still move it, after
 * that the picker lists only its engine. Absent engine means Grok (every task from before 3.0).
 */

export function taskEngineOf(task: Pick<TaskSummaryProjection, "engine"> | undefined): GuildEngine {
  return task?.engine ?? "grok";
}

/**
 * True once the task has any Run. The projection carries no explicit flag, so this reads the traces
 * a Run leaves: a timeline entry (a Run's first entry is the user message), an earlier page of the
 * timeline, a queued follow-up, a live run state, or a message being sent right now. The main
 * process stays the authority: `setTaskEngine` is refused for a task that has a Run.
 */
export function taskEngineFixed(
  view: Pick<TaskViewProjection, "task" | "timeline" | "queuedTurns" | "hasEarlierTimeline"> | undefined,
  sendPending: boolean,
): boolean {
  if (view === undefined) return true;
  return sendPending ||
    view.hasEarlierTimeline ||
    view.timeline.length > 0 ||
    view.queuedTurns.length > 0 ||
    view.task.activeRunState !== undefined;
}

/**
 * The letter of an engine's marker on the sidebar rows. It is fixed, not the first letter of the engine's name,
 * because Claude and Codex both begin with C.
 */
const ENGINE_MARKER_LETTERS: Readonly<Record<GuildEngine, string>> = Object.freeze({ grok: "G", claude: "C", codex: "X" });

export function engineMarkerLetter(engine: GuildEngine): string {
  return ENGINE_MARKER_LETTERS[engine];
}

/**
 * Engine markers on the sidebar rows appear only while more than one engine is in use, so a user who only ever
 * uses one engine sees no change at all, and with several every row carries a marker.
 */
export function hasMixedEngines(workspaces: readonly Pick<WorkspaceProjection, "tasks">[]): boolean {
  const seen = new Set<GuildEngine>();
  for (const workspace of workspaces) {
    for (const task of workspace.tasks) {
      seen.add(taskEngineOf(task));
      if (seen.size > 1) return true;
    }
  }
  return false;
}
