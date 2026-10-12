import type {
  GuildEngine,
  GuildRendererApi,
  SetTaskRuntimeSettingsResponse,
  TaskId,
  TaskViewProjection,
} from "@guild/contracts";
import type { ModelSelectionChange } from "./model-picker.js";

/*
 * What the picker's change does to the task (PC-ENG-001, PC-MODEL-001): a task that has not run yet may still
 * choose its engine, and the first model of the other engine (or the Claude Code default row) moves it there
 * before the model applies. The main process stays the authority and refuses the move once a Run exists.
 */

export type ModelChangeApi = Pick<GuildRendererApi, "setTaskEngine" | "setTaskRuntimeSettings">;

export async function applyModelSelectionChange(
  api: ModelChangeApi,
  input: Readonly<{
    taskId: TaskId;
    /** Engine the task sits on now. */
    taskEngine: GuildEngine;
    change: ModelSelectionChange;
    /** The task after the engine move, to adopt before the model request is made. */
    onEngineMoved: (moved: TaskViewProjection) => void;
  }>,
): Promise<SetTaskRuntimeSettingsResponse> {
  const { taskId, change } = input;
  if (change.engine !== undefined && change.engine !== input.taskEngine) {
    input.onEngineMoved(await api.setTaskEngine({ taskId, engine: change.engine }));
  }
  return api.setTaskRuntimeSettings({
    taskId,
    model: change.model,
    reasoningEffort: change.reasoningEffort,
  });
}
