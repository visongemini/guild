import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AcpV1Adapter,
  AcpV1AdapterError,
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
  Parameters<AcpV1AdapterSink[Name]>[0];

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
  sessionGate: Promise<void> | undefined;
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

  it("applies only supported official Grok model and reasoning selectors", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startAdapter(process, sink);
    const session = await newSession(adapter, process);

    const selectingModel = adapter.setModel(session, "grok-4.5");
    const model = await waitForOutbound(process, ACP_V1_METHODS.sessionSetModel);
    assert.deepEqual(model.params, {
      sessionId: "session-1",
      modelId: "grok-4.5",
    });
    process.emitMessages({
      jsonrpc: "2.0",
      id: model.id,
      result: { _meta: { model: { Ok: { modelId: "grok-4.5" } } } },
    });
    await selectingModel;

    const selectingMode = adapter.setMode(session, "grok-4.5", "medium");
    const mode = await waitForOutbound(process, ACP_V1_METHODS.sessionSetMode);
    assert.deepEqual(mode.params, {
      sessionId: "session-1",
      modeId: "medium",
    });
    process.emitMessages({ jsonrpc: "2.0", id: mode.id, result: {} });
    await selectingMode;

    const selectingConfig = adapter.setConfigOption(session, "web-search", false);
    const config = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption);
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
        configOptions: [{
          id: "web-search",
          name: "Web search",
          type: "boolean",
          currentValue: false,
        }],
      },
    });
    assert.deepEqual(await selectingConfig, [{
      id: "web-search",
      name: "Web search",
      type: "boolean",
      currentValue: false,
    }]);

    const frameCount = process.frames.length;
    await assert.rejects(
      adapter.setMode(session, "grok-4.5", "xhigh"),
      hasAdapterCode("operation_failed"),
    );
    assert.equal(process.frames.length, frameCount);
    await adapter.close();
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
