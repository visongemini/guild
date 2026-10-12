import type { GuildRendererApi, ModelSourceKind, ModelSourceProjection, TestModelSourceResponse } from "@guild/contracts";
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
  SOURCE_LIMITS,
  sourceHost,
  sourceHostConfirmed,
  sourceSaveFailureOf,
  sourceStatus,
  validateSourceForm,
  type ModelRowForm,
  type SourceForm,
  type SourceIssue,
  type SourceSaveFailure,
} from "./model-sources-form.js";

type SourcesApi = Pick<
  GuildRendererApi,
  "listModelSources" | "upsertModelSource" | "deleteModelSource" | "confirmModelSource" | "testModelSource"
>;

/** The connection test of one source: running, answered (per model, or refused as a whole), or not able to run. */
export type SourceTestState =
  | Readonly<{ state: "running" }>
  | Readonly<{ state: "done"; response: TestModelSourceResponse }>
  | Readonly<{ state: "failed" }>;

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
  initialSaveFailure?: SourceSaveFailure;
  initialNotice?: SourcesNotice;
  initialTests?: Readonly<Record<string, SourceTestState>>;
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

/** What the connection test found, under the source it tested: one line per model, or the one reason nothing was sent. */
function SourceTestResult({ messages, source, test }: {
  readonly messages: GuildMessages;
  readonly source: ModelSourceProjection;
  readonly test: SourceTestState | undefined;
}) {
  if (test === undefined || test.state === "running") return null;
  if (test.state === "failed") return <p className="guild-setting-help blocked" role="status">{messages.sourcesTestFailed}</p>;
  const { response } = test;
  if (response.refused !== undefined) {
    return <p className="guild-setting-help blocked" role="status">{messages.sourcesTestRefusal(response.refused)}</p>;
  }
  const labelOf = (modelId: string) => source.models.find((model) => model.id === modelId)?.label ?? modelId;
  return <ul className="guild-source-test-results" role="status" aria-label={messages.sourcesTestHeading}>
    {response.results.map((entry) => (
      <li key={entry.modelId} className={entry.outcome.kind === "ok" ? "ok" : "bad"}>
        <span className="guild-source-test-model" title={entry.modelId}>{labelOf(entry.modelId)}</span>
        <span className="guild-source-test-outcome">{messages.sourcesProbeOutcome(entry.outcome)}</span>
      </li>
    ))}
  </ul>;
}

/**
 * The Model sources tab (PC-MODEL-001): the Online and Local endpoints whose models join the Claude
 * picker. It names a key file and a variable inside it, never a key: no field accepts or shows a
 * secret. A new or changed address needs the user's confirmation in a native window owned by the main
 * process; this tab only asks for it and waits for the answer.
 */
export function ModelSourcesSettings({ messages, api, onChanged, initialSources, initialForm, initialIssues, initialSaveFailure, initialNotice, initialTests }: ModelSourcesSettingsProps) {
  const [sources, setSources] = useState<readonly ModelSourceProjection[] | undefined>(initialSources);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<SourceForm | undefined>(initialForm);
  const [issues, setIssues] = useState<readonly SourceIssue[]>(initialIssues ?? []);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState<SourceSaveFailure | undefined>(initialSaveFailure);
  const [notice, setNotice] = useState<SourcesNotice | undefined>(initialNotice);
  const [confirmingId, setConfirmingId] = useState<string>();
  const [deleteTargetId, setDeleteTargetId] = useState<string>();
  const [tests, setTests] = useState<Readonly<Record<string, SourceTestState>>>(initialTests ?? {});
  /** Bumped whenever a source's result is forgotten: an answer that arrives for an older test is dropped. */
  const testEpoch = useRef<Record<string, number>>({});
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
    setSaveFailure(undefined);
    if (found.length > 0) return;
    setSaving(true);
    try {
      const response = await api.upsertModelSource(draftFromForm(form, (sources ?? []).map((source) => source.id)));
      if (!alive.current) return;
      await load();
      if (!alive.current) return;
      forgetTest(response.source.id);
      setForm(undefined);
      setIssues([]);
      setNotice(response.needsConfirmation
        ? Object.freeze({ kind: "needs_confirmation", label: response.source.label })
        : undefined);
      latestOnChanged.current();
    } catch (cause) {
      if (!alive.current) return;
      const failure = sourceSaveFailureOf(cause, form, sources ?? []);
      setSaveFailure(failure);
      // The source changed or went away under the form: show the list as it is now.
      if (failure.reason === "changed" || failure.reason === "not_found") await load();
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
      forgetTest(source.id);
      await load();
      latestOnChanged.current();
    } catch {
      if (alive.current) setNotice(Object.freeze({ kind: "confirm_failed" }));
    } finally {
      if (alive.current) setConfirmingId(undefined);
    }
  }

  /** A source that changed or went away has no result to show: what was tested is not what is stored now. */
  const forgetTest = (id: string) => {
    testEpoch.current[id] = (testEpoch.current[id] ?? 0) + 1;
    setTests((current) => {
      if (!(id in current)) return current;
      const { [id]: _gone, ...rest } = current;
      return rest;
    });
  };

  async function runTest(source: ModelSourceProjection) {
    if (tests[source.id]?.state === "running") return;
    setTests((current) => ({ ...current, [source.id]: Object.freeze({ state: "running" as const }) }));
    const epoch = testEpoch.current[source.id] ?? 0;
    const stillWanted = () => alive.current && (testEpoch.current[source.id] ?? 0) === epoch;
    try {
      const response = await api.testModelSource({ id: source.id });
      if (stillWanted()) setTests((current) => ({ ...current, [source.id]: Object.freeze({ state: "done" as const, response }) }));
    } catch {
      if (stillWanted()) setTests((current) => ({ ...current, [source.id]: Object.freeze({ state: "failed" as const }) }));
    }
  }

  async function remove(source: ModelSourceProjection) {
    setNotice(undefined);
    try {
      await api.deleteModelSource({ id: source.id });
      if (!alive.current) return;
      forgetTest(source.id);
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
  /** What the main process refused, in words; any other failure keeps the generic line. */
  const failureText = (failure: SourceSaveFailure) => failure.reason === "unknown"
    ? messages.sourcesSaveFailed
    : messages.sourcesSaveError(failure.reason, SOURCE_LIMITS.maxSources);

  if (form !== undefined) {
    const labelIssue = issueFor("label");
    const urlIssue = issueFor("baseUrl");
    const fileIssue = issueFor("keyFile");
    const variableIssue = issueFor("keyVariable");
    const modelsIssue = issueFor("models");
    const labelFailure = saveFailure?.place === "label" ? saveFailure : undefined;
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
          placeholder={messages.sourcesLabelPlaceholder}
          autoComplete="off"
          aria-invalid={labelIssue !== undefined || labelFailure !== undefined || undefined}
          aria-describedby={labelIssue === undefined && labelFailure === undefined ? undefined : `${fieldId}-label-error`}
          onChange={(event) => patchForm({ label: event.currentTarget.value })}
        />
        {labelIssue === undefined && labelFailure !== undefined
          ? <p className="guild-source-error" id={`${fieldId}-label-error`} role="alert">{failureText(labelFailure)}</p>
          : errorOf(`${fieldId}-label-error`, labelIssue)}
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
        <small className="guild-setting-help" id={`${fieldId}-variable-hint`}>{messages.sourcesKeyVariableHint}</small>
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
          // A model ID another source already offers (the main process refused the save for it).
          const repeated = saveFailure?.reason === "duplicate_model" && saveFailure.rows.includes(index);
          const rowMessage = rowIssue !== undefined ? issueText(rowIssue) : repeated ? failureText(saveFailure) : undefined;
          return <div className="guild-source-model-entry" key={index}>
            <div className="guild-source-model-row">
              <input
                type="text"
                spellCheck={false}
                value={row.id}
                autoComplete="off"
                aria-label={`${messages.sourcesModelId} ${index + 1}`}
                aria-invalid={idIssue !== undefined || repeated || undefined}
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
                placeholder={messages.sourcesModelContextPlaceholder}
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
            {rowMessage !== undefined && <p className="guild-source-error" role="alert">{rowMessage}</p>}
          </div>;
        })}
        {modelsIssue !== undefined && <p className="guild-source-error" role="alert">{issueText(modelsIssue)}</p>}
        {saveFailure?.place === "models" && saveFailure.rows.length === 0 && (
          <p className="guild-source-error" role="alert">{failureText(saveFailure)}</p>
        )}
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
      {saveFailure?.place === "form" && <p className="guild-source-error" role="alert">{failureText(saveFailure)}</p>}
      <div className="guild-sources-actions">
        <button type="button" className="guild-soft-button" disabled={saving} onClick={() => { setForm(undefined); setIssues([]); setSaveFailure(undefined); }}>{messages.cancel}</button>
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
            </div>
            <ul className="guild-source-model-chips" aria-label={messages.sourcesModelCount(source.models.length)}>
              {source.models.map((model) => (
                <li key={model.id} className="guild-source-chip model" title={model.id}>{model.label}</li>
              ))}
            </ul>
            {status === "needs_confirmation" && <p className="guild-setting-help">{messages.sourcesConfirmHelp(host, source.keyVariable, source.kind)}</p>}
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
                {sourceHostConfirmed(source)
                  ? (
                    <button
                      type="button"
                      className="guild-soft-button"
                      disabled={tests[source.id]?.state === "running"}
                      aria-busy={tests[source.id]?.state === "running" || undefined}
                      onClick={() => void runTest(source)}
                    >{tests[source.id]?.state === "running"
                      ? <><SpinnerGap size={13} className="guild-spin" aria-hidden="true" />{messages.sourcesTesting}</>
                      : messages.sourcesTest}</button>
                  )
                  : <span className="guild-source-test-hint">{source.enabled ? messages.sourcesTestNeedsConfirm : messages.sourcesTestNeedsEnable}</span>}
                <button type="button" className="guild-soft-button" onClick={() => { setNotice(undefined); setSaveFailure(undefined); setIssues([]); forgetTest(source.id); setForm(formFromSource(source)); }}>{messages.sourcesEdit}</button>
                <button type="button" className="guild-soft-button" onClick={() => { setNotice(undefined); setDeleteTargetId(source.id); }}>{messages.delete}</button>
              </div>
            )}
            <SourceTestResult messages={messages} source={source} test={tests[source.id]} />
          </li>;
        })}
      </ul>
    )}
    <button type="button" className="guild-soft-button guild-source-add" onClick={() => { setNotice(undefined); setSaveFailure(undefined); setIssues([]); setForm(emptySourceForm()); }}>
      <Plus size={13} aria-hidden="true" />{messages.sourcesAdd}
    </button>
  </div>;
}
