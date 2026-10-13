import type {
  DesktopBootstrapProjection,
  EngineApiKeyProjection,
  GrokModelDescriptor,
  GuildAddonEngine,
  GuildRendererApi,
  ModelCatalog,
} from "@guild/contracts";
import { claudeStatusOf, type ClaudeStatusView } from "./claude-engine.js";
import type { GuildMessages } from "./locales.js";
import { effortsDescending, engineOffersEffort, globalDefaultView } from "./model-picker.js";
import { KEY_VARIABLE_PATTERN, SOURCE_LIMITS, isAbsolutePath, secretLike } from "./model-sources-form.js";

/*
 * What the renderer shows about an add-on engine itself (Codex, Gemini; PC-ENG-003, PC-ENG-004, PC-SET-002): whether
 * it can run on this machine, the account label its adapter reported, and the default-model control of Settings. The
 * states are the Claude engine's, because the main process reports them the same way; everything is read from what it
 * supplies. Guild never reads a credential, and for an engine that takes an API key (Gemini) the renderer handles only
 * the names of the file and variable the key is read from, never the key.
 */

export type AddonStatusView = ClaudeStatusView;

/** Reads `runtimeSettings.engines[engine]` defensively; anything unexpected, or nothing, yields `undefined`. */
export function addonStatusOf(settings: unknown): AddonStatusView | undefined {
  return claudeStatusOf(settings);
}

export type AddonStatusText = Readonly<{
  text: string;
  /** A command for the user to run in Terminal, shown after the text and never run by Guild. */
  command?: string;
}>;

/** The one-line status Settings shows for an add-on engine, with the command that fixes it when there is one. */
export function addonStatusText(
  messages: GuildMessages,
  engine: GuildAddonEngine,
  status: AddonStatusView,
): AddonStatusText {
  switch (status.state) {
    case "ready": return Object.freeze({ text: messages.addonStatusReady(engine, status.accountLabel, status.version) });
    case "not_found": return Object.freeze({ text: messages.addonStatusNotFound(engine), command: messages.addonInstallCommand(engine) });
    case "not_logged_in": {
      // For an engine that takes an API key (Gemini) this is "no usable key": there is no login to run, the key
      // binding below the status is the way out.
      const login = messages.addonLoginCommand(engine);
      return Object.freeze({ text: messages.addonStatusNotLoggedIn(engine), ...(login === undefined ? {} : { command: login }) });
    }
    case "unavailable": return Object.freeze({ text: messages.addonStatusUnavailable(engine) });
    case "integrity_changed": return Object.freeze({ text: messages.addonStatusIntegrityChanged(engine) });
  }
}

export type AddonDefaultsView = Readonly<{
  models: readonly GrokModelDescriptor[];
  /** A stored default the catalog no longer lists; the select keeps it visible instead of lying. */
  unlistedModelId: string | undefined;
  effortId: string | null;
  efforts: readonly Readonly<{ id: string; label: string }>[];
  /** False for an engine without an effort setting (Gemini): Settings shows no effort control at all. */
  showEfforts: boolean;
}>;

/**
 * The default-model control of an add-on engine: its own models, and the efforts of the stored model, strongest first.
 * An engine without an effort setting (Gemini) has none, whatever its list or the stored default says.
 */
export function addonDefaultsView(input: {
  readonly catalog: ModelCatalog;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  /** Absent reads as an engine with an effort setting (Codex). */
  readonly engine?: GuildAddonEngine;
}): AddonDefaultsView {
  const view = globalDefaultView({ catalog: input.catalog, model: input.model, reasoningEffort: input.reasoningEffort });
  const showEfforts = input.engine === undefined || engineOffersEffort(input.engine);
  return Object.freeze({
    models: input.catalog.models,
    unlistedModelId: view.unlistedModelId,
    effortId: showEfforts ? view.effortId : null,
    efforts: showEfforts ? effortsDescending(view.efforts) : Object.freeze([]),
    showEfforts,
  });
}

/**
 * The order Settings lists an engine's permission modes in, from the most careful to asking nothing, when the
 * adapter's own order is not that (Gemini lists `yolo` before `plan`); an engine without an entry keeps its order.
 */
const ADDON_MODE_DISPLAY_ORDER: Readonly<Partial<Record<GuildAddonEngine, readonly string[]>>> = Object.freeze({
  gemini: Object.freeze(["default", "autoEdit", "plan", "yolo"]),
});

/** The mode of each add-on engine that asks nothing: Settings marks it as a warning (docs/21 sections 4.4 and 8.5). */
const ADDON_FULL_ACCESS_MODE: Readonly<Record<GuildAddonEngine, string>> = Object.freeze({
  codex: "agent-full-access",
  gemini: "yolo",
});

/** The modes the engine offers, in the order Settings shows them; a mode the order table does not know comes last. */
export function addonPermissionModesInOrder(engine: GuildAddonEngine, available: readonly string[]): readonly string[] {
  const order = ADDON_MODE_DISPLAY_ORDER[engine];
  if (order === undefined) return available;
  const rank = (mode: string) => {
    const index = order.indexOf(mode);
    return index < 0 ? order.length : index;
  };
  return Object.freeze(available.map((mode, index) => ({ mode, index }))
    .sort((a, b) => rank(a.mode) - rank(b.mode) || a.index - b.index)
    .map(({ mode }) => mode));
}

export function addonModeIsFullAccess(engine: GuildAddonEngine, mode: string): boolean {
  return ADDON_FULL_ACCESS_MODE[engine] === mode;
}

/**
 * The permission mode an add-on task shows: the mode its live session reports when that is one the engine offers,
 * else the default Settings holds, else nothing (the pill is then left out rather than guessed).
 */
export function addonPermissionModeOf(
  sessionModes: Readonly<{ currentModeId: string }> | null | undefined,
  available: readonly string[] | undefined,
  settingsDefault: string | undefined,
): string | undefined {
  const live = sessionModes?.currentModeId;
  return live !== undefined && (available ?? []).includes(live) ? live : settingsDefault;
}

/** The two names of an engine's key binding as typed in Settings: the key file (empty for the default) and the variable. */
export type EngineKeyDraft = Readonly<{ keyFile: string; keyVariable: string }>;

export type EngineKeyIssues = Readonly<{
  keyFile?: "key_file";
  /** `key_variable_secret` when the text looks like a key rather than the name of a variable. */
  keyVariable?: "key_variable" | "key_variable_secret";
}>;

/**
 * The problems of a draft by the rules the main process enforces (`parseModelSourceKeyFile`, `parseModelSourceKeyVariable`):
 * an absolute key file or none, and a variable name of capital letters, digits and underscores. Something that looks like a
 * key in the variable field (a Google `AIza...` key, `sk-...`, a bearer token) is named as such; it is never sent.
 */
export function engineKeyIssues(draft: EngineKeyDraft): EngineKeyIssues {
  const keyFile = draft.keyFile.trim();
  const keyVariable = draft.keyVariable.trim();
  const fileBad = keyFile !== "" && (keyFile.length > SOURCE_LIMITS.keyFileLength || !isAbsolutePath(keyFile));
  const variableIssue = KEY_VARIABLE_PATTERN.test(keyVariable)
    ? undefined
    : keyVariable !== "" && (secretLike(keyVariable) || /^AIza/u.test(keyVariable)) ? "key_variable_secret" as const : "key_variable" as const;
  return Object.freeze({
    ...(fileBad ? { keyFile: "key_file" as const } : {}),
    ...(variableIssue === undefined ? {} : { keyVariable: variableIssue }),
  });
}

/** The request a valid draft becomes: an empty key file is the default file (`null`). */
export function engineKeyRequest(draft: EngineKeyDraft): Readonly<{ keyFile: string | null; keyVariable: string }> {
  const keyFile = draft.keyFile.trim();
  return Object.freeze({ keyFile: keyFile === "" ? null : keyFile, keyVariable: draft.keyVariable.trim() });
}

/**
 * Confirm in Settings: saves the two names with `setEngineApiKey` only when they differ from the stored binding (a save
 * voids an earlier confirmation), then asks the main process for the native confirmation with `confirmEngineApiKey`.
 * Each returned projection is handed on as it arrives, so a saved binding shows even when the confirmation fails. A
 * cancelled dialog is not a failure: the projection then simply still says `confirmed: false`. A rejection propagates.
 */
export async function saveAndConfirmEngineApiKey(
  api: Pick<GuildRendererApi, "setEngineApiKey" | "confirmEngineApiKey">,
  input: Readonly<{
    engine: GuildAddonEngine;
    current: Pick<EngineApiKeyProjection, "keyFile" | "keyVariable">;
    keyFile: string | null;
    keyVariable: string;
  }>,
  onProjection: (projection: DesktopBootstrapProjection) => void,
): Promise<void> {
  if (input.keyFile !== input.current.keyFile || input.keyVariable !== input.current.keyVariable) {
    onProjection(await api.setEngineApiKey({ engine: input.engine, keyFile: input.keyFile, keyVariable: input.keyVariable }));
  }
  onProjection(await api.confirmEngineApiKey({ engine: input.engine }));
}
