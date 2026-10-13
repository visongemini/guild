import type { GrokModelDescriptor, GuildAddonEngine, ModelCatalog } from "@guild/contracts";
import { claudeStatusOf, type ClaudeStatusView } from "./claude-engine.js";
import type { GuildMessages } from "./locales.js";
import { effortsDescending, globalDefaultView } from "./model-picker.js";

/*
 * What the renderer shows about an add-on engine itself (Codex first; PC-ENG-003, PC-SET-002): whether it can run on
 * this machine, the account label its adapter reported, and the default-model control of Settings. The states are
 * the Claude engine's, because the main process reports them the same way; everything is read from what it supplies,
 * and Guild never reads a credential.
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
    case "ready": return Object.freeze({ text: messages.addonStatusReady(engine, status.accountLabel) });
    case "not_found": return Object.freeze({ text: messages.addonStatusNotFound(engine), command: messages.addonInstallCommand(engine) });
    case "not_logged_in": return Object.freeze({ text: messages.addonStatusNotLoggedIn(engine), command: messages.addonLoginCommand(engine) });
    case "unavailable": return Object.freeze({ text: messages.addonStatusUnavailable(engine) });
    case "integrity_changed": return Object.freeze({ text: messages.addonStatusIntegrityChanged(engine) });
    case "install_not_private": return Object.freeze({
      text: status.installPath === undefined
        ? messages.addonStatusUnavailable(engine)
        : messages.addonStatusInstallNotPrivate(engine, status.installPath),
    });
  }
}

export type AddonDefaultsView = Readonly<{
  models: readonly GrokModelDescriptor[];
  /** A stored default the catalog no longer lists; the select keeps it visible instead of lying. */
  unlistedModelId: string | undefined;
  effortId: string | null;
  efforts: readonly Readonly<{ id: string; label: string }>[];
}>;

/** The default-model control of an add-on engine: its own models, and the efforts of the stored model, strongest first. */
export function addonDefaultsView(input: {
  readonly catalog: ModelCatalog;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}): AddonDefaultsView {
  const view = globalDefaultView({ catalog: input.catalog, model: input.model, reasoningEffort: input.reasoningEffort });
  return Object.freeze({
    models: input.catalog.models,
    unlistedModelId: view.unlistedModelId,
    effortId: view.effortId,
    efforts: effortsDescending(view.efforts),
  });
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
