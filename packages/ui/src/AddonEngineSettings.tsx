import type { AddonEngineSettingsProjection, GuildAddonEngine, ModelCatalog } from "@guild/contracts";
import { addonDefaultsView, addonStatusOf, addonStatusText } from "./addon-engine.js";
import type { GuildMessages } from "./locales.js";
import { selectionAfterModelChange } from "./model-picker.js";

/*
 * The Engines tab section of an add-on engine (Codex first; PC-ENG-003, PC-SET-002): its status with the command that
 * fixes a missing install or login, and the defaults a new task of that engine starts from. The same layout as the
 * Claude section, driven by the engine instead of by Claude's names. Nothing here reads a credential or offers one to
 * type: the status is what the main process learned from the engine itself.
 */

export type AddonEngineSettingsProps = Readonly<{
  engine: GuildAddonEngine;
  messages: GuildMessages;
  settings: AddonEngineSettingsProjection;
  catalog: ModelCatalog;
  busy: boolean;
  /** The last save failed. */
  failed: boolean;
  onChange: (model: string | null, reasoningEffort: string | null, permissionMode: string) => void;
}>;

export function AddonEngineSettings({ engine, messages, settings, catalog, busy, failed, onChange }: AddonEngineSettingsProps) {
  const status = addonStatusOf(settings);
  const statusText = status === undefined ? undefined : addonStatusText(messages, engine, status);
  const defaults = addonDefaultsView({ catalog, model: settings.model, reasoningEffort: settings.reasoningEffort });
  const headingId = `guild-engine-${engine}-heading`;
  const modeLabelId = `guild-${engine}-mode-label`;
  return (
    <div className={`guild-settings-section guild-engine-${engine}`}>
      <h3 className="guild-engine-heading" id={headingId}>{messages.settingsAddonHeading(engine)}</h3>
      <p className="guild-setting-help">{messages.enginesAddonIntro(engine)}</p>
      {status !== undefined && statusText !== undefined && (
        <p className={`guild-engine-status ${status.state}`} role="status">
          <span>{messages.claudeStatusLabel}</span>
          <strong>{statusText.text}</strong>
          {statusText.command !== undefined && <code className="guild-engine-command">{statusText.command}</code>}
        </p>
      )}
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.model}</span>
        <select
          value={settings.model ?? ""}
          disabled={busy}
          onChange={(event) => {
            const modelId = event.currentTarget.value;
            if (modelId === "") {
              onChange(null, null, settings.permissionMode);
              return;
            }
            const change = selectionAfterModelChange(catalog, modelId, settings.reasoningEffort);
            onChange(change.model, change.reasoningEffort, settings.permissionMode);
          }}
        >
          <option value="">{messages.addonDefaultModelOption(engine)}</option>
          {defaults.unlistedModelId !== undefined && <option value={defaults.unlistedModelId}>{defaults.unlistedModelId}</option>}
          {defaults.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.description === undefined ? model.name : `${model.name} · ${model.description}`}
            </option>
          ))}
        </select>
      </label>
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.reasoningEffort}</span>
        <select
          value={defaults.effortId ?? ""}
          disabled={busy || defaults.efforts.length === 0}
          onChange={(event) => onChange(settings.model, event.currentTarget.value, settings.permissionMode)}
        >
          {defaults.efforts.length === 0 && <option value="">{messages.reasoningFollowsRuntimeDefault}</option>}
          {defaults.efforts.map((effort) => (
            <option key={effort.id} value={effort.id}>{messages.reasoningEffortName(effort.id, effort.label)}</option>
          ))}
        </select>
      </label>
      <div className="guild-settings-section">
        <div className="guild-setting-label" id={modeLabelId}>{messages.permissionMode}</div>
        <div className="guild-claude-modes" role="radiogroup" aria-labelledby={modeLabelId}>
          {settings.availablePermissionModes.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={settings.permissionMode === mode}
              className={`guild-claude-mode${settings.permissionMode === mode ? " selected" : ""}${mode.endsWith("full-access") ? " warn" : ""}`}
              disabled={busy}
              onClick={() => onChange(settings.model, settings.reasoningEffort, mode)}
            >
              <strong>{messages.addonPermissionModeName(engine, mode)}</strong>
              <small>{messages.addonPermissionModeHelp(engine, mode)}</small>
            </button>
          ))}
        </div>
      </div>
      <p className="guild-setting-help">{messages.addonSettingsHelp(engine)}</p>
      {failed && <p className="guild-setting-help blocked" role="alert">{messages.addonSettingsFailed(engine)}</p>}
    </div>
  );
}
