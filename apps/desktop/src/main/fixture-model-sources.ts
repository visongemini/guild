import { modelSourceHost } from "@guild/contracts";
import type { ModelSourceRecord } from "@guild/persistence";
import { createModelSourcesService, type ModelSourcesService, type ModelSourcesStore } from "./model-sources-service.js";

// In-memory model sources for the UI fixture (GUILD_DESKTOP_FIXTURE=1). Not packaged. It runs the real
// service over a Map instead of SQLite and answers the native confirmation with "Allow".

function seeded(): Map<string, ModelSourceRecord> {
  const at = Date.now();
  const records = new Map<string, ModelSourceRecord>();
  const add = (record: Omit<ModelSourceRecord, "revision" | "createdAtMs" | "updatedAtMs">): void => {
    records.set(record.id, Object.freeze({ ...record, revision: 2, createdAtMs: at, updatedAtMs: at }));
  };
  add({
    id: "deepseek",
    kind: "online",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    keyFile: null,
    keyVariable: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 128000, supportsImages: false },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 128000, supportsImages: false },
    ],
    enabled: true,
    confirmedHost: "api.deepseek.com",
  });
  add({
    id: "workstation",
    kind: "local",
    label: "Workstation (llama.cpp)",
    baseUrl: "http://127.0.0.1:8081",
    keyFile: null,
    keyVariable: null,
    models: [{ id: "flash-next-local", label: "Flash-Next (local)", contextWindow: 65536 }],
    enabled: true,
    confirmedHost: "127.0.0.1:8081",
  });
  return records;
}

export function createFixtureModelSources(): ModelSourcesService {
  const records = seeded();
  const dismissed = new Map<string, boolean>();
  const store: ModelSourcesStore = {
    listModelSources: () => [...records.values()],
    loadModelSource: (id) => records.get(id),
    upsertModelSource: (draft) => {
      const existing = records.get(draft.id);
      const trustChanged = existing !== undefined && (
        existing.kind !== draft.kind || existing.baseUrl !== draft.baseUrl ||
        existing.keyFile !== draft.keyFile || existing.keyVariable !== draft.keyVariable
      );
      const confirmedHost = existing === undefined || trustChanged ? null : existing.confirmedHost;
      const at = Date.now();
      const source: ModelSourceRecord = Object.freeze({
        ...draft,
        confirmedHost,
        revision: (existing?.revision ?? 0) + 1,
        createdAtMs: existing?.createdAtMs ?? at,
        updatedAtMs: at,
      });
      records.set(draft.id, source);
      return { source, needsConfirmation: confirmedHost === null };
    },
    deleteModelSource: (id) => {
      if (!records.delete(id)) throw new Error("aggregate_not_found");
    },
    confirmModelSource: ({ sourceId, expectedRevision }) => {
      const current = records.get(sourceId);
      if (current === undefined) throw new Error("aggregate_not_found");
      if (current.revision !== expectedRevision) throw new Error("persistence_cas_conflict");
      const source: ModelSourceRecord = Object.freeze({
        ...current,
        confirmedHost: modelSourceHost(current.baseUrl),
        revision: current.revision + 1,
      });
      records.set(sourceId, source);
      return source;
    },
    loadWorkspacePrefs: (workspaceId) => ({ workspaceId, onlineReminderDismissed: dismissed.get(workspaceId) ?? false }),
    saveWorkspacePrefs: ({ workspaceId, onlineReminderDismissed }) => {
      dismissed.set(workspaceId, onlineReminderDismissed);
      return { workspaceId, onlineReminderDismissed };
    },
  };
  return createModelSourcesService({
    store,
    defaultKeyFile: "/Users/fixture/.config/guild/keys.env",
    getLocale: async () => "en-US",
    confirmHost: async () => true,
    onChanged: () => undefined,
    // No network in the fixture: every model answers, one slower than the next.
    connectionTest: {
      fetchImpl: async () => new Response("{}", { status: 200 }),
      readKey: async (record) => ({ usable: record.keyVariable !== null || record.kind === "local", key: "fixture-key" }),
    },
  });
}
