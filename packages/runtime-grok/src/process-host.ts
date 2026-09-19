import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  GuildGrokModel,
  GuildGrokPermissionMode,
  GuildGrokReasoningEffort,
  GuildGrokStartupSettings,
} from "@guild/contracts";
import {
  ExecutablePinError,
  pinExecutable,
  type ExecutablePinFailureCode,
  type PinnedExecutable,
  type PinnedExecutableCleanup,
} from "./executable-pin.js";
import {
  GROK_ACP_PRODUCTION_ARGV,
  createGrokAcpProductionArgv,
} from "./grok-acp-profile.js";

export type ProcessHostPreflightCode = ExecutablePinFailureCode | "working_directory_not_absolute";

export type ProcessGroupSignalEvidence = {
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly outcome: "sent" | "already_gone" | "failed";
  readonly errorCode?: string;
};
export type ProcessGroupProbeEvidence = "present" | "already_gone" | "failed";

export type ProcessHostFailure =
  | { readonly type: "preflight_failure"; readonly code: ProcessHostPreflightCode; readonly message: string }
  | { readonly type: "process_error"; readonly message: string }
  | {
    readonly type: "reap_timeout";
    readonly timeoutMs: number;
    readonly processGroupId: number;
    readonly directChildClosed: boolean;
    readonly groupGoneObserved: boolean;
    readonly groupTermSignal: ProcessGroupSignalEvidence;
    readonly groupKillSignal?: ProcessGroupSignalEvidence;
  }
  | { readonly type: "spawn_failure"; readonly message: string }
  | { readonly type: "write_failure"; readonly writeId: number; readonly message: string };

export class GrokProcessHostError extends Error {
  readonly failure: ProcessHostFailure;

  constructor(failure: ProcessHostFailure) {
    super(failure.type === "reap_timeout"
      ? `owned process group ${failure.processGroupId} and direct child close were not both confirmed within ${failure.timeoutMs} ms`
      : failure.message);
    this.name = "GrokProcessHostError";
    this.failure = failure;
  }
}

export const PROCESS_ENVIRONMENT_POLICY_VERSION = "macos-posix-v3";

export type ProcessStartReceipt = {
  readonly type: "process_started";
  readonly pid: number;
  readonly processGroupId: number;
  readonly executablePath: string;
  readonly verifiedSha256: string;
  readonly argv: readonly string[];
  readonly shell: false;
  readonly stdio: "piped";
  readonly workingDirectory: string;
  readonly environmentPolicyVersion: typeof PROCESS_ENVIRONMENT_POLICY_VERSION;
};

export type ProcessWriteReceipt = {
  readonly type: "stdin_write_completed";
  readonly writeId: number;
  readonly bytes: number;
  readonly evidence: "local_stream_callback";
  readonly remoteAcceptance: "not_evidenced";
};
export type ProcessCloseEvidence = {
  readonly type: "process_closed";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly exitObserved: boolean;
  readonly stdoutEofObserved: boolean;
};
export type ProcessNotSpawnedEvidence = {
  readonly type: "not_spawned";
  readonly failure: Extract<ProcessHostFailure, { type: "preflight_failure" | "spawn_failure" }>;
};
export type ProcessTerminationEvidence = ProcessStopReceipt | ProcessNotSpawnedEvidence;
export type ProcessCleanupTimedOutEvidence = {
  readonly status: "timed_out";
  readonly stageHandleClosed: "unknown";
  readonly stagingDirectoryRemoved: "unknown";
  readonly failure: "cleanup_pending";
};
export type ProcessCleanupEvidence = PinnedExecutableCleanup | ProcessCleanupTimedOutEvidence;
export type ProcessStopReceipt = {
  readonly type: "stop_reaped";
  readonly stopRequested: boolean;
  readonly termSignalSent: boolean;
  readonly killSignalSent: boolean;
  readonly processGroupId: number;
  readonly groupTermSignalSent: boolean;
  readonly groupKillSignalSent: boolean;
  readonly groupTermSignal: ProcessGroupSignalEvidence;
  readonly groupKillSignal?: ProcessGroupSignalEvidence;
  readonly groupGoneObserved: true;
  readonly close: ProcessCloseEvidence;
  readonly cleanup: ProcessCleanupEvidence;
};

export type ProcessHostEvent =
  | { readonly type: "preflight_failure"; readonly failure: Extract<ProcessHostFailure, { type: "preflight_failure" }> }
  | { readonly type: "process_close"; readonly evidence: ProcessCloseEvidence }
  | { readonly type: "process_error"; readonly failure: Extract<ProcessHostFailure, { type: "process_error" }> }
  | { readonly type: "process_exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: "process_started"; readonly receipt: ProcessStartReceipt }
  | { readonly type: "reaped"; readonly receipt: ProcessStopReceipt }
  | { readonly type: "cleanup_late_result"; readonly result: PinnedExecutableCleanup }
  | { readonly type: "spawn_failure"; readonly failure: Extract<ProcessHostFailure, { type: "spawn_failure" }> }
  | { readonly type: "stderr_diagnostic"; readonly text: string; readonly sourceBytes: number; readonly capturedBytes: number; readonly droppedBytes: number }
  | { readonly type: "stderr_eof"; readonly capturedBytes: number; readonly droppedBytes: number }
  | { readonly type: "stdout_data"; readonly chunk: Uint8Array }
  | { readonly type: "stdout_eof" }
  | { readonly type: "stop_escalated"; readonly signal: "SIGKILL"; readonly evidence: ProcessGroupSignalEvidence }
  | { readonly type: "stop_failure"; readonly failure: Extract<ProcessHostFailure, { type: "reap_timeout" }>; readonly cleanup: ProcessCleanupEvidence }
  | { readonly type: "stop_requested"; readonly signal: "SIGTERM"; readonly evidence: ProcessGroupSignalEvidence }
  | { readonly type: "write_failure"; readonly failure: Extract<ProcessHostFailure, { type: "write_failure" }> };

export type GrokProcessHostOptions = {
  readonly executablePath: string;
  readonly expectedSha256: string;
  readonly workingDirectory: string;
  readonly stagingRoot: string;
  readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly killGraceMs?: number;
  readonly maxStderrBytes?: number;
  readonly redactValues?: readonly string[];
  readonly runtimeSettings?: {
    readonly model: GuildGrokModel;
    readonly reasoningEffort: GuildGrokReasoningEffort;
    readonly permissionMode: GuildGrokPermissionMode;
    readonly startup?: GuildGrokStartupSettings;
  };
  readonly stopGraceMs?: number;
};

/** @internal Only the non-root package testing entry may construct this seam. */
export type InternalProcessHostTestConfiguration = {
  readonly fixtureArgs?: readonly string[];
  readonly afterPin?: (pinned: PinnedExecutable) => void | Promise<void>;
  readonly cleanupPinned?: (pinned: PinnedExecutable) => Promise<PinnedExecutableCleanup>;
  readonly signalGroup?: (processGroupId: number, signal: "SIGTERM" | "SIGKILL") => ProcessGroupSignalEvidence;
  readonly probeGroup?: (processGroupId: number) => ProcessGroupProbeEvidence;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly monotonicNow?: () => number;
  readonly cleanupDeadlineMs?: number;
};

type ProcessHostLifecycle = Required<Omit<InternalProcessHostTestConfiguration, "fixtureArgs">> & {
  readonly pin: typeof pinExecutable;
};

type HostState = "closed" | "created" | "failed" | "running" | "starting" | "stopping";
type Deferred<T> = { readonly promise: Promise<T>; readonly reject: (reason: unknown) => void; readonly resolve: (value: T) => void };
type PendingWrite = { readonly bytes: number; readonly deferred: Deferred<ProcessWriteReceipt> };

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const PRODUCTION_CLEANUP_DEADLINE_MS = 500;
const LATE_CLEANUP_LISTENER_RETENTION_MS = 1_000;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/u;
const MACOS_FALLBACK_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const STOP_POLL_MS = 25;
const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "SSH_AUTH_SOCK",
]);
const ENVIRONMENT_DENYLIST = new Set([
  "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "BASH_ENV", "ENV", "ZDOTDIR",
]);
const DISABLED_EXTERNAL_INSTRUCTION_IMPORTS = Object.freeze([
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
] as const);

class ProcessHostCore {
  readonly executablePath: string;
  readonly expectedSha256: string;
  private readonly argv: readonly string[];
  private readonly workingDirectoryInput: string;
  private readonly stagingRoot: string;
  private readonly baseEnvironment: Readonly<Record<string, string | undefined>>;
  private readonly maxStderrBytes: number;
  private readonly redactValues: readonly string[];
  private readonly stopGraceMs: number;
  private readonly killGraceMs: number;
  private readonly lifecycle: ProcessHostLifecycle;
  private readonly listeners = new Set<(event: ProcessHostEvent) => void>();
  private readonly termination = createDeferred<ProcessTerminationEvidence>();
  private readonly pendingWrites = new Map<number, PendingWrite>();
  private readonly stderrCollector: BoundedStderrCollector;
  private child: ChildProcessWithoutNullStreams | undefined;
  private pinned: PinnedExecutable | undefined;
  private processGroupId: number | undefined;
  private currentState: HostState = "created";
  private startOperation: Promise<ProcessStartReceipt> | undefined;
  private stopOperation: Promise<ProcessStopReceipt> | undefined;
  private finalReceipt: ProcessStopReceipt | undefined;
  private writeSequence = 0;
  private spawnSucceeded = false;
  private terminationSettled = false;
  private stdoutEofObserved = false;
  private stderrEofObserved = false;
  private exitObserved = false;
  private explicitStopRequested = false;
  private groupTermSignal: ProcessGroupSignalEvidence | undefined;
  private groupKillSignal: ProcessGroupSignalEvidence | undefined;
  private groupGoneObserved = false;
  private closeEvidence: ProcessCloseEvidence | undefined;
  private cleanupOperation: Promise<PinnedExecutableCleanup> | undefined;
  private cleanupEvidenceOperation: Promise<ProcessCleanupEvidence> | undefined;
  private terminalListenersFinished = false;

  constructor(options: GrokProcessHostOptions, lifecycle: ProcessHostLifecycle, argv: readonly string[]) {
    this.executablePath = options.executablePath;
    this.workingDirectoryInput = options.workingDirectory;
    this.stagingRoot = options.stagingRoot;
    if (!SHA256_PATTERN.test(options.expectedSha256)) {
      throw new TypeError("expectedSha256 must be exactly 64 hexadecimal characters");
    }
    this.expectedSha256 = options.expectedSha256.toLowerCase();
    this.argv = Object.freeze([...argv]);
    for (const argument of this.argv) {
      if (typeof argument !== "string" || argument.includes("\0")) {
        throw new TypeError("process arguments must be NUL-free strings");
      }
    }
    this.baseEnvironment = snapshotEnvironment(options.baseEnvironment);
    this.maxStderrBytes = positiveSafeInteger(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes");
    this.stopGraceMs = positiveSafeInteger(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS, "stopGraceMs");
    this.killGraceMs = positiveSafeInteger(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "killGraceMs");
    this.lifecycle = lifecycle;
    this.redactValues = Object.freeze([...(options.redactValues ?? [])].filter((value) => value.length > 0));
    this.stderrCollector = new BoundedStderrCollector(this.maxStderrBytes, this.redactValues, (event) => this.emit(event));
    void this.termination.promise.then(() => undefined, () => undefined);
  }

  get state(): HostState {
    return this.currentState;
  }

  onEvent(listener: (event: ProcessHostEvent) => void): () => void {
    if (this.currentState === "closed" || this.currentState === "failed") {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): Promise<ProcessStartReceipt> {
    if (this.startOperation !== undefined) {
      return this.startOperation;
    }
    if (this.currentState !== "created") {
      return rejectedHandled(new GrokProcessHostError({ type: "spawn_failure", message: "process host cannot be started from its current state" }));
    }
    this.currentState = "starting";
    this.startOperation = this.startOwnedProcess();
    void this.startOperation.catch(() => undefined);
    return this.startOperation;
  }

  waitForTermination(): Promise<ProcessTerminationEvidence> {
    return this.termination.promise;
  }

  write(data: string | Uint8Array): Promise<ProcessWriteReceipt> {
    const child = this.child;
    if (this.currentState !== "running" || child === undefined || child.stdin.destroyed) {
      const failure = writeFailure(this.nextWriteId(), "stdin is not writable");
      // One rejected public write owns exactly one diagnostic event.
      this.emit({ type: "write_failure", failure });
      return rejectedHandled(new GrokProcessHostError(failure));
    }
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    const writeId = this.nextWriteId();
    const deferred = createDeferred<ProcessWriteReceipt>();
    this.pendingWrites.set(writeId, { bytes, deferred });
    void deferred.promise.catch(() => undefined);
    try {
      child.stdin.write(data, (error?: Error | null) => {
        if (!this.pendingWrites.has(writeId)) {
          return;
        }
        if (error !== undefined && error !== null) {
          this.rejectWrite(writeId, "stdin write callback reported failure");
          return;
        }
        this.pendingWrites.delete(writeId);
        deferred.resolve({ type: "stdin_write_completed", writeId, bytes, evidence: "local_stream_callback", remoteAcceptance: "not_evidenced" });
      });
    } catch {
      this.rejectWrite(writeId, "stdin write threw before completion");
    }
    return deferred.promise;
  }

  // Deliberately non-async: the stop promise exists before in-flight start is awaited.
  stop(): Promise<ProcessStopReceipt> {
    if (this.stopOperation !== undefined) {
      return this.stopOperation;
    }
    if (this.finalReceipt !== undefined) {
      this.stopOperation = Promise.resolve(this.finalReceipt);
      return this.stopOperation;
    }
    this.explicitStopRequested = true;
    return this.beginStop(() => this.stopAfterStart());
  }

  private async startOwnedProcess(): Promise<ProcessStartReceipt> {
    let workingDirectory: string;
    let environment: Readonly<Record<string, string>>;
    try {
      workingDirectory = await resolveWorkingDirectory(this.workingDirectoryInput);
      environment = buildChildEnvironment(this.baseEnvironment);
    } catch (cause) {
      return this.failPreflight(cause);
    }

    let pinned: PinnedExecutable;
    try {
      pinned = await this.lifecycle.pin(this.executablePath, this.stagingRoot, this.expectedSha256);
    } catch (cause) {
      return this.failPreflight(cause);
    }
    this.pinned = pinned;
    try {
      await this.lifecycle.afterPin(pinned);
    } catch {
      const cleanup = await this.cleanupPin();
      return this.failPreflight(new ExecutablePinError("preflight_io_failure", "pinned executable test gate failed"), cleanup);
    }
    try {
      await pinned.verifyForSpawn();
    } catch (cause) {
      const cleanup = await this.cleanupPin();
      return this.failPreflight(cause, cleanup);
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(pinned.stagedExecutablePath, this.argv, {
        cwd: workingDirectory,
        detached: true,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      const cleanup = await this.cleanupPin();
      throw this.failSpawn(cleanup);
    }
    this.child = child;
    this.attachChild(child);
    return new Promise<ProcessStartReceipt>((resolve, reject) => {
      let settled = false;
      child.once("spawn", () => {
        if (settled) {
          return;
        }
        const pid = child.pid;
        if (pid === undefined) {
          settled = true;
          void this.cleanupPin().then((cleanup) => reject(this.failSpawn(cleanup)));
          return;
        }
        settled = true;
        this.spawnSucceeded = true;
        this.processGroupId = pid;
        this.currentState = this.explicitStopRequested ? "stopping" : "running";
        const receipt: ProcessStartReceipt = {
          type: "process_started",
          pid,
          processGroupId: pid,
          executablePath: pinned.stagedExecutablePath,
          verifiedSha256: pinned.sha256,
          argv: this.argv,
          shell: false,
          stdio: "piped",
          workingDirectory,
          environmentPolicyVersion: PROCESS_ENVIRONMENT_POLICY_VERSION,
        };
        this.emit({ type: "process_started", receipt });
        resolve(receipt);
      });
      child.once("error", () => {
        if (settled || this.spawnSucceeded) {
          return;
        }
        settled = true;
        void this.cleanupPin().then((cleanup) => reject(this.failSpawn(cleanup)));
      });
    });
  }

  private async stopAfterStart(): Promise<ProcessStopReceipt> {
    await this.start();
    return this.reapGroup();
  }

  private startAutomaticReap(): void {
    if (this.stopOperation !== undefined) {
      return;
    }
    this.beginStop(() => this.reapGroup());
  }

  private beginStop(operation: () => Promise<ProcessStopReceipt>): Promise<ProcessStopReceipt> {
    const deferred = createDeferred<ProcessStopReceipt>();
    // Reserve the public identity before any reaper work can emit synchronously.
    this.stopOperation = deferred.promise;
    void deferred.promise.catch(() => undefined);
    void operation().then(deferred.resolve, deferred.reject);
    return deferred.promise;
  }

  private async reapGroup(): Promise<ProcessStopReceipt> {
    const processGroupId = this.processGroupId;
    if (processGroupId === undefined) {
      throw new GrokProcessHostError({ type: "process_error", message: "spawned process has no process group" });
    }
    if (this.finalReceipt !== undefined) {
      return this.finalReceipt;
    }
    this.currentState = "stopping";
    this.observeGroupGone();
    this.groupTermSignal = this.groupGoneObserved
      ? { signal: "SIGTERM", outcome: "already_gone" }
      : this.lifecycle.signalGroup(processGroupId, "SIGTERM");
    if (this.groupTermSignal.outcome === "already_gone") {
      this.groupGoneObserved = true;
    }
    this.emit({ type: "stop_requested", signal: "SIGTERM", evidence: this.groupTermSignal });
    if (await this.waitForGroupGoneAndClose(this.stopGraceMs)) {
      return this.finishReap(processGroupId);
    }
    if (!this.groupGoneObserved) {
      this.groupKillSignal = this.lifecycle.signalGroup(processGroupId, "SIGKILL");
      if (this.groupKillSignal.outcome === "already_gone") {
        this.groupGoneObserved = true;
      }
      this.emit({ type: "stop_escalated", signal: "SIGKILL", evidence: this.groupKillSignal });
    }
    if (await this.waitForGroupGoneAndClose(this.killGraceMs)) {
      return this.finishReap(processGroupId);
    }
    const failure: Extract<ProcessHostFailure, { type: "reap_timeout" }> = {
      type: "reap_timeout",
      timeoutMs: this.stopGraceMs + this.killGraceMs,
      processGroupId,
      directChildClosed: this.closeEvidence !== undefined,
      groupGoneObserved: this.groupGoneObserved,
      groupTermSignal: this.groupTermSignal ?? { signal: "SIGTERM", outcome: "already_gone" },
      groupKillSignal: this.groupKillSignal,
    };
    return this.failReap(failure);
  }

  private async waitForGroupGoneAndClose(timeoutMs: number): Promise<boolean> {
    const deadline = this.lifecycle.monotonicNow() + timeoutMs;
    while (true) {
      // Probe on every lifecycle poll, including while close evidence is delayed.
      const groupGone = this.observeGroupGone();
      if (this.closeEvidence !== undefined && groupGone) {
        return true;
      }
      const remaining = deadline - this.lifecycle.monotonicNow();
      if (remaining <= 0) {
        return false;
      }
      await this.lifecycle.delay(Math.min(STOP_POLL_MS, remaining));
    }
  }

  private observeGroupGone(): boolean {
    if (this.groupGoneObserved) {
      return true;
    }
    const processGroupId = this.processGroupId;
    if (processGroupId === undefined) {
      return false;
    }
    const evidence = this.lifecycle.probeGroup(processGroupId);
    if (evidence === "already_gone") {
      this.groupGoneObserved = true;
      return true;
    }
    return false;
  }

  private async finishReap(processGroupId: number): Promise<ProcessStopReceipt> {
    if (this.finalReceipt !== undefined) {
      return this.finalReceipt;
    }
    const close = this.closeEvidence;
    if (close === undefined || !this.groupGoneObserved) {
      throw new Error("reap completion requires direct close and confirmed group absence");
    }
    const cleanup = await this.cleanupPin();
    const groupTermSignal = this.groupTermSignal ?? { signal: "SIGTERM", outcome: "already_gone" };
    const receipt: ProcessStopReceipt = {
      type: "stop_reaped",
      stopRequested: this.explicitStopRequested,
      termSignalSent: groupTermSignal.outcome === "sent",
      killSignalSent: this.groupKillSignal?.outcome === "sent",
      processGroupId,
      groupTermSignalSent: groupTermSignal.outcome === "sent",
      groupKillSignalSent: this.groupKillSignal?.outcome === "sent",
      groupTermSignal,
      groupKillSignal: this.groupKillSignal,
      groupGoneObserved: true,
      close,
      cleanup,
    };
    this.finalReceipt = receipt;
    this.currentState = "closed";
    this.emit({ type: "reaped", receipt });
    this.resolveTermination(receipt);
    this.finishTerminalListeners(cleanup);
    return receipt;
  }

  private async failReap(failure: Extract<ProcessHostFailure, { type: "reap_timeout" }>): Promise<never> {
    const cleanup = await this.cleanupPin();
    const error = new GrokProcessHostError(failure);
    this.currentState = "failed";
    this.rejectAllWrites("process reaping timed out");
    this.emit({ type: "stop_failure", failure, cleanup });
    this.rejectTermination(error);
    this.finishTerminalListeners(cleanup);
    throw error;
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.emit({ type: "stdout_data", chunk: Uint8Array.from(typeof chunk === "string" ? Buffer.from(chunk) : chunk) });
    });
    child.stdout.once("end", () => this.observeStdoutEof());
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrCollector.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.stderr.once("end", () => this.observeStderrEof());
    child.stdin.on("error", () => this.rejectAllWrites("stdin stream emitted an error"));
    child.on("error", () => {
      if (this.spawnSucceeded) {
        this.emit({ type: "process_error", failure: { type: "process_error", message: "owned process emitted an error after spawn" } });
      }
    });
    child.once("exit", (code, signal) => {
      if (!this.spawnSucceeded) {
        return;
      }
      this.exitObserved = true;
      this.emit({ type: "process_exit", code, signal });
      this.rejectAllWrites("process exited before stdin write completion");
      if (this.stopOperation === undefined) {
        this.startAutomaticReap();
      }
    });
    child.once("close", (code, signal) => this.handleClose(code, signal));
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.spawnSucceeded) {
      return;
    }
    this.observeStdoutEof();
    this.observeStderrEof();
    this.rejectAllWrites("process closed before stdin write completion");
    this.closeEvidence = {
      type: "process_closed",
      code,
      signal,
      exitObserved: this.exitObserved,
      stdoutEofObserved: this.stdoutEofObserved,
    };
    this.emit({ type: "process_close", evidence: this.closeEvidence });
    // `close` reports only the direct child and inherited streams. The reaper owns
    // terminal state and keeps the independent executable until the PGID is ESRCH.
    if (this.stopOperation === undefined) {
      // Enter automatic reaping exactly once for this close observation.
      this.startAutomaticReap();
    }
  }

  private observeStdoutEof(): void {
    if (!this.stdoutEofObserved && this.spawnSucceeded) {
      this.stdoutEofObserved = true;
      this.emit({ type: "stdout_eof" });
    }
  }

  private observeStderrEof(): void {
    if (!this.stderrEofObserved && this.spawnSucceeded) {
      this.stderrEofObserved = true;
      this.emit({ type: "stderr_eof", ...this.stderrCollector.end() });
    }
  }

  private failPreflight(cause: unknown, cleanup?: ProcessCleanupEvidence): never {
    const failure = normalizePreflightFailure(cause);
    this.currentState = "failed";
    this.emit({ type: "preflight_failure", failure });
    this.resolveTermination({ type: "not_spawned", failure });
    this.finishTerminalListeners(cleanup);
    throw new GrokProcessHostError(failure);
  }

  private failSpawn(cleanup?: ProcessCleanupEvidence): GrokProcessHostError {
    const failure = spawnFailure();
    this.currentState = "failed";
    this.emit({ type: "spawn_failure", failure });
    this.rejectAllWrites("process failed to spawn");
    this.resolveTermination({ type: "not_spawned", failure });
    this.finishTerminalListeners(cleanup);
    return new GrokProcessHostError(failure);
  }

  private cleanupPin(): Promise<ProcessCleanupEvidence> {
    this.cleanupEvidenceOperation ??= this.beginCleanupPin();
    return this.cleanupEvidenceOperation;
  }

  private async beginCleanupPin(): Promise<ProcessCleanupEvidence> {
    const pinned = this.pinned;
    this.pinned = undefined;
    if (pinned === undefined) {
      return { stageHandleClosed: true, stagingDirectoryRemoved: true, failure: "none" };
    }
    this.cleanupOperation ??= Promise.resolve()
      .then(() => this.lifecycle.cleanupPinned(pinned))
      .catch(() => Object.freeze({
        stageHandleClosed: false,
        stagingDirectoryRemoved: false,
        failure: "stage_handle_close_and_staging_directory_remove_failed" as const,
      }));
    const outcome = await cleanupWithDeadline(this.cleanupOperation, this.lifecycle.cleanupDeadlineMs);
    return outcome.type === "timed_out"
      ? Object.freeze({
        status: "timed_out",
        stageHandleClosed: "unknown",
        stagingDirectoryRemoved: "unknown",
        failure: "cleanup_pending",
      })
      : outcome.result;
  }

  private finishTerminalListeners(cleanup: ProcessCleanupEvidence | undefined): void {
    if (this.terminalListenersFinished) {
      return;
    }
    this.terminalListenersFinished = true;
    if (cleanup?.failure !== "cleanup_pending" || this.cleanupOperation === undefined) {
      this.listeners.clear();
      return;
    }
    const release = setTimeout(() => {
      this.listeners.clear();
    }, LATE_CLEANUP_LISTENER_RETENTION_MS);
    release.unref();
    void this.cleanupOperation.then((result) => {
      this.emit({ type: "cleanup_late_result", result });
      clearTimeout(release);
      this.listeners.clear();
    });
  }

  private rejectWrite(writeId: number, message: string): void {
    const pending = this.pendingWrites.get(writeId);
    if (pending === undefined) {
      return;
    }
    this.pendingWrites.delete(writeId);
    const failure = writeFailure(writeId, message);
    this.emit({ type: "write_failure", failure });
    pending.deferred.reject(new GrokProcessHostError(failure));
  }

  private rejectAllWrites(message: string): void {
    for (const writeId of [...this.pendingWrites.keys()]) {
      this.rejectWrite(writeId, message);
    }
  }

  private nextWriteId(): number {
    this.writeSequence += 1;
    return this.writeSequence;
  }

  private resolveTermination(evidence: ProcessTerminationEvidence): void {
    if (!this.terminationSettled) {
      this.terminationSettled = true;
      this.termination.resolve(evidence);
    }
  }

  private rejectTermination(error: GrokProcessHostError): void {
    if (!this.terminationSettled) {
      this.terminationSettled = true;
      this.termination.reject(error);
    }
  }

  private emit(event: ProcessHostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Diagnostic listeners are not lifecycle owners.
      }
    }
  }
}

const PRODUCTION_LIFECYCLE = Object.freeze<ProcessHostLifecycle>({
  pin: pinExecutable,
  afterPin: () => undefined,
  cleanupPinned: (pinned) => pinned.cleanup(),
  signalGroup,
  probeGroup,
  delay,
  monotonicNow: () => performance.now(),
  cleanupDeadlineMs: PRODUCTION_CLEANUP_DEADLINE_MS,
});

/** @internal Constructed only by `process-host-testing.ts`; not exported at package root. */
export function createInternalProcessHostForTesting(
  options: GrokProcessHostOptions,
  configuration: InternalProcessHostTestConfiguration,
): ProcessHostCore {
  const cleanupDeadlineMs = positiveSafeInteger(
    configuration.cleanupDeadlineMs ?? PRODUCTION_CLEANUP_DEADLINE_MS,
    "cleanupDeadlineMs",
  );
  return new ProcessHostCore(options, Object.freeze({
    ...PRODUCTION_LIFECYCLE,
    afterPin: configuration.afterPin ?? PRODUCTION_LIFECYCLE.afterPin,
    cleanupPinned: configuration.cleanupPinned ?? PRODUCTION_LIFECYCLE.cleanupPinned,
    signalGroup: configuration.signalGroup ?? PRODUCTION_LIFECYCLE.signalGroup,
    probeGroup: configuration.probeGroup ?? PRODUCTION_LIFECYCLE.probeGroup,
    delay: configuration.delay ?? PRODUCTION_LIFECYCLE.delay,
    monotonicNow: configuration.monotonicNow ?? PRODUCTION_LIFECYCLE.monotonicNow,
    cleanupDeadlineMs,
  }), ["agent", "stdio", ...(configuration.fixtureArgs ?? [])]);
}

/** Owned, independently pinned official process boundary (PC-SEC-001, PC-TRN-001/002/003, D-008). */
export class GrokProcessHost {
  private readonly core: ProcessHostCore;

  constructor(options: GrokProcessHostOptions) {
    const argv = options.runtimeSettings === undefined
      ? GROK_ACP_PRODUCTION_ARGV
      : createGrokAcpProductionArgv(options.runtimeSettings);
    this.core = new ProcessHostCore(options, PRODUCTION_LIFECYCLE, argv);
  }

  get executablePath(): string {
    return this.core.executablePath;
  }

  get expectedSha256(): string {
    return this.core.expectedSha256;
  }

  get state(): HostState {
    return this.core.state;
  }

  onEvent(listener: (event: ProcessHostEvent) => void): () => void {
    return this.core.onEvent(listener);
  }

  start(): Promise<ProcessStartReceipt> {
    return this.core.start();
  }

  waitForTermination(): Promise<ProcessTerminationEvidence> {
    return this.core.waitForTermination();
  }

  write(data: string | Uint8Array): Promise<ProcessWriteReceipt> {
    return this.core.write(data);
  }

  stop(): Promise<ProcessStopReceipt> {
    return this.core.stop();
  }
}

export function buildChildEnvironment(
  baseEnvironment: Readonly<Record<string, string | undefined>> = Object.freeze(Object.create(null) as Record<string, string>),
): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (key.length === 0 || key.includes("\0") || key.includes("=") || (value !== undefined && value.includes("\0"))) {
      throw new TypeError("child environment contains an invalid key or value");
    }
    if (value === undefined || isDeniedEnvironmentKey(key) || !ALLOWED_ENVIRONMENT_KEYS.has(key)) {
      continue;
    }
    result[key] = value;
  }
  const home = homedir();
  if (home.includes("\0")) {
    throw new TypeError("child environment contains an invalid key or value");
  }
  result.HOME = home;
  result.PATH = mergeExecutableSearchPath(result.PATH, home);
  for (const key of DISABLED_EXTERNAL_INSTRUCTION_IMPORTS) {
    result[key] = "false";
  }
  return Object.freeze(result);
}

function mergeExecutableSearchPath(environmentPath: string | undefined, homeDirectory: string): string {
  const directories = [
    environmentPath,
    join(homeDirectory, ".grok", "bin"),
    join(homeDirectory, ".local", "bin"),
    MACOS_FALLBACK_PATH,
  ]
    .flatMap((value) => value?.split(":") ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(directories)].join(":");
}

class BoundedStderrCollector {
  private readonly pendingLine: number[] = [];
  private capturedBytes = 0;
  private droppedBytes = 0;
  private sourceBytes = 0;
  private lineSourceBytes = 0;
  private pendingLineTruncated = false;
  private ended = false;

  constructor(
    private readonly limit: number,
    private readonly redactValues: readonly string[],
    private readonly emitLine: (event: Extract<ProcessHostEvent, { type: "stderr_diagnostic" }>) => void,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.ended) {
      return;
    }
    for (const byte of chunk) {
      this.sourceBytes += 1;
      this.lineSourceBytes += 1;
      if (this.capturedBytes >= this.limit) {
        this.droppedBytes += 1;
        this.pendingLineTruncated = true;
      } else {
        this.capturedBytes += 1;
        this.pendingLine.push(byte);
      }
      if (byte === 0x0a) {
        this.flushLine();
      }
    }
  }

  end(): { readonly capturedBytes: number; readonly droppedBytes: number } {
    if (!this.ended) {
      this.ended = true;
      this.flushLine();
    }
    return { capturedBytes: this.capturedBytes, droppedBytes: this.droppedBytes };
  }

  private flushLine(): void {
    if (this.lineSourceBytes === 0) {
      return;
    }
    const bytes = Uint8Array.from(this.pendingLine);
    const sourceBytes = this.lineSourceBytes;
    this.pendingLine.length = 0;
    this.lineSourceBytes = 0;
    const text = this.pendingLineTruncated
      ? "[TRUNCATED STDERR LINE]"
      : redactDiagnostic(Buffer.from(bytes).toString("utf8"), this.redactValues);
    this.pendingLineTruncated = false;
    this.emitLine({ type: "stderr_diagnostic", text, sourceBytes, capturedBytes: this.capturedBytes, droppedBytes: this.droppedBytes });
  }
}

export function redactDiagnostic(input: string, redactValues: readonly string[] = []): string {
  let redacted = input;
  for (const value of [...redactValues].filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  redacted = redacted.replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/giu, "$1[REDACTED]");
  redacted = redacted.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]");
  redacted = redacted.replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[REDACTED]");
  return redacted.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED]");
}

async function resolveWorkingDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw { type: "preflight_failure", code: "working_directory_not_absolute", message: "working directory must be absolute" };
  }
  try {
    const resolved = await realpath(path);
    if (!(await lstat(resolved)).isDirectory()) {
      throw new Error("not a directory");
    }
    return resolved;
  } catch {
    throw { type: "preflight_failure", code: "preflight_io_failure", message: "working directory must name a directory" };
  }
}

function normalizePreflightFailure(cause: unknown): Extract<ProcessHostFailure, { type: "preflight_failure" }> {
  if (cause instanceof GrokProcessHostError && cause.failure.type === "preflight_failure") {
    return cause.failure;
  }
  if (cause instanceof ExecutablePinError) {
    return { type: "preflight_failure", code: cause.code, message: cause.message };
  }
  if (cause !== null && typeof cause === "object" && (cause as { readonly type?: unknown }).type === "preflight_failure") {
    return cause as Extract<ProcessHostFailure, { type: "preflight_failure" }>;
  }
  return { type: "preflight_failure", code: "preflight_io_failure", message: "executable verification failed" };
}

function spawnFailure(): Extract<ProcessHostFailure, { type: "spawn_failure" }> {
  return { type: "spawn_failure", message: "owned process failed to spawn" };
}

function writeFailure(writeId: number, message: string): Extract<ProcessHostFailure, { type: "write_failure" }> {
  return { type: "write_failure", writeId, message };
}

function isDeniedEnvironmentKey(key: string): boolean {
  return key.startsWith("DYLD_") || key.startsWith("LD_") || ENVIRONMENT_DENYLIST.has(key);
}

function snapshotEnvironment(input: Readonly<Record<string, string | undefined>> | undefined): Readonly<Record<string, string | undefined>> {
  const snapshot = Object.assign(Object.create(null) as Record<string, string | undefined>, input ?? {});
  return Object.freeze(snapshot);
}

function signalGroup(processGroupId: number, signal: "SIGTERM" | "SIGKILL"): ProcessGroupSignalEvidence {
  try {
    process.kill(-processGroupId, signal);
    return { signal, outcome: "sent" };
  } catch (cause) {
    const errorCode = nodeErrorCode(cause);
    return errorCode === "ESRCH"
      ? { signal, outcome: "already_gone", errorCode }
      : { signal, outcome: "failed", errorCode };
  }
}

function probeGroup(processGroupId: number): ProcessGroupProbeEvidence {
  try {
    process.kill(-processGroupId, 0);
    return "present";
  } catch (cause) {
    return nodeErrorCode(cause) === "ESRCH" ? "already_gone" : "failed";
  }
}

function nodeErrorCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === "object"
    ? (cause as { readonly code?: unknown }).code as string | undefined
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function cleanupWithDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<{ readonly type: "completed"; readonly result: T } | { readonly type: "timed_out" }> {
  let resolveDeadline!: (result: { readonly type: "timed_out" }) => void;
  const deadline = new Promise<{ readonly type: "timed_out" }>((resolve) => {
    resolveDeadline = resolve;
  });
  const timer = setTimeout(() => resolveDeadline({ type: "timed_out" }), milliseconds);
  // Cleanup is terminal evidence. A still-pending deadline must keep Node alive.
  timer.ref();
  try {
    return await Promise.race([
      operation.then((result) => ({ type: "completed" as const, result })),
      deadline,
    ]);
  } finally {
    // Fast cleanup must not leave a referenced deadline handle behind.
    clearTimeout(timer);
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function rejectedHandled<T>(error: Error): Promise<T> {
  const promise = Promise.reject<T>(error);
  void promise.catch(() => undefined);
  return promise;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
