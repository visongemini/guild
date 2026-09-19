import { ChatCircleDotsIcon as ChatCircleDots } from "@phosphor-icons/react/ChatCircleDots";
import { CheckIcon as Check } from "@phosphor-icons/react/Check";
import { CodeIcon as Code } from "@phosphor-icons/react/Code";
import { GearSixIcon as GearSix } from "@phosphor-icons/react/GearSix";
import { FolderOpenIcon as FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { GitForkIcon as GitFork } from "@phosphor-icons/react/GitFork";
import { MagnifyingGlassIcon as MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { SpinnerGapIcon as SpinnerGap } from "@phosphor-icons/react/SpinnerGap";
import { WarningCircleIcon as WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/Wrench";
import { XIcon as X } from "@phosphor-icons/react/X";
import type {
  GuildGrokManagementAction,
  GuildGrokManagementParameter,
  GuildRendererApi,
  GrokManagementProgressProjection,
  RunGrokManagementResponse,
  RuntimeCommand,
  RuntimeDiagnosticsProjection,
  TaskId,
} from "@guild/contracts";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { GuildMessages } from "./locales.js";

type Section = "home" | "commands" | "runtime" | "extensions" | "sessions" | "worktrees" | "diagnostics";
type FieldType = "boolean" | "lines" | "number" | "select" | "text";
type FieldSpec = Readonly<{
  key: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[];
  defaultValue?: string | boolean;
}>;
type ActionSpec = Readonly<{
  action: GuildGrokManagementAction;
  section: Exclude<Section, "commands" | "home">;
  confirm?: boolean;
  fields?: readonly FieldSpec[];
}>;

const field = (key: string, type: FieldType = "text", options?: readonly string[], defaultValue?: string | boolean, required = false): FieldSpec =>
  Object.freeze({ key, type, ...(options === undefined ? {} : { options }), ...(defaultValue === undefined ? {} : { defaultValue }), ...(required ? { required: true } : {}) });

const ACTIONS: readonly ActionSpec[] = Object.freeze([
  { action: "version", section: "runtime" },
  { action: "models", section: "runtime" },
  { action: "update_check", section: "runtime" },
  { action: "update_stable", section: "runtime", confirm: true },
  { action: "update_alpha", section: "runtime", confirm: true },
  { action: "update_version", section: "runtime", confirm: true, fields: [field("version", "text", undefined, undefined, true)] },
  { action: "update_reinstall", section: "runtime", confirm: true },
  { action: "login_oauth", section: "runtime" },
  { action: "login_device", section: "runtime" },
  { action: "logout", section: "runtime", confirm: true },
  { action: "leader_list", section: "runtime" },
  { action: "leader_info", section: "runtime", fields: [field("pid", "number")] },
  { action: "leader_kill", section: "runtime", confirm: true },

  { action: "plugin_list", section: "extensions" },
  { action: "plugin_available", section: "extensions" },
  { action: "plugin_details", section: "extensions", fields: [field("name", "text", undefined, undefined, true)] },
  { action: "plugin_validate", section: "extensions", fields: [field("path")] },
  { action: "plugin_install", section: "extensions", confirm: true, fields: [field("source", "text", undefined, undefined, true)] },
  { action: "plugin_uninstall", section: "extensions", confirm: true, fields: [field("name", "text", undefined, undefined, true), field("keepData", "boolean")] },
  { action: "plugin_update", section: "extensions", fields: [field("name")] },
  { action: "plugin_enable", section: "extensions", fields: [field("name", "text", undefined, undefined, true)] },
  { action: "plugin_disable", section: "extensions", fields: [field("name", "text", undefined, undefined, true)] },
  { action: "plugin_tag_preview", section: "extensions", fields: [field("path")] },
  { action: "plugin_tag", section: "extensions", confirm: true, fields: [field("path"), field("push", "boolean"), field("force", "boolean")] },
  { action: "marketplace_list", section: "extensions" },
  { action: "marketplace_add", section: "extensions", fields: [field("source", "text", undefined, undefined, true), field("force", "boolean")] },
  { action: "marketplace_remove", section: "extensions", confirm: true, fields: [field("source", "text", undefined, undefined, true)] },
  { action: "marketplace_update", section: "extensions", fields: [field("name")] },
  { action: "mcp_list", section: "extensions" },
  { action: "mcp_doctor", section: "extensions", fields: [field("name")] },
  { action: "mcp_add", section: "extensions", confirm: true, fields: [
    field("name", "text", undefined, undefined, true), field("transport", "select", ["stdio", "http", "sse"], "stdio"),
    field("scope", "select", ["user", "project"], "user"), field("endpoint", "text", undefined, undefined, true),
    field("args", "lines"), field("env", "lines"), field("headers", "lines"),
  ] },
  { action: "mcp_remove", section: "extensions", confirm: true, fields: [field("name", "text", undefined, undefined, true), field("scope", "select", ["", "user", "project"], "")] },
  { action: "mcp_enable", section: "extensions", fields: [field("name", "text", undefined, undefined, true)] },
  { action: "mcp_disable", section: "extensions", fields: [field("name", "text", undefined, undefined, true)] },

  { action: "sessions_list", section: "sessions", fields: [field("limit", "number", undefined, "50")] },
  { action: "sessions_search", section: "sessions", fields: [field("query", "text", undefined, undefined, true), field("limit", "number", undefined, "50")] },
  { action: "session_delete", section: "sessions", confirm: true, fields: [field("sessionId", "text", undefined, undefined, true)] },
  { action: "session_export", section: "sessions", fields: [field("sessionId", "text", undefined, undefined, true), field("output", "text", undefined, undefined, true)] },
  { action: "session_trace_local", section: "sessions", fields: [field("sessionId", "text", undefined, undefined, true), field("output")] },
  { action: "session_trace_upload", section: "sessions", confirm: true, fields: [field("sessionId", "text", undefined, undefined, true), field("output")] },
  { action: "memory_clear", section: "sessions", confirm: true, fields: [field("scope", "select", ["workspace", "global", "all"], "workspace")] },

  { action: "worktree_list", section: "worktrees", fields: [field("repo"), field("type"), field("all", "boolean")] },
  { action: "worktree_show", section: "worktrees", fields: [field("id", "text", undefined, undefined, true)] },
  { action: "worktree_remove", section: "worktrees", confirm: true, fields: [field("ids", "lines", undefined, undefined, true), field("force", "boolean")] },
  { action: "worktree_gc_preview", section: "worktrees", fields: [field("maxAge", "text", undefined, "7d")] },
  { action: "worktree_gc", section: "worktrees", confirm: true, fields: [field("maxAge", "text", undefined, "7d"), field("force", "boolean")] },
  { action: "worktree_detach", section: "worktrees", confirm: true, fields: [field("id", "text", undefined, undefined, true), field("allowCopy", "boolean")] },
  { action: "worktree_salvage", section: "worktrees", confirm: true, fields: [field("id", "text", undefined, undefined, true), field("output", "text", undefined, undefined, true)] },
  { action: "worktree_clean_preview", section: "worktrees", fields: [field("id", "text", undefined, undefined, true)] },
  { action: "worktree_clean", section: "worktrees", confirm: true, fields: [field("id", "text", undefined, undefined, true)] },
  { action: "worktree_db_stats", section: "worktrees" },
  { action: "worktree_db_path", section: "worktrees" },
  { action: "worktree_db_rebuild", section: "worktrees", confirm: true },
  { action: "clone", section: "worktrees", fields: [field("url", "text", undefined, undefined, true), field("directory"), field("branch"), field("cones", "lines"), field("fullHistory", "boolean")] },

  { action: "inspect", section: "diagnostics" },
  { action: "doctor", section: "diagnostics" },
  { action: "doctor_fixes", section: "diagnostics" },
  { action: "doctor_fix", section: "diagnostics", confirm: true, fields: [field("id")] },
  { action: "disk_usage", section: "diagnostics" },
  { action: "setup_preview", section: "diagnostics" },
  { action: "setup_apply", section: "diagnostics", confirm: true },
]);
export const GUILD_GROK_CONTROL_ACTIONS = Object.freeze(ACTIONS.map((spec) => spec.action));
export const GUILD_GROK_CONTROL_PARAMETER_KEYS = Object.freeze(Object.fromEntries(
  ACTIONS.map((spec) => [spec.action, Object.freeze((spec.fields ?? []).map((item) => item.key))]),
)) as Readonly<Record<GuildGrokManagementAction, readonly string[]>>;

const SECTIONS: readonly Section[] = Object.freeze(["home", "commands", "runtime", "extensions", "sessions", "worktrees", "diagnostics"]);

export type GrokControlCenterProps = Readonly<{
  api: GuildRendererApi;
  messages: GuildMessages;
  activeTaskId?: TaskId;
  commands: readonly RuntimeCommand[];
  runtimeSummary: string;
  managementAvailable: boolean;
  managementProgress?: GrokManagementProgressProjection;
  diagnostics?: RuntimeDiagnosticsProjection;
  onClose: () => void;
  onOpenSessionSettings: () => void;
  onRunCommand: (command: RuntimeCommand, input: string) => Promise<void>;
}>;

export function GrokControlCenter(props: GrokControlCenterProps) {
  const initialProgressSpec = props.managementProgress === undefined
    ? undefined
    : ACTIONS.find((spec) => spec.action === props.managementProgress?.action);
  const [section, setSection] = useState<Section>(initialProgressSpec?.section ?? "home");
  const [query, setQuery] = useState("");
  const [selectedAction, setSelectedAction] = useState<GuildGrokManagementAction | undefined>(props.managementProgress?.action);
  const [selectedCommand, setSelectedCommand] = useState<RuntimeCommand | undefined>();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunGrokManagementResponse | undefined>();
  const [localError, setLocalError] = useState<string>();
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const visibleActions = useMemo(() => ACTIONS.filter((spec) =>
    (spec.section === section || (section === "home" && ["doctor", "models", "login_oauth", "update_check", "plugin_list", "mcp_list"].includes(spec.action))) &&
    (normalizedQuery.length === 0 || props.messages.grokManagementAction(spec.action).toLocaleLowerCase().includes(normalizedQuery))),
  [normalizedQuery, props.messages, section]);
  const visibleCommands = useMemo(() => props.commands.filter((command) =>
    normalizedQuery.length === 0 ||
    command.name.toLocaleLowerCase().includes(normalizedQuery) ||
    command.description.toLocaleLowerCase().includes(normalizedQuery)),
  [normalizedQuery, props.commands]);
  const activeSpec = selectedAction === undefined ? undefined : ACTIONS.find((spec) => spec.action === selectedAction);

  function selectAction(spec: ActionSpec) {
    setSelectedCommand(undefined);
    setSelectedAction(spec.action);
    setConfirming(false);
    setLocalError(undefined);
    setResult(undefined);
    setValues(Object.fromEntries((spec.fields ?? []).map((item) => [item.key, item.defaultValue ?? (item.type === "boolean" ? false : "")])));
  }

  function selectCommand(command: RuntimeCommand) {
    setSelectedAction(undefined);
    setSelectedCommand(command);
    setConfirming(false);
    setLocalError(undefined);
    setResult(undefined);
    setValues({ commandInput: "" });
  }

  function selectSection(next: Section) {
    setSection(next);
    setSelectedAction(undefined);
    setSelectedCommand(undefined);
    setQuery("");
    setLocalError(undefined);
    setConfirming(false);
    setResult(undefined);
  }

  function moveSectionFocus(event: ReactKeyboardEvent<HTMLButtonElement>, current: Section) {
    const currentIndex = SECTIONS.indexOf(current);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % SECTIONS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = SECTIONS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = SECTIONS[nextIndex]!;
    selectSection(next);
    queueMicrotask(() => document.getElementById(`guild-control-tab-${next}`)?.focus());
  }

  async function runAction() {
    if (activeSpec === undefined || running || !props.managementAvailable || props.activeTaskId === undefined) return;
    if (activeSpec.confirm && !confirming) {
      setConfirming(true);
      return;
    }
    for (const item of activeSpec.fields ?? []) {
      const value = values[item.key];
      if (item.required && (typeof value !== "string" || value.trim().length === 0)) {
        setLocalError(props.messages.grokManagementRequired(item.key));
        return;
      }
    }
    setRunning(true);
    setLocalError(undefined);
    setResult(undefined);
    try {
      const response = await props.api.runGrokManagement({
        action: activeSpec.action,
        ...(props.activeTaskId === undefined ? {} : { taskId: props.activeTaskId }),
        parameters: parametersFrom(activeSpec.fields ?? [], values),
        ...(activeSpec.confirm ? { confirmed: true } : {}),
      });
      setResult(response);
      setConfirming(false);
    } catch {
      setLocalError(props.messages.operationFailed);
    } finally {
      setRunning(false);
    }
  }

  async function runCommand() {
    if (selectedCommand === undefined || props.activeTaskId === undefined || running) return;
    setRunning(true);
    setLocalError(undefined);
    try {
      await props.onRunCommand(selectedCommand, String(values.commandInput ?? ""));
    } catch {
      setLocalError(props.messages.operationFailed);
    } finally {
      setRunning(false);
    }
  }

  const list = section === "commands"
    ? visibleCommands.map((command) => (
        <button key={command.name} type="button" aria-current={selectedCommand?.name === command.name ? "true" : undefined} className={selectedCommand?.name === command.name ? "selected" : ""} onClick={() => selectCommand(command)}>
          <Code size={15} /><span><strong>/{command.name}</strong><small>{command.description}</small></span>
        </button>
      ))
    : visibleActions.map((spec) => (
        <button key={spec.action} type="button" aria-current={selectedAction === spec.action ? "true" : undefined} className={selectedAction === spec.action ? "selected" : ""} onClick={() => selectAction(spec)}>
          {sectionIcon(spec.section)}<span><strong>{props.messages.grokManagementAction(spec.action)}</strong><small>grok {spec.action.replaceAll("_", " ")}</small></span>
        </button>
      ));

  return (
    <div className="guild-dialog-backdrop guild-control-backdrop" role="presentation" onPointerDown={props.onClose}>
      <div
        className="guild-control-center"
        role="dialog"
        aria-modal="true"
        aria-label={props.messages.manageGrokBuild}
        onKeyDown={(event) => handleControlDialogKeyDown(event, props.onClose)}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="guild-control-head">
          <div><strong>{props.messages.manageGrokBuild}</strong><span>{props.runtimeSummary}</span></div>
          <button type="button" aria-label={props.messages.closeDialog} onClick={props.onClose}><X size={17} /></button>
        </header>
        <div className="guild-control-intro">{section === "home" ? props.messages.commonToolsHelp : props.messages.grokManagementSectionHelp(section)}</div>
        <div className={`guild-control-layout ${selectedAction === undefined && selectedCommand === undefined ? "browsing" : ""}`}>
          <nav className="guild-control-sections" role="tablist" aria-label={props.messages.manageGrokBuild}>
            {SECTIONS.map((item) => (
              <button key={item} id={`guild-control-tab-${item}`} type="button" role="tab" tabIndex={section === item ? 0 : -1} aria-controls={`guild-control-panel-${item}`} aria-selected={section === item} aria-label={item === "home" ? props.messages.commonTools : props.messages.grokManagementSection(item)} title={item === "home" ? props.messages.commonTools : props.messages.grokManagementSection(item)} autoFocus={item === (initialProgressSpec?.section ?? "home")} className={section === item ? "selected" : ""} onKeyDown={(event) => moveSectionFocus(event, item)} onClick={() => selectSection(item)}>{sectionIcon(item)}<span>{item === "home" ? props.messages.commonTools : props.messages.grokManagementSection(item)}</span></button>
            ))}
          </nav>
          <section className="guild-control-browser">
            <div className="guild-control-browser-head">
              <div><strong>{section === "home" ? props.messages.commonTools : props.messages.grokManagementSection(section)}</strong><small>{props.messages.grokManagementSectionHelp(section)}</small></div>
              <label><MagnifyingGlass size={14} /><input aria-label={props.messages.grokManagementSearch} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={props.messages.grokManagementSearch} /></label>
            </div>
            {section === "commands" && (
              <button className="guild-control-settings-link" type="button" onClick={props.onOpenSessionSettings}><GearSix size={15} />{props.messages.grokManagementOpenSettings}</button>
            )}
            {section === "diagnostics" && (
              <button className="guild-control-settings-link" type="button" onClick={() => {
                setLocalError(undefined);
                void props.api.openRuntimeDiagnostics({}).catch(() => setLocalError(props.messages.operationFailed));
              }}><FolderOpen size={15} />{props.messages.openRuntimeDiagnostics}</button>
            )}
            <div className="guild-control-list">{list}</div>
          </section>
          <section className="guild-control-detail" id={`guild-control-panel-${section}`} role="tabpanel" aria-labelledby={`guild-control-tab-${section}`}>
            {selectedCommand !== undefined ? (
              <>
                <button className="guild-control-back guild-soft-button" type="button" onClick={() => selectSection(section)}>{props.messages.advancedTools}</button><div className="guild-control-detail-title"><Code size={19} /><div><strong>/{selectedCommand.name}</strong><span>{selectedCommand.description}</span></div></div>
                {selectedCommand.inputHint !== undefined && <label className="guild-control-field"><span>{props.messages.grokManagementCommandInput}</span><textarea value={String(values.commandInput ?? "")} placeholder={selectedCommand.inputHint} onChange={(event) => setValues({ commandInput: event.currentTarget.value })} /></label>}
                {props.activeTaskId === undefined && <p className="guild-control-warning"><WarningCircle size={14} />{props.messages.grokManagementNoTask}</p>}
                <button className="guild-control-run" type="button" disabled={running || props.activeTaskId === undefined} onClick={() => void runCommand()}>{running ? <SpinnerGap className="guild-spin" size={15} /> : <Check size={15} />}{props.messages.grokManagementRun}</button>
              </>
            ) : activeSpec !== undefined ? (
              <>
                <button className="guild-control-back guild-soft-button" type="button" onClick={() => selectSection(section)}>{props.messages.advancedTools}</button><div className="guild-control-detail-title">{sectionIcon(activeSpec.section)}<div><strong>{props.messages.grokManagementAction(activeSpec.action)}</strong><span>grok {activeSpec.action.replaceAll("_", " ")}</span></div></div>
                {(activeSpec.fields ?? []).map((item) => <ManagementField key={item.key} spec={item} messages={props.messages} value={values[item.key] ?? (item.type === "boolean" ? false : "")} onChange={(value) => { setValues((current) => ({ ...current, [item.key]: value })); setLocalError(undefined); }} />)}
                {activeSpec.confirm && confirming && <div className="guild-control-confirm"><WarningCircle size={16} /><span>{props.messages.grokManagementConfirm}</span><button type="button" onClick={() => setConfirming(false)}>{props.messages.grokManagementCancelConfirm}</button></div>}
                {props.activeTaskId === undefined
                  ? <p className="guild-control-warning"><WarningCircle size={14} />{props.messages.grokManagementNoTask}</p>
                  : !props.managementAvailable && <p className="guild-control-warning"><WarningCircle size={14} />{props.messages.grokManagementBusy}</p>}
                {localError !== undefined && <p className="guild-control-warning"><WarningCircle size={14} />{localError}</p>}
                <button className={`guild-control-run ${activeSpec.confirm && confirming ? "danger" : ""}`} type="button" disabled={running || !props.managementAvailable || props.activeTaskId === undefined} onClick={() => void runAction()}>{running ? <SpinnerGap className="guild-spin" size={15} /> : <Check size={15} />}{activeSpec.confirm && !confirming ? props.messages.grokManagementConfirm : props.messages.grokManagementRun}</button>
              </>
            ) : section === "diagnostics" ? (
              <RuntimeDiagnosticsSummary diagnostics={props.diagnostics ?? EMPTY_RUNTIME_DIAGNOSTICS} messages={props.messages} />
            ) : (
              <div className="guild-control-empty"><Code size={25} /><p>{props.messages.grokManagementSelect}</p></div>
            )}
            {result !== undefined && (
              <div className={`guild-control-result ${result.status}`} role="status" aria-live="polite">
                <header><strong title={result.commandLabel}>{result.commandLabel}</strong><span>{result.status === "completed" ? props.messages.grokManagementCompleted : props.messages.grokManagementFailed} · {result.durationMs} ms</span></header>
                <pre>{result.output}</pre>
              </div>
            )}
            {props.managementProgress !== undefined && props.managementProgress.action === selectedAction && (
              <div className="guild-control-result running" aria-live="polite">
                <header><strong title={props.managementProgress.commandLabel}>{props.managementProgress.commandLabel}</strong><span><SpinnerGap className="guild-spin" size={12} />{props.messages.activeActivity("working")}</span></header>
                <pre>{props.managementProgress.output || props.managementProgress.commandLabel}</pre>
              </div>
            )}
          </section>
        </div>
        <footer className="guild-control-boundary">{props.messages.grokManagementBoundary}</footer>
      </div>
    </div>
  );
}

function RuntimeDiagnosticsSummary(props: Readonly<{
  diagnostics: RuntimeDiagnosticsProjection;
  messages: GuildMessages;
}>) {
  return <div className="guild-runtime-diagnostics">
    <div className="guild-control-detail-title"><WarningCircle size={19} /><div><strong>{props.messages.runtimeDiagnostics}</strong><span>{props.diagnostics.logRelativePath}</span></div></div>
    <p>{props.messages.runtimeDiagnosticsHelp}</p>
    {props.diagnostics.recentIncidents.length === 0
      ? <div className="guild-runtime-diagnostics-empty"><Check size={16} />{props.messages.noRuntimeIncidents}</div>
      : <div className="guild-runtime-incident-list">{props.diagnostics.recentIncidents.map((incident) => (
          <article key={incident.incidentId} className={`guild-runtime-incident ${incident.recovery}`}>
            <header><strong>{incident.taskTitle}</strong><time>{new Date(incident.occurredAtIso).toLocaleString()}</time></header>
            <span>{props.messages.runtimeRecoveryState(incident.recovery)}</span>
            <small>{incident.signal ?? (typeof incident.exitCode === "number" ? `exit ${incident.exitCode}` : incident.reason)}{incident.hasStderr ? ` · ${props.messages.runtimeLogHasStderr}` : ""}</small>
          </article>
        ))}</div>}
  </div>;
}

const EMPTY_RUNTIME_DIAGNOSTICS: RuntimeDiagnosticsProjection = Object.freeze({
  enabled: true,
  logRelativePath: "diagnostics/runtime.jsonl",
  recentIncidents: Object.freeze([]),
});

function handleControlDialogKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  onClose: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function ManagementField(props: Readonly<{ spec: FieldSpec; messages: GuildMessages; value: string | boolean; onChange: (value: string | boolean) => void }>) {
  const label = props.messages.grokManagementField(props.spec.key);
  if (props.spec.type === "boolean") {
    return <label className="guild-control-toggle"><span>{label}</span><button type="button" className={`guild-switch ${props.value ? "on" : ""}`} aria-pressed={Boolean(props.value)} onClick={() => props.onChange(!props.value)} /></label>;
  }
  if (props.spec.type === "select") {
    return <label className="guild-control-field"><span>{label}</span><select value={String(props.value)} onChange={(event) => props.onChange(event.currentTarget.value)}>{props.spec.options?.map((option) => <option key={option || "default"} value={option}>{option || "—"}</option>)}</select></label>;
  }
  if (props.spec.type === "lines") {
    return <label className="guild-control-field"><span>{label}</span><textarea value={String(props.value)} placeholder={label} onChange={(event) => props.onChange(event.currentTarget.value)} /></label>;
  }
  return <label className="guild-control-field"><span>{label}</span><input type={props.spec.type === "number" ? "number" : "text"} value={String(props.value)} placeholder={label} onChange={(event) => props.onChange(event.currentTarget.value)} /></label>;
}

function parametersFrom(fields: readonly FieldSpec[], values: Readonly<Record<string, string | boolean>>): Readonly<Record<string, GuildGrokManagementParameter>> {
  const result: Record<string, GuildGrokManagementParameter> = {};
  for (const item of fields) {
    const value = values[item.key];
    if (item.type === "boolean") {
      result[item.key] = Boolean(value);
    } else if (item.type === "number") {
      if (String(value ?? "").trim().length > 0) result[item.key] = Number(value);
    } else if (item.type === "lines") {
      const lines = String(value ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      if (lines.length > 0) result[item.key] = Object.freeze(lines);
    } else if (String(value ?? "").length > 0) {
      result[item.key] = String(value);
    }
  }
  return Object.freeze(result);
}

function sectionIcon(section: Section): ReactNode {
  switch (section) {
    case "home": return <Wrench size={15} />;
    case "commands": return <Code size={15} />;
    case "runtime": return <GearSix size={15} />;
    case "extensions": return <Wrench size={15} />;
    case "sessions": return <ChatCircleDots size={15} />;
    case "worktrees": return <GitFork size={15} />;
    case "diagnostics": return <WarningCircle size={15} />;
  }
}
