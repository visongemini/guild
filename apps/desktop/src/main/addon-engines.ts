import {
  freezeModelCatalog,
  type GuildAddonEngine,
  type GuildEngineStatus,
  type ModelCatalog,
  type ModelDescriptor,
} from "@guild/contracts";

/**
 * PC-ENG-003, PC-SET-002: the state the main process keeps for each add-on engine (Codex first): what was found of
 * its installation, what it last said about its login, its model list and the version it reported. It is the
 * engine-keyed counterpart of the Claude variables in live-service.ts; a further add-on engine is one more entry of
 * `GUILD_ADDON_ENGINES` and one more state created from this module. Everything here is pure data handling: the
 * live service decides when to call it.
 */

export type AddonInstall = Readonly<{
  status: "ready" | "not_found" | "unavailable" | "integrity_changed";
  version?: string;
}>;

/** What the engine last said about its account: its kind and, for a ChatGPT account, the plan label. Never an address. */
export type AddonAuth = Readonly<{ kind: string; label?: string }>;

export type AddonEngineState = {
  readonly engine: GuildAddonEngine;
  /** The models the engine's own sessions reported, seeded from the local cache. */
  catalog: ModelCatalog;
  /** The version label a started process reported, for the catalog cache. */
  runtimeVersion: string | undefined;
  auth: AddonAuth | undefined;
  install: AddonInstall | undefined;
  probeAtMs: number;
  probeOperation: Promise<void> | undefined;
};

export function createAddonEngineState(engine: GuildAddonEngine, catalog: ModelCatalog): AddonEngineState {
  return { engine, catalog, runtimeVersion: undefined, auth: undefined, install: undefined, probeAtMs: 0, probeOperation: undefined };
}

export type AddonEngineReport = Readonly<{
  status?: GuildEngineStatus;
  accountLabel?: string;
  version?: string;
}>;

/**
 * The status, account label and version the settings and the composer show. A reduced install state wins over a
 * missing login; a login is named only when the engine itself said nobody is logged in. The plan label is shown only
 * for an account the engine calls one (`kind: "account"`, a ChatGPT login): an API key, a gateway or an external
 * provider have no plan, and the interface says the engine manages them.
 */
export function addonEngineReport(state: AddonEngineState): AddonEngineReport {
  const loginRequired = state.auth?.kind === "none";
  const status = state.install !== undefined && state.install.status !== "ready"
    ? state.install.status
    : loginRequired
      ? "not_logged_in" as const
      : state.install?.status;
  const accountLabel = state.auth?.kind === "account" && !loginRequired ? state.auth.label : undefined;
  return Object.freeze({
    ...(status === undefined ? {} : { status }),
    ...(accountLabel === undefined ? {} : { accountLabel }),
    ...(state.install?.version === undefined ? {} : { version: state.install.version }),
  });
}

/**
 * Merges the model list a session reported into what is known.
 *
 * - Efforts: a session lists the efforts of every model at its start (`atStart`), later updates only those of the
 *   selected model, so a model that comes back with none keeps the efforts seen before.
 * - Defaults: the engine's own default model and default effort are what a session reports when it starts (before
 *   Guild applied anything). A later update shows the user's choice, never the default, so it only keeps what was
 *   known.
 *
 * Returns `undefined` when there is nothing to change.
 */
export function mergeAddonCatalog(
  engine: GuildAddonEngine,
  previous: ModelCatalog,
  derived: ModelCatalog | undefined,
  atStart: boolean,
): ModelCatalog | undefined {
  if (derived === undefined || derived.models.length === 0) return undefined;
  const previousById = new Map(previous.models.map((model) => [model.id, model]));
  const models = derived.models.map((model): ModelDescriptor => {
    const before = previousById.get(model.id);
    const efforts = model.reasoningEfforts.length > 0 ? model.reasoningEfforts : before?.reasoningEfforts ?? [];
    if (atStart) return Object.freeze({ ...model, reasoningEfforts: efforts });
    const keptDefaults = new Set(before?.reasoningEfforts.filter((effort) => effort.isDefault).map((effort) => effort.id));
    return Object.freeze({
      ...model,
      reasoningEfforts: Object.freeze(efforts.map((effort) => Object.freeze({
        ...effort,
        isDefault: keptDefaults.has(effort.id),
      }))),
    });
  });
  const ids = new Set(models.map((model) => model.id));
  const runtimeDefaultModelId = [
    atStart ? derived.runtimeDefaultModelId : undefined,
    previous.runtimeDefaultModelId,
    derived.runtimeDefaultModelId,
  ].find((candidate) => candidate !== undefined && ids.has(candidate));
  try {
    return freezeModelCatalog(engine, {
      engine,
      models,
      ...(runtimeDefaultModelId === undefined ? {} : { runtimeDefaultModelId }),
    });
  } catch {
    // The catalog is advisory display data: a list the contracts refuse must not fault the session.
    return undefined;
  }
}
