import type { AddonEngineSettingsProjection, EngineApiKeyProjection, GuildAddonEngine, ModelCatalog } from "@guild/contracts";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { useState } from "react";
import {
  addonDefaultsView,
  addonModeIsFullAccess,
  addonPermissionModesInOrder,
  addonStatusOf,
  addonStatusText,
  engineKeyIssues,
  engineKeyRequest,
  type EngineKeyDraft,
} from "./addon-engine.js";
import type { GuildMessages } from "./locales.js";
import { selectionAfterModelChange } from "./model-picker.js";

/*
 * The Engines tab section of an add-on engine (Codex, Gemini; PC-ENG-003, PC-ENG-004, PC-SET-002): its status with the
 * command that fixes a missing install or login, and the defaults a new task of that engine starts from. The same
 * layout as the Claude section, driven by the engine instead of by Claude's names. Nothing here reads a credential or
 * offers one to type: the status is what the main process learned from the engine itself. An engine paid for with an
 * API key (Gemini) adds its key binding: the names of the file and variable the key is read from, the one host it may
 * be sent to and the Confirm control; the key itself never passes through the renderer.
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
  /** A save or confirmation of the key binding is running (the native dialog may be open). */
  keyBusy?: boolean;
  /** The last save or confirmation of the key binding failed. */
  keyFailed?: boolean;
  /** Saves the two names when they changed, then asks for the native confirmation. */
  onConfirmKey?: (keyFile: string | null, keyVariable: string) => void;
}>;

export function AddonEngineSettings({
  engine,
  messages,
  settings,
  catalog,
  busy,
  failed,
  onChange,
  keyBusy = false,
  keyFailed = false,
  onConfirmKey,
}: AddonEngineSettingsProps) {
  const status = addonStatusOf(settings);
  const statusText = status === undefined ? undefined : addonStatusText(messages, engine, status);
  const defaults = addonDefaultsView({ catalog, model: settings.model, reasoningEffort: settings.reasoningEffort, engine });
  // An engine without an effort setting (Gemini) never saves one, whatever is stored.
  const effortOf = (effort: string | null) => defaults.showEfforts ? effort : null;
  const headingId = `guild-engine-${engine}-heading`;
  const modeLabelId = `guild-${engine}-mode-label`;
  const apiKey = settings.apiKey;
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
      {apiKey !== undefined && (
        <EngineApiKeySettings
          // The draft starts again from what is stored whenever a save changed it.
          key={`${apiKey.keyFile ?? ""}\u0000${apiKey.keyVariable}`}
          engine={engine}
          messages={messages}
          apiKey={apiKey}
          busy={busy || keyBusy}
          keyBusy={keyBusy}
          failed={keyFailed}
          onConfirm={(keyFile, keyVariable) => onConfirmKey?.(keyFile, keyVariable)}
        />
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
            onChange(change.model, effortOf(change.reasoningEffort), settings.permissionMode);
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
      {defaults.showEfforts && (
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
      )}
      <div className="guild-settings-section">
        <div className="guild-setting-label" id={modeLabelId}>{messages.permissionMode}</div>
        <div className="guild-claude-modes" role="radiogroup" aria-labelledby={modeLabelId}>
          {addonPermissionModesInOrder(engine, settings.availablePermissionModes).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={settings.permissionMode === mode}
              className={`guild-claude-mode${settings.permissionMode === mode ? " selected" : ""}${addonModeIsFullAccess(engine, mode) ? " warn" : ""}`}
              disabled={busy}
              onClick={() => onChange(settings.model, effortOf(settings.reasoningEffort), mode)}
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

/**
 * The key binding of an engine paid for per use (PC-ENG-004, docs/21 section 8.2): two text fields for names (the key
 * file, empty for the default, and the variable), the host read-only, whether the user confirmed this binding for that
 * host, what the main process found when it last looked, and one Confirm control. There is no field for the key.
 */
function EngineApiKeySettings({ engine, messages, apiKey, busy, keyBusy, failed, onConfirm }: Readonly<{
  engine: GuildAddonEngine;
  messages: GuildMessages;
  apiKey: EngineApiKeyProjection;
  busy: boolean;
  keyBusy: boolean;
  failed: boolean;
  onConfirm: (keyFile: string | null, keyVariable: string) => void;
}>) {
  const [draft, setDraft] = useState<EngineKeyDraft>({ keyFile: apiKey.keyFile ?? "", keyVariable: apiKey.keyVariable });
  const issues = engineKeyIssues(draft);
  const valid = issues.keyFile === undefined && issues.keyVariable === undefined;
  const fieldId = `guild-engine-${engine}-key`;
  return (
    <div className="guild-settings-section guild-engine-key" role="group" aria-labelledby={`${fieldId}-heading`}>
      <div className="guild-setting-label" id={`${fieldId}-heading`}>{messages.engineKeyHeading}</div>
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.sourcesFieldKeyFile}</span>
        <input
          type="text"
          spellCheck={false}
          value={draft.keyFile}
          placeholder={apiKey.defaultKeyFile}
          autoComplete="off"
          disabled={busy}
          aria-invalid={issues.keyFile !== undefined || undefined}
          aria-describedby={`${fieldId}-file-hint${issues.keyFile === undefined ? "" : ` ${fieldId}-file-error`}`}
          onChange={(event) => setDraft({ ...draft, keyFile: event.currentTarget.value })}
        />
        <small className="guild-setting-help" id={`${fieldId}-file-hint`}>{messages.sourcesKeyFileHint}</small>
        {issues.keyFile !== undefined && (
          <p className="guild-source-error" id={`${fieldId}-file-error`} role="alert">{messages.sourcesInvalid(issues.keyFile)}</p>
        )}
      </label>
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.sourcesFieldKeyVariable}</span>
        <input
          type="text"
          spellCheck={false}
          value={draft.keyVariable}
          placeholder={apiKey.keyVariable}
          autoComplete="off"
          disabled={busy}
          aria-invalid={issues.keyVariable !== undefined || undefined}
          aria-describedby={`${fieldId}-variable-hint${issues.keyVariable === undefined ? "" : ` ${fieldId}-variable-error`}`}
          onChange={(event) => setDraft({ ...draft, keyVariable: event.currentTarget.value })}
        />
        <small className="guild-setting-help" id={`${fieldId}-variable-hint`}>{messages.engineKeyVariableHint(apiKey.keyVariable)}</small>
        {issues.keyVariable !== undefined && (
          <p className="guild-source-error" id={`${fieldId}-variable-error`} role="alert">{messages.sourcesInvalid(issues.keyVariable)}</p>
        )}
      </label>
      <dl className="guild-engine-key-facts">
        <div><dt>{messages.engineKeyHostLabel}</dt><dd><code>{apiKey.host}</code></dd></div>
        <div>
          <dt>{messages.engineKeyConfirmationLabel}</dt>
          <dd className={apiKey.confirmed ? "confirmed" : "unconfirmed"}>
            {apiKey.confirmed ? messages.engineKeyConfirmed(apiKey.host) : messages.engineKeyNotConfirmed}
          </dd>
        </div>
        <div><dt>{messages.engineKeyStateLabel}</dt><dd className={apiKey.state}>{messages.engineKeyStateName(apiKey.state)}</dd></div>
      </dl>
      <div className="guild-engine-key-actions">
        <button
          type="button"
          className="guild-soft-button primary"
          disabled={busy || !valid}
          aria-busy={keyBusy || undefined}
          onClick={() => {
            const request = engineKeyRequest(draft);
            onConfirm(request.keyFile, request.keyVariable);
          }}
        >{keyBusy
          ? <><SpinnerGap size={13} className="guild-spin" aria-hidden="true" />{messages.sourcesConfirming}</>
          : messages.engineKeyConfirm}</button>
      </div>
      <p className="guild-setting-help">{messages.engineKeyConfirmHelp(apiKey.host)}</p>
      {failed && <p className="guild-setting-help blocked" role="alert">{messages.engineKeyFailed}</p>}
    </div>
  );
}
