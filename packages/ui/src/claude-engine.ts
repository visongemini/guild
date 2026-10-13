import type { GrokModelDescriptor, GuildClaudePermissionMode, ModelCatalog } from "@guild/contracts";
import { modelGroupOf } from "@guild/contracts/grok-models";
import type { GuildMessages } from "./locales.js";
import { CLAUDE_DEFAULT_ROW_ID, claudeModelIdentity, splitOlderClaudeModels } from "./claude-model-families.js";
import { MODEL_PICKER_SEPARATOR, effortsDescending, globalDefaultView } from "./model-picker.js";

/*
 * What the renderer shows about the Claude engine itself: whether Claude Code can run, the account
 * label the adapter reported, and the default-model control of Settings. Everything is read from
 * what the main process supplies; Guild never reads a Claude credential.
 */

export type ClaudeStatusState = "ready" | "not_found" | "not_logged_in" | "unavailable" | "integrity_changed" | "install_not_private";

export type ClaudeStatusView = Readonly<{
  state: ClaudeStatusState;
  /** The plan label the adapter reported, for example "Claude Max". Never an email address. */
  accountLabel?: string;
  version?: string;
  /** With `install_not_private`: the absolute path that someone other than the user may be able to change. */
  installPath?: string;
}>;

const STATUS_STATES: readonly string[] = ["ready", "not_found", "not_logged_in", "unavailable", "integrity_changed", "install_not_private"];
const MAX_LABEL = 80;
const MAX_PATH = 1024;

function plainPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH || !value.startsWith("/")) return undefined;
  return /[\u0000-\u001F\u007F]/u.test(value) ? undefined : value;
}

function plainLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  // A label that looks like an address could be the account email; it is never shown.
  if (text.length === 0 || text.length > MAX_LABEL || text.includes("@") || /[\u0000-\u001F\u007F]/u.test(text)) {
    return undefined;
  }
  return text;
}

/**
 * Reads `runtimeSettings.claude` defensively. The contract lists only the defaults today; the main
 * process adds `status` ("ready" | "not_found" | "not_logged_in" | "unavailable" | "integrity_changed" |
 * "install_not_private"), `accountLabel`, `version` and, for the last status, `installPath` as optional strings. Anything else, or nothing, yields `undefined` and the UI then
 * falls back to what it can see (an empty Claude catalog).
 */
export function claudeStatusOf(claude: unknown): ClaudeStatusView | undefined {
  if (claude === null || typeof claude !== "object") return undefined;
  const record = claude as Record<string, unknown>;
  const state = record["status"];
  if (typeof state !== "string" || !STATUS_STATES.includes(state)) return undefined;
  const accountLabel = plainLabel(record["accountLabel"]);
  const version = plainLabel(record["version"]);
  const installPath = state === "install_not_private" ? plainPath(record["installPath"]) : undefined;
  return Object.freeze({
    state: state as ClaudeStatusState,
    ...(accountLabel === undefined ? {} : { accountLabel }),
    ...(version === undefined ? {} : { version }),
    ...(installPath === undefined ? {} : { installPath }),
  });
}

/** The models Claude itself offers, without the Online and Local ones: those cannot be a default. */
export function claudeNativeCatalog(catalog: ModelCatalog): ModelCatalog {
  return Object.freeze({
    ...catalog,
    models: Object.freeze(catalog.models.filter((model) => modelGroupOf(model) === "claude")),
  });
}

export type ClaudeDefaultsView = Readonly<{
  catalog: ModelCatalog;
  models: readonly GrokModelDescriptor[];
  /** A stored default the catalog no longer lists; the select keeps it visible instead of lying. */
  unlistedModelId: string | undefined;
  effortId: string | null;
  efforts: readonly Readonly<{ id: string; label: string }>[];
}>;

export function claudeDefaultsView(input: {
  readonly catalog: ModelCatalog;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}): ClaudeDefaultsView {
  const catalog = claudeNativeCatalog(input.catalog);
  const view = globalDefaultView({ catalog, model: input.model, reasoningEffort: input.reasoningEffort });
  return Object.freeze({
    catalog,
    models: catalog.models,
    unlistedModelId: view.unlistedModelId,
    effortId: view.effortId,
    efforts: effortsDescending(view.efforts),
  });
}

export type ClaudeDefaultOption = Readonly<{ id: string; label: string }>;

/**
 * The model list of the default-model control in Settings, read the way the picker reads Claude's list: the
 * adapter's own Default row is the control's one "default" option (so it never appears a second time, in the
 * adapter's English), the newest model of each family comes first and the rest follow as older models, and a
 * family is described by the same Chinese text as in the picker.
 */
export function claudeDefaultModelOptions(
  messages: Pick<GuildMessages, "claudeModelDescription">,
  catalog: ModelCatalog,
): Readonly<{ current: readonly ClaudeDefaultOption[]; older: readonly ClaudeDefaultOption[] }> {
  const rows = claudeNativeCatalog(catalog).models.filter((model) => model.id !== CLAUDE_DEFAULT_ROW_ID);
  const { shown, older } = splitOlderClaudeModels(rows, () => false);
  const option = (model: GrokModelDescriptor): ClaudeDefaultOption => {
    const description = messages.claudeModelDescription(claudeModelIdentity(model).family, model.description);
    return Object.freeze({
      id: model.id,
      label: description === undefined ? model.name : `${model.name}${MODEL_PICKER_SEPARATOR}${description}`,
    });
  };
  return Object.freeze({ current: Object.freeze(shown.map(option)), older: Object.freeze(older.map(option)) });
}

/** The stored default as the control shows it: the adapter's Default row and no choice are the same "default" option. */
export function claudeDefaultSelectValue(model: string | null): string {
  return model === null || model === CLAUDE_DEFAULT_ROW_ID ? "" : model;
}

const CLAUDE_PERMISSION_MODES: readonly string[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

/**
 * The permission mode a Claude task shows: the mode its live session reports when that is one of the
 * adapter's, else the default Settings holds, else nothing (the pill is then left out rather than guessed).
 */
export function claudePermissionModeOf(
  sessionModes: Readonly<{ currentModeId: string }> | null | undefined,
  settingsDefault: GuildClaudePermissionMode | undefined,
): GuildClaudePermissionMode | undefined {
  const live = sessionModes?.currentModeId;
  return live !== undefined && CLAUDE_PERMISSION_MODES.includes(live)
    ? live as GuildClaudePermissionMode
    : settingsDefault;
}

/** The one-line status Settings shows for Claude Code. */
export function claudeStatusText(messages: GuildMessages, status: ClaudeStatusView): string {
  switch (status.state) {
    case "ready": return messages.claudeStatusReady(status.accountLabel);
    case "not_found": return messages.claudeStatusNotFound;
    case "not_logged_in": return messages.claudeStatusNotLoggedIn;
    case "unavailable": return messages.claudeStatusUnavailable;
    case "integrity_changed": return messages.claudeStatusIntegrityChanged;
    // Without a path the main process sent nothing to name; the generic unavailable text says no more than that.
    case "install_not_private":
      return status.installPath === undefined ? messages.claudeStatusUnavailable : messages.claudeStatusInstallNotPrivate(status.installPath);
  }
}
