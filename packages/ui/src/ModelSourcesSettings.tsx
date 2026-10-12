import type { GuildRendererApi, ModelSourceKind, ModelSourceProjection } from "@guild/contracts";
import { InfoIcon as Info } from "@phosphor-icons/react/Info";
import { PlusIcon as Plus } from "@phosphor-icons/react/Plus";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { XIcon as X } from "@phosphor-icons/react/X";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { GuildMessages } from "./locales.js";
import {
  BLANK_MODEL_ROW,
  draftFromForm,
  emptySourceForm,
  formFromSource,
  sourceHost,
  sourceStatus,
  validateSourceForm,
  type ModelRowForm,
  type SourceForm,
  type SourceIssue,
} from "./model-sources-form.js";

type SourcesApi = Pick<
  GuildRendererApi,
  "listModelSources" | "upsertModelSource" | "deleteModelSource" | "confirmModelSource"
>;

export type SourcesNotice =
  | Readonly<{ kind: "needs_confirmation"; label: string }>
  | Readonly<{ kind: "confirmed" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "confirm_failed" }>
  | Readonly<{ kind: "delete_failed" }>;

export type ModelSourcesSettingsProps = Readonly<{
  messages: GuildMessages;
  api: SourcesApi;
  /** Called after a change that can alter the Online and Local models of the picker. */
  onChanged: () => void;
  /** Test seams: render a loaded list, an open form or a notice without a request. */
  initialSources?: readonly ModelSourceProjection[];
  initialForm?: SourceForm;
  initialIssues?: readonly SourceIssue[];
  initialNotice?: SourcesNotice;
}>;

const BASE_URL_PLACEHOLDER: Readonly<Record<ModelSourceKind, string>> = Object.freeze({
  online: "https://api.example.com/anthropic",
  local: "http://127.0.0.1:8080",
});

function noticeText(messages: GuildMessages, notice: SourcesNotice): string {
  switch (notice.kind) {
    case "needs_confirmation": return messages.sourcesNeedsConfirmationNotice(notice.label);
    case "confirmed": return messages.sourcesConfirmedNotice;
    case "cancelled": return messages.sourcesConfirmCancelled;
    case "confirm_failed": return messages.sourcesConfirmFailed;
    case "delete_failed": return messages.sourcesDeleteFailed;
  }
}

/**
 * The Model sources tab (PC-MODEL-001): the Online and Local endpoints whose models join the Claude
 * picker. It names a key file and a variable inside it, never a key: no field accepts or shows a
 * secret. A new or changed address needs the user's confirmation in a native window owned by the main
 * process; this tab only asks for it and waits for the answer.
 */
export function ModelSourcesSettings({ messages, api, onChanged, initialSources, initialForm, initialIssues, initialNotice }: ModelSourcesSettingsProps) {
  const [sources, setSources] = useState<readonly ModelSourceProjection[] | undefined>(initialSources);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<SourceForm | undefined>(initialForm);
  const [issues, setIssues] = useState<readonly SourceIssue[]>(initialIssues ?? []);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [notice, setNotice] = useState<SourcesNotice | undefined>(initialNotice);
  const [confirmingId, setConfirmingId] = useState<string>();
  const [deleteTargetId, setDeleteTargetId] = useState<string>();
  const alive = useRef(true);
  const latestOnChanged = useRef(onChanged);
  latestOnChanged.current = onChanged;
  const fieldId = useId();

  const load = useCallback(async () => {
    try {
      const response = await api.listModelSources();
      if (!alive.current) return;
      setSources(response.sources);
      setLoadFailed(false);
    } catch {
      if (alive.current) setLoadFailed(true);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    if (initialSources === undefined) void load();
    return () => { alive.current = false; };
  }, [initialSources, load]);

  async function save() {
    if (form === undefined || saving) return;
    const found = validateSourceForm(form);
    setIssues(found);
    setSaveFailed(false);
    if (found.length > 0) return;
    setSaving(true);
    try {
      const response = await api.upsertModelSource(draftFromForm(form, (sources ?? []).map((source) => source.id)));
      if (!alive.current) return;
      await load();
      if (!alive.current) return;
      setForm(undefined);
      setIssues([]);
      setNotice(response.needsConfirmation
        ? Object.freeze({ kind: "needs_confirmation", label: response.source.label })
        : undefined);
      latestOnChanged.current();
    } catch {
      if (alive.current) setSaveFailed(true);
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  async function confirm(source: ModelSourceProjection) {
    if (confirmingId !== undefined) return;
    setConfirmingId(source.id);
    setNotice(undefined);
    try {
      const response = await api.confirmModelSource({ id: source.id });
      if (!alive.current) return;
      setNotice(Object.freeze({ kind: response.status === "confirmed" ? "confirmed" : "cancelled" }));
      await load();
      latestOnChanged.current();
    } catch {
      if (alive.current) setNotice(Object.freeze({ kind: "confirm_failed" }));
    } finally {
      if (alive.current) setConfirmingId(undefined);
    }
  }

  async function remove(source: ModelSourceProjection) {
    setNotice(undefined);
    try {
      await api.deleteModelSource({ id: source.id });
      if (!alive.current) return;
      setDeleteTargetId(undefined);
      await load();
      latestOnChanged.current();
    } catch {
      if (alive.current) setNotice(Object.freeze({ kind: "delete_failed" }));
    }
  }

  const patchForm = (patch: Partial<SourceForm>) =>
    setForm((current) => current === undefined ? current : Object.freeze({ ...current, ...patch }));
  const patchRow = (index: number, patch: Partial<ModelRowForm>) =>
    setForm((current) => current === undefined ? current : Object.freeze({
      ...current,
      models: Object.freeze(current.models.map((row, rowIndex) =>
        rowIndex === index ? Object.freeze({ ...row, ...patch }) : row)),
    }));
  const issueFor = (field: SourceIssue["field"], row?: number): SourceIssue | undefined =>
    issues.find((issue) => issue.field === field && issue.row === row);
  const issueText = (issue: SourceIssue | undefined) => issue === undefined ? undefined : messages.sourcesInvalid(issue.problem);

  if (form !== undefined) {
    const labelIssue = issueFor("label");
    const urlIssue = issueFor("baseUrl");
    const fileIssue = issueFor("keyFile");
    const variableIssue = issueFor("keyVariable");
    const modelsIssue = issueFor("models");
    const errorOf = (id: string, issue: SourceIssue | undefined) => issue === undefined
      ? null
      : <p className="guild-source-error" id={id} role="alert">{issueText(issue)}</p>;
    return <div className="guild-sources-form" aria-busy={saving || undefined}>
      <div className="guild-setting-label">{form.id === undefined ? messages.sourcesAddTitle : messages.sourcesEditTitle}</div>
      <div className="guild-setting-label guild-source-field-label" id={`${fieldId}-kind`}>{messages.sourcesFieldKind}</div>
      <div className="guild-segmented" role="radiogroup" aria-labelledby={`${fieldId}-kind`}>
        {(["online", "local"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={form.kind === kind}
            className={form.kind === kind ? "selected" : undefined}
            onClick={() => patchForm({ kind })}
          >{messages.sourcesKindName(kind)}</button>
        ))}
      </div>
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.sourcesFieldLabel}</span>
        <input
          type="text"
          value={form.label}
          maxLength={80}
          autoComplete="off"
          aria-invalid={labelIssue !== undefined || undefined}
          aria-describedby={labelIssue === undefined ? undefined : `${fieldId}-label-error`}
          onChange={(event) => patchForm({ label: event.currentTarget.value })}
        />
        {errorOf(`${fieldId}-label-error`, labelIssue)}
      </label>
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.sourcesFieldBaseUrl}</span>
        <input
          type="text"
          inputMode="url"
          spellCheck={false}
          value={form.baseUrl}
          placeholder={BASE_URL_PLACEHOLDER[form.kind]}
          autoComplete="off"
          aria-invalid={urlIssue !== undefined || undefined}
          aria-describedby={`${fieldId}-url-hint${urlIssue === undefined ? "" : ` ${fieldId}-url-error`}`}
          onChange={(event) => patchForm({ baseUrl: event.currentTarget.value })}
        />
        <small className="guild-setting-help" id={`${fieldId}-url-hint`}>{messages.sourcesBaseUrlHint(form.kind)}</small>
        {errorOf(`${fieldId}-url-error`, urlIssue)}
      </label>
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.sourcesFieldKeyFile}</span>
        <input
          type="text"
          spellCheck={false}
          value={form.keyFile}
          placeholder={messages.sourcesKeyFilePlaceholder}
          autoComplete="off"
          aria-invalid={fileIssue !== undefined || undefined}
          aria-describedby={`${fieldId}-file-hint${fileIssue === undefined ? "" : ` ${fieldId}-file-error`}`}
          onChange={(event) => patchForm({ keyFile: event.currentTarget.value })}
        />
        <small className="guild-setting-help" id={`${fieldId}-file-hint`}>{messages.sourcesKeyFileHint}</small>
        {errorOf(`${fieldId}-file-error`, fileIssue)}
      </label>
      <label className="guild-setting-field">
        <span className="guild-setting-label">{messages.sourcesFieldKeyVariable}</span>
        <input
          type="text"
          spellCheck={false}
          value={form.keyVariable}
          placeholder={messages.sourcesKeyVariablePlaceholder}
          autoComplete="off"
          aria-invalid={variableIssue !== undefined || undefined}
          aria-describedby={`${fieldId}-variable-hint${variableIssue === undefined ? "" : ` ${fieldId}-variable-error`}`}
          onChange={(event) => patchForm({ keyVariable: event.currentTarget.value })}
        />
        <small className="guild-setting-help" id={`${fieldId}-variable-hint`}>{messages.sourcesKeyVariableHint} {messages.sourcesKeyNotice}</small>
        {errorOf(`${fieldId}-variable-error`, variableIssue)}
      </label>
      <div className="guild-setting-label guild-source-field-label">{messages.sourcesModels}</div>
      <div className="guild-source-models" role="group" aria-label={messages.sourcesModels}>
        <div className="guild-source-model-row head" aria-hidden="true">
          <span>{messages.sourcesModelId}</span>
          <span>{messages.sourcesModelLabel}</span>
          <span>{messages.sourcesModelContext}</span>
          <span>{messages.sourcesModelImages}</span>
          <span />
        </div>
        {form.models.map((row, index) => {
          const idIssue = issueFor("modelId", index);
          const nameIssue = issueFor("modelLabel", index);
          const contextIssue = issueFor("modelContext", index);
          const rowIssue = idIssue ?? nameIssue ?? contextIssue;
          return <div className="guild-source-model-entry" key={index}>
            <div className="guild-source-model-row">
              <input
                type="text"
                spellCheck={false}
                value={row.id}
                autoComplete="off"
                aria-label={`${messages.sourcesModelId} ${index + 1}`}
                aria-invalid={idIssue !== undefined || undefined}
                onChange={(event) => patchRow(index, { id: event.currentTarget.value })}
              />
              <input
                type="text"
                value={row.label}
                maxLength={128}
                autoComplete="off"
                aria-label={`${messages.sourcesModelLabel} ${index + 1}`}
                aria-invalid={nameIssue !== undefined || undefined}
                onChange={(event) => patchRow(index, { label: event.currentTarget.value })}
              />
              <input
                type="text"
                inputMode="numeric"
                value={row.contextWindow}
                autoComplete="off"
                aria-label={`${messages.sourcesModelContext} ${index + 1}`}
                aria-invalid={contextIssue !== undefined || undefined}
                onChange={(event) => patchRow(index, { contextWindow: event.currentTarget.value })}
              />
              <input
                type="checkbox"
                checked={row.supportsImages}
                aria-label={`${messages.sourcesModelImages} ${index + 1}`}
                onChange={(event) => patchRow(index, { supportsImages: event.currentTarget.checked })}
              />
              <button
                type="button"
                className="guild-icon-button"
                aria-label={messages.sourcesRemoveModel(row.id.trim())}
                title={messages.sourcesRemoveModel(row.id.trim())}
                disabled={form.models.length <= 1}
                onClick={() => patchForm({ models: Object.freeze(form.models.filter((_, rowIndex) => rowIndex !== index)) })}
              ><X size={13} /></button>
            </div>
            {rowIssue !== undefined && <p className="guild-source-error" role="alert">{issueText(rowIssue)}</p>}
          </div>;
        })}
        {modelsIssue !== undefined && <p className="guild-source-error" role="alert">{issueText(modelsIssue)}</p>}
        <button
          type="button"
          className="guild-soft-button guild-source-add-model"
          onClick={() => patchForm({ models: Object.freeze([...form.models, BLANK_MODEL_ROW]) })}
        ><Plus size={13} aria-hidden="true" />{messages.sourcesAddModel}</button>
      </div>
      <label className="guild-setting-toggle">
        <span><strong>{messages.sourcesEnabled}</strong></span>
        <button
          type="button"
          className={`guild-switch ${form.enabled ? "on" : ""}`}
          aria-label={messages.sourcesEnabled}
          aria-pressed={form.enabled}
          onClick={() => patchForm({ enabled: !form.enabled })}
        />
      </label>
      {saveFailed && <p className="guild-source-error" role="alert">{messages.sourcesSaveFailed}</p>}
      <div className="guild-sources-actions">
        <button type="button" className="guild-soft-button" disabled={saving} onClick={() => { setForm(undefined); setIssues([]); setSaveFailed(false); }}>{messages.cancel}</button>
        <button type="button" className="guild-soft-button primary" disabled={saving} onClick={() => void save()}>
          {saving ? <><SpinnerGap size={13} className="guild-spin" aria-hidden="true" />{messages.sourcesSaving}</> : messages.save}
        </button>
      </div>
    </div>;
  }

  return <div className="guild-sources">
    <p className="guild-setting-scope"><Info size={13} />{messages.sourcesIntro}</p>
    {notice !== undefined && (
      <p className={`guild-setting-help ${notice.kind === "confirmed" ? "success" : notice.kind === "needs_confirmation" ? "" : "blocked"}`} role="status">{noticeText(messages, notice)}</p>
    )}
    {sources === undefined ? (
      loadFailed
        ? <p className="guild-setting-help blocked" role="alert">{messages.sourcesLoadFailed} <button type="button" className="guild-soft-button" onClick={() => void load()}>{messages.retry}</button></p>
        : <p className="guild-setting-help guild-usage-loading" role="status"><SpinnerGap size={13} className="guild-spin" aria-hidden="true" />{messages.sourcesLoading}</p>
    ) : sources.length === 0 ? (
      <p className="guild-setting-help">{messages.sourcesEmpty}</p>
    ) : (
      <ul className="guild-source-list" aria-label={messages.settingsModelSources}>
        {sources.map((source) => {
          const status = sourceStatus(source);
          const host = sourceHost(source.baseUrl) ?? source.baseUrl;
          const deleting = deleteTargetId === source.id;
          return <li className="guild-source-row" key={source.id}>
            <div className="guild-source-main">
              <strong>{source.label}</strong>
              <span className={`guild-source-chip kind ${source.kind}`}>{messages.sourcesKindName(source.kind)}</span>
              <span className={`guild-source-chip status ${status}`}>{messages.sourcesStatusName(status)}</span>
            </div>
            <div className="guild-source-meta">
              <code title={source.baseUrl}>{host}</code>
              <span>{messages.sourcesModelCount(source.models.length)}</span>
            </div>
            {status === "needs_confirmation" && <p className="guild-setting-help">{messages.sourcesConfirmHelp(host, source.keyVariable)}</p>}
            {deleting ? (
              <div className="guild-source-delete" role="alertdialog" aria-label={messages.sourcesDeleteConfirm(source.label)}>
                <p className="guild-setting-help">{messages.sourcesDeleteConfirm(source.label)}</p>
                <div className="guild-source-actions">
                  <button type="button" className="guild-soft-button" autoFocus onClick={() => setDeleteTargetId(undefined)}>{messages.cancel}</button>
                  <button type="button" className="guild-soft-button danger" onClick={() => void remove(source)}>{messages.confirmDelete}</button>
                </div>
              </div>
            ) : (
              <div className="guild-source-actions">
                {status === "needs_confirmation" && (
                  <button
                    type="button"
                    className="guild-soft-button primary"
                    disabled={confirmingId !== undefined}
                    aria-busy={confirmingId === source.id || undefined}
                    onClick={() => void confirm(source)}
                  >{confirmingId === source.id
                    ? <><SpinnerGap size={13} className="guild-spin" aria-hidden="true" />{messages.sourcesConfirming}</>
                    : messages.sourcesConfirm}</button>
                )}
                <button type="button" className="guild-soft-button" onClick={() => { setNotice(undefined); setSaveFailed(false); setIssues([]); setForm(formFromSource(source)); }}>{messages.sourcesEdit}</button>
                <button type="button" className="guild-soft-button" onClick={() => { setNotice(undefined); setDeleteTargetId(source.id); }}>{messages.delete}</button>
              </div>
            )}
          </li>;
        })}
      </ul>
    )}
    <button type="button" className="guild-soft-button guild-source-add" onClick={() => { setNotice(undefined); setSaveFailed(false); setIssues([]); setForm(emptySourceForm()); }}>
      <Plus size={13} aria-hidden="true" />{messages.sourcesAdd}
    </button>
  </div>;
}
