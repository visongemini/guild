import type { ModelSourceDraft, ModelSourceKind, ModelSourceProjection } from "@guild/contracts";

/*
 * Pure logic for the Model sources settings tab (PC-MODEL-001, PC-ROUTE-002): list status, the form
 * state, validation with the same rules the main process enforces, and the draft that
 * `upsertModelSource` receives. The main process validates again and stays the authority; this
 * module only gives early, specific feedback. No key value ever passes through here: the form holds
 * the name of a variable and the path of a file, never a secret.
 */

export const SOURCE_LIMITS = Object.freeze({
  labelLength: 80,
  baseUrlLength: 2_048,
  keyFileLength: 4_096,
  keyVariableLength: 64,
  maxSources: 32,
  maxModels: 64,
  modelIdLength: 128,
  modelLabelLength: 128,
  maxContextWindow: 100_000_000,
});

/** The contract's key variable grammar (`parseModelSourceKeyVariable`); the engine key binding uses it too. */
export const KEY_VARIABLE_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type SourceStatus = "confirmed" | "needs_confirmation" | "disabled";

/** Host (with a non-default port) of a base URL, or undefined when it does not parse. */
export function sourceHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A disabled source is off whatever else is true. An enabled one is confirmed only while the host the
 * main process confirmed is the host of its current address.
 */
export function sourceStatus(source: Pick<ModelSourceProjection, "enabled" | "baseUrl" | "confirmedHost">): SourceStatus {
  if (!source.enabled) return "disabled";
  return sourceHostConfirmed(source) ? "confirmed" : "needs_confirmation";
}

/** The host the main process confirmed is the host of the current address (what a connection test needs, enabled or not). */
export function sourceHostConfirmed(source: Pick<ModelSourceProjection, "baseUrl" | "confirmedHost">): boolean {
  const host = sourceHost(source.baseUrl);
  return source.confirmedHost !== null && host !== undefined && source.confirmedHost === host;
}

export type ModelRowForm = Readonly<{
  id: string;
  label: string;
  /** Digits as typed; empty means "not stated". */
  contextWindow: string;
  supportsImages: boolean;
}>;

export type SourceForm = Readonly<{
  /** Undefined while adding: the id is derived from the name when saving. */
  id: string | undefined;
  kind: ModelSourceKind;
  label: string;
  baseUrl: string;
  /** Empty means the default key file. */
  keyFile: string;
  /** The variable's name, never its value. */
  keyVariable: string;
  models: readonly ModelRowForm[];
  enabled: boolean;
}>;

export const BLANK_MODEL_ROW: ModelRowForm = Object.freeze({
  id: "",
  label: "",
  contextWindow: "",
  supportsImages: false,
});

export function emptySourceForm(kind: ModelSourceKind = "online"): SourceForm {
  return Object.freeze({
    id: undefined,
    kind,
    label: "",
    baseUrl: "",
    keyFile: "",
    keyVariable: "",
    models: Object.freeze([BLANK_MODEL_ROW]),
    enabled: true,
  });
}

export function formFromSource(source: ModelSourceProjection): SourceForm {
  return Object.freeze({
    id: source.id,
    kind: source.kind,
    label: source.label,
    baseUrl: source.baseUrl,
    keyFile: source.keyFile ?? "",
    keyVariable: source.keyVariable ?? "",
    models: Object.freeze(source.models.map((model) => Object.freeze({
      id: model.id,
      label: model.label,
      contextWindow: model.contextWindow === undefined ? "" : String(model.contextWindow),
      supportsImages: model.supportsImages === true,
    }))),
    enabled: source.enabled,
  });
}

export type SourceProblem =
  | "label"
  | "base_url"
  | "base_url_https"
  | "key_file"
  | "key_variable"
  | "key_variable_secret"
  | "models"
  | "model_id"
  | "model_duplicate"
  | "model_label"
  | "model_context";

/** Where a problem belongs: a form field, or a model row (by index) and its column. */
export type SourceIssue = Readonly<{
  field: "label" | "baseUrl" | "keyFile" | "keyVariable" | "models" | "modelId" | "modelLabel" | "modelContext";
  row?: number;
  problem: SourceProblem;
}>;

function isBlankRow(row: ModelRowForm): boolean {
  return row.id.trim() === "" && row.label.trim() === "" && row.contextWindow.trim() === "";
}

export function secretLike(text: string): boolean {
  return /^(?:sk-|Bearer\s|eyJ)/iu.test(text) || text.length > SOURCE_LIMITS.keyVariableLength;
}

export function isAbsolutePath(text: string): boolean {
  return (text.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(text)) && !text.split(/[\\/]/u).includes("..");
}

export function validateSourceForm(form: SourceForm): readonly SourceIssue[] {
  const issues: SourceIssue[] = [];
  const label = form.label.trim();
  if (label === "" || label.length > SOURCE_LIMITS.labelLength) {
    issues.push({ field: "label", problem: "label" });
  }
  const baseUrl = form.baseUrl.trim();
  if (baseUrl === "" || baseUrl.length > SOURCE_LIMITS.baseUrlLength) {
    issues.push({ field: "baseUrl", problem: "base_url" });
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(baseUrl);
    } catch {
      parsed = undefined;
    }
    if (
      parsed === undefined ||
      parsed.hostname === "" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    ) {
      issues.push({ field: "baseUrl", problem: "base_url" });
    } else if (form.kind === "online" && parsed.protocol !== "https:") {
      issues.push({ field: "baseUrl", problem: "base_url_https" });
    }
  }
  const keyFile = form.keyFile.trim();
  if (keyFile !== "" && (keyFile.length > SOURCE_LIMITS.keyFileLength || !isAbsolutePath(keyFile))) {
    issues.push({ field: "keyFile", problem: "key_file" });
  }
  const keyVariable = form.keyVariable.trim();
  if (keyVariable === "") {
    // An Online source needs a key; a Local one may have none, but a key file without a variable names nothing.
    if (form.kind === "online" || keyFile !== "") issues.push({ field: "keyVariable", problem: "key_variable" });
  } else if (!KEY_VARIABLE_PATTERN.test(keyVariable)) {
    issues.push({ field: "keyVariable", problem: secretLike(keyVariable) ? "key_variable_secret" : "key_variable" });
  }
  const rows = form.models.map((row, index) => ({ row, index })).filter(({ row }) => !isBlankRow(row));
  if (rows.length === 0 || rows.length > SOURCE_LIMITS.maxModels) {
    issues.push({ field: "models", problem: "models" });
  }
  const seen = new Set<string>();
  for (const { row, index } of rows) {
    const id = row.id.trim();
    if (!MODEL_ID_PATTERN.test(id)) issues.push({ field: "modelId", row: index, problem: "model_id" });
    else if (seen.has(id)) issues.push({ field: "modelId", row: index, problem: "model_duplicate" });
    seen.add(id);
    const modelLabel = row.label.trim();
    if (modelLabel === "" || modelLabel.length > SOURCE_LIMITS.modelLabelLength) {
      issues.push({ field: "modelLabel", row: index, problem: "model_label" });
    }
    const context = row.contextWindow.trim();
    if (context !== "") {
      const value = Number(context);
      if (!/^\d+$/u.test(context) || !Number.isSafeInteger(value) || value < 1 || value > SOURCE_LIMITS.maxContextWindow) {
        issues.push({ field: "modelContext", row: index, problem: "model_context" });
      }
    }
  }
  return Object.freeze(issues);
}

/** A source id for a new source: the name lowercased into the id alphabet, unique among `existingIds`. */
export function newSourceId(label: string, existingIds: readonly string[]): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .replace(/[-._]+$/u, "")
    .slice(0, 48) || "source";
  let candidate = base;
  for (let counter = 2; existingIds.includes(candidate); counter += 1) candidate = `${base}-${counter}`;
  return SOURCE_ID_PATTERN.test(candidate) ? candidate : "source";
}

/**
 * The draft `upsertModelSource` receives. Call it only for a form `validateSourceForm` accepts.
 * Blank model rows are dropped; an empty key file becomes the default key file (`null`).
 */
export function draftFromForm(form: SourceForm, existingIds: readonly string[]): ModelSourceDraft {
  const keyVariable = form.keyVariable.trim();
  const keyFile = form.keyFile.trim();
  return Object.freeze({
    id: form.id ?? newSourceId(form.label, existingIds),
    kind: form.kind,
    label: form.label.trim(),
    baseUrl: form.baseUrl.trim(),
    keyFile: keyFile === "" ? null : keyFile,
    keyVariable: keyVariable === "" ? null : keyVariable,
    models: Object.freeze(form.models.filter((row) => !isBlankRow(row)).map((row) => {
      const context = row.contextWindow.trim();
      return Object.freeze({
        id: row.id.trim(),
        label: row.label.trim(),
        ...(context === "" ? {} : { contextWindow: Number(context) }),
        ...(row.supportsImages ? { supportsImages: true } : {}),
      });
    })),
    enabled: form.enabled,
  });
}

/** The refusals `upsertModelSource` can raise; they reach the renderer as `Error: model_source_<reason>`. */
export const SOURCE_SAVE_FAILURE_REASONS = Object.freeze([
  "invalid",
  "reserved_id",
  "reserved_model",
  "duplicate_model",
  "limit",
  "changed",
  "not_found",
  "rejected",
] as const);
export type SourceSaveFailureReason = (typeof SOURCE_SAVE_FAILURE_REASONS)[number];

/**
 * Where a failed save is explained: beside the Name field, with the model list (under the rows it names, or under
 * the list when it names none), or at the foot of the form.
 */
export type SourceSaveFailure = Readonly<{
  place: "label" | "models" | "form";
  /** `unknown` is any failure that is not one of the main process's own refusals (the generic message). */
  reason: SourceSaveFailureReason | "unknown";
  /** Model rows (by index) that repeat an ID another source already offers; only for `duplicate_model`. */
  rows: readonly number[];
}>;

/**
 * The reason behind a failed save, read from the error the preload raises (Electron wraps the main process's
 * message as `Error invoking remote method '...': Error: model_source_<reason>`). Anything else is undefined.
 */
export function sourceSaveFailureReason(cause: unknown): SourceSaveFailureReason | undefined {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const reason = /\bmodel_source_([a-z_]{1,48})\b/u.exec(text)?.[1];
  return (SOURCE_SAVE_FAILURE_REASONS as readonly string[]).includes(reason ?? "")
    ? reason as SourceSaveFailureReason
    : undefined;
}

/**
 * Places a failed save next to what the person can fix. A repeated model ID is pinned to the rows that repeat one
 * of the other sources' IDs (the renderer knows them all); a reserved ID or name has no row to point at, so it sits
 * with the model list or the Name field.
 */
export function sourceSaveFailureOf(
  cause: unknown,
  form: SourceForm,
  sources: readonly Pick<ModelSourceProjection, "id" | "models">[],
): SourceSaveFailure {
  const reason = sourceSaveFailureReason(cause);
  if (reason === undefined) return Object.freeze({ place: "form", reason: "unknown", rows: Object.freeze([]) });
  if (reason === "reserved_id") return Object.freeze({ place: "label", reason, rows: Object.freeze([]) });
  if (reason === "reserved_model") return Object.freeze({ place: "models", reason, rows: Object.freeze([]) });
  if (reason === "duplicate_model") {
    const taken = new Set(sources.filter((source) => source.id !== form.id).flatMap((source) => source.models.map((model) => model.id)));
    const rows = form.models.flatMap((row, index) => !isBlankRow(row) && taken.has(row.id.trim()) ? [index] : []);
    return Object.freeze({ place: "models", reason, rows: Object.freeze(rows) });
  }
  return Object.freeze({ place: "form", reason, rows: Object.freeze([]) });
}
