import type { GuildEngine, ModelCatalog, ModelGroup } from "@guild/contracts";
import { modelGroupOf } from "@guild/contracts/grok-models";
import { CLAUDE_DEFAULT_ROW_ID, modelNameFromDescription } from "./claude-model-families.js";
import type { GuildMessages } from "./locales.js";

/*
 * Switching between a Claude subscription model and an Online / Local model (D-062). The two run in different
 * engine processes: a Claude model natively, an Online or Local model through Guild's local router. A switch that
 * crosses that boundary restarts Claude Code and resumes the same conversation, which takes 30 to 120 seconds, so
 * the picker says beforehand which rows do it and the composer says while it runs. Pure view-model; nothing here
 * knows a model id.
 */

export type ProcessMode = "native" | "routed";

/** The mode a model of this picker group runs in; Grok has none. */
export function processModeOfGroup(group: ModelGroup | undefined): ProcessMode | undefined {
  if (group === "claude") return "native";
  if (group === "online" || group === "local") return "routed";
  return undefined;
}

/** A task whose selection is unknown, or a Claude default, runs natively. */
export function currentProcessMode(selectedGroup: ModelGroup | undefined): ProcessMode {
  return processModeOfGroup(selectedGroup) ?? "native";
}

/**
 * Whether choosing a model of `targetGroup` restarts the engine. `targetGroup` is undefined when the choice is
 * cleared, which falls back to Claude's default. A brand-new task has no session yet and starts in the right mode
 * whatever is chosen, and a Grok task has no router, so neither shows the restart.
 */
export function switchRestartsEngine(input: Readonly<{
  taskEngine: GuildEngine;
  /** The task has a Run, so a Claude session is live or can be resumed. */
  engineFixed: boolean;
  /** Group of the model the task runs on now. */
  currentGroup: ModelGroup | undefined;
  targetGroup: ModelGroup | undefined;
}>): boolean {
  if (input.taskEngine !== "claude" || !input.engineFixed) return false;
  return currentProcessMode(input.currentGroup) !== currentProcessMode(input.targetGroup);
}

/** Group of the model with this id in the Claude catalog (Claude, Online or Local), or undefined. */
export function groupOfModel(catalog: ModelCatalog, modelId: string | null): ModelGroup | undefined {
  if (modelId === null) return undefined;
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  return model === undefined ? undefined : modelGroupOf(model);
}

/** The name the composer line gives the model being switched to; a cleared choice names Claude's default. */
export function switchTargetName(
  messages: Pick<GuildMessages, "modelPickerClaudeDefault" | "modelPickerClaudeDefaultRow">,
  catalog: ModelCatalog,
  modelId: string | null,
): string {
  if (modelId === null) return messages.modelPickerClaudeDefault;
  const model = catalog.models.find((candidate) => candidate.id === modelId);
  if (model === undefined) return modelId;
  return modelGroupOf(model) === "claude" && model.id === CLAUDE_DEFAULT_ROW_ID
    ? messages.modelPickerClaudeDefaultRow(modelNameFromDescription(model.description))
    : model.name;
}

/** A cross-mode switch of one task, as the app holds it: while it runs, and the reason it failed. */
export type ModelSwitchState =
  | Readonly<{ kind: "switching"; taskId: string; modelName: string }>
  | Readonly<{ kind: "failed"; taskId: string; message: string }>;

export type ModelSwitchLine = Readonly<{
  kind: "switching" | "failed";
  text: string;
}>;

/** The composer line for this task, or undefined when there is nothing to say (including a switch of another task). */
export function modelSwitchLine(
  state: ModelSwitchState | undefined,
  taskId: string | undefined,
  messages: Pick<GuildMessages, "modelSwitchStatus">,
): ModelSwitchLine | undefined {
  if (state === undefined || taskId === undefined || state.taskId !== taskId) return undefined;
  return state.kind === "switching"
    ? Object.freeze({ kind: "switching", text: messages.modelSwitchStatus(state.modelName) })
    : Object.freeze({ kind: "failed", text: state.message });
}

/** The picker trigger shows its spinner and "Switching…" exactly while a cross-mode switch of this task runs. */
export function modelSwitchRunning(state: ModelSwitchState | undefined, taskId: string | undefined): boolean {
  return state?.kind === "switching" && taskId !== undefined && state.taskId === taskId;
}
