import type { GuildPersistence, ModelSourceRecord } from "@guild/persistence";
import {
  ANTHROPIC_SOURCE_ID,
  readKeyFromEnvFile,
  startModelRouter,
  type ModelRouterHandle,
  type ProvenanceStore,
  type RouterSource,
} from "@guild/model-router";
import { isReservedAnthropicModelId } from "./anthropic-model-ids.js";
import type { ModelRouterHostPort, RoutedModelInfo } from "./engine-ports.js";

/** Default key file named by a source whose `keyFile` is null (docs/20 section 3.4). */
export const DEFAULT_KEY_FILE_UNDER_HOME = ".config/guild/keys.env";

export type ModelRouterHostStore = Pick<
  GuildPersistence,
  "listModelSources" | "loadThinkingProvenance" | "saveThinkingProvenance" | "pruneThinkingProvenance"
>;

export type RouterHostLog = (event: string, fields: Record<string, string | number | boolean>) => void;

export interface ModelRouterHost extends ModelRouterHostPort {
  /**
   * Re-reads the stored sources and their keys. Listeners are told when the usable model list
   * changed. Call it after any change to a source; it is cheap and calls never overlap.
   */
  refresh(): Promise<void>;
}

export type ModelRouterHostOptions = {
  readonly store: ModelRouterHostStore;
  /** Absolute path of the key file used by sources with `keyFile: null`. */
  readonly defaultKeyFile: string;
  /** Transport for Anthropic and Online upstreams. Production: Electron `net.fetch` on a dedicated session. */
  readonly fetchImpl: typeof fetch;
  /** Transport for Local upstreams (never through a system proxy). Defaults to `fetchImpl`. */
  readonly directFetchImpl?: typeof fetch;
  readonly log?: RouterHostLog;
};

type Snapshot = {
  readonly sources: readonly RouterSource[];
  readonly models: readonly RoutedModelInfo[];
  /** Model ids some usable source claims; they are never Anthropic ids. */
  readonly claimed: ReadonlySet<string>;
  /** Origins of usable Local sources. */
  readonly localOrigins: ReadonlySet<string>;
  readonly signature: string;
};

const EMPTY_SNAPSHOT: Snapshot = {
  sources: Object.freeze([]),
  models: Object.freeze([]),
  claimed: new Set(),
  localOrigins: new Set(),
  signature: "[]",
};

const ELECTRON_REDIRECT_CANCELLED = "Redirect was cancelled";
const MAX_NOTED_ANTHROPIC_MODELS = 1024;
const MAX_MODEL_ID_LENGTH = 128;

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function createModelRouterHost(options: ModelRouterHostOptions): ModelRouterHost {
  const { store } = options;
  const log: RouterHostLog = (event, fields) => {
    try {
      options.log?.(event, fields);
    } catch {
      // Logging must never break routing.
    }
  };
  const listeners = new Set<() => void>();
  const notedAnthropic = new Set<string>();
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  let primed = false;
  let refreshTail: Promise<void> = Promise.resolve();
  let starting: Promise<ModelRouterHandle> | undefined;
  let handle: ModelRouterHandle | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const isAnthropicModel = (id: string): boolean =>
    !snapshot.claimed.has(id) && (notedAnthropic.has(id) || id.startsWith("claude-"));

  const provenance: ProvenanceStore = {
    get: (hash) => {
      try {
        return store.loadThinkingProvenance(hash);
      } catch {
        log("router_host.provenance_error", { operation: "get" });
        return undefined;
      }
    },
    put: (hash, sourceId) => {
      try {
        store.saveThinkingProvenance({ hash, sourceId });
      } catch {
        log("router_host.provenance_error", { operation: "put" });
      }
    },
  };

  const routerFetch: typeof fetch = async (input, init) => {
    const origin = originOf(requestUrl(input));
    const transport = options.directFetchImpl !== undefined && origin !== undefined && snapshot.localOrigins.has(origin)
      ? options.directFetchImpl
      : options.fetchImpl;
    try {
      // Cookies from a vendor must never come back on a later request.
      return await transport(input, { ...init, credentials: "omit" });
    } catch (error) {
      // With redirect "manual" Electron's network stack rejects instead of returning the 3xx. Say
      // what happened so the router logs a refused redirect, not an unreachable upstream.
      if (error instanceof Error && error.message === ELECTRON_REDIRECT_CANCELLED) {
        return new Response(null, { status: 307 });
      }
      throw error;
    }
  };

  async function keyFor(record: ModelSourceRecord): Promise<{ readonly usable: boolean; readonly key?: string }> {
    if (record.keyVariable === null) {
      // A key-less source is only legitimate on this computer or the user's own network.
      return { usable: record.kind === "local" };
    }
    try {
      const key = await readKeyFromEnvFile(record.keyFile ?? options.defaultKeyFile, record.keyVariable);
      return key === undefined ? { usable: false } : { usable: true, key };
    } catch (error) {
      log("router_host.key_unreadable", {
        sourceId: record.id,
        errorName: error instanceof Error && /^[A-Za-z0-9_]{1,40}$/u.test(error.name) ? error.name : "Error",
      });
      return { usable: false };
    }
  }

  async function build(): Promise<Snapshot> {
    const sources: RouterSource[] = [];
    const models: RoutedModelInfo[] = [];
    const claimed = new Set<string>();
    const sourceIds = new Set<string>();
    const localOrigins = new Set<string>();
    for (const record of store.listModelSources()) {
      if (!record.enabled || record.confirmedHost === null) continue;
      if (record.id.toLowerCase() === ANTHROPIC_SOURCE_ID || sourceIds.has(record.id)) {
        log("router_host.source_skipped", { sourceId: record.id, reason: "reserved_or_duplicate_id" });
        continue;
      }
      const { usable, key } = await keyFor(record);
      if (!usable) {
        log("router_host.source_skipped", { sourceId: record.id, reason: "no_usable_key" });
        continue;
      }
      const accepted = record.models.filter((model) => {
        if (isReservedAnthropicModelId(model.id) || claimed.has(model.id)) {
          log("router_host.model_skipped", { sourceId: record.id, reason: "reserved_or_duplicate_model" });
          return false;
        }
        return true;
      });
      if (accepted.length === 0) continue;
      sourceIds.add(record.id);
      sources.push(Object.freeze({
        id: record.id,
        kind: record.kind,
        label: record.label,
        baseUrl: record.baseUrl,
        ...(key === undefined ? {} : { key }),
        confirmedHost: record.confirmedHost,
        models: Object.freeze(accepted.map((model) => Object.freeze({ ...model }))),
      }));
      if (record.kind === "local") {
        const origin = originOf(record.baseUrl);
        if (origin !== undefined) localOrigins.add(origin);
      }
      for (const model of accepted) {
        claimed.add(model.id);
        models.push(Object.freeze({
          id: model.id,
          label: model.label,
          group: record.kind,
          sourceId: record.id,
          sourceLabel: record.label,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.supportsImages === undefined ? {} : { supportsImages: model.supportsImages }),
        }));
      }
    }
    return Object.freeze({
      sources: Object.freeze(sources),
      models: Object.freeze(models),
      claimed,
      localOrigins,
      signature: JSON.stringify(models),
    });
  }

  function commit(next: Snapshot): boolean {
    const changed = next.signature !== snapshot.signature;
    snapshot = next;
    if (handle !== undefined) {
      try {
        handle.updateSources(next.sources);
      } catch {
        // build() already removed what the router rejects; keep the previous registry otherwise.
        log("router_host.update_failed", {});
      }
    }
    return changed;
  }

  function runRefresh(notify: boolean): Promise<void> {
    const operation = refreshTail.then(async () => {
      if (closed) return;
      let next: Snapshot;
      try {
        next = await build();
      } catch {
        log("router_host.refresh_failed", {});
        return;
      }
      const changed = commit(next);
      if (changed && notify) for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A faulty listener must not stop the others.
        }
      }
    });
    refreshTail = operation;
    return operation;
  }

  async function startRouter(): Promise<ModelRouterHandle> {
    // Keys are read when the router starts, so a rotated key is picked up by the next routed session.
    await runRefresh(true);
    const started = await startModelRouter({
      sources: snapshot.sources,
      isAnthropicModel,
      provenance,
      logger: { info: (event, fields) => log(event, fields) },
      fetchImpl: routerFetch,
    });
    if (closed) {
      await started.close();
      throw new Error("model_router_closed");
    }
    handle = started;
    // A refresh may have finished while the listener was starting.
    started.updateSources(snapshot.sources);
    try {
      store.pruneThinkingProvenance();
    } catch {
      log("router_host.provenance_error", { operation: "prune" });
    }
    return started;
  }

  const host: ModelRouterHost = {
    listRoutedModels: () => {
      if (!primed && !closed) {
        primed = true;
        void runRefresh(true);
      }
      return snapshot.models;
    },
    ensureStarted: async () => {
      if (closed) throw new Error("model_router_closed");
      starting ??= startRouter().catch((error: unknown) => {
        starting = undefined;
        throw error;
      });
      return { baseUrl: (await starting).url };
    },
    noteAnthropicModels: (ids) => {
      for (const id of ids) {
        if (typeof id !== "string" || id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) continue;
        if (notedAnthropic.size >= MAX_NOTED_ANTHROPIC_MODELS) break;
        notedAnthropic.add(id);
      }
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => runRefresh(true),
    close: () => {
      closing ??= (async () => {
        closed = true;
        listeners.clear();
        const started = await (starting ?? Promise.resolve(undefined)).catch(() => undefined);
        await started?.close();
        handle = undefined;
      })();
      return closing;
    },
  };
  return Object.freeze(host);
}
