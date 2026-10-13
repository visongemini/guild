import type { ModelGroup, ModelSourceProjection } from "@guild/contracts";

/*
 * The Online-model reminder (PC-PRIV-001). Before a conversation first sends to an Online vendor, Guild says
 * what leaves this Mac. The agreement is per task and per vendor (model source): agreeing to one vendor says
 * nothing about another, and going Online A -> Claude -> Online B asks again for B. Claude and Local models
 * never ask. "Don't remind me again in this workspace" is a workspace preference kept by the main process and
 * silences every reminder. Which vendors a task agreed to is renderer state kept in localStorage (D-065), so a
 * Guild restart does not ask again for a vendor the task already agreed to; a blocked store only forgets it.
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
 * The vendor a model belongs to: the model source that lists it, together with the full address that source sends
 * to (an agreement for one address says nothing about another, so a source edited to a new host or path, or deleted
 * and recreated under the same id elsewhere, asks again), else a key made from the model id (a model no source
 * lists still gets one stable key, so it is asked about once, not on every switch).
 */
export function onlineSourceKey(
  modelId: string,
  sources: readonly (Pick<ModelSourceProjection, "id" | "models"> & Partial<Pick<ModelSourceProjection, "baseUrl">>)[],
): string {
  const source = sources.find((candidate) => candidate.models.some((model) => model.id === modelId));
  if (source === undefined) return `model:${modelId}`;
  let address = "";
  try {
    if (source.baseUrl !== undefined) {
      const url = new URL(source.baseUrl);
      address = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, "")}`;
    }
  } catch {
    address = "";
  }
  return address === "" ? `source:${source.id}` : `source:${source.id}@${address}`;
}

/** Which vendors each task agreed to send to; survives a restart when a store is given. */
export type OnlineConsentLedger = Readonly<{
  agreedSources: (taskId: string) => ReadonlySet<string>;
  agree: (taskId: string, sourceKey: string) => void;
}>;

export const ONLINE_CONSENT_STORAGE_KEY = "guild.onlineConsent.v1";
/** Tasks remembered; the oldest agreements are dropped first. */
const ONLINE_CONSENT_MAX_TASKS = 500;
const ONLINE_CONSENT_MAX_SOURCES = 32;

function readOnlineConsent(storage: Pick<Storage, "getItem"> | undefined): Map<string, Set<string>> {
  const byTask = new Map<string, Set<string>>();
  if (storage === undefined) return byTask;
  try {
    const parsed = JSON.parse(storage.getItem(ONLINE_CONSENT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return byTask;
    for (const entry of parsed.slice(-ONLINE_CONSENT_MAX_TASKS)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
      const keys = (entry[1] as unknown[]).filter((key): key is string => typeof key === "string" && key.length <= 256);
      if (keys.length > 0) byTask.set(entry[0], new Set(keys.slice(0, ONLINE_CONSENT_MAX_SOURCES)));
    }
  } catch {
    // A damaged or blocked store only means the reminder asks again.
  }
  return byTask;
}

export function createOnlineConsentLedger(storage?: Pick<Storage, "getItem" | "setItem">): OnlineConsentLedger {
  const byTask = readOnlineConsent(storage);
  const persist = (): void => {
    if (storage === undefined) return;
    try {
      const entries = [...byTask].slice(-ONLINE_CONSENT_MAX_TASKS).map(([taskId, keys]) => [taskId, [...keys]]);
      storage.setItem(ONLINE_CONSENT_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // The agreement is a convenience; a full or blocked store only loses it on restart.
    }
  };
  return Object.freeze({
    agreedSources: (taskId) => new Set(byTask.get(taskId) ?? []),
    agree: (taskId, sourceKey) => {
      const agreed = byTask.get(taskId) ?? new Set<string>();
      if (agreed.has(sourceKey)) return;
      agreed.add(sourceKey);
      // Both caps hold in memory too, so a long-running window cannot grow without bound.
      while (agreed.size > ONLINE_CONSENT_MAX_SOURCES) agreed.delete(agreed.values().next().value as string);
      // Re-inserting moves the task to the newest end, so the cap drops the least recent agreements.
      byTask.delete(taskId);
      byTask.set(taskId, agreed);
      while (byTask.size > ONLINE_CONSENT_MAX_TASKS) byTask.delete(byTask.keys().next().value as string);
      persist();
    },
  });
}

/**
 * The vendors a task already agreed to send to, as recorded when the reminder was answered (or skipped because the
 * workspace silenced it). Going Online A -> Claude -> Online B therefore knows A and not B. The Online model a task
 * runs on now is not counted implicitly any more (D-065): its source may have been edited to another address since
 * the agreement, and a task from before the ledger was kept asks once more instead.
 */
export function agreedSourcesOf(input: Readonly<{
  ledger: OnlineConsentLedger;
  taskId: string;
  currentModelId: string | null;
  currentGroup: ModelGroup | undefined;
  sources: readonly Pick<ModelSourceProjection, "id" | "models">[];
}>): ReadonlySet<string> {
  return new Set(input.ledger.agreedSources(input.taskId));
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
