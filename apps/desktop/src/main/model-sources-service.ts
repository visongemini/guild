import {
  GUILD_MODEL_SOURCE_LIMITS,
  modelSourceHost,
  parseModelSourceDraft,
  type ConfirmModelSourceResponse,
  type GetWorkspacePrefsRequest,
  type GuildLocale,
  type ListModelSourcesResponse,
  type ModelSourceDraft,
  type ModelSourceProjection,
  type SetWorkspacePrefsRequest,
  type UpsertModelSourceResponse,
  type WorkspacePrefsProjection,
} from "@guild/contracts";
import type { GuildPersistence, ModelSourceRecord } from "@guild/persistence";
import { ANTHROPIC_SOURCE_ID } from "@guild/model-router";
import { isReservedAnthropicModelId } from "./anthropic-model-ids.js";
import { hostConfirmationPrompt, type HostConfirmationPrompt } from "./model-source-messages.js";

export type { HostConfirmationPrompt };

export type ModelSourcesStore = Pick<
  GuildPersistence,
  | "listModelSources"
  | "loadModelSource"
  | "upsertModelSource"
  | "deleteModelSource"
  | "confirmModelSource"
  | "loadWorkspacePrefs"
  | "saveWorkspacePrefs"
>;

export type ModelSourcesServiceOptions = {
  readonly store: ModelSourcesStore;
  /** Absolute path of the key file used by sources with `keyFile: null`; shown in the dialog. */
  readonly defaultKeyFile: string;
  readonly getLocale: () => Promise<GuildLocale>;
  /** Shows the native dialog (`dialog.showMessageBox`) and resolves true only for "Allow". */
  readonly confirmHost: (prompt: HostConfirmationPrompt) => Promise<boolean>;
  /** Called after every mutation so the router host re-reads sources and keys. */
  readonly onChanged: () => void;
};

/** The model source and workspace preference operations behind the IPC channels. */
export interface ModelSourcesService {
  list(): Promise<ListModelSourcesResponse>;
  upsert(draft: ModelSourceDraft): Promise<UpsertModelSourceResponse>;
  remove(id: string): Promise<void>;
  confirm(id: string): Promise<ConfirmModelSourceResponse>;
  getWorkspacePrefs(request: GetWorkspacePrefsRequest): Promise<WorkspacePrefsProjection>;
  setWorkspacePrefs(request: SetWorkspacePrefsRequest): Promise<WorkspacePrefsProjection>;
}

/** Codes pass through `toDesktopIpcFailure` (`model_source_<reason>`); never a path, key or address. */
function failure(reason: string): Error {
  return new Error(`model_source_${reason}`);
}

/** Bidirectional controls and zero-width characters could make the dialog say something else. */
const INVISIBLE_FORMATTING = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/u;

/** The projection is an explicit copy: nothing but the documented, secret-free fields can reach the renderer. */
function project(record: ModelSourceRecord): ModelSourceProjection {
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    label: record.label,
    baseUrl: record.baseUrl,
    keyFile: record.keyFile,
    keyVariable: record.keyVariable,
    models: Object.freeze(record.models.map((model) => Object.freeze({
      id: model.id,
      label: model.label,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
    }))),
    enabled: record.enabled,
    confirmedHost: record.confirmedHost,
  });
}

function persistenceCode(cause: unknown): string | undefined {
  return cause instanceof Error ? cause.message : undefined;
}

export function createModelSourcesService(options: ModelSourcesServiceOptions): ModelSourcesService {
  const { store } = options;
  const confirmations = new Map<string, Promise<ConfirmModelSourceResponse>>();

  function changed(): void {
    try {
      options.onChanged();
    } catch {
      // The stored change is already durable; a faulty listener must not turn it into an error.
    }
  }

  function validated(input: unknown): ModelSourceDraft {
    let draft: ModelSourceDraft;
    try {
      draft = parseModelSourceDraft(input);
    } catch {
      throw failure("invalid");
    }
    if (draft.id.toLowerCase() === ANTHROPIC_SOURCE_ID) throw failure("reserved_id");
    if (draft.models.some((model) => isReservedAnthropicModelId(model.id))) throw failure("reserved_model");
    const shown = [draft.label, draft.keyFile ?? "", ...draft.models.map((model) => model.label)];
    if (shown.some((text) => INVISIBLE_FORMATTING.test(text))) throw failure("invalid");
    return draft;
  }

  async function confirmFresh(id: string): Promise<ConfirmModelSourceResponse> {
    const source = store.loadModelSource(id);
    if (source === undefined) throw failure("not_found");
    const host = modelSourceHost(source.baseUrl);
    if (source.confirmedHost === host) return { status: "confirmed", source: project(source) };
    // The dialog is built from this revision; an edit made while it is open voids the answer.
    const prompt = hostConfirmationPrompt({
      locale: await options.getLocale(),
      kind: source.kind,
      label: source.label,
      host,
      keyVariable: source.keyVariable,
      keyFile: source.keyFile ?? options.defaultKeyFile,
    });
    if (!(await options.confirmHost(prompt))) {
      return { status: "cancelled", source: project(store.loadModelSource(id) ?? source) };
    }
    let confirmed: ModelSourceRecord;
    try {
      confirmed = store.confirmModelSource({ sourceId: id, expectedRevision: source.revision });
    } catch (cause) {
      const code = persistenceCode(cause);
      throw failure(code === "persistence_cas_conflict" ? "changed" : code === "aggregate_not_found" ? "not_found" : "rejected");
    }
    changed();
    return { status: "confirmed", source: project(confirmed) };
  }

  const service: ModelSourcesService = {
    list: async () => Object.freeze({ sources: Object.freeze(store.listModelSources().map(project)) }),

    upsert: async (input) => {
      const draft = validated(input);
      const existing = store.listModelSources();
      if (existing.some((other) => other.id !== draft.id && other.models.some((model) => draft.models.some((mine) => mine.id === model.id)))) {
        throw failure("duplicate_model");
      }
      if (existing.length >= GUILD_MODEL_SOURCE_LIMITS.maxSources && !existing.some((other) => other.id === draft.id)) {
        throw failure("limit");
      }
      let result: ReturnType<ModelSourcesStore["upsertModelSource"]>;
      try {
        result = store.upsertModelSource(draft);
      } catch (cause) {
        throw failure(persistenceCode(cause) === "persistence_cas_conflict" ? "changed" : "rejected");
      }
      changed();
      return Object.freeze({ source: project(result.source), needsConfirmation: result.needsConfirmation });
    },

    remove: async (id) => {
      try {
        store.deleteModelSource(id);
      } catch (cause) {
        throw failure(persistenceCode(cause) === "aggregate_not_found" ? "not_found" : "rejected");
      }
      changed();
    },

    confirm: (id) => {
      // One dialog per source: a second request while it is open joins the first.
      const open = confirmations.get(id);
      if (open !== undefined) return open;
      const operation = confirmFresh(id).finally(() => confirmations.delete(id));
      confirmations.set(id, operation);
      return operation;
    },

    getWorkspacePrefs: async (request) => {
      const prefs = store.loadWorkspacePrefs(request.workspaceId);
      return Object.freeze({ workspaceId: request.workspaceId, onlineReminderDismissed: prefs.onlineReminderDismissed });
    },

    setWorkspacePrefs: async (request) => {
      const prefs = store.saveWorkspacePrefs({
        workspaceId: request.workspaceId,
        onlineReminderDismissed: request.onlineReminderDismissed,
      });
      return Object.freeze({ workspaceId: request.workspaceId, onlineReminderDismissed: prefs.onlineReminderDismissed });
    },
  };
  return Object.freeze(service);
}
