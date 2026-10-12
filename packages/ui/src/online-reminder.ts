import type { ModelGroup, ModelSourceProjection } from "@guild/contracts";

/*
 * The Online-model reminder (PC-PRIV-001). The first time a conversation switches to a model of the
 * Online group, Guild says what leaves this Mac before it happens. Claude and Local models never
 * ask. "Don't remind me again in this workspace" is a workspace preference kept by the main process;
 * which tasks were already asked in this window is plain renderer state.
 */

export type OnlineReminderInput = Readonly<{
  /** Group of the model being chosen. */
  targetGroup: ModelGroup | undefined;
  /** Group of the model the task uses now: already Online means the user was asked (or chose not to be). */
  currentGroup: ModelGroup | undefined;
  /** This task was already asked, or skipped the question, since the window opened. */
  alreadyHandledForTask: boolean;
  /** The workspace preference "Don't remind me again" is set. */
  dismissedForWorkspace: boolean;
}>;

export function onlineReminderNeeded(input: OnlineReminderInput): boolean {
  return input.targetGroup === "online" &&
    input.currentGroup !== "online" &&
    !input.alreadyHandledForTask &&
    !input.dismissedForWorkspace;
}

/**
 * The vendor the reminder names: the label of the model source that lists the model, else the model's
 * own display name, else its id.
 */
export function vendorLabelFor(
  modelId: string,
  sources: readonly Pick<ModelSourceProjection, "label" | "models">[],
  modelName: string | undefined,
): string {
  const source = sources.find((candidate) => candidate.models.some((model) => model.id === modelId));
  return source?.label ?? modelName ?? modelId;
}
