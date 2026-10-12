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
  type TestModelSourceResponse,
  type UpsertModelSourceResponse,
  type WorkspacePrefsProjection,
} from "@guild/contracts";
import type { GuildPersistence, ModelSourceRecord } from "@guild/persistence";
import {
  ANTHROPIC_SOURCE_ID,
  probeSourceModels,
  type RouterLogger,
  type UpstreamFetch,
} from "@guild/model-router";
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

/**
 * What the connection test runs on. The transport and the key reader are the router host's own (`createRouterFetch`,
 * `readSourceKey`), so a test goes where, and with what, a real turn would; tests inject a fake transport.
 */
export type ModelSourceTestPort = {
  readonly fetchImpl: UpstreamFetch;
  readonly readKey: (record: ModelSourceRecord) => Promise<{ readonly usable: boolean; readonly key?: string }>;
  /** DNS lookup of the Local address check; the router's default when absent. */
  readonly lookup?: (host: string) => Promise<string[]>;
  readonly timeoutMs?: number;
  readonly logger?: RouterLogger;
};

export type ModelSourcesServiceOptions = {
  readonly store: ModelSourcesStore;
  /** Absolute path of the key file used by sources with `keyFile: null`; shown in the dialog. */
  readonly defaultKeyFile: string;
  readonly getLocale: () => Promise<GuildLocale>;
  /** Shows the native dialog (`dialog.showMessageBox`) and resolves true only for "Allow". */
  readonly confirmHost: (prompt: HostConfirmationPrompt) => Promise<boolean>;
  /** Called after every mutation so the router host re-reads sources and keys. */
  readonly onChanged: () => void;
  /** The connection test (`test`); a service without it answers `model_source_unavailable`. */
  readonly connectionTest?: ModelSourceTestPort;
};

/** The model source and workspace preference operations behind the IPC channels. */
export interface ModelSourcesService {
  list(): Promise<ListModelSourcesResponse>;
  upsert(draft: ModelSourceDraft): Promise<UpsertModelSourceResponse>;
  remove(id: string): Promise<void>;
  confirm(id: string): Promise<ConfirmModelSourceResponse>;
  /** One one-token request per model of a confirmed source, through the router's own rules and transport. */
  test(id: string): Promise<TestModelSourceResponse>;
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

  const tests = new Map<string, Promise<TestModelSourceResponse>>();

  async function testFresh(id: string, port: ModelSourceTestPort): Promise<TestModelSourceResponse> {
    const record = store.loadModelSource(id);
    if (record === undefined) throw failure("not_found");
    const refused = (reason: NonNullable<TestModelSourceResponse["refused"]>): TestModelSourceResponse =>
      Object.freeze({ id, refused: reason, results: Object.freeze([]) });
    // Only the address the user confirmed is ever contacted, and only with the key that address was confirmed for.
    if (record.confirmedHost === null || record.confirmedHost !== modelSourceHost(record.baseUrl)) return refused("not_confirmed");
    const { usable, key } = await port.readKey(record);
    if (!usable) return refused("key_unavailable");
    const probed = await probeSourceModels({
      source: {
        id: record.id,
        kind: record.kind,
        label: record.label,
        baseUrl: record.baseUrl,
        ...(key === undefined ? {} : { key }),
        confirmedHost: record.confirmedHost,
        models: record.models.filter((model) => !isReservedAnthropicModelId(model.id)),
      },
      fetchImpl: port.fetchImpl,
      ...(port.lookup === undefined ? {} : { lookup: port.lookup }),
      ...(port.timeoutMs === undefined ? {} : { timeoutMs: port.timeoutMs }),
      ...(port.logger === undefined ? {} : { logger: port.logger }),
    });
    if ("refused" in probed) {
      return refused(probed.refused === "source_not_confirmed"
        ? "not_confirmed"
        : probed.refused === "anthropic_key_denied" ? "key_not_allowed" : "address_not_allowed");
    }
    return Object.freeze({ id, results: Object.freeze(probed.models.map((entry) => Object.freeze({ modelId: entry.modelId, outcome: entry.outcome }))) });
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

    test: (id) => {
      const port = options.connectionTest;
      if (port === undefined) return Promise.reject(failure("unavailable"));
      // One test per source at a time: a second click while it runs joins the first.
      // The key is the source at its current revision: an edit or a confirmation made while a test runs
      // starts a new test of the new source instead of joining the one that used the old one.
      const key = `${id}:${store.loadModelSource(id)?.revision ?? "none"}`;
      const running = tests.get(key);
      if (running !== undefined) return running;
      const operation = testFresh(id, port).finally(() => tests.delete(key));
      tests.set(key, operation);
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
