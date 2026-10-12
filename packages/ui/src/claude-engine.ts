import type { GrokModelDescriptor, GuildClaudePermissionMode, ModelCatalog } from "@guild/contracts";
import { modelGroupOf } from "@guild/contracts/grok-models";
import type { GuildMessages } from "./locales.js";
import { effortsDescending, globalDefaultView } from "./model-picker.js";

/*
 * What the renderer shows about the Claude engine itself: whether Claude Code can run, the account
 * label the adapter reported, and the default-model control of Settings. Everything is read from
 * what the main process supplies; Guild never reads a Claude credential.
 */

export type ClaudeStatusState = "ready" | "not_found" | "not_logged_in" | "unavailable" | "integrity_changed";

export type ClaudeStatusView = Readonly<{
  state: ClaudeStatusState;
  /** The plan label the adapter reported, for example "Claude Max". Never an email address. */
  accountLabel?: string;
  version?: string;
}>;

const STATUS_STATES: readonly string[] = ["ready", "not_found", "not_logged_in", "unavailable", "integrity_changed"];
const MAX_LABEL = 80;

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
 * process adds `status` ("ready" | "not_found" | "not_logged_in" | "unavailable" | "integrity_changed"), `accountLabel`
 * and `version` as optional strings. Anything else, or nothing, yields `undefined` and the UI then
 * falls back to what it can see (an empty Claude catalog).
 */
export function claudeStatusOf(claude: unknown): ClaudeStatusView | undefined {
  if (claude === null || typeof claude !== "object") return undefined;
  const record = claude as Record<string, unknown>;
  const state = record["status"];
  if (typeof state !== "string" || !STATUS_STATES.includes(state)) return undefined;
  const accountLabel = plainLabel(record["accountLabel"]);
  const version = plainLabel(record["version"]);
  return Object.freeze({
    state: state as ClaudeStatusState,
    ...(accountLabel === undefined ? {} : { accountLabel }),
    ...(version === undefined ? {} : { version }),
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
  }
}
