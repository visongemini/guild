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
 * True for a Claude task that has already run a turn on a native (subscription) session and does not run through
 * the model router yet. Its first switch to an Online or Local model moves it there for good (D-061), so the picker
 * asks first. A new Claude task with no turn yet chooses freely, and a Grok task never routes.
 */
export function taskHasNativeClaudeSession(
  view: Pick<TaskViewProjection, "task" | "timeline" | "queuedTurns" | "hasEarlierTimeline" | "engineStatus"> | undefined,
  sendPending: boolean,
): boolean {
  return view !== undefined &&
    taskEngineOf(view.task) === "claude" &&
    view.engineStatus?.routed !== true &&
    taskEngineFixed(view, sendPending);
}

/**
 * Engine markers on the sidebar rows appear only while both engines are in use, so a user who only
 * ever uses one engine sees no change at all, and with both every row carries a marker.
 */
export function hasMixedEngines(workspaces: readonly Pick<WorkspaceProjection, "tasks">[]): boolean {
  let sawClaude = false;
  let sawGrok = false;
  for (const workspace of workspaces) {
    for (const task of workspace.tasks) {
      if (taskEngineOf(task) === "claude") sawClaude = true;
      else sawGrok = true;
      if (sawClaude && sawGrok) return true;
    }
  }
  return false;
}
