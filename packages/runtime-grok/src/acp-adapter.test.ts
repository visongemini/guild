import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { XaiSignalEnvelope } from "@guild/contracts";
import {
  AcpV1Adapter,
  AcpV1AdapterError,
  AcpV1ConfigOptionRefusedError,
  AcpV1ExtensionRequestError,
  type AcpV1AdapterOptions,
  type AcpV1AdapterSink,
  type AcpV1PeerPort,
  type AcpV1ProcessPort,
} from "./acp-adapter.js";
import { ACP_V1_METHODS } from "./acp-v1-methods.js";
import { ACP_V1_CODEC_LIMITS } from "./acp-v1-codec.js";
import {
  JsonRpcPeer,
  type JsonRpcFrameWriter,
  type JsonRpcRequestOptions,
} from "./json-rpc-peer.js";
import type { ProcessHostEvent } from "./process-host.js";

type WireMessage = Record<string, unknown>;
type SinkEvent<Name extends keyof AcpV1AdapterSink> =
  Parameters<NonNullable<AcpV1AdapterSink[Name]>>[0];

/** Signals the default RecordingSink observer collected; tests that read it run one at a time. */
const signals: XaiSignalEnvelope[] = [];

function officialModelState(): Record<string, unknown> {
  const efforts = (ids: readonly string[], descriptions: Readonly<Record<string, string>>) =>
    ids.map((id) => ({
      id,
      value: id,
      label: { xhigh: "Extra High", high: "High", medium: "Medium", low: "Low" }[id] ?? id,
      description: descriptions[id],
      default: id === "high",
    }));
  const descriptions = {
    xhigh: "Maximum reasoning for the hardest tasks.",
    high: "Thorough reasoning and quality. Recommended.",
    medium: "Strong quality with a faster turnaround.",
    low: "Fastest responses. Best for simple tasks.",
  };
  const meta = (ids: readonly string[]) => ({
    totalContextTokens: 256_000,
    agentType: "grok-build-plan",
    supportsReasoningEffort: true,
    reasoningEffort: "high",
    reasoningEfforts: efforts(ids, descriptions),
    contextWindows: [256_000, 500_000],
  });
  return {
    currentModelId: "grok-4.7",
    availableModels: [
      { modelId: "grok-4.7", name: "Grok 4.7", description: "SpaceXAI's latest frontier model", _meta: meta(["xhigh", "high", "medium", "low"]) },
      { modelId: "grok-4.7-build-fast", name: "Grok 4.7 Fast", description: "Fast variant. 2x the price.", _meta: meta(["xhigh", "high", "medium", "low"]) },
      { modelId: "grok-4.5", name: "Grok 4.5", _meta: meta(["high", "medium", "low"]) },
      { modelId: "MiniMax-M3", name: "MiniMax-M3", description: "OpenAI \u00b7 https://api.minimax.chat/v1", _meta: { totalContextTokens: 200_000, agentType: "grok-build-plan" } },
      { modelId: "ornith-1.5-35b-a3b-unc", name: "ornith", description: "OpenAI \u00b7 http://100.86.5.125:8080/v1", _meta: { totalContextTokens: 200_000 } },
    ],
  };
}

function officialConfigOptions(model: string, effort: string): unknown[] {
  return [
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: model,
      options: [
        { value: "grok-4.7", name: "Grok 4.7" },
        { value: "grok-4.7-build-fast", name: "Grok 4.7 Fast" },
        { value: "grok-4.5", name: "Grok 4.5" },
      ],
    },
    {
      id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select", currentValue: effort,
      options: [
        { value: "xhigh", name: "Extra High", description: "Maximum reasoning for the hardest tasks." },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
        { value: "low", name: "Low" },
      ],
    },
  ];
}

const clock = Object.freeze({
  monotonicMs: () => 123.5,
  wallClockIso: () => "2026-08-27T12:34:56.789Z",
});

const initializeResult = Object.freeze({
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { resume: {} },
  },
  authMethods: [{ id: "agent-auth", name: "Agent auth" }],
});

class FakeProcess implements AcpV1ProcessPort {
  readonly frames: string[] = [];
  readonly listeners = new Set<(event: ProcessHostEvent) => void>();
  rejectNextWrite = false;
  startEvent: ProcessHostEvent | undefined;
  startCalls = 0;
  stopCalls = 0;
  writeGate: Promise<void> | undefined;

  onEvent(listener: (event: ProcessHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<unknown> {
    this.startCalls += 1;
    if (this.startEvent !== undefined) this.emit(this.startEvent);
    return { type: "fake_started" };
  }

  async stop(): Promise<unknown> {
    this.stopCalls += 1;
    return { type: "fake_stopped" };
  }

  async waitForTermination(): Promise<unknown> {
    return { type: "fake_terminated" };
  }

  async write(data: string | Uint8Array): Promise<unknown> {
    if (this.rejectNextWrite) {
      this.rejectNextWrite = false;
      throw new Error("fake writer fault");
    }
    await this.writeGate;
    this.frames.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    return { type: "fake_write" };
  }

  emit(event: ProcessHostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  emitMessages(...messages: readonly WireMessage[]): void {
    this.emit({
      type: "stdout_data",
      chunk: Buffer.from(messages.map((message) => JSON.stringify(message)).join("\n") + "\n"),
    });
  }
}

class RecordingSink implements AcpV1AdapterSink {
  readonly order: string[] = [];
  readonly sessions: SinkEvent<"commitSessionEstablished">[] = [];
  readonly accepted: SinkEvent<"commitPromptAccepted">[] = [];
  readonly updates: SinkEvent<"commitUpdate">[] = [];
  readonly auxiliaryUpdates: SinkEvent<"commitAuxiliaryUpdate">[] = [];
  readonly permissionRequests: SinkEvent<"preparePermissionResponse">[] = [];
  readonly permissionFlushes: SinkEvent<"commitPermissionResponseFlushed">[] = [];
  readonly terminals: SinkEvent<"commitPromptTerminal">[] = [];
  readonly cancellations: SinkEvent<"commitCancelSent">[] = [];
  readonly interruptions: SinkEvent<"commitTransportInterrupted">[] = [];
  readonly barriers: SinkEvent<"beginReplayBarrier">[] = [];
  observeSignal?: (envelope: XaiSignalEnvelope) => void = (envelope) => {
    signals.push(envelope);
  };
  sessionGate: Promise<void> | undefined;
  liveUpdateGate: Promise<void> | undefined;
  promptGate: Promise<void> | undefined;
  rejectPromptAcceptance = false;
  permissionGate: Promise<void> | undefined;
  permissionAbortOnSignal = false;
  permissionFlushGate: Promise<void> | undefined;
  permissionFlushStarted = 0;
  rejectPermissionFlush = false;
  replayBarrierResult: { readonly barrierId: string } | undefined;
  replayCommitGate: Promise<void> | undefined;
  replayUpdateGate: Promise<void> | undefined;
  terminalGate: Promise<void> | undefined;
  terminalStarted = 0;
  rejectTerminal = false;
  rejectInterruption = false;
  prepared: Awaited<ReturnType<AcpV1AdapterSink["preparePermissionResponse"]>> = {
    decision: { type: "selected", optionId: "allow" },
    delivery: {
      commandId: "permission-command-1",
      version: 1,
      deliveryAttemptId: "permission-attempt-1",
    },
  };

  async commitSessionEstablished(event: SinkEvent<"commitSessionEstablished">): Promise<void> {
    this.sessions.push(event);
    this.order.push(`session:${event.establishedBy}`);
    await this.sessionGate;
  }

  async commitPromptAccepted(event: SinkEvent<"commitPromptAccepted">): Promise<void> {
    this.accepted.push(event);
    this.order.push("prompt:accepted");
    await this.promptGate;
    if (this.rejectPromptAcceptance) throw new Error("fake prompt acceptance persistence failure");
  }

  async commitUpdate(event: SinkEvent<"commitUpdate">): Promise<void> {
    this.updates.push(event);
    this.order.push(`update:${event.ingestMode}`);
    if (event.ingestMode === "replay") await this.replayUpdateGate;
    else await this.liveUpdateGate;
  }

  async commitAuxiliaryUpdate(event: SinkEvent<"commitAuxiliaryUpdate">): Promise<void> {
    this.auxiliaryUpdates.push(event);
    this.order.push("update:auxiliary");
  }

  async preparePermissionResponse(event: SinkEvent<"preparePermissionResponse">): Promise<
    Awaited<ReturnType<AcpV1AdapterSink["preparePermissionResponse"]>>
  > {
    this.permissionRequests.push(event);
    this.order.push("permission:awaiting");
    if (this.permissionAbortOnSignal) {
      await abortableGate(this.permissionGate, event.signal);
    } else {
      await this.permissionGate;
    }
    this.order.push("permission:prepared");
    return this.prepared;
  }

  async commitPermissionResponseFlushed(
    event: SinkEvent<"commitPermissionResponseFlushed">,
  ): Promise<void> {
    this.permissionFlushStarted += 1;
    await this.permissionFlushGate;
    if (this.rejectPermissionFlush) throw new Error("fake permission flush fault");
    this.permissionFlushes.push(event);
    this.order.push("permission:flushed");
  }

  async commitPromptTerminal(event: SinkEvent<"commitPromptTerminal">): Promise<void> {
    this.terminalStarted += 1;
    await this.terminalGate;
    if (this.rejectTerminal) throw new Error("fake terminal persistence fault");
    this.terminals.push(event);
    this.order.push("prompt:terminal");
  }

  async commitCancelSent(event: SinkEvent<"commitCancelSent">): Promise<void> {
    this.cancellations.push(event);
    this.order.push("cancel:sent");
  }

  async commitTransportInterrupted(
    event: SinkEvent<"commitTransportInterrupted">,
  ): Promise<void> {
    if (this.rejectInterruption) throw new Error("fake interruption persistence fault");
    this.interruptions.push(event);
    this.order.push(`interrupted:${event.reason}`);
  }

  async beginReplayBarrier(event: SinkEvent<"beginReplayBarrier">): Promise<{ barrierId: string }> {
    this.barriers.push(event);
    this.order.push("barrier:begin");
    return this.replayBarrierResult ?? Object.freeze({ barrierId: `barrier-${this.barriers.length}` });
  }

  async commitReplayBarrier(event: SinkEvent<"commitReplayBarrier">): Promise<void> {
    this.order.push(`barrier:commit:${event.barrier.barrierId}`);
    await this.replayCommitGate;
  }

  async abortReplayBarrier(event: SinkEvent<"abortReplayBarrier">): Promise<void> {
    this.order.push(`barrier:abort:${event.barrier.barrierId}`);
  }
}

type RequestObservation = {
  readonly method: string;
  readonly options: JsonRpcRequestOptions | undefined;
};

function observingPeerFactory(observations: RequestObservation[]): AcpV1AdapterOptions["peerFactory"] {
  return (write: JsonRpcFrameWriter): AcpV1PeerPort => {
    const peer = new JsonRpcPeer({ write, requestTimeoutMs: 1_000, writeTimeoutMs: 1_000 });
    return {
      close: peer.close.bind(peer),
      failTransport: peer.failTransport.bind(peer),
      onDiagnostic: peer.onDiagnostic.bind(peer),
      onInboundResponseWrite: peer.onInboundResponseWrite.bind(peer),
      receive: peer.receive.bind(peer),
      sendNotification: peer.sendNotification.bind(peer),
      sendRequest(method, params, options) {
        observations.push({ method, options });
        return peer.sendRequest(method, params, options);
      },
      setNotificationHandler: peer.setNotificationHandler.bind(peer),
      setRequestHandler: peer.setRequestHandler.bind(peer),
    };
  };
}

function options(
  process: FakeProcess,
  sink: RecordingSink,
  overrides: Partial<AcpV1AdapterOptions> = {},
): AcpV1AdapterOptions {
  return {
    adapterEpoch: 7,
    clock,
    process,
    sink,
    timeouts: { authenticateMs: 61, initializeMs: 62, sessionMs: 63, writeMs: 64 },
    ...overrides,
  };
}

async function startAdapter(
  process: FakeProcess,
  sink: RecordingSink,
  overrides: Partial<AcpV1AdapterOptions> = {},
  advertisedInitializeResult: unknown = initializeResult,
): Promise<AcpV1Adapter> {
  const adapter = new AcpV1Adapter(options(process, sink, overrides));
  const starting = adapter.start();
  const initialize = await waitForOutbound(process, ACP_V1_METHODS.initialize);
  assert.deepEqual(initialize.params, {
    protocolVersion: 1,
    clientCapabilities: {
      session: { configOptions: { boolean: {} } },
    },
    clientInfo: { name: "guild", title: "Guild", version: "2.0.31" },
  });
  process.emitMessages({ jsonrpc: "2.0", id: initialize.id, result: advertisedInitializeResult });
  await starting;
  return adapter;
}

async function newSession(
  adapter: AcpV1Adapter,
  process: FakeProcess,
  sessionId = "session-1",
): Promise<Awaited<ReturnType<AcpV1Adapter["newSession"]>>> {
  const operation = adapter.newSession("/tmp/project");
  const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
  process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { sessionId } });
  return operation;
}

function textUpdate(sessionId: string, text: string): WireMessage {
  return {
    jsonrpc: "2.0",
    method: ACP_V1_METHODS.sessionUpdate,
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
}

function permissionRequest(sessionId: string, id: number | string | null): WireMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: ACP_V1_METHODS.sessionRequestPermission,
    params: {
      sessionId,
      toolCall: { toolCallId: "tool-1", title: "Read settings" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  };
}

async function waitForOutbound(
  process: FakeProcess,
  method: string,
  occurrence = 0,
): Promise<WireMessage> {
  return bounded(async () => {
    for (;;) {
      const matches = process.frames.map(wireMessage).filter((message) => message.method === method);
      if (matches[occurrence] !== undefined) return matches[occurrence];
      await immediate();
    }
  });
}

async function waitFor(
  predicate: () => boolean,
): Promise<void> {
  await bounded(async () => {
    while (!predicate()) await immediate();
  });
}

async function bounded<T>(operation: () => Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test operation timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function wireMessage(frame: string): WireMessage {
  assert.equal(frame.endsWith("\n"), true);
  return JSON.parse(frame.slice(0, -1)) as WireMessage;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function zeroTrapProxy<T extends object>(target: T, onTrap: () => void): T {
  return new Proxy(target, {
    get(targetObject, property, receiver) {
      if (property === "then") return undefined;
      onTrap();
      return Reflect.get(targetObject, property, receiver) as unknown;
    },
    getOwnPropertyDescriptor(targetObject, property) {
      onTrap();
      return Reflect.getOwnPropertyDescriptor(targetObject, property);
    },
    getPrototypeOf(targetObject) {
      onTrap();
      return Reflect.getPrototypeOf(targetObject);
    },
    ownKeys(targetObject) {
      onTrap();
      return Reflect.ownKeys(targetObject);
    },
  });
}

function abortableGate(gate: Promise<void> | undefined, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve(gate).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

function hasAdapterCode(code: AcpV1AdapterError["code"]): (cause: unknown) => boolean {
  return (cause) => cause instanceof AcpV1AdapterError && cause.code === code;
}

describe("ACP v1 adapter initialization and durable session establishment", () => {
  it("fetches official account usage only through the Grok ACP extension", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);

    const fetching = adapter.officialBilling();
    const request = await waitForOutbound(process, ACP_V1_METHODS.officialBilling);
    assert.deepEqual(request.params, {});
    process.emitMessages({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        config: {
          creditUsagePercent: 4,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: "2026-09-01T01:00:29.066410+00:00",
          },
        },
      },
    });
    assert.deepEqual(await fetching, {
      creditUsagePercent: 4,
      periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      periodEndIso: "2026-09-01T01:00:29.066410+00:00",
    });
    await adapter.close();
  });

  it("probes liveness with a local round trip that counts any JSON-RPC answer as alive", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);

    const probing = adapter.probeLiveness(500);
    const request = await waitForOutbound(process, "_guild/ping");
    assert.deepEqual(request.params, {});
    process.emitMessages({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" },
    });
    assert.equal(await probing, true);
    assert.equal(adapter.state, "ready");

    const second = adapter.probeLiveness(500);
    const next = await waitForOutbound(process, "_guild/ping", 1);
    process.emitMessages({ jsonrpc: "2.0", id: next.id, result: {} });
    assert.equal(await second, true);
    await adapter.close();
  });

  it("reports an unresponsive process without faulting or closing the adapter", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);

    assert.equal(await adapter.probeLiveness(20), false);
    assert.equal(adapter.state, "ready", "a missed probe is evidence for the caller, not a fault");
    assert.equal(process.stopCalls, 0);
    process.rejectNextWrite = true;
    assert.equal(await adapter.probeLiveness(500), false);
    await adapter.close();
    assert.equal(await adapter.probeLiveness(500), false);
  });

  it("applies model and reasoning effort through session/set_config_option and context window through set_model", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);

    const selectingContext = adapter.setModel(session, "grok-4.7", {
      reasoningEffort: "medium",
      contextWindow: 500_000,
    });
    const model = await waitForOutbound(process, ACP_V1_METHODS.sessionSetModel);
    assert.deepEqual(model.params, {
      sessionId: "session-1",
      modelId: "grok-4.7",
      _meta: { reasoningEffort: "medium", contextWindow: 500_000 },
    });
    process.emitMessages({ jsonrpc: "2.0", id: model.id, result: { _meta: { model: { Ok: "grok-4.7" } } } });
    await selectingContext;
    await assert.rejects(adapter.setModel(session, "MiniMax-M3"), /invalid_grok_model/u);
    await assert.rejects(adapter.setModel(session, "grok-4.7", { contextWindow: 0 }), /invalid_grok_context_window/u);

    const selectingEffort = adapter.setConfigOption(session, "reasoning_effort", "low");
    const effort = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption);
    assert.deepEqual(effort.params, {
      sessionId: "session-1",
      configId: "reasoning_effort",
      value: "low",
    });
    process.emitMessages({
      jsonrpc: "2.0",
      id: effort.id,
      result: {
        configOptions: [
          {
            id: "model", name: "Model", category: "model", type: "select", currentValue: "grok-4.7",
            options: [{ value: "grok-4.7", name: "Grok 4.7" }],
          },
          {
            id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select",
            currentValue: "low",
            options: [{ value: "high", name: "High" }, { value: "low", name: "Low" }],
          },
        ],
      },
    });
    const options = await selectingEffort;
    assert.deepEqual(options.map((option) => [option.id, option.currentValue]), [
      ["model", "grok-4.7"],
      ["reasoning_effort", "low"],
    ]);

    const selectingConfig = adapter.setConfigOption(session, "web-search", false);
    const config = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption, 1);
    assert.deepEqual(config.params, {
      sessionId: "session-1",
      configId: "web-search",
      type: "boolean",
      value: false,
    });
    process.emitMessages({
      jsonrpc: "2.0",
      id: config.id,
      result: {
        configOptions: [{ id: "web-search", name: "Web search", type: "boolean", currentValue: false }],
      },
    });
    assert.deepEqual(await selectingConfig, [{
      id: "web-search",
      name: "Web search",
      type: "boolean",
      currentValue: false,
    }]);
    await adapter.close();
  });

  it("returns config options only after earlier config_option_update snapshots were committed, so a stale snapshot cannot overwrite them", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const gate = deferred<void>();
    sink.liveUpdateGate = gate.promise;

    const changing = adapter.setConfigOption(session, "reasoning_effort", "medium");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption);
    let resolved = false;
    void changing.then(() => { resolved = true; });
    // Wire order: the snapshot of the PREVIOUS change (effort still low), then this change's response.
    process.emitMessages(
      {
        jsonrpc: "2.0",
        method: ACP_V1_METHODS.sessionUpdate,
        params: {
          sessionId: "session-1",
          update: { sessionUpdate: "config_option_update", configOptions: officialConfigOptions("grok-4.5", "low") },
        },
      },
      { jsonrpc: "2.0", id: request.id, result: { configOptions: officialConfigOptions("grok-4.5", "medium") } },
    );
    await waitFor(() => sink.updates.length === 1);
    await immediate();
    assert.equal(resolved, false, "the change is not reported before the earlier snapshot is committed");
    gate.resolve();
    const options = await changing;
    assert.equal(resolved, true);
    assert.equal(sink.updates.length, 1, "the stale snapshot was committed first");
    assert.equal(options.find((option) => option.id === "reasoning_effort")?.currentValue, "medium");
    await adapter.close();
  });

  it("reports a runtime refusal of a config change without faulting the session, classifying the switch refusal", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);

    const refuse = async (error: Record<string, unknown>, occurrence: number) => {
      const operation = adapter.setConfigOption(session, "model", "grok-4.6");
      const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption, occurrence);
      process.emitMessages({ jsonrpc: "2.0", id: request.id, error });
      return operation;
    };
    const refusal = (reason: string, remoteCode: number) => (cause: unknown) =>
      cause instanceof AcpV1ConfigOptionRefusedError &&
      cause.code === "config_option_refused" &&
      cause.reason === reason &&
      cause.remoteCode === remoteCode;

    await assert.rejects(
      refuse({ code: -32602, message: "Invalid params", data: "MODEL_SWITCH_INCOMPATIBLE_AGENT: agent type differs" }, 0),
      refusal("incompatible_agent", -32602),
    );
    await assert.rejects(
      refuse({ code: -32602, message: "Invalid params", data: { code: "MODEL_SWITCH_INCOMPATIBLE_AGENT" } }, 1),
      refusal("incompatible_agent", -32602),
    );
    await assert.rejects(
      refuse({ code: -32602, message: "Invalid params", data: "unknown model id" }, 2),
      refusal("invalid_value", -32602),
    );
    await assert.rejects(
      refuse({ code: -32603, message: "Internal error" }, 3),
      refusal("other", -32603),
    );
    assert.equal(adapter.state, "ready", "a refused switch keeps the adapter and the session usable");
    assert.equal(process.stopCalls, 0);

    const prompting = adapter.prompt(session, "hello");
    const prompt = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await assert.rejects(
      adapter.setConfigOption(session, "model", "grok-4.6"),
      hasAdapterCode("overlapping_prompt"),
    );
    await assert.rejects(adapter.setModel(session, "grok-4.6"), hasAdapterCode("overlapping_prompt"));
    process.emitMessages({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await prompting;
    await adapter.close();
  });

  it("passes the reasoning effort in _meta on session/new and session/resume", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);

    const creating = adapter.newSession("/tmp/project", { reasoningEffort: "high" });
    const create = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
    assert.deepEqual(create.params, {
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { reasoningEffort: "high" },
    });
    process.emitMessages({ jsonrpc: "2.0", id: create.id, result: { sessionId: "session-1" } });
    await creating;

    const resuming = adapter.resumeSession("session-2", "/tmp/project", { reasoningEffort: "medium" });
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    assert.deepEqual(resume.params, {
      sessionId: "session-2",
      cwd: "/tmp/project",
      mcpServers: [],
      _meta: { reasoningEffort: "medium" },
    });
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: {} });
    await resuming;

    const frames = process.frames.length;
    await assert.rejects(
      adapter.newSession("/tmp/project", { reasoningEffort: "Extra High" }),
      hasAdapterCode("operation_failed"),
    );
    assert.equal(process.frames.length, frames, "an invalid effort is rejected before anything is written");
    await adapter.close();
  });

  it("decodes the official model list from initialize, session/new and later updates, keeping only official models", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const advertised = officialModelState();
    const adapter = await startAdapter(process, sink, {}, {
      ...initializeResult,
      _meta: { modelState: advertised },
    });
    const initialized = await adapter.start();
    assert.deepEqual(initialized.modelCatalog?.models.map((model) => model.id), [
      "grok-4.7", "grok-4.7-build-fast", "grok-4.5",
    ]);
    assert.equal(initialized.modelCatalog?.runtimeDefaultModelId, "grok-4.7");
    const fast = initialized.modelCatalog?.models[1];
    assert.equal(fast?.name, "Grok 4.7 Fast");
    assert.equal(fast?.description, "Fast variant. 2x the price.");
    assert.deepEqual(fast?.contextWindows, [256_000, 500_000]);
    assert.deepEqual(fast?.reasoningEfforts.map((effort) => [effort.id, effort.label, effort.isDefault]), [
      ["xhigh", "Extra High", false],
      ["high", "High", true],
      ["medium", "Medium", false],
      ["low", "Low", false],
    ]);
    assert.equal(fast?.reasoningEfforts[1]?.description, "Thorough reasoning and quality. Recommended.");
    assert.deepEqual(initialized.modelCatalog?.models[2]?.reasoningEfforts.map((effort) => effort.id), ["high", "medium", "low"]);
    assert.doesNotMatch(JSON.stringify(initialized.modelCatalog), /MiniMax|ornith|api\.minimax|100\.86/u);

    const creating = adapter.newSession("/tmp/project");
    const create = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
    process.emitMessages({
      jsonrpc: "2.0",
      id: create.id,
      result: {
        sessionId: "session-1",
        models: advertised,
        configOptions: officialConfigOptions("grok-4.7", "high"),
      },
    });
    const session = await creating;
    assert.deepEqual(session.modelCatalog, initialized.modelCatalog);
    assert.equal(session.contextWindowSize, 256_000);
    assert.deepEqual(
      session.configOptions?.map((option) => [option.id, option.category, option.currentValue]),
      [["model", "model", "grok-4.7"], ["reasoning_effort", "thought_level", "high"]],
    );
    assert.deepEqual(sink.sessions[0]?.state.modelCatalog, initialized.modelCatalog);

    // A live selection change arrives as a standard config_option_update.
    process.emitMessages({
      jsonrpc: "2.0",
      method: ACP_V1_METHODS.sessionUpdate,
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "config_option_update", configOptions: officialConfigOptions("grok-4.7-build-fast", "low") },
      },
    });
    await waitFor(() => sink.updates.length === 1);
    const update = sink.updates[0]?.update;
    assert.equal(update?.type, "session_context");
    assert.equal(update?.type === "session_context" && update.payload.context.kind, "config");
    await adapter.close();
  });

  it("probes an unadvertised extension once, treats -32601 as unsupported, and validates the method name", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);

    const unsupported = adapter.sendExtensionRequest("_x.ai/interject", { sessionId: "session-1", text: "x" });
    const first = await waitForOutbound(process, "_x.ai/interject");
    assert.deepEqual(first.params, { sessionId: "session-1", text: "x" });
    process.emitMessages({ jsonrpc: "2.0", id: first.id, error: { code: -32601, message: "Method not found" } });
    assert.deepEqual(await unsupported, { status: "unsupported" });
    const frames = process.frames.length;
    assert.deepEqual(await adapter.sendExtensionRequest("_x.ai/interject", { sessionId: "session-1", text: "y" }), { status: "unsupported" });
    assert.equal(process.frames.length, frames, "the second call is answered from the per-process memory");

    const supported = adapter.sendExtensionRequest("_x.ai/rewind/points", { sessionId: "session-1" });
    const points = await waitForOutbound(process, "_x.ai/rewind/points");
    process.emitMessages({ jsonrpc: "2.0", id: points.id, result: { rewind_points: [] } });
    assert.deepEqual(await supported, { status: "ok", result: { rewind_points: [] } });

    const failing = adapter.sendExtensionRequest("_x.ai/rewind/execute", { sessionId: "session-1" });
    const execute = await waitForOutbound(process, "_x.ai/rewind/execute");
    process.emitMessages({ jsonrpc: "2.0", id: execute.id, error: { code: -32602, message: "Invalid params" } });
    await assert.rejects(failing, (cause) =>
      cause instanceof AcpV1ExtensionRequestError && cause.remoteCode === -32602 && cause.code === "extension_request_failed");
    assert.equal(adapter.state, "ready");

    const written = process.frames.length;
    for (const bad of ["x.ai/interject", "session/prompt", "_x.ai/", "_x.ai/Upper", "_x.ai/../x", "_x.ai/a b", "_x.ai/a/b/c/d/e"]) {
      await assert.rejects(adapter.sendExtensionRequest(bad, {}), hasAdapterCode("invalid_adapter_options"), bad);
    }
    assert.equal(process.frames.length, written, "invalid extension names are never written");
    await adapter.close();
  });

  it("turns only the allowlisted _x.ai notifications into bounded signals and never stores the rest", async () => {
    signals.length = 0;
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const notify = (method: string, params: unknown) =>
      process.emitMessages({ jsonrpc: "2.0", method, params } as WireMessage);
    const sessionNotification = (update: Record<string, unknown>) =>
      notify("_x.ai/session_notification", { sessionId: "session-1", update, _meta: { eventId: "e-1" } });

    notify("_x.ai/session/setup", { method: "session/new", phase: "mcp_merge", sessionId: null });
    notify("_x.ai/mcp/init_progress", { total: 7, connected: 3, sessionId: "session-1" });
    notify("_x.ai/sessions/changed", {
      upserted: [{ sessionId: "session-1", activity: "working", cwd: "/secret/path", title: "private title", modelId: "grok-4.7", origin: { kind: "local" } }],
      removed: [],
    });
    notify("_x.ai/queue/changed", {
      sessionId: "session-1",
      entries: [{ id: "p-1", version: 0, kind: "prompt", text: "PRIVATE PROMPT TEXT", position: 1 }],
      runningPromptId: "p-0",
      runningText: "PRIVATE RUNNING TEXT",
    });
    sessionNotification({ sessionUpdate: "hook_run_started", event_name: "user_prompt_submit", prompt_id: "p-1", count: 2 });
    sessionNotification({
      sessionUpdate: "hook_execution",
      event_name: "user_prompt_submit",
      runs: [
        { name: "plugin/private-hook-name:user_prompt_submit[0]", status: { status: "success", elapsed_ms: 7965 } },
        { name: "global/other-hook", status: { status: "failed", elapsed_ms: 12 } },
      ],
    });
    sessionNotification({ sessionUpdate: "tool_call_delta_chunk", tool_call_id: "c-1", tool_index: 0, name: "run_terminal_command" });
    sessionNotification({ sessionUpdate: "pending_interaction", tool_call_id: "c-1", kind: "permission" });
    sessionNotification({ sessionUpdate: "interaction_resolved", tool_call_id: "c-1" });
    sessionNotification({ sessionUpdate: "retry_state", type: "retrying", attempt: 1, max_retries: 15, reason: "reqwest error stream: SECRET-HOST-DETAIL", error_type: "http" });
    sessionNotification({ sessionUpdate: "response_completed", usage: { input_tokens: 5 }, signature: "SIGNATURE-BLOB" });
    sessionNotification({ sessionUpdate: "turn_completed", prompt_id: "p-1", stop_reason: "end_turn", usage: { inputTokens: 1 } });
    sessionNotification({ sessionUpdate: "model_changed", model_id: "grok-4.7", reasoning_effort: "high" });
    notify("_x.ai/session/prompt_complete", { sessionId: "session-1", promptId: "p-1", stopReason: "end_turn", agentResult: { secret: "AGENT-RESULT" } });
    notify("_x.ai/models/update", officialModelState());

    // Everything below must be ignored without ever reaching the sink.
    notify("_x.ai/mcp/servers_updated", { servers: [{ name: "github", env: { GITHUB_TOKEN: "ghp_PLAINTEXT_SECRET" } }] });
    notify("_x.ai/settings/update", { tips: ["private tip"] });
    notify("_x.ai/announcements/update", { announcements: [{ message: "hello" }] });
    notify("_x.ai/mcp/server_status", { sessionId: "session-1", name: "github", detail: "PRIVATE DETAIL" });
    notify("_x.ai/session/interjection", { sessionId: "session-1", text: "PRIVATE STEER", interjectionId: "i-1" });
    notify("_x.ai/unknown/future", { sessionId: "session-1", anything: "PRIVATE" });
    sessionNotification({ sessionUpdate: "session_summary_generated", session_summary: "PRIVATE SUMMARY" });
    sessionNotification({ sessionUpdate: "future_subtype", payload: "PRIVATE" });
    notify("not-an-extension/queue/changed", { entries: [] });
    sessionNotification({ sessionUpdate: "hook_run_started", event_name: "", count: -1 });
    await waitFor(() => signals.length >= 14);
    await immediate();

    const kinds = signals.map((envelope) => envelope.signal.kind);
    assert.deepEqual(kinds, [
      "session_setup", "mcp_init_progress", "sessions_changed", "queue_changed", "hook_run_started",
      "hook_execution", "tool_call_delta_chunk", "pending_interaction", "interaction_resolved",
      "retry_state", "response_completed", "turn_completed", "model_changed", "prompt_complete",
      "models_update",
    ]);
    const byKind = Object.fromEntries(signals.map((envelope) => [envelope.signal.kind, envelope]));
    assert.deepEqual(byKind["session_setup"], { sessionId: null, signal: { kind: "session_setup", phase: "mcp_merge" }, receivedMonotonicMs: 123.5 });
    assert.deepEqual(byKind["mcp_init_progress"]?.signal, { kind: "mcp_init_progress", connected: 3, total: 7 });
    assert.deepEqual(byKind["sessions_changed"]?.signal, { kind: "sessions_changed", sessions: [{ sessionId: "session-1", activity: "working" }] });
    assert.equal(byKind["sessions_changed"]?.sessionId, null);
    assert.deepEqual(byKind["queue_changed"]?.signal, { kind: "queue_changed", queued: 1, firstPosition: 1, running: true });
    assert.deepEqual(byKind["hook_run_started"]?.signal, { kind: "hook_run_started", event: "user_prompt_submit", count: 2 });
    assert.deepEqual(byKind["hook_execution"]?.signal, { kind: "hook_execution", event: "user_prompt_submit", runs: 2, failed: 1, maxElapsedMs: 7965 });
    assert.deepEqual(byKind["tool_call_delta_chunk"]?.signal, { kind: "tool_call_delta_chunk", toolName: "run_terminal_command" });
    assert.deepEqual(byKind["pending_interaction"]?.signal, { kind: "pending_interaction", interaction: "permission" });
    assert.deepEqual(byKind["retry_state"]?.signal, { kind: "retry_state", active: true, attempt: 1, maxRetries: 15, errorType: "http" });
    assert.deepEqual(byKind["turn_completed"]?.signal, { kind: "turn_completed", stopReason: "end_turn" });
    assert.deepEqual(byKind["model_changed"]?.signal, { kind: "model_changed", modelId: "grok-4.7", reasoningEffort: "high" });
    assert.deepEqual(byKind["prompt_complete"]?.signal, { kind: "prompt_complete", stopReason: "end_turn" });
    assert.equal(byKind["models_update"]?.sessionId, null);
    assert.equal(byKind["models_update"]?.signal.kind === "models_update" && byKind["models_update"].signal.catalog.models.length, 3);
    assert.equal(byKind["queue_changed"]?.sessionId, "session-1");

    const serialized = JSON.stringify(signals);
    for (const secret of [
      "PRIVATE", "SECRET-HOST-DETAIL", "SIGNATURE-BLOB", "AGENT-RESULT", "ghp_PLAINTEXT_SECRET", "GITHUB_TOKEN",
      "private-hook-name", "/secret/path", "private title", "reqwest",
    ]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(sink.updates.length, 0, "extension signals are never committed as conversation updates");
    assert.equal(adapter.state, "ready");
    void session;
    await adapter.close();
  });

  it("keeps working when the sink throws from a signal observer or has none", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    sink.observeSignal = () => {
      throw new Error("observer fault");
    };
    const adapter = await startAdapter(process, sink);
    process.emitMessages({ jsonrpc: "2.0", method: "_x.ai/session/setup", params: { phase: "auth", sessionId: null } } as WireMessage);
    await immediate();
    assert.equal(adapter.state, "ready");
    await adapter.close();

    const quietProcess = new FakeProcess();
    const quietSink = new RecordingSink();
    delete (quietSink as { observeSignal?: unknown }).observeSignal;
    const quiet = await startAdapter(quietProcess, quietSink);
    quietProcess.emitMessages({ jsonrpc: "2.0", method: "_x.ai/session/setup", params: { phase: "auth", sessionId: null } } as WireMessage);
    await immediate();
    assert.equal(quiet.state, "ready");
    await quiet.close();
  });

  it("uses finite initialize/auth/new deadlines, exact auth provenance, and withholds the session until sink commit", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const observations: RequestObservation[] = [];
    const gate = deferred<void>();
    sink.sessionGate = gate.promise;
    const adapter = await startAdapter(process, sink, {
      peerFactory: observingPeerFactory(observations),
    });

    assert.deepEqual(process.frames.map(wireMessage).map((message) => message.method), ["initialize"]);
    const authenticating = adapter.authenticate("agent-auth");
    const auth = await waitForOutbound(process, ACP_V1_METHODS.authenticate);
    assert.deepEqual(auth.params, { methodId: "agent-auth" });
    process.emitMessages({ jsonrpc: "2.0", id: auth.id, result: {} });
    await authenticating;

    let established = false;
    const creating = adapter.newSession("/tmp/project").then((session) => {
      established = true;
      return session;
    });
    const create = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
    assert.deepEqual(create.params, { cwd: "/tmp/project", mcpServers: [] });
    process.emitMessages(
      { jsonrpc: "2.0", id: create.id, result: { sessionId: "session-1" } },
      {
        jsonrpc: "2.0",
        method: ACP_V1_METHODS.sessionUpdate,
        params: {
          sessionId: "session-1",
          update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
        },
      },
    );
    await waitFor(() => sink.sessions.length === 1);
    assert.equal(established, false);
    assert.equal(sink.updates.length, 0);
    gate.resolve();
    const session = await creating;
    await waitFor(() => sink.updates.length === 1);
    assert.deepEqual(sink.sessions[0]?.state, {});
    assert.deepEqual(session, {
      adapterEpoch: 7,
      sessionId: "session-1",
      establishedBy: "new",
    });
    assert.equal(Object.isFrozen(session), true);
    assert.deepEqual(
      observations.map(({ method, options }) => [method, options?.responseTimeoutMs]),
      [
        ["initialize", 62],
        ["authenticate", 61],
        ["session/new", 63],
      ],
    );
    await adapter.close();
  });

  it("buffers bounded session context emitted before the session/new response", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);

    const creating = adapter.newSession("/tmp/project");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
    process.emitMessages(
      {
        jsonrpc: "2.0",
        method: ACP_V1_METHODS.sessionUpdate,
        params: {
          sessionId: "session-early",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "context", description: "Show context" }],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: request.id,
        result: { sessionId: "session-early" },
      },
    );

    const session = await creating;
    await waitFor(() => sink.updates.length === 1);
    assert.equal(session.sessionId, "session-early");
    assert.equal(sink.updates[0]?.update.type, "session_context");
    assert.deepEqual(sink.order.slice(0, 2), ["session:new", "update:live"]);
    await adapter.close();
  });

  it("drops an undecodable command list without ending the session", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    await newSession(adapter, process, "session-commands");
    process.emitMessages({
      jsonrpc: "2.0",
      method: ACP_V1_METHODS.sessionUpdate,
      params: {
        sessionId: "session-commands",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: 42, description: "Not a valid command" }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("does not write initialize after an immediate process-exit event during start", async () => {
    const process = new FakeProcess();
    process.startEvent = { type: "process_exit", code: 9, signal: null };
    const sink = new RecordingSink();
    const adapter = new AcpV1Adapter(options(process, sink));
    await assert.rejects(adapter.start(), hasAdapterCode("transport_lost"));
    assert.equal(process.frames.length, 0);
    assert.equal(process.stopCalls > 0, true);
  });

  it("terminalizes the epoch when session/new reuses a server-issued session ID", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    await newSession(adapter, process, "duplicate-session");
    const duplicate = adapter.newSession("/tmp/project");
    void duplicate.catch(() => undefined);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew, 1);
    process.emitMessages({
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId: "duplicate-session" },
    });
    await assert.rejects(duplicate, hasAdapterCode("protocol_fault"));
    assert.equal(adapter.state, "faulted");
    await adapter.interrupted;
  });
});

describe("ACP v1 adapter prompt correlation", () => {
  it("sends file resource links only when embedded context is advertised", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink, {}, {
      ...initializeResult,
      agentCapabilities: {
        ...initializeResult.agentCapabilities,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
      },
    });
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "Review it", [{
      name: "README.md",
      uri: "file:///tmp/project/README.md",
      mimeType: "text/markdown",
      size: 42,
    }]);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    assert.deepEqual(request.params, {
      sessionId: "session-1",
      prompt: [
        { type: "text", text: "Review it" },
        {
          type: "resource_link",
          name: "README.md",
          uri: "file:///tmp/project/README.md",
          mimeType: "text/markdown",
          size: 42,
        },
      ],
    });
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    await prompting;
    await adapter.close();

    const unsupportedProcess = new FakeProcess();
    const unsupported = await startAdapter(unsupportedProcess, new RecordingSink());
    const unsupportedSession = await newSession(unsupported, unsupportedProcess);
    const frameCount = unsupportedProcess.frames.length;
    await assert.rejects(
      unsupported.prompt(unsupportedSession, "Review it", [{ name: "a", uri: "file:///tmp/a" }]),
      hasAdapterCode("capability_not_advertised"),
    );
    assert.equal(unsupportedProcess.frames.length, frameCount);
    await unsupported.close();
  });

  it("drops unknown extension notifications without exposing their environment payload", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const before = JSON.stringify(sink);
    process.emitMessages({
      jsonrpc: "2.0",
      method: "_x.ai/mcp/servers_updated",
      params: {
        servers: [{ name: "fake", env: { GITHUB_TOKEN: "fake-secret-must-not-survive" } }],
      },
    });
    await immediate();
    assert.equal(adapter.state, "ready");
    assert.equal(JSON.stringify(sink), before);
    assert.doesNotMatch(JSON.stringify(sink), /fake-secret-must-not-survive/u);
    await adapter.close();
  });

  it("keeps an active prompt alive when Grok emits an orphan response", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "survive orphan response");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages({ jsonrpc: "2.0", id: 9_999, result: null });
    await immediate();
    assert.equal(adapter.state, "ready");
    assert.equal(sink.interruptions.length, 0);

    process.emitMessages(
      textUpdate("session-1", "still connected"),
      { jsonrpc: "2.0", id: promptRequest.id, result: { stopReason: "end_turn" } },
    );
    assert.equal((await prompting).classification, "completed");
    assert.equal(sink.updates.at(-1)?.update.type, "turn");
    assert.equal(sink.terminals.length, 1);
    assert.equal(sink.interruptions.length, 0);
    await adapter.close();
  });

  it("supports two turns on one session, rejects overlap, and keeps cancel nonterminal", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const observations: RequestObservation[] = [];
    const adapter = await startAdapter(process, sink, {
      peerFactory: observingPeerFactory(observations),
    });
    const session = await newSession(adapter, process);

    let firstSettled = false;
    const first = adapter.prompt(session, "first").then((terminal) => {
      firstSettled = true;
      return terminal;
    });
    const firstRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);
    await assert.rejects(adapter.prompt(session, "overlap"), hasAdapterCode("overlapping_prompt"));

    const cancel = await adapter.cancel(session);
    const cancelMessage = await waitForOutbound(process, ACP_V1_METHODS.sessionCancel);
    assert.equal(Object.hasOwn(cancelMessage, "id"), false);
    assert.deepEqual(cancelMessage.params, { sessionId: "session-1" });
    assert.equal(cancel.messageType, "notification");
    assert.equal(firstSettled, false);
    assert.equal(sink.terminals.length, 0);

    process.emitMessages(textUpdate("session-1", "first update"));
    await waitFor(() => sink.updates.length === 1);
    process.emitMessages({
      jsonrpc: "2.0",
      id: firstRequest.id,
      result: { stopReason: "cancelled" },
    });
    assert.equal((await first).classification, "cancelled");

    const second = adapter.prompt(session, "second");
    const secondRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt, 1);
    process.emitMessages(textUpdate("session-1", "second update"));
    await waitFor(() => sink.updates.length === 2);
    process.emitMessages({
      jsonrpc: "2.0",
      id: secondRequest.id,
      result: { stopReason: "end_turn" },
    });
    assert.equal((await second).classification, "completed");
    assert.equal(sink.accepted.length, 2);
    assert.equal(sink.terminals.length, 2);
    assert.equal(
      observations.find(({ method }) => method === ACP_V1_METHODS.sessionPrompt)?.options?.responseTimeoutMs,
      null,
    );
    await adapter.close();
  });

  it("buffers early updates until the prompt write and durable acceptance commit", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const gate = deferred<void>();
    sink.promptGate = gate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "gated");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    process.emitMessages(textUpdate("session-1", "too early"));
    await immediate();
    assert.equal(sink.updates.length, 0);
    gate.resolve();
    await waitFor(() => sink.updates.length === 1);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    await prompting;
    assert.deepEqual(sink.order.slice(-3), ["prompt:accepted", "update:live", "prompt:terminal"]);
    await adapter.close();
  });

  it("isolates updates from Grok worker sessions without interrupting the root prompt", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "root with worker");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    try {
      process.emitMessages(
        textUpdate("worker-session-1", "worker-only text"),
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "worker-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "worker-tool-1",
              title: "Search files",
              kind: "search",
              status: "in_progress",
            },
          },
        },
        textUpdate("session-1", "root text"),
      );
      try {
        await waitFor(() => sink.updates.length === 1 && sink.auxiliaryUpdates.length === 2);
      } catch {
        assert.fail(
          `worker update routing did not settle: root=${sink.updates.length}, auxiliary=${sink.auxiliaryUpdates.length}, state=${adapter.state}`,
        );
      }
      assert.equal(adapter.state, "ready");
      const rootUpdate = sink.updates[0]?.update;
      assert.equal(rootUpdate?.type, "turn");
      if (rootUpdate?.type !== "turn") assert.fail("root update was not a turn");
      assert.equal(rootUpdate.payload.type, "agent_text_chunk");
      if (rootUpdate.payload.type !== "agent_text_chunk") {
        assert.fail("root update was not agent text");
      }
      assert.equal(rootUpdate.payload.text, "root text");
      assert.deepEqual(
        sink.auxiliaryUpdates.map((event) => ({
          sessionId: event.auxiliarySessionId,
          payloadType: event.update.payload.type,
        })),
        [
          { sessionId: "worker-session-1", payloadType: "agent_text_chunk" },
          { sessionId: "worker-session-1", payloadType: "tool_call_create" },
        ],
      );
    } finally {
      process.emitMessages({
        jsonrpc: "2.0",
        id: promptRequest.id,
        result: { stopReason: "end_turn" },
      });
      await prompting.catch(() => undefined);
      await adapter.close();
    }
  });

  it("keeps response proof terminal when the process exits during its durable terminal commit", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const gate = deferred<void>();
    sink.terminalGate = gate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "terminal race");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    await waitFor(() => sink.terminalStarted === 1);
    process.emit({ type: "process_exit", code: 9, signal: null });
    await waitFor(() => adapter.state === "faulted");
    gate.resolve();
    assert.equal((await prompting).classification, "completed");
    await adapter.interrupted;
    assert.deepEqual(
      sink.order.filter((entry) => entry === "prompt:terminal" || entry.startsWith("interrupted:")),
      ["prompt:terminal", "interrupted:process_fault"],
    );
    assert.equal(sink.interruptions[0]?.activePromptSequence, undefined);
  });

  it("interrupts the active prompt when terminal proof cannot be durably committed", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    sink.rejectTerminal = true;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "terminal persistence fault");
    void prompting.catch(() => undefined);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    await assert.rejects(prompting, hasAdapterCode("sink_commit_failed"));
    assert.equal(adapter.state, "faulted");
    await adapter.interrupted;
    assert.deepEqual(sink.interruptions.map((event) => event.activePromptSequence), [1]);
    assert.equal(sink.terminals.length, 0);
  });

  it("classifies acceptance failure after the prompt frame write as sink_commit_failed", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    sink.rejectPromptAcceptance = true;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "acceptance persistence fault");
    void prompting.catch(() => undefined);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);

    assert.equal(request.params !== undefined, true);
    await assert.rejects(prompting, hasAdapterCode("sink_commit_failed"));
    assert.equal(adapter.state, "faulted");
    await adapter.interrupted;
    assert.deepEqual(sink.interruptions.map((event) => event.activePromptSequence), [1]);
    assert.equal(
      process.frames.map(wireMessage).some((message) => message.id === request.id),
      true,
    );
  });
});

describe("ACP v1 adapter permission callback and frame pump", () => {
  it("safe-cancels a worker-session permission without faulting the root prompt", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "root prompt with worker callback");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages(permissionRequest("worker-session-1", "worker-permission"));
    await waitFor(() => process.frames.map(wireMessage).some((message) =>
      message.id === "worker-permission" && Object.hasOwn(message, "result")));
    const response = process.frames.map(wireMessage).find((message) =>
      message.id === "worker-permission" && Object.hasOwn(message, "result"));
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: "worker-permission",
      result: { outcome: { outcome: "cancelled" } },
    });
    assert.equal(sink.permissionRequests.length, 0);
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(adapter.state, "ready");

    process.emitMessages(textUpdate("session-1", "root continues"));
    await waitFor(() => sink.updates.length === 1);
    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    assert.equal((await prompting).classification, "completed");
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("lets updates progress while permission awaits the user and ACKs only the exact callback write", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const permissionGate = deferred<void>();
    const flushGate = deferred<void>();
    sink.permissionGate = permissionGate.promise;
    sink.permissionFlushGate = flushGate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "permission");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages(
      permissionRequest("session-1", "permission-1"),
      textUpdate("session-1", "update while waiting"),
    );
    await waitFor(() => sink.permissionRequests.length === 1 && sink.updates.length === 1);
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(
      process.frames.map(wireMessage).some((message) => message.id === "permission-1"),
      false,
    );
    permissionGate.resolve();
    await waitFor(() =>
      process.frames.map(wireMessage).some((message) => message.id === "permission-1"),
    );
    const callback = process.frames.map(wireMessage).find((message) => message.id === "permission-1");
    assert.deepEqual(callback, {
      jsonrpc: "2.0",
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    await immediate();
    assert.equal(sink.terminals.length, 0);
    flushGate.resolve();
    await waitFor(() => sink.permissionFlushes.length === 1);
    assert.equal(sink.permissionFlushes[0]?.request.callbackRequestId, "permission-1");
    assert.equal(sink.permissionFlushes[0]?.write.remoteAcceptance, "not_evidenced");
    assert.deepEqual(sink.permissionFlushes[0]?.delivery, {
      commandId: "permission-command-1",
      version: 1,
      deliveryAttemptId: "permission-attempt-1",
    });
    await prompting;
    await adapter.close();
  });

  it("holds terminal commit until an admitted permission response is written and durably flushed", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const writeGate = deferred<void>();
    const flushGate = deferred<void>();
    sink.permissionFlushGate = flushGate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "permission terminal fence");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.writeGate = writeGate.promise;
    process.emitMessages(permissionRequest("session-1", "permission-before-terminal"));
    await waitFor(() => sink.order.includes("permission:prepared"));
    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    await immediate();
    assert.equal(sink.terminalStarted, 0);
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(
      process.frames.map(wireMessage).some((message) =>
        message.id === "permission-before-terminal"),
      false,
    );

    writeGate.resolve();
    await waitFor(() => process.frames.map(wireMessage).some((message) =>
      message.id === "permission-before-terminal"),
    );
    await waitFor(() => sink.permissionFlushStarted === 1);
    assert.equal(sink.terminalStarted, 0);
    assert.equal(sink.permissionFlushes.length, 0);

    flushGate.resolve();
    await prompting;
    assert.equal(sink.permissionFlushes.length, 1);
    assert.equal(sink.terminals.length, 1);
    assert.equal(
      sink.order.indexOf("permission:flushed") < sink.order.indexOf("prompt:terminal"),
      true,
    );
    await adapter.close();
  });

  it("aborts a permission writer wait before interruption without flushing or terminalizing", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const writeGate = deferred<void>();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "permission writer loss");
    void prompting.catch(() => undefined);
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.writeGate = writeGate.promise;
    process.emitMessages(permissionRequest("session-1", "permission-writer-loss"));
    await waitFor(() => sink.order.includes("permission:prepared"));
    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    await immediate();
    assert.equal(sink.terminalStarted, 0);

    process.emit({ type: "process_exit", code: 9, signal: null });
    await waitFor(() => adapter.state === "faulted");
    assert.equal(sink.permissionRequests[0]?.signal.aborted, true);
    await bounded(async () => adapter.interrupted);
    await assert.rejects(prompting, hasAdapterCode("transport_lost"));
    assert.equal(sink.permissionFlushStarted, 0);
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(sink.terminals.length, 0);
    assert.deepEqual(sink.interruptions.map((event) => event.activePromptSequence), [1]);
    writeGate.resolve();
    await immediate();
  });

  it("does not commit terminal state after the exact permission flush commit fails", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const flushGate = deferred<void>();
    sink.permissionFlushGate = flushGate.promise;
    sink.rejectPermissionFlush = true;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "permission flush failure");
    void prompting.catch(() => undefined);
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages(permissionRequest("session-1", "permission-flush-failure"));
    await waitFor(() => sink.permissionFlushStarted === 1);
    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    await immediate();
    assert.equal(sink.terminalStarted, 0);

    flushGate.resolve();
    await waitFor(() => adapter.state === "faulted");
    await adapter.interrupted;
    await assert.rejects(prompting, hasAdapterCode("sink_commit_failed"));
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(sink.terminalStarted, 0);
    assert.deepEqual(sink.interruptions.map((event) => event.activePromptSequence), [1]);
  });

  it("abandons a pre-decision permission wait so normal cancellation and terminal proof stay live", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const permissionGate = deferred<void>();
    sink.permissionAbortOnSignal = true;
    sink.permissionGate = permissionGate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "cancel pending permission");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);
    process.emitMessages(permissionRequest("session-1", "permission-abandoned-by-cancel"));
    await waitFor(() => sink.permissionRequests.length === 1);

    const cancelling = adapter.cancel(session);
    const cancelFrame = await waitForOutbound(process, ACP_V1_METHODS.sessionCancel);
    assert.equal(Object.hasOwn(cancelFrame, "id"), false);
    await bounded(async () => cancelling);
    assert.equal(sink.permissionRequests[0]?.signal.aborted, true);
    assert.equal(sink.cancellations.length, 1);
    assert.equal(sink.permissionFlushStarted, 0);
    assert.equal(
      process.frames.map(wireMessage).some((message) =>
        message.id === "permission-abandoned-by-cancel"),
      false,
    );

    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "cancelled" },
    });
    assert.equal((await bounded(async () => prompting)).classification, "cancelled");
    assert.equal(adapter.state, "ready");
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(sink.terminals.length, 1);
    assert.equal(
      sink.order.indexOf("cancel:sent") < sink.order.indexOf("prompt:terminal"),
      true,
    );

    const secondPrompting = adapter.prompt(session, "cancel another pending permission");
    const secondPromptRequest = await waitForOutbound(
      process,
      ACP_V1_METHODS.sessionPrompt,
      1,
    );
    await waitFor(() => sink.accepted.length === 2);
    process.emitMessages(permissionRequest("session-1", "permission-abandoned-second-turn"));
    await waitFor(() => sink.permissionRequests.length === 2);
    const secondCancelling = adapter.cancel(session);
    await waitForOutbound(process, ACP_V1_METHODS.sessionCancel, 1);
    await bounded(async () => secondCancelling);
    process.emitMessages({
      jsonrpc: "2.0",
      id: secondPromptRequest.id,
      result: { stopReason: "cancelled" },
    });
    assert.equal((await bounded(async () => secondPrompting)).classification, "cancelled");
    assert.deepEqual(
      sink.permissionRequests.map((event) => event.signal.aborted),
      [true, true],
    );
    assert.equal(sink.cancellations.length, 2);
    assert.equal(sink.terminals.length, 2);
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("abandons only a still-preparing permission when terminal proof arrives without cancel", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const permissionGate = deferred<void>();
    sink.permissionAbortOnSignal = true;
    sink.permissionGate = permissionGate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "terminal during permission preparation");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);
    process.emitMessages(permissionRequest("session-1", "permission-abandoned-by-terminal"));
    await waitFor(() => sink.permissionRequests.length === 1);

    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    assert.equal((await bounded(async () => prompting)).classification, "completed");
    assert.equal(sink.permissionRequests[0]?.signal.aborted, true);
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(sink.terminals.length, 1);
    assert.equal(adapter.state, "ready");
    assert.equal(
      process.frames.map(wireMessage).some((message) =>
        message.id === "permission-abandoned-by-terminal"),
      false,
    );
    await adapter.close();
  });

  it("rejects a permission callback received after prompt terminal proof without invoking the sink", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "late permission");
    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages(
      { jsonrpc: "2.0", id: promptRequest.id, result: { stopReason: "end_turn" } },
      permissionRequest("session-1", "permission-after-terminal"),
    );
    await prompting;
    await waitFor(() => adapter.state === "faulted");
    await adapter.interrupted;
    assert.equal(sink.terminals.length, 1);
    assert.equal(sink.permissionRequests.length, 0);
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(
      process.frames.map(wireMessage).some((message) =>
        message.id === "permission-after-terminal" && Object.hasOwn(message, "result")),
      false,
    );
  });

  it("rejects a proxied prepared permission result without executing any proxy trap", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    let traps = 0;
    sink.prepared = zeroTrapProxy(
      {
        decision: { type: "selected" as const, optionId: "allow" },
        delivery: {
          commandId: "permission-command-proxy",
          version: 1,
          deliveryAttemptId: "permission-attempt-proxy",
        },
      },
      () => {
        traps += 1;
      },
    );
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "proxied permission result");
    void prompting.catch(() => undefined);
    await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages(permissionRequest("session-1", "proxied-result"));
    await waitFor(() => adapter.state === "faulted");
    await adapter.interrupted;
    await assert.rejects(prompting, hasAdapterCode("transport_lost"));
    assert.equal(traps, 0);
    assert.equal(sink.permissionFlushes.length, 0);
  });

  it("treats a permission response writer fault as transport interruption and never claims a flush", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "permission fault");
    void prompting.catch(() => undefined);
    await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);
    process.rejectNextWrite = true;
    process.emitMessages(permissionRequest("session-1", 17));
    await waitFor(() => adapter.state === "faulted");
    await adapter.interrupted;
    await assert.rejects(prompting, hasAdapterCode("transport_lost"));
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(sink.interruptions.length, 1);
    assert.equal(process.stopCalls > 0, true);
  });

  it("keeps callback ID types distinct and accepts sequential reuse after a response", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "typed callbacks");
    void prompting.catch(() => undefined);
    await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages(
      permissionRequest("session-1", 1),
      permissionRequest("session-1", "1"),
      permissionRequest("session-1", null),
    );
    await waitFor(() => sink.permissionFlushes.length === 3);
    assert.deepEqual(
      sink.permissionRequests.map((event) => event.request.callbackRequestId),
      [1, "1", null],
    );
    assert.deepEqual(
      sink.permissionFlushes.map((event) => event.write.requestId),
      [1, "1", null],
    );

    process.emitMessages(permissionRequest("session-1", 1));
    await waitFor(() => sink.permissionFlushes.length === 4);
    assert.equal(adapter.state, "ready");
    assert.deepEqual(
      sink.permissionRequests.map((event) => event.request.callbackRequestId),
      [1, "1", null, 1],
    );
    assert.deepEqual(
      sink.permissionFlushes.map((event) => event.write.requestId),
      [1, "1", null, 1],
    );

    const promptRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    process.emitMessages({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    await prompting;
    await adapter.close();
  });

  it("fails the epoch when a concurrent callback reuses an ID while the first awaits user", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const gate = deferred<void>();
    sink.permissionGate = gate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "duplicate callback");
    void prompting.catch(() => undefined);
    await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);
    process.emitMessages(
      permissionRequest("session-1", "same-id"),
      permissionRequest("session-1", "same-id"),
    );
    await waitFor(() => adapter.state === "faulted");
    gate.resolve();
    await adapter.interrupted;
    await assert.rejects(prompting, hasAdapterCode("transport_lost"));
    assert.equal(sink.permissionFlushes.length, 0);
  });

  it("aborts and fences a pending permission transaction before interruption commits", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const gate = deferred<void>();
    sink.permissionGate = gate.promise;
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "permission transport loss");
    void prompting.catch(() => undefined);
    await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);
    process.emitMessages(permissionRequest("session-1", "pending-id"));
    await waitFor(() => sink.permissionRequests.length === 1);
    process.emit({ type: "process_exit", code: 9, signal: null });
    await waitFor(() => adapter.state === "faulted");
    assert.equal(sink.permissionRequests[0]?.signal.aborted, true);
    gate.resolve();
    await adapter.interrupted;
    await assert.rejects(prompting, hasAdapterCode("transport_lost"));
    assert.equal(sink.permissionFlushes.length, 0);
    assert.equal(
      sink.order.indexOf("permission:prepared") <
        sink.order.findIndex((entry) => entry.startsWith("interrupted:")),
      true,
    );
  });
});

describe("ACP v1 adapter epoch identity and restore paths", () => {
  it("rejects cloned session capability and interrupts the exact active prompt on process proof", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    await assert.rejects(
      adapter.prompt({ ...session }, "forged"),
      hasAdapterCode("stale_session_identity"),
    );
    const prompting = adapter.prompt(session, "live");
    void prompting.catch(() => undefined);
    await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);
    process.emit({
      type: "stderr_diagnostic",
      text: "worker exited after redaction",
      sourceBytes: 31,
      capturedBytes: 31,
      droppedBytes: 0,
    });
    process.emit({ type: "process_exit", code: 9, signal: null });
    const newRequestsBefore = process.frames
      .map(wireMessage)
      .filter((message) => message.method === ACP_V1_METHODS.sessionNew).length;
    await assert.rejects(
      adapter.newSession("/tmp/after-loss"),
      hasAdapterCode("transport_lost"),
    );
    assert.equal(
      process.frames
        .map(wireMessage)
        .filter((message) => message.method === ACP_V1_METHODS.sessionNew).length,
      newRequestsBefore,
    );
    await waitFor(() => adapter.state === "faulted");
    await adapter.interrupted;
    await assert.rejects(prompting, hasAdapterCode("transport_lost"));
    assert.deepEqual(sink.interruptions.map((event) => event.activePromptSequence), [1]);
    assert.deepEqual(sink.interruptions[0]?.diagnostic, {
      exitCode: 9,
      signal: null,
      faultCode: "process_exit",
      faultStage: "transport",
      stderrTail: ["worker exited after redaction"],
      stderrCapturedBytes: 31,
      stderrDroppedBytes: 0,
    });
    await assert.rejects(adapter.cancel(session), hasAdapterCode("transport_lost"));
  });

  it("preserves the exact ACP update fault in interruption diagnostics", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    await newSession(adapter, process);

    process.emitMessages({
      jsonrpc: "2.0",
      method: ACP_V1_METHODS.sessionUpdate,
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk" },
      },
    });

    await waitFor(() => adapter.state === "faulted");
    await adapter.interrupted;
    assert.deepEqual(sink.interruptions[0]?.diagnostic, {
      faultCode: "invalid_type",
      faultPath: "$.update.content",
      faultStage: "session_update",
      updateKind: "agent_message_chunk",
      stderrTail: [],
      stderrCapturedBytes: 0,
      stderrDroppedBytes: 0,
    });
  });

  it("keeps the adapter ready when Grok emits oversized tool display output", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);
    const prompting = adapter.prompt(session, "large tool output");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await waitFor(() => sink.accepted.length === 1);

    process.emitMessages({
      jsonrpc: "2.0",
      method: ACP_V1_METHODS.sessionUpdate,
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-large-output",
          status: "completed",
          content: [{
            type: "content",
            content: {
              type: "text",
              text: "x".repeat(ACP_V1_CODEC_LIMITS.maxStringLength + 256),
            },
          }],
        },
      },
    });

    await waitFor(() => sink.updates.length === 1);
    assert.equal(adapter.state, "ready");
    assert.equal(sink.interruptions.length, 0);
    const update = sink.updates[0]?.update;
    assert.equal(update?.type, "turn");
    if (update?.type === "turn") {
      assert.equal(update.payload.type, "tool_call_update");
      if (update.payload.type === "tool_call_update") {
        assert.equal(update.payload.replayProofUnavailable, true);
      }
    }

    process.emitMessages({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn" },
    });
    assert.equal((await prompting).classification, "completed");
    await adapter.close();
  });

  it("capability-gates resume and load and closes a replay barrier after preceding replay updates", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);

    const resuming = adapter.resumeSession("session-resume", "/tmp/project");
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    assert.deepEqual(resume.params, {
      sessionId: "session-resume",
      cwd: "/tmp/project",
      mcpServers: [],
    });
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: {} });
    assert.equal((await resuming).establishedBy, "resume");

    const loading = adapter.loadSession("session-load", "/tmp/project");
    const load = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    process.emitMessages(textUpdate("session-load", "replayed"));
    await waitFor(() => sink.updates.some((event) => event.ingestMode === "replay"));
    process.emitMessages({
      jsonrpc: "2.0",
      id: load.id,
      result: {
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", name: "Default" }],
        },
      },
    });
    const loaded = await loading;
    assert.equal(loaded.establishedBy, "load");
    assert.equal(loaded.modes?.currentModeId, "default");
    assert.deepEqual(
      sink.order.filter((entry) => entry.includes("barrier") || entry === "update:replay"),
      ["barrier:begin", "update:replay", "barrier:commit:barrier-1"],
    );
    await adapter.close();

    const unavailableProcess = new FakeProcess();
    const unavailableSink = new RecordingSink();
    const unavailable = new AcpV1Adapter(options(unavailableProcess, unavailableSink));
    const starting = unavailable.start();
    const initialize = await waitForOutbound(unavailableProcess, ACP_V1_METHODS.initialize);
    unavailableProcess.emitMessages({
      jsonrpc: "2.0",
      id: initialize.id,
      result: { protocolVersion: 1 },
    });
    await starting;
    await assert.rejects(
      unavailable.resumeSession("session-x", "/tmp/project"),
      hasAdapterCode("capability_not_advertised"),
    );
    await assert.rejects(
      unavailable.loadSession("session-x", "/tmp/project"),
      hasAdapterCode("capability_not_advertised"),
    );
    assert.equal(
      unavailableProcess.frames.map(wireMessage).some((message) =>
        message.method === ACP_V1_METHODS.sessionResume || message.method === ACP_V1_METHODS.sessionLoad),
      false,
    );
    await unavailable.close();
  });

  it("never returns a loaded session after process loss during the durable barrier commit", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const gate = deferred<void>();
    sink.replayCommitGate = gate.promise;
    const adapter = await startAdapter(process, sink);
    const loading = adapter.loadSession("session-load-race", "/tmp/project");
    void loading.catch(() => undefined);
    const load = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    process.emitMessages({ jsonrpc: "2.0", id: load.id, result: {} });
    await waitFor(() => sink.order.includes("barrier:commit:barrier-1"));
    process.emit({ type: "process_exit", code: 9, signal: null });
    await waitFor(() => adapter.state === "faulted");
    gate.resolve();
    await assert.rejects(loading, hasAdapterCode("transport_lost"));
    await adapter.interrupted;
    assert.deepEqual(
      sink.order.filter((entry) => entry.startsWith("barrier:") || entry.startsWith("interrupted:")),
      ["barrier:begin", "barrier:commit:barrier-1", "interrupted:process_fault"],
    );
    assert.equal(sink.order.some((entry) => entry.startsWith("barrier:abort")), false);
  });

  it("does not deadlock when process loss races a blocked replay update before barrier commit", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const gate = deferred<void>();
    sink.replayUpdateGate = gate.promise;
    const adapter = await startAdapter(process, sink);
    const loading = adapter.loadSession("session-load-update-race", "/tmp/project");
    void loading.catch(() => undefined);
    const load = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    process.emitMessages(textUpdate("session-load-update-race", "replayed"));
    await waitFor(() => sink.order.includes("update:replay"));
    process.emitMessages({ jsonrpc: "2.0", id: load.id, result: {} });
    process.emit({ type: "process_exit", code: 9, signal: null });
    await waitFor(() => adapter.state === "faulted");
    gate.resolve();
    await assert.rejects(
      () => bounded(() => loading),
      hasAdapterCode("transport_lost"),
    );
    await bounded(() => adapter.interrupted);
    assert.deepEqual(
      sink.order.filter((entry) => entry.startsWith("barrier:") || entry.startsWith("interrupted:")),
      [
        "barrier:begin",
        "interrupted:process_fault",
        "barrier:abort:barrier-1",
      ],
    );
  });

  it("rejects a proxied replay barrier without executing any proxy trap or writing session/load", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    let traps = 0;
    sink.replayBarrierResult = zeroTrapProxy(
      { barrierId: "proxied-barrier" },
      () => {
        traps += 1;
      },
    );
    const adapter = await startAdapter(process, sink);

    await assert.rejects(
      adapter.loadSession("session-load-proxy", "/tmp/project"),
      hasAdapterCode("sink_commit_failed"),
    );
    await waitFor(() => adapter.state === "faulted");
    await adapter.interrupted;
    assert.equal(traps, 0);
    assert.equal(
      process.frames.map(wireMessage).some((message) =>
        message.method === ACP_V1_METHODS.sessionLoad),
      false,
    );
  });

  it("surfaces interruption persistence failure instead of claiming it settled", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    sink.rejectInterruption = true;
    const adapter = await startAdapter(process, sink);
    await newSession(adapter, process);
    process.emit({ type: "process_exit", code: 9, signal: null });
    await waitFor(() => adapter.state === "faulted");
    await assert.rejects(adapter.interrupted, /fake interruption persistence fault/u);
  });
});
