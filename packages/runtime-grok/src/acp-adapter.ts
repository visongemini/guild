import { performance } from "node:perf_hooks";
import { types as nodeTypes } from "node:util";
import {
  classifyStopReason,
  freezeRuntimePayload,
  parseGuildGrokContextWindow,
  parseGuildGrokModel,
  parseGuildGrokReasoningEffort,
  type AcpPromptStopReason,
  type GuildGrokModel,
  type GuildGrokReasoningEffort,
  type RuntimePermissionRequestPayload,
  type RuntimePromptTerminalPayload,
  type RuntimeConfigOption,
  type RuntimeReceiveTimestamp,
  type XaiSignalEnvelope,
} from "@guild/contracts";
import {
  decodeAuthenticateResult,
  decodeOfficialBillingResult,
  decodeInitializeResult,
  decodeLoadSessionResult,
  decodeNewSessionResult,
  decodePermissionRequest,
  decodePromptResult,
  decodeResumeSessionResult,
  decodeSessionSelectorResult,
  decodeSetSessionConfigOptionResult,
  decodeSessionUpdate,
  encodeAuthenticateParams,
  encodeBillingParams,
  encodeCancelParams,
  encodeCancelledPermissionResult,
  encodeInitializeParams,
  encodeLoadSessionParams,
  encodeNewSessionParams,
  encodeResumeSessionParams,
  encodeSetSessionConfigOptionParams,
  encodeSetSessionModelParams,
  encodeSelectedPermissionResult,
  encodePromptParams,
  AcpV1CodecError,
  type AcpV1DecodedUpdate,
  type AcpV1InitializeResult,
  type AcpV1OfficialBillingSnapshot,
  type AcpV1PromptResourceLink,
  type AcpV1SessionStartOptions,
  type AcpV1SessionState,
} from "./acp-v1-codec.js";
import { ACP_V1_METHODS } from "./acp-v1-methods.js";
import {
  ACP_AUTH_REQUIRED_CODE,
  CLAUDE_AUTH_STATUS_METHOD,
  CLAUDE_STEERING_METHOD,
  decodeClaudeAuthStatus,
  decodeClaudeSteeringResult,
  encodeClaudeSteeringParams,
  type ClaudeSteerOutcome,
  type EngineSignal,
} from "./claude-dialect.js";
import {
  GROK_ENGINE_PROFILE,
  type EngineFeatureFlags,
  type EngineProfile,
  type RuntimeEngine,
} from "./engine-profile.js";
import {
  JsonRpcPeer,
  JsonRpcRemoteError,
  type JsonRpcDiagnostic,
  type JsonRpcHandlerReply,
  type JsonRpcInboundNotification,
  type JsonRpcInboundRequest,
  type JsonRpcInboundResponseWriteReceipt,
  type JsonRpcParams,
  type JsonRpcRequestHandle,
  type JsonRpcRequestOptions,
  type JsonRpcTerminalFault,
  type JsonRpcTransportFault,
  type JsonRpcWriteReceipt,
} from "./json-rpc-peer.js";
import {
  assertJsonValue,
  isNonArrayObject,
  type JsonObject,
  type JsonValue,
} from "./json-value.js";
import { NdjsonDecoder, NdjsonProtocolError } from "./ndjson.js";
import {
  XAI_EXTENSION_METHOD_PATTERN,
  isMethodNotFound,
  parseXaiNotification,
  parseXaiQueueSnapshot,
  promptIdOfSessionUpdate,
  type XaiExtensionOutcome,
} from "./xai-extensions.js";
import type {
  ProcessHostEvent,
  ProcessStartReceipt,
  ProcessStopReceipt,
  ProcessTerminationEvidence,
  ProcessWriteReceipt,
} from "./process-host.js";

export const ACP_V1_ADAPTER_DEFAULT_TIMEOUTS = Object.freeze({
  authenticateMs: 30_000,
  initializeMs: 30_000,
  sessionMs: 30_000,
  writeMs: 10_000,
});

export type AcpV1AdapterTimeouts = {
  readonly authenticateMs?: number;
  readonly initializeMs?: number;
  readonly sessionMs?: number;
  readonly writeMs?: number;
};

export type AcpV1AdapterErrorCode =
  | "adapter_closed"
  | "adapter_not_initialized"
  | "auth_required"
  | "capability_not_advertised"
  | "config_option_refused"
  | "extension_request_failed"
  | "invalid_adapter_options"
  | "invalid_permission_decision"
  | "operation_failed"
  | "overlapping_prompt"
  | "protocol_fault"
  | "sink_commit_failed"
  | "stale_session_identity"
  | "transport_lost"
  | "unsupported_for_engine";

export class AcpV1AdapterError extends Error {
  readonly code: AcpV1AdapterErrorCode;

  constructor(code: AcpV1AdapterErrorCode) {
    super(`ACP v1 adapter ${code}`);
    this.name = "AcpV1AdapterError";
    this.code = code;
  }
}

/** Why the runtime refused `session/set_config_option` (JSON-RPC error response, not a transport fault). */
export type AcpV1ConfigRefusalReason = "incompatible_agent" | "invalid_value" | "other";

/**
 * The runtime answered `session/set_config_option` with an error: the option, the value, or the
 * switch itself was refused (for example `MODEL_SWITCH_INCOMPATIBLE_AGENT` after the first turn).
 * The adapter and the session stay healthy and keep their previous selection.
 */
export class AcpV1ConfigOptionRefusedError extends AcpV1AdapterError {
  readonly reason: AcpV1ConfigRefusalReason;
  readonly remoteCode: number;

  constructor(reason: AcpV1ConfigRefusalReason, remoteCode: number) {
    super("config_option_refused");
    this.name = "AcpV1ConfigOptionRefusedError";
    this.reason = reason;
    this.remoteCode = remoteCode;
  }
}

/** An `_x.ai/*` extension request failed with an error response other than -32601. */
export class AcpV1ExtensionRequestError extends AcpV1AdapterError {
  readonly remoteCode: number;

  constructor(remoteCode: number) {
    super("extension_request_failed");
    this.name = "AcpV1ExtensionRequestError";
    this.remoteCode = remoteCode;
  }
}

export type AcpV1ProcessPort = {
  readonly onEvent: (listener: (event: ProcessHostEvent) => void) => () => void;
  readonly start: () => Promise<ProcessStartReceipt | unknown>;
  readonly stop: () => Promise<ProcessStopReceipt | unknown>;
  readonly waitForTermination: () => Promise<ProcessTerminationEvidence | unknown>;
  readonly write: (data: string | Uint8Array) => Promise<ProcessWriteReceipt | unknown>;
};

export type AcpV1PeerPort = {
  readonly close: (reason?: string) => boolean;
  readonly failTransport: (fault: JsonRpcTransportFault) => boolean;
  readonly onDiagnostic: (listener: (diagnostic: JsonRpcDiagnostic) => void) => () => void;
  readonly onInboundResponseWrite: (
    listener: (receipt: JsonRpcInboundResponseWriteReceipt) => void,
  ) => () => void;
  readonly receive: (input: unknown) => Promise<void>;
  readonly sendNotification: (
    method: string,
    params?: JsonRpcParams,
    options?: { readonly writeTimeoutMs?: number },
  ) => Promise<JsonRpcWriteReceipt>;
  readonly sendRequest: (
    method: string,
    params?: JsonRpcParams,
    options?: JsonRpcRequestOptions,
  ) => JsonRpcRequestHandle;
  readonly setNotificationHandler: (
    handler: ((notification: JsonRpcInboundNotification) => void | Promise<void>) | undefined,
  ) => () => void;
  readonly setRequestHandler: (
    handler: ((request: JsonRpcInboundRequest) =>
      JsonRpcHandlerReply | Promise<JsonRpcHandlerReply>) | undefined,
  ) => () => void;
};

export type AcpV1AdapterSessionIdentity = {
  readonly adapterEpoch: number;
  readonly sessionId: string;
};

export type AcpV1AdapterPromptIdentity = AcpV1AdapterSessionIdentity & {
  readonly promptSequence: number;
};

export type AcpV1AdapterSession = AcpV1AdapterSessionIdentity &
  AcpV1SessionState & {
    readonly establishedBy: "new" | "resume" | "load";
  };

export type AcpV1PermissionDecision =
  | { readonly type: "cancelled" }
  | { readonly type: "selected"; readonly optionId: string };

export type AcpV1PermissionDeliveryCorrelation = {
  readonly commandId: string;
  readonly version: number;
  readonly deliveryAttemptId: string;
};

export type AcpV1PreparedPermissionResponse = {
  readonly decision: AcpV1PermissionDecision;
  readonly delivery: AcpV1PermissionDeliveryCorrelation;
};

export type AcpV1ReplayBarrier = {
  readonly barrierId: string;
};

export type AcpV1AdapterSink = {
  /** Durable SessionBinding commit. A session handle is not returned before this settles. */
  readonly commitSessionEstablished: (event: {
    readonly identity: AcpV1AdapterSessionIdentity;
    readonly establishedBy: "new" | "resume";
    readonly state: AcpV1SessionState;
  }) => Promise<void>;
  /** Durable Run acceptance. Turn data remains gated until this settles. */
  readonly commitPromptAccepted: (event: {
    readonly identity: AcpV1AdapterPromptIdentity;
    readonly write: JsonRpcWriteReceipt;
  }) => Promise<void>;
  readonly commitUpdate: (event: {
    readonly identity: AcpV1AdapterSessionIdentity;
    readonly ingestMode: "live" | "replay";
    readonly promptSequence?: number;
    readonly update: AcpV1DecodedUpdate;
  }) => Promise<void>;
  /**
   * Ephemeral worker/reviewer activity multiplexed by the official Grok process.
   * The update is deliberately kept outside the bound conversation: consumers may
   * project activity, but must not persist authored child-session content as root output.
   */
  readonly commitAuxiliaryUpdate: (event: {
    readonly identity: AcpV1AdapterSessionIdentity;
    readonly auxiliarySessionId: string;
    readonly update: Extract<AcpV1DecodedUpdate, { readonly type: "turn" }>;
  }) => Promise<void>;
  /**
   * Ephemeral, allowlisted `_x.ai/*` signal (queue, hooks, retry, setup progress, model list ...).
   * Display state only: never awaited, never persisted, and a throw is swallowed so it can never
   * affect delivery. Signals for sessions the adapter does not own are delivered with that id.
   */
  readonly observeSignal?: (envelope: XaiSignalEnvelope) => void;
  /**
   * Ephemeral engine signals that are not `_x.ai/*` (the Claude account summary, dropped late
   * frames). Same contract as `observeSignal`: display and diagnostics only, a throw is swallowed.
   */
  readonly observeEngineSignal?: (signal: EngineSignal) => void;
  /**
   * First-frame transaction: durably register the exact callback request, apply the decision, and
   * claim its outbox command before resolving. The adapter writes no response byte before this.
   */
  readonly preparePermissionResponse: (event: {
    readonly identity: AcpV1AdapterPromptIdentity;
    readonly request: RuntimePermissionRequestPayload;
    /** On pre-decision cancellation, stop durably and reject with this signal's exact reason. */
    readonly signal: AbortSignal;
  }) => Promise<AcpV1PreparedPermissionResponse>;
  /** Called only after the exact JSON-RPC callback response writer completes locally. */
  readonly commitPermissionResponseFlushed: (event: {
    readonly identity: AcpV1AdapterPromptIdentity;
    readonly request: RuntimePermissionRequestPayload;
    readonly decision: AcpV1PermissionDecision;
    readonly delivery: AcpV1PermissionDeliveryCorrelation;
    readonly write: JsonRpcInboundResponseWriteReceipt;
  }) => Promise<void>;
  readonly commitPromptTerminal: (event: {
    readonly identity: AcpV1AdapterPromptIdentity;
    readonly terminal: RuntimePromptTerminalPayload;
  }) => Promise<void>;
  /**
   * The runtime started a turn Guild did not send (for example the `interject-fallback-*` prompt it
   * makes from a Steer that missed its turn): its first turn frame arrived while no prompt of Guild's
   * was active. Resolve to attach the turn to a Run; the turn's frames then arrive through
   * `commitUpdate` with the allocated prompt sequence and it ends through `commitPromptTerminal`.
   * Reject to decline it: the adapter then drops the turn's frames and answers its permission
   * requests with a cancellation, and the transport stays healthy. Without this hook an unexpected
   * turn frame is a protocol fault, as before.
   */
  readonly commitAgentTurnStarted?: (event: {
    readonly identity: AcpV1AdapterPromptIdentity;
    /** The runtime's own id for the turn, from the frames' `_meta.promptId`. */
    readonly agentPromptId?: string;
    /** The user message the turn runs, from `_x.ai/queue/changed`; never logged by the adapter. */
    readonly promptText?: string;
  }) => Promise<void>;
  readonly commitCancelSent: (event: {
    readonly identity: AcpV1AdapterPromptIdentity;
    readonly write: JsonRpcWriteReceipt;
  }) => Promise<void>;
  readonly commitTransportInterrupted: (event: {
    readonly identity: AcpV1AdapterSessionIdentity;
    readonly activePromptSequence?: number;
    readonly reason: AcpV1AdapterInterruptionReason;
    readonly diagnostic?: AcpV1AdapterInterruptionDiagnostic;
  }) => Promise<void>;
  /** Opens and durably records a load replay barrier before session/load is written. */
  readonly beginReplayBarrier: (event: {
    readonly identity: AcpV1AdapterSessionIdentity;
  }) => Promise<AcpV1ReplayBarrier>;
  /** Closes the barrier only after all preceding replay updates have durably flushed. */
  readonly commitReplayBarrier: (event: {
    readonly identity: AcpV1AdapterSessionIdentity;
    readonly barrier: AcpV1ReplayBarrier;
    readonly state: AcpV1SessionState;
  }) => Promise<void>;
  readonly abortReplayBarrier: (event: {
    readonly identity: AcpV1AdapterSessionIdentity;
    readonly barrier: AcpV1ReplayBarrier;
  }) => Promise<void>;
};

export type AcpV1AdapterInterruptionReason =
  | "decoder_fault"
  | "explicit_close"
  | "peer_fault"
  | "process_fault"
  | "protocol_fault"
  | "sink_fault"
  | "stdout_eof"
  | "write_fault";

export type AcpV1AdapterInterruptionDiagnostic = Readonly<{
  processId?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  faultCode?: string;
  faultPath?: string;
  faultStage?: string;
  updateKind?: string;
  stderrTail: readonly string[];
  stderrCapturedBytes: number;
  stderrDroppedBytes: number;
}>;

type AcpV1AdapterFaultDiagnostic = Pick<
  AcpV1AdapterInterruptionDiagnostic,
  "faultCode" | "faultPath" | "faultStage" | "updateKind"
>;

export type AcpV1AdapterClock = {
  readonly monotonicMs: () => number;
  readonly wallClockIso: () => string;
};

export type AcpV1AdapterOptions = {
  readonly adapterEpoch: number;
  readonly clock?: AcpV1AdapterClock;
  /** Selects dialect, auth policy and features (PC-ENG-001). Defaults to the Grok profile. */
  readonly profile?: EngineProfile;
  readonly peerFactory?: (write: (frame: string, signal: AbortSignal) => Promise<void>) => AcpV1PeerPort;
  readonly process: AcpV1ProcessPort;
  readonly sink: AcpV1AdapterSink;
  readonly timeouts?: AcpV1AdapterTimeouts;
};

type AdapterState = "created" | "starting" | "ready" | "faulted" | "closed";

/** Not an ACP method: Grok rejects it with "method not found", which is all a liveness probe needs. */
const LIVENESS_PROBE_METHOD = "_guild/ping";
const UNSUPPORTED_EXTENSION = Object.freeze({ status: "unsupported" } as const);
const UNSUPPORTED_FOR_ENGINE = Object.freeze({ status: "unsupported", reason: "engine" } as const);
const NOT_FOUND_STEER = Object.freeze({ status: "unsupported", reason: "not_found" } as const);

/** Result of `AcpV1Adapter.steer` (the Claude `_session/steering` request). */
export type AcpV1SteerResult =
  | Readonly<{ status: "ok"; outcome: ClaudeSteerOutcome }>
  /** `engine`: no request sent, the engine has no such feature. `not_found`: the agent answered -32601. */
  | Readonly<{ status: "unsupported"; reason: "engine" | "not_found" }>;
type SessionPhase = "committing" | "ready" | "replaying" | "barrier_committing";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
};

type ActivePrompt = {
  readonly acceptance: Deferred<void>;
  /** The JSON-RPC request of a prompt Guild sent; absent for a turn the runtime started itself. */
  readonly handle: JsonRpcRequestHandle | undefined;
  readonly origin: "client" | "agent";
  readonly identity: AcpV1AdapterPromptIdentity;
  cancelOperation: Promise<JsonRpcWriteReceipt> | undefined;
  readonly permissionControllers: Set<AbortController>;
  /** Settles when the prompt's terminal commit finished or the adapter failed. */
  readonly settled: Deferred<void>;
  /** The runtime's id for an agent-started turn, when its frames named one. */
  readonly agentPromptId: string | undefined;
  /** An agent-started turn the sink declined: its frames are dropped. */
  discarded: boolean;
  responseProven: boolean;
  terminalCommitted: boolean;
};

/** Queue text the runtime announced, kept in memory only to name an agent-started turn. */
type QueuedPromptTexts = {
  runningPromptId: string | undefined;
  runningText: string | undefined;
  readonly byId: Map<string, string>;
};
const MAX_TRACKED_QUEUE_SESSIONS = 16;
const MAX_TRACKED_QUEUE_TEXTS = 64;

type SessionTransport = {
  readonly identity: AcpV1AdapterSessionIdentity;
  readonly ready: Deferred<void>;
  readonly publicSession: AcpV1AdapterSession;
  activePrompt: ActivePrompt | undefined;
  readonly permissionOperations: Set<Promise<unknown>>;
  phase: SessionPhase;
  sinkTail: Promise<void>;
  updateTail: Promise<void>;
};

type PermissionPreparationOutcome =
  | { readonly type: "abandoned" }
  | {
      readonly type: "prepared";
      readonly response: AcpV1PreparedPermissionResponse;
    };

type PendingNewSession = {
  sessionId: string | undefined;
  readonly updates: AcpV1DecodedUpdate[];
};

type PendingPermissionFlush = {
  readonly active: ActivePrompt;
  abandonRequested: boolean;
  readonly controller: AbortController;
  deliveryOperation: Promise<void> | undefined;
  readonly identity: AcpV1AdapterPromptIdentity;
  readonly prepared: Deferred<PermissionPreparationOutcome>;
  readonly receipt: Deferred<JsonRpcInboundResponseWriteReceipt>;
  readonly session: SessionTransport;
  preparedResolved: boolean;
  writeReceived: boolean;
};

type AdapterTimeouts = Required<AcpV1AdapterTimeouts>;

const DEFAULT_CLOCK: AcpV1AdapterClock = Object.freeze({
  monotonicMs: () => performance.now(),
  wallClockIso: () => new Date().toISOString(),
});

const PERMISSION_PREPARATION_ABANDONED = Object.freeze(
  new Error("ACP v1 permission preparation abandoned"),
);
const PERMISSION_NO_RESPONSE = Object.freeze({
  type: "no_response",
  reason: "abandoned",
} as const);

/**
 * ACP v1 transport orchestrator. Domain state remains behind `sink`; local maps contain only
 * process-epoch correlation and in-flight delivery gates.
 */
export class AcpV1Adapter {
  private readonly adapterEpoch: number;
  readonly profile: EngineProfile;
  private readonly clock: AcpV1AdapterClock;
  private readonly decoder = new NdjsonDecoder();
  private readonly peer: AcpV1PeerPort;
  private readonly process: AcpV1ProcessPort;
  private readonly sink: AcpV1AdapterSink;
  private readonly timeouts: AdapterTimeouts;
  private readonly sessions = new Map<string, SessionTransport>();
  private readonly sessionProvenance = new WeakMap<object, SessionTransport>();
  private readonly pendingPermissionFlushes = new Map<string, PendingPermissionFlush>();
  private readonly unboundPermissionResponses = new Set<string>();
  private readonly responseAdmissions = new Map<number, Promise<void>>();
  private readonly removeListeners: (() => void)[] = [];
  private currentState: AdapterState = "created";
  private initializeOperation: Promise<AcpV1InitializeResult> | undefined;
  private initializeResult: AcpV1InitializeResult | undefined;
  private pendingNewSession: PendingNewSession | undefined;
  private promptSequence = 0;
  private pumpTail: Promise<void> = Promise.resolve();
  private faultQueued = false;
  private interruptionOperation: Promise<void> = Promise.resolve();
  private processId: number | undefined;
  private processExitCode: number | null | undefined;
  private processSignal: NodeJS.Signals | null | undefined;
  private stderrCapturedBytes = 0;
  private stderrDroppedBytes = 0;
  private readonly stderrTail: string[] = [];
  private readonly auxiliaryUpdateTails = new Map<string, Promise<void>>();
  private readonly unsupportedExtensions = new Set<string>();
  private readonly queuedPromptTexts = new Map<string, QueuedPromptTexts>();

  constructor(options: AcpV1AdapterOptions) {
    this.adapterEpoch = positiveSafeInteger(options.adapterEpoch, "adapterEpoch");
    this.profile = options.profile ?? GROK_ENGINE_PROFILE;
    this.timeouts = Object.freeze({
      authenticateMs: positiveSafeInteger(
        options.timeouts?.authenticateMs ?? ACP_V1_ADAPTER_DEFAULT_TIMEOUTS.authenticateMs,
        "authenticateMs",
      ),
      initializeMs: positiveSafeInteger(
        options.timeouts?.initializeMs ?? ACP_V1_ADAPTER_DEFAULT_TIMEOUTS.initializeMs,
        "initializeMs",
      ),
      sessionMs: positiveSafeInteger(
        options.timeouts?.sessionMs ?? ACP_V1_ADAPTER_DEFAULT_TIMEOUTS.sessionMs,
        "sessionMs",
      ),
      writeMs: positiveSafeInteger(
        options.timeouts?.writeMs ?? ACP_V1_ADAPTER_DEFAULT_TIMEOUTS.writeMs,
        "writeMs",
      ),
    });
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.process = options.process;
    this.sink = options.sink;
    const writer = async (frame: string, _signal: AbortSignal): Promise<void> => {
      await this.process.write(frame);
    };
    this.peer = options.peerFactory?.(writer) ?? new JsonRpcPeer({
      requestTimeoutMs: this.timeouts.sessionMs,
      writeTimeoutMs: this.timeouts.writeMs,
      write: writer,
    });

    // Subscribe before start: immediate process exit must not escape the epoch boundary.
    this.removeListeners.push(
      this.process.onEvent((event) => this.onProcessEvent(event)),
      this.peer.onDiagnostic((diagnostic) => this.onPeerDiagnostic(diagnostic)),
      this.peer.onInboundResponseWrite((receipt) => this.onInboundResponseWrite(receipt)),
      this.peer.setNotificationHandler((notification) => this.onNotification(notification)),
      this.peer.setRequestHandler((request) => this.onRequest(request)),
    );
  }

  get state(): AdapterState {
    return this.currentState;
  }

  get engine(): RuntimeEngine {
    return this.profile.engine;
  }

  /**
   * The features available through this adapter. For Claude, Steer additionally needs the agent to
   * have advertised `_meta.steering.supported` at initialize, so it reads false before then.
   */
  get features(): EngineFeatureFlags {
    const base = this.profile.features;
    if (this.profile.dialect !== "claude") return base;
    return Object.freeze({ ...base, steer: base.steer && this.initializeResult?.steering?.supported === true });
  }

  /** Settles after interruption sink commits triggered so far have settled. */
  get interrupted(): Promise<void> {
    return this.interruptionOperation;
  }

  start(): Promise<AcpV1InitializeResult> {
    if (this.initializeOperation !== undefined) {
      return this.initializeOperation;
    }
    if (this.currentState !== "created") {
      return Promise.reject(this.stateError());
    }
    this.currentState = "starting";
    this.initializeOperation = this.startAndInitialize();
    void this.initializeOperation.catch(() => undefined);
    return this.initializeOperation;
  }

  async authenticate(methodId: string): Promise<void> {
    // Claude: the user's own login is used as is; the adapter's gateway/provider auth would bypass it.
    if (this.profile.authPolicy === "never") {
      throw new AcpV1AdapterError("unsupported_for_engine");
    }
    const initialized = this.requireInitialized();
    try {
      await this.request(
        ACP_V1_METHODS.authenticate,
        encodeAuthenticateParams(initialized, methodId),
        this.timeouts.authenticateMs,
        (response) => this.decodeProtocol(() => decodeAuthenticateResult(response)),
      );
    } catch (cause: unknown) {
      throw this.normalizeOperationFailure(cause);
    }
  }

  async officialBilling(): Promise<AcpV1OfficialBillingSnapshot> {
    if (!this.profile.features.billing) {
      throw new AcpV1AdapterError("unsupported_for_engine");
    }
    this.requireInitialized();
    try {
      return await this.request(
        ACP_V1_METHODS.officialBilling,
        encodeBillingParams(),
        this.timeouts.sessionMs,
        (response) => this.decodeProtocol(() => decodeOfficialBillingResult(response)),
      );
    } catch (cause: unknown) {
      throw this.normalizeOperationFailure(cause);
    }
  }

  /**
   * Local liveness probe: one JSON-RPC round trip that touches no session and no upstream
   * service. The official runtime answers an unknown extension method with an error response,
   * which proves it is still reading and writing stdio. A timeout or dead transport yields
   * `false`; the probe never faults or closes the adapter itself.
   */
  async probeLiveness(timeoutMs: number): Promise<boolean> {
    if (this.currentState !== "ready") return false;
    try {
      const handle = this.peer.sendRequest(LIVENESS_PROBE_METHOD, {}, {
        responseTimeoutMs: timeoutMs,
        writeTimeoutMs: timeoutMs,
      });
      await handle.write;
      await handle.response;
      return true;
    } catch (cause: unknown) {
      return cause instanceof JsonRpcRemoteError;
    }
  }

  /**
   * `session/set_model` is kept only for what `session/set_config_option` cannot express: the
   * context window. Model and reasoning effort changes use `setConfigOption`.
   */
  async setModel(
    session: AcpV1AdapterSession,
    model: GuildGrokModel,
    options?: { readonly reasoningEffort?: GuildGrokReasoningEffort; readonly contextWindow?: number },
  ): Promise<void> {
    if (this.profile.dialect !== "grok") {
      throw new AcpV1AdapterError("unsupported_for_engine");
    }
    this.assertReady();
    const transport = this.requireSession(session);
    if (transport.activePrompt !== undefined) {
      throw new AcpV1AdapterError("overlapping_prompt");
    }
    const exactModel = parseGuildGrokModel(model);
    const meta = {
      ...(options?.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: parseGuildGrokReasoningEffort(options.reasoningEffort) }),
      ...(options?.contextWindow === undefined
        ? {}
        : { contextWindow: parseGuildGrokContextWindow(options.contextWindow) }),
    };
    try {
      await this.request(
        ACP_V1_METHODS.sessionSetModel,
        encodeSetSessionModelParams(transport.identity.sessionId, exactModel, meta),
        this.timeouts.sessionMs,
        (response) => this.decodeProtocol(() => decodeSessionSelectorResult(response)),
      );
    } catch (cause: unknown) {
      throw this.normalizeOperationFailure(cause);
    }
  }

  /**
   * Applies one official session config option (model, reasoning effort ...). Must not run during
   * a turn. A runtime refusal (-32602 and friends) rejects with `AcpV1ConfigOptionRefusedError`
   * and leaves the session on its previous selection.
   */
  async setConfigOption(
    session: AcpV1AdapterSession,
    configId: string,
    value: string | boolean,
  ): Promise<readonly RuntimeConfigOption[]> {
    this.assertReady();
    const transport = this.requireSession(session);
    if (transport.activePrompt !== undefined) {
      throw new AcpV1AdapterError("overlapping_prompt");
    }
    try {
      const options = await this.request(
        ACP_V1_METHODS.sessionSetConfigOption,
        encodeSetSessionConfigOptionParams(transport.identity.sessionId, configId, value),
        this.timeouts.sessionMs,
        (response) => this.decodeProtocol(() => decodeSetSessionConfigOptionResult(response)),
      );
      // The runtime also pushes a `config_option_update` snapshot for every change. Updates are
      // committed asynchronously, so one from an earlier change could land after this response
      // and overwrite the newer options. Draining them first makes the returned options the last
      // word the caller applies.
      await transport.updateTail.catch(() => undefined);
      return options;
    } catch (cause: unknown) {
      if (cause instanceof JsonRpcRemoteError) {
        throw new AcpV1ConfigOptionRefusedError(
          classifyConfigRefusal(cause),
          cause.response.code,
        );
      }
      throw this.normalizeOperationFailure(cause);
    }
  }

  /**
   * Sends one `_x.ai/*` extension request. Extensions are not advertised, so the first call per
   * process is the probe: -32601 resolves to `{ status: "unsupported" }` (remembered for the
   * life of this adapter, so an unsupported extension costs one round trip). Any other error
   * response rejects with `AcpV1ExtensionRequestError`; transport faults reject as usual. The
   * result is returned as plain JSON for the caller to validate against its own bounded schema.
   */
  async sendExtensionRequest(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number },
  ): Promise<XaiExtensionOutcome<JsonValue>> {
    this.assertReady();
    if (!XAI_EXTENSION_METHOD_PATTERN.test(method)) {
      throw new AcpV1AdapterError("invalid_adapter_options");
    }
    // `_x.ai/*` is the Grok runtime's namespace: another engine is never asked.
    if (this.profile.dialect !== "grok") {
      return UNSUPPORTED_FOR_ENGINE;
    }
    if (this.unsupportedExtensions.has(method)) {
      return UNSUPPORTED_EXTENSION;
    }
    try {
      const result = await this.request(
        method,
        params,
        options?.timeoutMs ?? this.timeouts.sessionMs,
        (response) => response,
      );
      return Object.freeze({ status: "ok" as const, result });
    } catch (cause: unknown) {
      if (isMethodNotFound(cause)) {
        this.unsupportedExtensions.add(method);
        return UNSUPPORTED_EXTENSION;
      }
      if (cause instanceof JsonRpcRemoteError) {
        throw new AcpV1ExtensionRequestError(cause.response.code);
      }
      throw this.normalizeOperationFailure(cause);
    }
  }

  /**
   * Claude Steer (`_session/steering`): injects `text` into the running turn. Asked with
   * `idleBehavior: "promptRequired"`, so when no turn is running the agent sends nothing and
   * answers `promptRequired`: the caller then sends the text as an ordinary prompt. Engines
   * without this request (Grok uses `_x.ai/interject` through `sendExtensionRequest`) and agents
   * that did not advertise `_meta.steering.supported` answer `unsupported` without a wire call; a
   * -32601 from the agent is remembered for the life of this adapter.
   */
  async steer(
    session: AcpV1AdapterSession,
    text: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<AcpV1SteerResult> {
    this.assertReady();
    const transport = this.requireSession(session);
    if (typeof text !== "string" || text.length === 0) {
      throw new AcpV1AdapterError("invalid_adapter_options");
    }
    if (transport.phase !== "ready") {
      throw new AcpV1AdapterError("stale_session_identity");
    }
    if (!this.features.steer || this.profile.dialect !== "claude") {
      return UNSUPPORTED_FOR_ENGINE;
    }
    if (this.unsupportedExtensions.has(CLAUDE_STEERING_METHOD)) {
      return NOT_FOUND_STEER;
    }
    try {
      const response = await this.request(
        CLAUDE_STEERING_METHOD,
        encodeClaudeSteeringParams(transport.identity.sessionId, text),
        options?.timeoutMs ?? this.timeouts.sessionMs,
        (result) => result,
      );
      const outcome = decodeClaudeSteeringResult(response);
      if (outcome === undefined) {
        // An outcome this client does not know is a refused steer, not a broken transport.
        throw new AcpV1AdapterError("operation_failed");
      }
      return Object.freeze({ status: "ok" as const, outcome });
    } catch (cause: unknown) {
      if (isMethodNotFound(cause)) {
        this.unsupportedExtensions.add(CLAUDE_STEERING_METHOD);
        return NOT_FOUND_STEER;
      }
      if (cause instanceof JsonRpcRemoteError) {
        throw new AcpV1ExtensionRequestError(cause.response.code);
      }
      throw this.normalizeOperationFailure(cause);
    }
  }

  /**
   * Claude applies the permission mode as the `mode` config option after the session starts (no
   * argv, no restart). Grok takes its permission mode on the command line.
   */
  async setPermissionMode(
    session: AcpV1AdapterSession,
    mode: string,
  ): Promise<readonly RuntimeConfigOption[]> {
    if (this.profile.dialect !== "claude") {
      throw new AcpV1AdapterError("unsupported_for_engine");
    }
    const configId = session.configOptions?.find((option) => option.category === "mode")?.id ?? "mode";
    return this.setConfigOption(session, configId, mode);
  }

  async newSession(
    cwd: string,
    startOptions?: AcpV1SessionStartOptions,
  ): Promise<AcpV1AdapterSession> {
    this.assertSessionStartOptions(this.requireInitialized(), startOptions);
    if (this.pendingNewSession !== undefined) {
      throw new AcpV1AdapterError("operation_failed");
    }
    this.pendingNewSession = { sessionId: undefined, updates: [] };
    try {
      const established = await this.request(
        ACP_V1_METHODS.sessionNew,
        encodeNewSessionParams(cwd, startOptions, this.profile.dialect),
        this.timeouts.sessionMs,
        (response) => {
          const decoded = this.decodeProtocol(() => decodeNewSessionResult(response, this.profile.dialect));
          const state = sessionStateFromNew(decoded);
          if (this.sessions.has(decoded.sessionId)) {
            this.fail(
              "protocol_fault",
              { type: "explicit_close", reason: "duplicate ACP session ID" },
              true,
            );
            throw new AcpV1AdapterError("protocol_fault");
          }
          const pending = this.pendingNewSession;
          if (
            pending === undefined ||
            (pending.sessionId !== undefined && pending.sessionId !== decoded.sessionId)
          ) {
            this.fail(
              "protocol_fault",
              { type: "explicit_close", reason: "early ACP session update identity mismatch" },
              true,
            );
            throw new AcpV1AdapterError("protocol_fault");
          }
          this.pendingNewSession = undefined;
          const session = this.createSession(decoded.sessionId, "new", state, "committing");
          for (const update of pending.updates) {
            void this.routeUpdate(session, update).catch((cause: unknown) => {
              if (this.currentState === "ready") {
                this.fail(
                  isSinkLikeFailure(cause) ? "sink_fault" : "protocol_fault",
                  { type: "explicit_close", reason: "early ACP session update failed" },
                  true,
                );
              }
            });
          }
          return {
            state,
            session,
          };
        },
      );
      await this.commitSessionEstablished(established.session, "new", established.state);
      return established.session.publicSession;
    } catch (cause: unknown) {
      this.pendingNewSession = undefined;
      throw this.normalizeOperationFailure(cause);
    }
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    startOptions?: AcpV1SessionStartOptions,
  ): Promise<AcpV1AdapterSession> {
    const initialized = this.requireInitialized();
    if (!initialized.agentCapabilities.resumeSession) {
      throw new AcpV1AdapterError("capability_not_advertised");
    }
    this.assertSessionStartOptions(initialized, startOptions);
    const identity = sessionIdentity(this.adapterEpoch, sessionId);
    this.assertSessionIdAvailable(identity.sessionId);
    const provisional = this.createSession(identity.sessionId, "resume", {}, "committing");
    try {
      const decoded = await this.request(
        ACP_V1_METHODS.sessionResume,
        encodeResumeSessionParams(identity.sessionId, cwd, startOptions, this.profile.dialect),
        this.timeouts.sessionMs,
        (response) => {
          const state = this.decodeProtocol(() => decodeResumeSessionResult(response, this.profile.dialect));
          this.replacePublicSession(provisional, "resume", state);
          return state;
        },
      );
      await this.commitSessionEstablished(provisional, "resume", decoded);
      return provisional.publicSession;
    } catch (cause: unknown) {
      this.removeProvisionalSession(provisional);
      throw this.normalizeOperationFailure(cause);
    }
  }

  async loadSession(sessionId: string, cwd: string): Promise<AcpV1AdapterSession> {
    const initialized = this.requireInitialized();
    if (!initialized.agentCapabilities.loadSession) {
      throw new AcpV1AdapterError("capability_not_advertised");
    }
    const identity = sessionIdentity(this.adapterEpoch, sessionId);
    this.assertSessionIdAvailable(identity.sessionId);
    let barrier: AcpV1ReplayBarrier;
    try {
      barrier = canonicalReplayBarrier(
        await this.commitSink(() => this.sink.beginReplayBarrier(freeze({ identity }))),
      );
    } catch (cause: unknown) {
      this.fail("sink_fault", undefined, true);
      throw this.normalizeOperationFailure(cause);
    }

    const provisional = this.createSession(identity.sessionId, "load", {}, "replaying");
    let barrierCommitted = false;
    try {
      const decoded = await this.request(
        ACP_V1_METHODS.sessionLoad,
        encodeLoadSessionParams(identity.sessionId, cwd),
        this.timeouts.sessionMs,
        (response) => {
          const state = this.decodeProtocol(() => decodeLoadSessionResult(response, this.profile.dialect));
          this.replacePublicSession(provisional, "load", state);
          provisional.phase = "barrier_committing";
          return state;
        },
      );
      const updatesBeforeBarrier = provisional.updateTail;
      const commit = this.enqueueSink(provisional, async () => {
        await updatesBeforeBarrier;
        this.assertReady();
        await this.commitSink(() =>
          this.sink.commitReplayBarrier(
            freeze({ identity: provisional.identity, barrier, state: decoded }),
          ),
        );
      });
      await commit;
      barrierCommitted = true;
      this.assertReady();
      provisional.phase = "ready";
      provisional.ready.resolve();
      return provisional.publicSession;
    } catch (cause: unknown) {
      this.removeProvisionalSession(provisional);
      if (isSinkLikeFailure(cause)) {
        this.fail("sink_fault", undefined, true);
      }
      if (!barrierCommitted) {
        await Promise.allSettled([provisional.updateTail, provisional.sinkTail]);
        try {
          await this.commitSink(() =>
            this.sink.abortReplayBarrier(freeze({ identity, barrier })),
          );
        } catch {
          this.fail("sink_fault", undefined, true);
        }
      }
      throw this.normalizeOperationFailure(cause);
    }
  }

  async prompt(
    session: AcpV1AdapterSession,
    text: string,
    resources: readonly AcpV1PromptResourceLink[] = [],
  ): Promise<RuntimePromptTerminalPayload> {
    this.assertReady();
    const initialized = this.requireInitialized();
    if (resources.length > 0 && !initialized.agentCapabilities.prompt.embeddedContext) {
      throw new AcpV1AdapterError("capability_not_advertised");
    }
    const transport = this.requireSession(session);
    if (transport.phase !== "ready") {
      throw new AcpV1AdapterError("stale_session_identity");
    }
    if (transport.activePrompt !== undefined) {
      throw new AcpV1AdapterError("overlapping_prompt");
    }
    if (!Number.isSafeInteger(this.promptSequence + 1)) {
      throw new AcpV1AdapterError("operation_failed");
    }
    this.promptSequence += 1;
    const identity = freeze({
      ...transport.identity,
      promptSequence: this.promptSequence,
    });
    let handle: JsonRpcRequestHandle;
    try {
      handle = this.peer.sendRequest(
        ACP_V1_METHODS.sessionPrompt,
        jsonParams(encodePromptParams(transport.identity.sessionId, text, resources)),
        { responseTimeoutMs: null, writeTimeoutMs: this.timeouts.writeMs },
      );
    } catch (cause: unknown) {
      throw this.normalizeOperationFailure(cause);
    }
    const active: ActivePrompt = {
      acceptance: deferred<void>(),
      handle,
      origin: "client",
      identity,
      cancelOperation: undefined,
      permissionControllers: new Set(),
      settled: deferred<void>(),
      agentPromptId: undefined,
      discarded: false,
      responseProven: false,
      terminalCommitted: false,
    };
    void active.acceptance.promise.catch(() => undefined);
    transport.activePrompt = active;
    const responseAdmission = deferred<void>();
    this.responseAdmissions.set(handle.id, responseAdmission.promise);
    let responseAdmitted = false;

    try {
      const write = await handle.write;
      await this.enqueueSink(transport, () => this.commitSink(() =>
        this.sink.commitPromptAccepted(freeze({ identity, write })),
      ));
      this.assertSamePrompt(transport, active);
      active.acceptance.resolve();

      const response = await handle.response;
      const terminal = this.decodeProtocol(() => decodePromptResult(
        response,
        transport.identity.sessionId,
        this.receiveTimestamp(),
      ));
      active.responseProven = true;
      this.abandonPendingPermissionPreparations(active);
      const updatesBeforeTerminal = transport.updateTail;
      const terminalCommit = this.enqueueSink(transport, async () => {
        await updatesBeforeTerminal;
        await this.commitSink(() =>
          this.sink.commitPromptTerminal(freeze({ identity, terminal })),
        );
      });
      responseAdmission.resolve();
      this.responseAdmissions.delete(handle.id);
      responseAdmitted = true;
      await terminalCommit;
      this.assertPromptIdentity(transport, active);
      active.terminalCommitted = true;
      transport.activePrompt = undefined;
      return terminal;
    } catch (cause: unknown) {
      active.acceptance.reject(new AcpV1AdapterError("transport_lost"));
      if (this.currentState === "ready") {
        this.fail(
          isSinkLikeFailure(cause) ? "sink_fault" : "protocol_fault",
          { type: "explicit_close", reason: "adapter prompt failed" },
          true,
        );
      }
      throw this.normalizeOperationFailure(cause);
    } finally {
      active.settled.resolve();
      if (!responseAdmitted) {
        responseAdmission.resolve();
        this.responseAdmissions.delete(handle.id);
      }
    }
  }

  cancel(session: AcpV1AdapterSession): Promise<JsonRpcWriteReceipt> {
    try {
      this.assertReady();
      const transport = this.requireSession(session);
      const active = transport.activePrompt;
      if (active === undefined) {
        return Promise.reject(new AcpV1AdapterError("stale_session_identity"));
      }
      if (active.cancelOperation !== undefined) {
        return active.cancelOperation;
      }
      active.cancelOperation = this.cancelActivePrompt(transport, active);
      void active.cancelOperation.catch(() => undefined);
      return active.cancelOperation;
    } catch (cause: unknown) {
      return Promise.reject(this.normalizeOperationFailure(cause));
    }
  }

  async close(): Promise<void> {
    if (this.currentState === "closed") {
      await this.process.stop();
      return;
    }
    if (this.currentState !== "faulted") {
      this.fail(
        "explicit_close",
        { type: "explicit_close", reason: "adapter closed explicitly" },
        false,
      );
    }
    this.currentState = "closed";
    for (const remove of this.removeListeners.splice(0)) {
      remove();
    }
    await this.process.stop();
    await this.interruptionOperation;
  }

  private async startAndInitialize(): Promise<AcpV1InitializeResult> {
    try {
      await this.process.start();
      if (this.currentState !== "starting" || this.faultQueued) {
        throw new AcpV1AdapterError("transport_lost");
      }
      const initialized = await this.request(
        ACP_V1_METHODS.initialize,
        encodeInitializeParams(this.profile.dialect),
        this.timeouts.initializeMs,
        (response) => {
          const decoded = this.decodeProtocol(() => decodeInitializeResult(response, this.profile.dialect));
          if (this.faultQueued) {
            throw new AcpV1AdapterError("transport_lost");
          }
          this.initializeResult = decoded;
          this.currentState = "ready";
          return decoded;
        },
      );
      this.assertReady();
      return initialized;
    } catch (cause: unknown) {
      if (this.currentState === "starting") {
        this.fail(
          cause instanceof AcpV1AdapterError ? "process_fault" : "protocol_fault",
          { type: "explicit_close", reason: "adapter initialization failed" },
          true,
        );
      }
      throw this.normalizeOperationFailure(cause);
    }
  }

  private async request<T>(
    method: string,
    params: Readonly<Record<string, unknown>>,
    responseTimeoutMs: number,
    admit: (response: JsonValue) => T,
  ): Promise<T> {
    const handle = this.peer.sendRequest(method, jsonParams(params), {
      responseTimeoutMs,
      writeTimeoutMs: this.timeouts.writeMs,
    });
    const responseAdmission = deferred<void>();
    this.responseAdmissions.set(handle.id, responseAdmission.promise);
    try {
      await handle.write;
      return admit(await handle.response);
    } finally {
      responseAdmission.resolve();
      this.responseAdmissions.delete(handle.id);
    }
  }

  private async commitSessionEstablished(
    session: SessionTransport,
    establishedBy: "new" | "resume",
    state: AcpV1SessionState,
  ): Promise<void> {
    try {
      await this.enqueueSink(session, () => this.commitSink(() =>
        this.sink.commitSessionEstablished(
          freeze({ identity: session.identity, establishedBy, state }),
        ),
      ));
      this.assertReady();
      session.phase = "ready";
      session.ready.resolve();
    } catch (cause: unknown) {
      session.ready.reject(new AcpV1AdapterError("sink_commit_failed"));
      this.removeProvisionalSession(session);
      this.fail(
        "sink_fault",
        { type: "explicit_close", reason: "adapter sink commit failed" },
        true,
      );
      throw cause;
    }
  }

  private createSession(
    sessionId: string,
    establishedBy: AcpV1AdapterSession["establishedBy"],
    state: AcpV1SessionState,
    phase: SessionPhase,
  ): SessionTransport {
    const identity = sessionIdentity(this.adapterEpoch, sessionId);
    this.assertSessionIdAvailable(identity.sessionId);
    const ready = deferred<void>();
    void ready.promise.catch(() => undefined);
    const publicSession = adapterSession(identity, establishedBy, state);
    const transport: SessionTransport = {
      identity,
      ready,
      publicSession,
      activePrompt: undefined,
      permissionOperations: new Set(),
      phase,
      sinkTail: Promise.resolve(),
      updateTail: Promise.resolve(),
    };
    this.sessions.set(identity.sessionId, transport);
    this.sessionProvenance.set(publicSession, transport);
    return transport;
  }

  private replacePublicSession(
    session: SessionTransport,
    establishedBy: AcpV1AdapterSession["establishedBy"],
    state: AcpV1SessionState,
  ): void {
    const next = adapterSession(session.identity, establishedBy, state);
    (session as { publicSession: AcpV1AdapterSession }).publicSession = next;
    this.sessionProvenance.set(next, session);
  }

  private removeProvisionalSession(session: SessionTransport): void {
    if (this.sessions.get(session.identity.sessionId) === session) {
      this.sessions.delete(session.identity.sessionId);
    }
    session.ready.reject(new AcpV1AdapterError("operation_failed"));
  }

  private async cancelActivePrompt(
    session: SessionTransport,
    active: ActivePrompt,
  ): Promise<JsonRpcWriteReceipt> {
    try {
      if (active.handle !== undefined) await active.handle.write;
      this.assertSamePrompt(session, active);
      const write = await this.peer.sendNotification(
        ACP_V1_METHODS.sessionCancel,
        jsonParams(encodeCancelParams(session.identity.sessionId)),
        { writeTimeoutMs: this.timeouts.writeMs },
      );
      this.abandonPendingPermissionPreparations(active);
      await this.enqueueSink(session, () => this.commitSink(() =>
        this.sink.commitCancelSent(freeze({ identity: active.identity, write })),
      ));
      this.assertSamePrompt(session, active);
      return write;
    } catch (cause: unknown) {
      if (this.currentState === "ready") {
        this.fail(
          "write_fault",
          { type: "explicit_close", reason: "adapter cancellation write failed" },
          true,
        );
      }
      throw this.normalizeOperationFailure(cause);
    }
  }

  private onProcessEvent(event: ProcessHostEvent): void {
    switch (event.type) {
      case "stdout_data":
        this.acceptStdout(event.chunk);
        return;
      case "stdout_eof":
        try {
          this.decoder.end();
          this.queueTransportFault("stdout_eof", { type: "stdout_eof" });
        } catch (cause: unknown) {
          this.queueDecoderFault(cause);
        }
        return;
      case "process_exit":
        this.processExitCode = event.code;
        this.processSignal = event.signal;
        this.queueTransportFault("process_fault", {
          type: "process_exit",
          code: event.code,
          signal: event.signal,
        });
        return;
      case "process_started":
        this.processId = event.receipt.pid;
        return;
      case "stderr_diagnostic":
        this.stderrCapturedBytes = event.capturedBytes;
        this.stderrDroppedBytes = event.droppedBytes;
        this.stderrTail.push(event.text.slice(0, 2_000));
        if (this.stderrTail.length > 40) this.stderrTail.splice(0, this.stderrTail.length - 40);
        return;
      case "stderr_eof":
        this.stderrCapturedBytes = event.capturedBytes;
        this.stderrDroppedBytes = event.droppedBytes;
        return;
      case "preflight_failure":
      case "spawn_failure":
        this.queueTransportFault("process_fault", {
          type: "spawn_failure",
          reason: "owned process failed before protocol start",
        });
        return;
      case "process_error":
      case "stop_failure":
      case "write_failure":
        this.queueTransportFault("process_fault", {
          type: "write_failure",
          reason: "owned process transport failed",
        });
        return;
      case "cleanup_late_result":
      case "process_close":
      case "reaped":
      case "stop_escalated":
      case "stop_requested":
        return;
    }
  }

  private acceptStdout(chunk: Uint8Array): void {
    if (this.faultQueued || this.currentState === "faulted" || this.currentState === "closed") {
      return;
    }
    try {
      this.enqueueFrames(this.decoder.push(chunk));
    } catch (cause: unknown) {
      this.queueDecoderFault(cause);
    }
  }

  private queueDecoderFault(cause: unknown): void {
    if (cause instanceof NdjsonProtocolError) {
      this.enqueueFrames(cause.framesBeforeFault);
      this.queueTransportFault("decoder_fault", {
        type: "decoder_fault",
        code: cause.code,
      });
      return;
    }
    this.queueTransportFault("decoder_fault", {
      type: "decoder_fault",
      code: "unknown_decoder_fault",
    });
  }

  private enqueueFrames(frames: readonly JsonObject[]): void {
    if (frames.length === 0) return;
    this.pumpTail = this.pumpTail.then(() => this.dispatchFrames(frames));
    void this.pumpTail.catch(() => undefined);
  }

  private async dispatchFrames(frames: readonly JsonObject[]): Promise<void> {
    for (const frame of frames) {
      if (this.currentState === "faulted" || this.currentState === "closed") return;
      const operation = this.peer.receive(frame);
      if (isResponseFrame(frame)) {
        try {
          await operation;
          const id = frame["id"];
          if (typeof id === "number") {
            await this.responseAdmissions.get(id);
          }
        } catch {
          return;
        }
      } else {
        void operation.catch(() => undefined);
      }
    }
  }

  private queueTransportFault(
    reason: AcpV1AdapterInterruptionReason,
    fault: JsonRpcTransportFault,
  ): void {
    if (this.faultQueued || this.currentState === "faulted" || this.currentState === "closed") {
      return;
    }
    this.faultQueued = true;
    this.pumpTail = this.pumpTail.then(() => {
      this.fail(reason, fault, true, transportFaultDiagnostic(fault));
    });
    void this.pumpTail.catch(() => undefined);
  }

  private async onNotification(notification: JsonRpcInboundNotification): Promise<void> {
    if (notification.method !== ACP_V1_METHODS.sessionUpdate) {
      this.observeExtensionNotification(notification);
      return;
    }
    try {
      const sessionId = this.sessionIdFromParams(notification.params);
      if (!this.sessions.has(sessionId) && this.pendingNewSession !== undefined) {
        const update = decodeSessionUpdate(
          notification.params,
          sessionId,
          this.receiveTimestamp(),
        );
        if (
          update.type === "turn" ||
          update.type === "media_content" ||
          update.type === "unsupported_content"
        ) {
          throw new AcpV1AdapterError("protocol_fault");
        }
        const pending = this.pendingNewSession;
        if (pending.sessionId !== undefined && pending.sessionId !== sessionId) {
          throw new AcpV1AdapterError("protocol_fault");
        }
        if (pending.updates.length >= 128) {
          throw new AcpV1AdapterError("protocol_fault");
        }
        pending.sessionId = sessionId;
        pending.updates.push(update);
        return;
      }
      const session = this.sessions.get(sessionId);
      // The official Grok agent multiplexes reviewer/worker session updates on the
      // root ACP connection. They are not part of Guild's bound conversation and
      // must not be allowed to mutate or terminate it.
      if (session === undefined || session.identity.adapterEpoch !== this.adapterEpoch) {
        await this.routeAuxiliaryUpdate(sessionId, notification.params);
        return;
      }
      const update = decodeSessionUpdate(
        notification.params,
        session.identity.sessionId,
        this.receiveTimestamp(),
      );
      const operation = this.routeUpdate(session, update, promptIdOfSessionUpdate(notification.params));
      await operation;
    } catch (cause: unknown) {
      const update = isNonArrayObject(notification.params)
        && isNonArrayObject(notification.params["update"])
        ? notification.params["update"]
        : undefined;
      const faultDiagnostic = adapterFaultDiagnostic(
        cause,
        "session_update",
        typeof update?.["sessionUpdate"] === "string"
          ? update["sessionUpdate"].slice(0, 80)
          : undefined,
      );
      if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
        console.error(
          "guild_acp_update_failure",
          cause instanceof AcpV1CodecError
            ? `${cause.code}:${cause.path}`
            : cause instanceof AcpV1AdapterError
              ? cause.code
              : cause instanceof Error
                ? cause.name
                : typeof cause,
          typeof update?.["sessionUpdate"] === "string"
            ? update["sessionUpdate"].slice(0, 80)
            : "unknown_update",
        );
      }
      if (
        cause instanceof AcpV1CodecError &&
        update?.["sessionUpdate"] === "available_commands_update"
      ) {
        // The slash-command list is advisory; a list Guild cannot decode must not end the session.
        return;
      }
      if (
        this.profile.dialect === "claude" &&
        cause instanceof AcpV1CodecError &&
        this.claudeSessionIsIdle(notification.params)
      ) {
        // Content the agent sends outside a prompt is dropped, and so is content Guild cannot decode.
        this.emitEngineSignal({
          type: "late_update_dropped",
          engine: "claude",
          sessionId: String((notification.params as { readonly sessionId: unknown }).sessionId).slice(0, 128),
          discriminator: typeof update?.["sessionUpdate"] === "string"
            ? update["sessionUpdate"].slice(0, 80)
            : "unknown",
        });
        return;
      }
      if (this.currentState === "ready" || this.currentState === "starting") {
        this.fail(
          isSinkLikeFailure(cause) ? "sink_fault" : "protocol_fault",
          { type: "explicit_close", reason: "adapter update failed" },
          true,
          faultDiagnostic,
        );
      }
    }
  }

  /**
   * Only allowlisted `_x.ai/*` notifications become a typed signal; every other method is dropped
   * here without being decoded, stored or logged (`_x.ai/mcp/servers_updated` carries secrets).
   */
  private observeExtensionNotification(notification: JsonRpcInboundNotification): void {
    if (this.profile.dialect === "claude") {
      // Out-of-session account summary; every other method outside a session is ignored.
      if (notification.method === CLAUDE_AUTH_STATUS_METHOD) {
        const status = decodeClaudeAuthStatus(notification.params);
        if (status !== undefined) this.emitEngineSignal({ type: "auth_status", engine: "claude", status });
      }
      return;
    }
    if (!notification.method.startsWith("_x.ai/")) return;
    try {
      if (notification.method === "_x.ai/queue/changed") this.noteQueuedPromptTexts(notification.params);
      const envelope = parseXaiNotification(
        notification.method,
        notification.params,
        this.clock.monotonicMs(),
      );
      if (envelope === undefined) return;
      // The end of a turn the runtime started itself is only visible here.
      this.onTurnEndSignal(envelope);
      this.sink.observeSignal?.(envelope);
    } catch {
      // Display-only signals must never affect the transport.
    }
  }

  /** Remembers which text each queued prompt carries, so an agent-started turn can be named. */
  private noteQueuedPromptTexts(params: JsonRpcParams | undefined): void {
    const snapshot = parseXaiQueueSnapshot(params);
    const sessionId = isNonArrayObject(params) && typeof params["sessionId"] === "string"
      ? params["sessionId"]
      : undefined;
    if (snapshot === undefined || sessionId === undefined) return;
    let tracked = this.queuedPromptTexts.get(sessionId);
    if (tracked === undefined) {
      tracked = { runningPromptId: undefined, runningText: undefined, byId: new Map() };
      this.queuedPromptTexts.set(sessionId, tracked);
      while (this.queuedPromptTexts.size > MAX_TRACKED_QUEUE_SESSIONS) {
        const oldest = this.queuedPromptTexts.keys().next().value;
        if (oldest === undefined) break;
        this.queuedPromptTexts.delete(oldest);
      }
    }
    tracked.runningPromptId = snapshot.runningPromptId;
    tracked.runningText = snapshot.runningText;
    for (const entry of snapshot.entries) {
      tracked.byId.delete(entry.id);
      tracked.byId.set(entry.id, entry.text);
    }
    while (tracked.byId.size > MAX_TRACKED_QUEUE_TEXTS) {
      const oldest = tracked.byId.keys().next().value;
      if (oldest === undefined) break;
      tracked.byId.delete(oldest);
    }
  }

  private queuedPromptText(sessionId: string, promptId: string | undefined): string | undefined {
    const tracked = this.queuedPromptTexts.get(sessionId);
    if (tracked === undefined) return undefined;
    if (promptId !== undefined) {
      if (tracked.runningPromptId === promptId && tracked.runningText !== undefined) {
        return tracked.runningText;
      }
      return tracked.byId.get(promptId);
    }
    return tracked.runningText;
  }

  /** `turn_completed` / `prompt_complete` end a turn that has no JSON-RPC response to wait for. */
  private onTurnEndSignal(envelope: XaiSignalEnvelope): void {
    const signal = envelope.signal;
    if ((signal.kind !== "turn_completed" && signal.kind !== "prompt_complete") || envelope.sessionId === null) {
      return;
    }
    const session = this.sessions.get(envelope.sessionId);
    if (
      session === undefined ||
      session.identity.adapterEpoch !== this.adapterEpoch ||
      session.phase !== "ready" ||
      !this.agentTurnsEnabled()
    ) return;
    void this.enqueueUpdate(session, () =>
      this.finishAgentTurn(session, signal.stopReason, signal.promptId)
    ).catch((cause: unknown) => {
      if (this.currentState === "ready" && !this.faultQueued) {
        this.fail(
          isSinkLikeFailure(cause) ? "sink_fault" : "protocol_fault",
          { type: "explicit_close", reason: "agent turn completion failed" },
          true,
        );
      }
    });
  }

  private async routeAuxiliaryUpdate(
    auxiliarySessionId: string,
    params: JsonRpcParams | undefined,
  ): Promise<void> {
    const activeRoots = [...this.sessions.values()].filter((candidate) =>
      candidate.identity.adapterEpoch === this.adapterEpoch &&
      candidate.activePrompt !== undefined &&
      !candidate.activePrompt.responseProven
    );
    if (activeRoots.length !== 1) return;
    let update: AcpV1DecodedUpdate;
    try {
      update = decodeSessionUpdate(params, auxiliarySessionId, this.receiveTimestamp());
    } catch {
      return;
    }
    if (update.type !== "turn") return;
    const prior = this.auxiliaryUpdateTails.get(auxiliarySessionId) ?? Promise.resolve();
    const next = prior.then(async () => {
      try {
        await this.sink.commitAuxiliaryUpdate(Object.freeze({
          identity: activeRoots[0]!.identity,
          auxiliarySessionId,
          update,
        }));
      } catch {
        // Auxiliary activity is observability only. It must never take down the
        // root ACP transport or alter its durable delivery semantics.
      }
    });
    this.auxiliaryUpdateTails.set(auxiliarySessionId, next);
    await next;
    if (this.auxiliaryUpdateTails.get(auxiliarySessionId) === next) {
      this.auxiliaryUpdateTails.delete(auxiliarySessionId);
    }
  }

  private async onRequest(request: JsonRpcInboundRequest): Promise<JsonRpcHandlerReply> {
    if (request.method !== ACP_V1_METHODS.sessionRequestPermission) {
      return { type: "error", error: { code: -32601, message: "Method not found" } };
    }
    try {
      const key = callbackKey(request.id);
      const sessionId = this.sessionIdFromParams(request.params);
      const session = this.sessions.get(sessionId);
      // Grok may multiplex worker/reviewer callbacks over the root ACP connection.
      // Guild has no durable Task/Run identity for those child sessions, so it must
      // never surface or approve their permissions. A safe cancellation lets the
      // child settle without sacrificing the bound root conversation.
      if (session === undefined || session.identity.adapterEpoch !== this.adapterEpoch) {
        return this.cancelUnboundPermission(key);
      }
      let active = session.activePrompt;
      if ((active === undefined || active.responseProven) && this.agentTurnsEnabled()) {
        // A turn the runtime started itself may still be attaching: its frames are on the update tail.
        await session.updateTail.catch(() => undefined);
        active = session.activePrompt;
      }
      if (active === undefined || active.responseProven) {
        if (this.profile.dialect === "claude") {
          // Work the agent does on its own after a turn: nothing is asked of the user, and the
          // transport stays healthy.
          return this.cancelUnboundPermission(key);
        }
        throw new AcpV1AdapterError("stale_session_identity");
      }
      await active.acceptance.promise;
      this.assertSamePrompt(session, active);
      if (active.responseProven) {
        throw new AcpV1AdapterError("stale_session_identity");
      }
      if (active.discarded) {
        // The sink declined this agent-started turn: nothing may be asked of the user for it.
        return this.cancelUnboundPermission(key);
      }
      const permission = decodePermissionRequest(
        request.id,
        request.params,
        session.identity.sessionId,
        this.receiveTimestamp(),
      );
      const controller = new AbortController();
      active.permissionControllers.add(controller);
      if (this.pendingPermissionFlushes.has(key)) {
        throw new AcpV1AdapterError("protocol_fault");
      }
      const transaction: PendingPermissionFlush = {
        active,
        abandonRequested: false,
        controller,
        deliveryOperation: undefined,
        identity: active.identity,
        prepared: deferred<PermissionPreparationOutcome>(),
        receipt: deferred<JsonRpcInboundResponseWriteReceipt>(),
        session,
        preparedResolved: false,
        writeReceived: false,
      };
      void transaction.prepared.promise.catch(() => undefined);
      void transaction.receipt.promise.catch(() => undefined);
      this.pendingPermissionFlushes.set(key, transaction);
      const deliveryOperation = this.enqueueSink(session, async () => {
        let rawPrepared: unknown;
        try {
          rawPrepared = await this.sink.preparePermissionResponse(
            Object.freeze({
              identity: active.identity,
              request: permission,
              signal: controller.signal,
            }),
          );
        } catch (cause: unknown) {
          if (
            transaction.abandonRequested &&
            controller.signal.aborted &&
            cause === controller.signal.reason
          ) {
            transaction.prepared.resolve(Object.freeze({ type: "abandoned" }));
            return;
          }
          throw new AcpV1AdapterError("sink_commit_failed");
        }
        const prepared = canonicalPreparedPermissionResponse(rawPrepared);
        transaction.preparedResolved = true;
        transaction.prepared.resolve(Object.freeze({
          type: "prepared",
          response: prepared,
        }));
        const write = await transaction.receipt.promise;
        await this.commitSink(() =>
          this.sink.commitPermissionResponseFlushed(
            freeze({
              identity: active.identity,
              request: permission,
              decision: prepared.decision,
              delivery: prepared.delivery,
              write,
            }),
          ),
        );
      });
      transaction.deliveryOperation = deliveryOperation;
      session.permissionOperations.add(deliveryOperation);
      void deliveryOperation.then(
        () => this.finishPermissionDelivery(key, transaction),
        (cause: unknown) => {
          transaction.prepared.reject(cause);
          transaction.receipt.reject(cause);
          this.finishPermissionDelivery(key, transaction);
          if (this.currentState === "ready" && !this.faultQueued) {
            this.fail(
              isSinkLikeFailure(cause) ? "sink_fault" : "protocol_fault",
              { type: "explicit_close", reason: "permission delivery failed" },
              true,
            );
          }
        },
      );
      const preparation = await transaction.prepared.promise;
      if (preparation.type === "abandoned") {
        return PERMISSION_NO_RESPONSE;
      }
      const prepared = preparation.response;
      this.assertSamePrompt(session, active);
      const result = prepared.decision.type === "selected"
        ? encodeSelectedPermissionResult(permission, prepared.decision.optionId)
        : encodeCancelledPermissionResult();
      return { type: "result", result: jsonValue(result) };
    } catch (cause: unknown) {
      if (this.currentState === "ready" && !this.faultQueued) {
        this.fail(
          isSinkLikeFailure(cause) ? "sink_fault" : "protocol_fault",
          { type: "explicit_close", reason: "adapter permission handling failed" },
          true,
        );
      }
      return { type: "error", error: { code: -32603, message: "Internal error" } };
    }
  }

  private onInboundResponseWrite(receipt: JsonRpcInboundResponseWriteReceipt): void {
    if (receipt.method !== ACP_V1_METHODS.sessionRequestPermission) return;
    const key = callbackKey(receipt.requestId);
    const pending = this.pendingPermissionFlushes.get(key);
    if (pending === undefined) {
      if (this.unboundPermissionResponses.delete(key)) return;
      this.fail(
        "protocol_fault",
        { type: "explicit_close", reason: "uncorrelated permission response write" },
        true,
      );
      return;
    }
    const { session } = pending;
    if (
      this.sessions.get(pending.identity.sessionId) !== session ||
      pending.writeReceived
    ) {
      this.fail(
        "protocol_fault",
        { type: "explicit_close", reason: "stale permission response write" },
        true,
      );
      return;
    }
    pending.writeReceived = true;
    pending.receipt.resolve(receipt);
  }

  private abandonPendingPermissionPreparations(active: ActivePrompt): void {
    for (const transaction of this.pendingPermissionFlushes.values()) {
      if (
        transaction.active !== active ||
        transaction.preparedResolved ||
        transaction.abandonRequested
      ) {
        continue;
      }
      transaction.abandonRequested = true;
      transaction.controller.abort(PERMISSION_PREPARATION_ABANDONED);
    }
  }

  private finishPermissionDelivery(
    key: string,
    transaction: PendingPermissionFlush,
  ): void {
    if (this.pendingPermissionFlushes.get(key) === transaction) {
      this.pendingPermissionFlushes.delete(key);
    }
    if (transaction.deliveryOperation !== undefined) {
      transaction.session.permissionOperations.delete(transaction.deliveryOperation);
    }
    transaction.active.permissionControllers.delete(transaction.controller);
  }

  private routeUpdate(
    session: SessionTransport,
    update: AcpV1DecodedUpdate,
    promptId?: string,
  ): Promise<void> {
    if (session.phase === "replaying") {
      return this.enqueueUpdate(session, () => this.commitSink(() =>
        this.sink.commitUpdate(
          freeze({ identity: session.identity, ingestMode: "replay", update }),
        ),
      ));
    }
    const active = session.activePrompt;
    const turnScoped = update.type === "turn" ||
      update.type === "media_content" ||
      update.type === "unsupported_content";
    if (this.profile.dialect === "claude" && (active === undefined || active.responseProven)) {
      return this.routeClaudeLateUpdate(session, update);
    }
    if (turnScoped && (active === undefined || active.responseProven)) {
      if (!this.agentTurnsEnabled()) {
        return Promise.reject(new AcpV1AdapterError("stale_session_identity"));
      }
      return this.routeAgentTurnUpdate(session, update, promptId);
    }
    return this.enqueueUpdate(session, async () => {
      if (session.phase === "committing") {
        await session.ready.promise;
      }
      if (active !== undefined) {
        await active.acceptance.promise;
        this.assertSamePrompt(session, active);
      }
      await this.commitSink(() =>
        this.sink.commitUpdate(
          freeze({
            identity: session.identity,
            ingestMode: "live",
            ...(active === undefined ? {} : { promptSequence: active.identity.promptSequence }),
            update,
          }),
        ),
      );
    });
  }

  /**
   * Claude frames that arrive when no prompt is in flight (the adapter sends `session_info_update`
   * and sometimes `available_commands_update` after the prompt response). Session metadata is
   * applied to the session without a prompt identity and never opens a Run; any content is
   * dropped and reported, and neither faults the transport (PC-ENG-001).
   */
  private routeClaudeLateUpdate(session: SessionTransport, update: AcpV1DecodedUpdate): Promise<void> {
    if (update.type !== "session_context") {
      const discriminator = update.type === "turn" ? update.payload.type : update.type;
      if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
        console.warn("guild_acp_late_update_dropped", discriminator);
      }
      this.emitEngineSignal({
        type: "late_update_dropped",
        engine: "claude",
        sessionId: session.identity.sessionId,
        discriminator,
      });
      return Promise.resolve();
    }
    return this.enqueueUpdate(session, async () => {
      if (session.phase === "committing") {
        await session.ready.promise;
      }
      await this.commitSink(() =>
        this.sink.commitUpdate(freeze({ identity: session.identity, ingestMode: "live", update })),
      );
    });
  }

  /**
   * A turn frame with no Guild prompt in flight belongs to a turn the runtime started itself. The
   * frame waits for the previous prompt's terminal commit, then the turn is attached to a Run
   * through the sink (once, on its first frame) and later frames follow it in order.
   */
  private routeAgentTurnUpdate(
    session: SessionTransport,
    update: AcpV1DecodedUpdate,
    promptId: string | undefined,
  ): Promise<void> {
    return this.enqueueUpdate(session, async () => {
      if (session.phase === "committing") {
        await session.ready.promise;
      }
      let active = session.activePrompt;
      if (active !== undefined && active.responseProven) {
        await active.settled.promise;
        active = session.activePrompt;
      }
      if (active === undefined) {
        active = await this.startAgentTurn(session, promptId);
      }
      await active.acceptance.promise;
      this.assertSamePrompt(session, active);
      if (active.discarded) return;
      await this.commitSink(() =>
        this.sink.commitUpdate(
          freeze({
            identity: session.identity,
            ingestMode: "live",
            promptSequence: active.identity.promptSequence,
            update,
          }),
        ),
      );
    });
  }

  private async startAgentTurn(
    session: SessionTransport,
    promptId: string | undefined,
  ): Promise<ActivePrompt> {
    if (!Number.isSafeInteger(this.promptSequence + 1)) {
      throw new AcpV1AdapterError("operation_failed");
    }
    this.promptSequence += 1;
    const identity = freeze({
      ...session.identity,
      promptSequence: this.promptSequence,
    });
    const active: ActivePrompt = {
      acceptance: deferred<void>(),
      handle: undefined,
      origin: "agent",
      identity,
      cancelOperation: undefined,
      permissionControllers: new Set(),
      settled: deferred<void>(),
      agentPromptId: promptId,
      discarded: false,
      responseProven: false,
      terminalCommitted: false,
    };
    void active.acceptance.promise.catch(() => undefined);
    session.activePrompt = active;
    const promptText = this.queuedPromptText(session.identity.sessionId, promptId);
    // A declined turn must not poison the ordered sink queue, so the rejection is absorbed here.
    const outcome = await this.enqueueSink(session, async () => {
      try {
        await this.sink.commitAgentTurnStarted!(freeze({
          identity,
          ...(promptId === undefined ? {} : { agentPromptId: promptId }),
          ...(promptText === undefined ? {} : { promptText }),
        }));
        return "attached" as const;
      } catch {
        return "declined" as const;
      }
    });
    active.discarded = outcome === "declined";
    active.acceptance.resolve();
    return active;
  }

  /** Ends the agent-started turn (if one is running) when the runtime reports its completion. */
  private async finishAgentTurn(
    session: SessionTransport,
    stopReason: string | undefined,
    promptId: string | undefined,
  ): Promise<void> {
    const active = session.activePrompt;
    if (active === undefined || active.origin !== "agent" || active.responseProven) return;
    // Both ids known and different: the signal ends another turn. Without an id on one side the
    // match cannot be proven, so only an id-less pair is accepted.
    if (active.agentPromptId !== promptId) return;
    active.responseProven = true;
    this.abandonPendingPermissionPreparations(active);
    if (!active.discarded) {
      const terminal = this.agentTurnTerminal(session, stopReason);
      await this.enqueueSink(session, () => this.commitSink(() =>
        this.sink.commitPromptTerminal(freeze({ identity: active.identity, terminal })),
      ));
    }
    this.assertPromptIdentity(session, active);
    active.terminalCommitted = true;
    session.activePrompt = undefined;
    active.settled.resolve();
  }

  private agentTurnTerminal(
    session: SessionTransport,
    stopReason: string | undefined,
  ): RuntimePromptTerminalPayload {
    // Anything the runtime reports beyond the ACP stop reasons (for example an error) is a refusal.
    const known: AcpPromptStopReason =
      stopReason === "end_turn" || stopReason === "max_tokens" ||
        stopReason === "max_turn_requests" || stopReason === "cancelled"
        ? stopReason
        : stopReason === undefined ? "end_turn" : "refusal";
    return freezeRuntimePayload({
      type: "prompt_terminal",
      sessionId: session.identity.sessionId,
      received: this.receiveTimestamp(),
      stopReason: known,
      classification: classifyStopReason(known),
    }) as RuntimePromptTerminalPayload;
  }

  private enqueueUpdate(session: SessionTransport, operation: () => Promise<void>): Promise<void> {
    const next = session.updateTail.then(operation);
    session.updateTail = next;
    void next.catch(() => undefined);
    return next;
  }

  private enqueueSink<T>(session: SessionTransport, operation: () => Promise<T>): Promise<T> {
    const result = session.sinkTail.then(operation);
    session.sinkTail = result.then(() => undefined);
    void session.sinkTail.catch(() => undefined);
    return result;
  }

  private sessionFromParams(params: JsonRpcParams | undefined): SessionTransport {
    const sessionId = this.sessionIdFromParams(params);
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.identity.adapterEpoch !== this.adapterEpoch) {
      throw new AcpV1AdapterError("stale_session_identity");
    }
    return session;
  }

  private sessionIdFromParams(params: JsonRpcParams | undefined): string {
    if (!isNonArrayObject(params) || typeof params["sessionId"] !== "string") {
      throw new AcpV1AdapterError("protocol_fault");
    }
    return params["sessionId"];
  }

  /** True when the notification names a bound session that has no prompt of Guild's in flight. */
  private claudeSessionIsIdle(params: JsonRpcParams | undefined): boolean {
    if (!isNonArrayObject(params) || typeof params["sessionId"] !== "string") return false;
    const session = this.sessions.get(params["sessionId"]);
    return session !== undefined &&
      (session.activePrompt === undefined || session.activePrompt.responseProven);
  }

  private agentTurnsEnabled(): boolean {
    return this.profile.features.agentInitiatedTurns && this.sink.commitAgentTurnStarted !== undefined;
  }

  /** Answers a permission callback that belongs to no Guild prompt with a cancellation. */
  private cancelUnboundPermission(key: string): JsonRpcHandlerReply {
    if (this.pendingPermissionFlushes.has(key) || this.unboundPermissionResponses.has(key)) {
      throw new AcpV1AdapterError("protocol_fault");
    }
    this.unboundPermissionResponses.add(key);
    return { type: "result", result: jsonValue(encodeCancelledPermissionResult()) };
  }

  private emitEngineSignal(signal: EngineSignal): void {
    try {
      this.sink.observeEngineSignal?.(signal);
    } catch {
      // Display-only signals must never affect the transport.
    }
  }

  /** Session start options the connected agent has not advertised support for are refused before any wire call. */
  private assertSessionStartOptions(
    initialized: AcpV1InitializeResult,
    options: AcpV1SessionStartOptions | undefined,
  ): void {
    if (options === undefined) return;
    if ((options.mcpServers?.length ?? 0) > 0 && initialized.mcpCapabilities?.http !== true) {
      throw new AcpV1AdapterError("capability_not_advertised");
    }
    if (options.claudeCodeOptions !== undefined && this.profile.dialect !== "claude") {
      throw new AcpV1AdapterError("invalid_adapter_options");
    }
  }

  private onPeerDiagnostic(diagnostic: JsonRpcDiagnostic): void {
    if (diagnostic.type === "orphan_response_ignored") {
      if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
        console.warn("guild_acp_orphan_response_ignored", JSON.stringify(diagnostic));
      }
      return;
    }
    if (diagnostic.type !== "terminal_fault") return;
    if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
      console.error("guild_acp_terminal_fault", JSON.stringify(diagnostic.fault));
    }
    this.fail(
      peerFaultReason(diagnostic.fault),
      undefined,
      true,
      peerTerminalFaultDiagnostic(diagnostic.fault),
    );
  }

  private fail(
    reason: AcpV1AdapterInterruptionReason,
    peerFault: JsonRpcTransportFault | undefined,
    stopProcess: boolean,
    faultDiagnostic: AcpV1AdapterFaultDiagnostic = {},
  ): void {
    if (this.currentState === "faulted" || this.currentState === "closed") return;
    this.currentState = "faulted";
    if (peerFault !== undefined) {
      this.peer.failTransport(peerFault);
    }
    const error = new AcpV1AdapterError("transport_lost");
    for (const pending of this.pendingPermissionFlushes.values()) {
      pending.controller.abort(error);
      pending.prepared.reject(error);
      pending.receipt.reject(error);
    }
    this.pendingPermissionFlushes.clear();
    this.unboundPermissionResponses.clear();
    const interruptionCommits: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      session.ready.reject(error);
      session.activePrompt?.acceptance.reject(error);
      session.activePrompt?.settled.resolve();
      const activeAtFault = session.activePrompt;
      for (const controller of activeAtFault?.permissionControllers ?? []) {
        controller.abort(error);
      }
      const prior = Promise.allSettled([
        session.sinkTail,
        session.updateTail,
        ...session.permissionOperations,
      ]);
      const interruption = prior.then(() =>
        this.sink.commitTransportInterrupted(
          freeze({
            identity: session.identity,
            ...(activeAtFault === undefined || activeAtFault.terminalCommitted
              ? {}
              : { activePromptSequence: activeAtFault.identity.promptSequence }),
            reason,
            diagnostic: this.interruptionDiagnostic(faultDiagnostic),
          }),
        ),
      );
      session.sinkTail = interruption;
      void interruption.catch(() => undefined);
      interruptionCommits.push(interruption);
    }
    this.interruptionOperation = Promise.all(interruptionCommits).then(() => undefined);
    void this.interruptionOperation.catch(() => undefined);
    if (stopProcess) {
      void Promise.resolve().then(() => this.process.stop()).catch(() => undefined);
    }
  }

  private interruptionDiagnostic(
    faultDiagnostic: AcpV1AdapterFaultDiagnostic = {},
  ): AcpV1AdapterInterruptionDiagnostic {
    return Object.freeze({
      ...(this.processId === undefined ? {} : { processId: this.processId }),
      ...(this.processExitCode === undefined ? {} : { exitCode: this.processExitCode }),
      ...(this.processSignal === undefined ? {} : { signal: this.processSignal }),
      ...faultDiagnostic,
      stderrTail: Object.freeze([...this.stderrTail]),
      stderrCapturedBytes: this.stderrCapturedBytes,
      stderrDroppedBytes: this.stderrDroppedBytes,
    });
  }

  private async commitSink<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new AcpV1AdapterError("sink_commit_failed");
    }
  }

  private decodeProtocol<T>(operation: () => T): T {
    try {
      return operation();
    } catch (cause: unknown) {
      this.fail(
        "protocol_fault",
        { type: "explicit_close", reason: "malformed ACP v1 payload" },
        true,
        adapterFaultDiagnostic(cause, "response_decode"),
      );
      throw new AcpV1AdapterError("protocol_fault");
    }
  }

  private requireInitialized(): AcpV1InitializeResult {
    this.assertReady();
    if (this.initializeResult === undefined) {
      throw new AcpV1AdapterError("adapter_not_initialized");
    }
    return this.initializeResult;
  }

  private assertReady(): void {
    if (this.currentState === "faulted" || this.faultQueued) {
      throw new AcpV1AdapterError("transport_lost");
    }
    if (this.currentState === "closed") {
      throw new AcpV1AdapterError("adapter_closed");
    }
    if (this.currentState !== "ready") {
      throw new AcpV1AdapterError("adapter_not_initialized");
    }
  }

  private stateError(): AcpV1AdapterError {
    if (this.currentState === "faulted" || this.faultQueued) {
      return new AcpV1AdapterError("transport_lost");
    }
    if (this.currentState === "closed") return new AcpV1AdapterError("adapter_closed");
    return new AcpV1AdapterError("adapter_not_initialized");
  }

  private requireSession(session: AcpV1AdapterSession): SessionTransport {
    if (session === null || typeof session !== "object") {
      throw new AcpV1AdapterError("stale_session_identity");
    }
    const transport = this.sessionProvenance.get(session);
    if (
      transport === undefined ||
      transport.publicSession !== session ||
      this.sessions.get(transport.identity.sessionId) !== transport
    ) {
      throw new AcpV1AdapterError("stale_session_identity");
    }
    return transport;
  }

  private assertSessionIdAvailable(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      throw new AcpV1AdapterError("stale_session_identity");
    }
  }

  private assertSamePrompt(session: SessionTransport, active: ActivePrompt): void {
    this.assertReady();
    this.assertPromptIdentity(session, active);
  }

  private assertPromptIdentity(session: SessionTransport, active: ActivePrompt): void {
    if (session.activePrompt !== active) {
      throw new AcpV1AdapterError("stale_session_identity");
    }
  }

  private receiveTimestamp(): RuntimeReceiveTimestamp {
    const wallClockIso = this.clock.wallClockIso();
    const monotonicMs = this.clock.monotonicMs();
    if (
      typeof wallClockIso !== "string" ||
      !Number.isFinite(monotonicMs) ||
      monotonicMs < 0
    ) {
      throw new AcpV1AdapterError("invalid_adapter_options");
    }
    return freeze({ wallClockIso, monotonicMs });
  }

  private normalizeOperationFailure(cause: unknown): AcpV1AdapterError {
    if (cause instanceof AcpV1AdapterError) return cause;
    // Claude is never authenticated by Guild; the user logs in with `claude` themselves.
    if (
      this.profile.dialect === "claude" &&
      cause instanceof JsonRpcRemoteError &&
      cause.response.code === ACP_AUTH_REQUIRED_CODE
    ) {
      return new AcpV1AdapterError("auth_required");
    }
    if (this.currentState === "faulted") return new AcpV1AdapterError("transport_lost");
    if (this.currentState === "closed") return new AcpV1AdapterError("adapter_closed");
    return new AcpV1AdapterError("operation_failed");
  }
}

function adapterSession(
  identity: AcpV1AdapterSessionIdentity,
  establishedBy: AcpV1AdapterSession["establishedBy"],
  state: AcpV1SessionState,
): AcpV1AdapterSession {
  return freeze({
    ...identity,
    establishedBy,
    ...(Object.hasOwn(state, "contextWindowSize")
      ? { contextWindowSize: state.contextWindowSize }
      : {}),
    ...(Object.hasOwn(state, "modelCatalog") ? { modelCatalog: state.modelCatalog } : {}),
    ...(Object.hasOwn(state, "modes") ? { modes: state.modes } : {}),
    ...(Object.hasOwn(state, "configOptions") ? { configOptions: state.configOptions } : {}),
  });
}

function sessionStateFromNew(
  input: AcpV1SessionState & { readonly sessionId: string },
): AcpV1SessionState {
  return freeze({
    ...(Object.hasOwn(input, "contextWindowSize")
      ? { contextWindowSize: input.contextWindowSize }
      : {}),
    ...(Object.hasOwn(input, "modelCatalog") ? { modelCatalog: input.modelCatalog } : {}),
    ...(Object.hasOwn(input, "modes") ? { modes: input.modes } : {}),
    ...(Object.hasOwn(input, "configOptions")
      ? { configOptions: input.configOptions }
      : {}),
  });
}

function sessionIdentity(adapterEpoch: number, sessionId: string): AcpV1AdapterSessionIdentity {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new AcpV1AdapterError("protocol_fault");
  }
  return freeze({ adapterEpoch, sessionId });
}

function canonicalReplayBarrier(input: unknown): AcpV1ReplayBarrier {
  if (!exactDataRecord(input, ["barrierId"]) || typeof input["barrierId"] !== "string" || input["barrierId"].length === 0) {
    throw new AcpV1AdapterError("sink_commit_failed");
  }
  return freeze({ barrierId: input["barrierId"] });
}

function canonicalPermissionDecision(input: unknown): AcpV1PermissionDecision {
  if (!exactDataRecord(input, ["type"], ["optionId"]) || typeof input["type"] !== "string") {
    throw new AcpV1AdapterError("invalid_permission_decision");
  }
  if (input["type"] === "cancelled" && !Object.hasOwn(input, "optionId")) {
    return Object.freeze({ type: "cancelled" });
  }
  if (
    input["type"] === "selected" &&
    typeof input["optionId"] === "string" &&
    input["optionId"].length > 0
  ) {
    return Object.freeze({ type: "selected", optionId: input["optionId"] });
  }
  throw new AcpV1AdapterError("invalid_permission_decision");
}

function canonicalPreparedPermissionResponse(
  input: unknown,
): AcpV1PreparedPermissionResponse {
  if (!exactDataRecord(input, ["decision", "delivery"])) {
    throw new AcpV1AdapterError("invalid_permission_decision");
  }
  const decision = canonicalPermissionDecision(input["decision"]);
  const delivery = input["delivery"];
  if (
    !exactDataRecord(delivery, ["commandId", "version", "deliveryAttemptId"]) ||
    typeof delivery["commandId"] !== "string" ||
    delivery["commandId"].length === 0 ||
    typeof delivery["deliveryAttemptId"] !== "string" ||
    delivery["deliveryAttemptId"].length === 0 ||
    typeof delivery["version"] !== "number" ||
    !Number.isSafeInteger(delivery["version"]) ||
    delivery["version"] < 1
  ) {
    throw new AcpV1AdapterError("invalid_permission_decision");
  }
  return freeze({
    decision,
    delivery: {
      commandId: delivery["commandId"],
      version: delivery["version"],
      deliveryAttemptId: delivery["deliveryAttemptId"],
    },
  });
}

function exactDataRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): input is Record<string, unknown> {
  if (input !== null && typeof input === "object" && nodeTypes.isProxy(input)) return false;
  if (!isNonArrayObject(input)) return false;
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set([...required, ...optional]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) return false;
  for (const key of required) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function jsonParams(input: Readonly<Record<string, unknown>>): JsonObject {
  assertJsonValue(input);
  if (!isNonArrayObject(input)) {
    throw new AcpV1AdapterError("protocol_fault");
  }
  return input as JsonObject;
}

function jsonValue(input: unknown): JsonValue {
  assertJsonValue(input);
  return input;
}

function positiveSafeInteger(value: unknown, _name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AcpV1AdapterError("invalid_adapter_options");
  }
  return value;
}

function callbackKey(id: number | string | null): string {
  if (id === null) return "null";
  return `${typeof id}:${String(id)}`;
}

function isResponseFrame(frame: JsonObject): boolean {
  return Object.hasOwn(frame, "id") && !Object.hasOwn(frame, "method");
}

function peerFaultReason(fault: JsonRpcTerminalFault): AcpV1AdapterInterruptionReason {
  if (fault.type === "protocol_fault" || fault.type === "request_id_exhausted") {
    return "peer_fault";
  }
  switch (fault.fault.type) {
    case "decoder_fault":
      return "decoder_fault";
    case "stdout_eof":
      return "stdout_eof";
    case "process_exit":
    case "spawn_failure":
      return "process_fault";
    case "write_failure":
    case "write_timeout":
      return "write_fault";
    case "explicit_close":
      return "explicit_close";
  }
}

function adapterFaultDiagnostic(
  cause: unknown,
  faultStage: string,
  updateKind?: string,
): AcpV1AdapterFaultDiagnostic {
  if (cause instanceof AcpV1CodecError) {
    return Object.freeze({
      faultCode: cause.code,
      faultPath: cause.path.slice(0, 512),
      faultStage,
      ...(updateKind === undefined ? {} : { updateKind }),
    });
  }
  if (cause instanceof AcpV1AdapterError) {
    return Object.freeze({
      faultCode: cause.code,
      faultStage,
      ...(updateKind === undefined ? {} : { updateKind }),
    });
  }
  return Object.freeze({
    faultCode: cause instanceof Error ? cause.name.slice(0, 80) : typeof cause,
    faultStage,
    ...(updateKind === undefined ? {} : { updateKind }),
  });
}

function peerTerminalFaultDiagnostic(
  fault: JsonRpcTerminalFault,
): AcpV1AdapterFaultDiagnostic {
  if (fault.type === "protocol_fault") {
    return Object.freeze({ faultCode: fault.code, faultStage: "json_rpc_peer" });
  }
  if (fault.type === "request_id_exhausted") {
    return Object.freeze({ faultCode: fault.type, faultStage: "json_rpc_peer" });
  }
  return transportFaultDiagnostic(fault.fault);
}

function transportFaultDiagnostic(
  fault: JsonRpcTransportFault,
): AcpV1AdapterFaultDiagnostic {
  return Object.freeze({
    faultCode: fault.type === "decoder_fault" ? fault.code : fault.type,
    faultStage: "transport",
  });
}

function isSinkLikeFailure(cause: unknown): boolean {
  return cause instanceof AcpV1AdapterError && cause.code === "sink_commit_failed";
}

/** `-32602` carries `MODEL_SWITCH_INCOMPATIBLE_AGENT` (in `data` or `message`) after the first turn. */
function classifyConfigRefusal(cause: JsonRpcRemoteError): AcpV1ConfigRefusalReason {
  const { code, message, data } = cause.response;
  const evidence = `${message} ${typeof data === "string" ? data : JSON.stringify(data ?? "")}`.slice(0, 2_000);
  if (/MODEL_SWITCH_INCOMPATIBLE_AGENT/iu.test(evidence)) return "incompatible_agent";
  return code === -32602 ? "invalid_value" : "other";
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    freeze(child);
  }
  return Object.freeze(value);
}
