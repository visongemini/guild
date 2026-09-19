import { appendFile, chmod, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { redactDiagnostic } from "@guild/runtime-grok";

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_GENERATIONS = 3;
const MAX_READ_RECORDS = 512;
const MAX_READ_FILE_BYTES = MAX_LOG_BYTES + 64 * 1024;

const SAFE_DIAGNOSTIC_REASONS = new Set([
  "unbound", "creating", "healthy", "restore_pending", "replay_reconciling",
  "broken", "replacement_pending", "new", "resume", "load", "cancelled",
  "completed", "refused", "truncated", "decoder_fault", "explicit_close",
  "peer_fault", "process_fault", "protocol_fault", "sink_fault", "stdout_eof",
  "write_fault", "system_power_event", "unknown_error",
]);
const SAFE_DIAGNOSTIC_FAULT_CODES = new Set([
  "adapter_closed", "adapter_not_initialized", "aggregate_limit_exceeded", "blank_line",
  "capability_not_advertised", "collection_limit_exceeded", "decoder_closed",
  "duplicate_auth_method_id", "duplicate_id", "duplicate_inbound_request_id",
  "duplicate_option_id", "duplicate_response_id", "frame_too_large", "invalid_adapter_options",
  "invalid_message", "invalid_outbound_message", "invalid_permission_decision", "invalid_request_id",
  "invalid_type", "invalid_utf8", "invalid_value", "malformed_json", "missing_field",
  "nesting_limit_exceeded", "non_object_frame", "operation_failed", "option_not_advertised",
  "overlapping_prompt", "peer_closed", "pending_request_limit", "process_exit", "protocol_fault",
  "request_id_exhausted", "request_timeout", "session_id_mismatch", "sink_commit_failed",
  "spawn_failure", "stale_session_identity", "stdout_eof", "string_limit_exceeded",
  "transport_lost", "truncated_frame", "unadvertised_auth_capability", "unknown_response_id",
  "unsupported_content", "unsupported_protocol_version", "wire_string_limit_exceeded",
  "write_failed", "write_failure", "write_timeout",
]);
const SAFE_DIAGNOSTIC_FAULT_STAGES = new Set([
  "json_rpc_peer", "response_decode", "session_update", "transport",
]);
const SAFE_DIAGNOSTIC_UPDATE_KINDS = new Set([
  "agent_message_chunk", "agent_thought_chunk", "available_commands_update",
  "config_option_update", "current_mode_update", "plan", "session_info_update",
  "tool_call", "tool_call_update", "usage_update", "user_message_chunk",
]);
const SAFE_DIAGNOSTIC_FAULT_PATHS = new Set([
  "$", "$.result", "$.stopReason", "$.update", "$.update.content", "$.update.sessionUpdate",
]);

export type RuntimeDiagnosticRecord = Readonly<{
  schemaVersion: 1;
  occurredAtIso: string;
  category: "runtime" | "session" | "prompt" | "auxiliary" | "transport" | "recovery";
  event: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  auxiliarySessionId?: string;
  incidentId?: string;
  adapterEpoch?: number;
  processId?: number;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
  faultCode?: string;
  faultPath?: string;
  faultStage?: string;
  updateKind?: string;
  activity?: string;
  toolKind?: string;
  stderrTail?: readonly string[];
  stderrCapturedBytes?: number;
  stderrDroppedBytes?: number;
}>;

/**
 * Private, bounded JSONL diagnostics for process ownership and session recovery.
 * Records never intentionally include prompts, normal authored output, credentials, or headers.
 * Process stderr contributes only bounded byte accounting and a presence sentinel.
 * Raw stderr and arbitrary Error.message text are never persisted.
 */
export class RuntimeDiagnosticLog {
  readonly directory: string;
  readonly path: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, "runtime.jsonl");
  }

  append(record: RuntimeDiagnosticRecord): Promise<void> {
    const operation = this.tail.then(() => this.write(record));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  /**
   * Rehydrates the small incident summary shown in the diagnostics UI after an app restart.
   * Corrupt, oversized, or unexpected records are ignored rather than blocking startup.
   */
  async readRecent(limit = MAX_READ_RECORDS): Promise<readonly RuntimeDiagnosticRecord[]> {
    const boundedLimit = Math.max(0, Math.min(MAX_READ_RECORDS, Math.trunc(limit)));
    if (boundedLimit === 0) return Object.freeze([]);
    const records: RuntimeDiagnosticRecord[] = [];
    for (let generation = MAX_GENERATIONS; generation >= 0; generation -= 1) {
      const candidatePath = generation === 0 ? this.path : `${this.path}.${generation}`;
      const fileSize = await stat(candidatePath).then((value) => value.size, () => 0);
      if (fileSize <= 0 || fileSize > MAX_READ_FILE_BYTES) continue;
      const contents = await readFile(candidatePath, "utf8").catch(() => undefined);
      if (contents === undefined) continue;
      for (const line of contents.split("\n")) {
        if (line.length === 0 || line.length > 64 * 1024) continue;
        const parsed = safeParseRecord(line);
        if (parsed !== undefined) records.push(parsed);
      }
    }
    return Object.freeze(records.slice(-boundedLimit));
  }

  private async write(record: RuntimeDiagnosticRecord): Promise<void> {
    const safeRecord = Object.freeze({
      ...record,
      ...(record.sessionId === undefined ? {} : {
        sessionId: hashedExternalIdentity("session", record.sessionId),
      }),
      ...(record.auxiliarySessionId === undefined ? {} : {
        auxiliarySessionId: hashedExternalIdentity("auxiliary", record.auxiliarySessionId),
      }),
      ...(record.reason === undefined ? {} : {
        reason: /^\d{1,5}_updates_reconciled$/u.test(record.reason)
          ? record.reason
          : allowlistedDiagnostic(record.reason, SAFE_DIAGNOSTIC_REASONS),
      }),
      ...(record.faultCode === undefined ? {} : {
        faultCode: allowlistedDiagnostic(record.faultCode, SAFE_DIAGNOSTIC_FAULT_CODES),
      }),
      ...(record.faultPath === undefined ? {} : {
        faultPath: allowlistedDiagnostic(record.faultPath, SAFE_DIAGNOSTIC_FAULT_PATHS),
      }),
      ...(record.faultStage === undefined ? {} : {
        faultStage: allowlistedDiagnostic(record.faultStage, SAFE_DIAGNOSTIC_FAULT_STAGES),
      }),
      ...(record.updateKind === undefined ? {} : {
        updateKind: allowlistedDiagnostic(record.updateKind, SAFE_DIAGNOSTIC_UPDATE_KINDS),
      }),
      ...(record.stderrTail === undefined
        ? {}
        : { stderrTail: Object.freeze(record.stderrTail.length === 0 ? [] : ["[STDERR REDACTED]"]) }),
    });
    const line = `${JSON.stringify(safeRecord)}\n`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded(Buffer.byteLength(line));
    await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const currentSize = await stat(this.path).then((value) => value.size, () => 0);
    if (currentSize + incomingBytes <= MAX_LOG_BYTES) return;
    await unlink(`${this.path}.${MAX_GENERATIONS}`).catch(ignoreMissing);
    for (let generation = MAX_GENERATIONS - 1; generation >= 1; generation -= 1) {
      await rename(`${this.path}.${generation}`, `${this.path}.${generation + 1}`)
        .catch(ignoreMissing);
    }
    await rename(this.path, `${this.path}.1`).catch(ignoreMissing);
  }
}

function allowlistedDiagnostic(value: string, allowlist: ReadonlySet<string>): string {
  const redacted = redactDiagnostic(value);
  if (redacted.includes("[REDACTED]")) return "[REDACTED]";
  return allowlist.has(redacted) ? redacted : "[REDACTED]";
}

function hashedExternalIdentity(kind: "session" | "auxiliary", value: string): string {
  const digest = createHash("sha256").update(`${kind}\0${value}`, "utf8").digest("hex");
  return `${kind}:sha256:${digest.slice(0, 24)}`;
}

function safeParseRecord(line: string): RuntimeDiagnosticRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.occurredAtIso !== "string" ||
    !Number.isFinite(Date.parse(record.occurredAtIso)) ||
    !isCategory(record.category) ||
    typeof record.event !== "string" ||
    record.event.length === 0 ||
    record.event.length > 80
  ) return undefined;
  const optionalStrings = [
    "taskId", "runId", "sessionId", "auxiliarySessionId", "incidentId",
    "signal", "reason", "faultCode", "faultPath", "faultStage", "updateKind",
    "activity", "toolKind",
  ] as const;
  for (const key of optionalStrings) {
    const candidate = record[key];
    if (candidate !== undefined && candidate !== null && (
      typeof candidate !== "string" || candidate.length > 512
    )) return undefined;
  }
  const optionalNumbers = [
    "adapterEpoch", "processId", "exitCode", "stderrCapturedBytes", "stderrDroppedBytes",
  ] as const;
  for (const key of optionalNumbers) {
    const candidate = record[key];
    if (candidate !== undefined && candidate !== null && (
      typeof candidate !== "number" || !Number.isFinite(candidate)
    )) return undefined;
  }
  if (record.stderrTail !== undefined && (
    !Array.isArray(record.stderrTail) ||
    record.stderrTail.length > 128 ||
    record.stderrTail.some((entry) => typeof entry !== "string" || entry.length > 4_096)
  )) return undefined;
  return Object.freeze(value as RuntimeDiagnosticRecord);
}

function isCategory(value: unknown): value is RuntimeDiagnosticRecord["category"] {
  return value === "runtime" || value === "session" || value === "prompt" ||
    value === "auxiliary" || value === "transport" || value === "recovery";
}

function ignoreMissing(cause: unknown): void {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT"
  ) return;
  throw cause;
}
