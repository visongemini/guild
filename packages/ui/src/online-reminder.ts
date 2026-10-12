import type { ModelGroup, ModelSourceProjection } from "@guild/contracts";

/*
 * The Online-model reminder (PC-PRIV-001). Before a conversation first sends to an Online vendor, Guild says
 * what leaves this Mac. The agreement is per task and per vendor (model source): agreeing to one vendor says
 * nothing about another, and going Online A -> Claude -> Online B asks again for B. Claude and Local models
 * never ask. "Don't remind me again in this workspace" is a workspace preference kept by the main process and
 * silences every reminder; which vendors a task agreed to is plain renderer state for the life of the window.
 */

export type OnlineReminderInput = Readonly<{
  /** Group of the model being chosen. */
  targetGroup: ModelGroup | undefined;
  /** Source key of the model being chosen (see `onlineSourceKey`). */
  targetSource: string;
  /**
   * Sources this task already sends to: the ones it agreed to, plus the one its current model belongs to
   * (the person was asked, or chose not to be, when they got there).
   */
  agreedSources: ReadonlySet<string>;
  /** The workspace preference "Don't remind me again" is set. */
  dismissedForWorkspace: boolean;
}>;

export function onlineReminderNeeded(input: OnlineReminderInput): boolean {
  return input.targetGroup === "online" &&
    !input.dismissedForWorkspace &&
    !input.agreedSources.has(input.targetSource);
}

/**
 * The vendor a model belongs to: the id of the model source that lists it, else a key made from the model id
 * (a model no source lists still gets one stable key, so it is asked about once, not on every switch).
 */
export function onlineSourceKey(
  modelId: string,
  sources: readonly Pick<ModelSourceProjection, "id" | "models">[],
): string {
  const source = sources.find((candidate) => candidate.models.some((model) => model.id === modelId));
  return source === undefined ? `model:${modelId}` : `source:${source.id}`;
}

/** Which vendors each task agreed to send to since the window opened. */
export type OnlineConsentLedger = Readonly<{
  agreedSources: (taskId: string) => ReadonlySet<string>;
  agree: (taskId: string, sourceKey: string) => void;
}>;

export function createOnlineConsentLedger(): OnlineConsentLedger {
  const byTask = new Map<string, Set<string>>();
  return Object.freeze({
    agreedSources: (taskId) => byTask.get(taskId) ?? new Set<string>(),
    agree: (taskId, sourceKey) => {
      const agreed = byTask.get(taskId) ?? new Set<string>();
      agreed.add(sourceKey);
      byTask.set(taskId, agreed);
    },
  });
}

/**
 * The vendors a task already sends to: the ones it agreed to, plus the vendor of the Online model it runs on now
 * (the person was asked, or chose not to be, when they got there). Going Online A -> Claude -> Online B therefore
 * knows A and not B.
 */
export function agreedSourcesOf(input: Readonly<{
  ledger: OnlineConsentLedger;
  taskId: string;
  currentModelId: string | null;
  currentGroup: ModelGroup | undefined;
  sources: readonly Pick<ModelSourceProjection, "id" | "models">[];
}>): ReadonlySet<string> {
  const agreed = new Set(input.ledger.agreedSources(input.taskId));
  if (input.currentGroup === "online" && input.currentModelId !== null) {
    agreed.add(onlineSourceKey(input.currentModelId, input.sources));
  }
  return agreed;
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
