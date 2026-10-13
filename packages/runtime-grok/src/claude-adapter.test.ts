import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { modelCatalogEngineOf } from "@guild/contracts";
import {
  AcpV1Adapter,
  AcpV1AdapterError,
  AcpV1ExtensionRequestError,
  type AcpV1AdapterOptions,
  type AcpV1AdapterSession,
  type AcpV1AdapterSink,
  type AcpV1PeerPort,
  type AcpV1ProcessPort,
} from "./acp-adapter.js";
import { ACP_V1_METHODS } from "./acp-v1-methods.js";
import type { EngineSignal } from "./claude-dialect.js";
import { CLAUDE_ENGINE_PROFILE } from "./engine-profile.js";
import { JsonRpcPeer, type JsonRpcFrameWriter } from "./json-rpc-peer.js";
import type { ProcessHostEvent } from "./process-host.js";

type WireMessage = Record<string, unknown>;
type SinkEvent<Name extends keyof AcpV1AdapterSink> =
  Parameters<NonNullable<AcpV1AdapterSink[Name]>>[0];

type FixtureFrame = { readonly dir: "->" | "<-"; readonly msg: WireMessage };
const fixture = JSON.parse(
  readFileSync(new URL("../src/fixtures/claude-acp-0.89.1-session.json", import.meta.url), "utf8"),
) as { readonly frames: readonly FixtureFrame[] };

const FIXTURE_SESSION_ID = "b9b4ee19-8ea2-486a-ba0a-81f46577b4ef";
const FIXTURE_CWD = "/tmp/guild-fixture-ws";

const clock = Object.freeze({
  monotonicMs: () => 123.5,
  wallClockIso: () => "2026-10-12T12:34:56.789Z",
});

class FakeProcess implements AcpV1ProcessPort {
  readonly frames: string[] = [];
  readonly listeners = new Set<(event: ProcessHostEvent) => void>();
  stopCalls = 0;

  onEvent(listener: (event: ProcessHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<unknown> {
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

  outbound(): WireMessage[] {
    return this.frames.map((frame) => JSON.parse(frame.slice(0, -1)) as WireMessage);
  }
}

class RecordingSink implements AcpV1AdapterSink {
  readonly sessions: SinkEvent<"commitSessionEstablished">[] = [];
  readonly accepted: SinkEvent<"commitPromptAccepted">[] = [];
  readonly updates: SinkEvent<"commitUpdate">[] = [];
  readonly terminals: SinkEvent<"commitPromptTerminal">[] = [];
  readonly interruptions: SinkEvent<"commitTransportInterrupted">[] = [];
  readonly permissionRequests: SinkEvent<"preparePermissionResponse">[] = [];
  readonly engineSignals: EngineSignal[] = [];
  readonly xaiSignals: unknown[] = [];
  readonly agentTurns: SinkEvent<"commitAgentTurnStarted">[] = [];

  observeSignal = (envelope: unknown): void => {
    this.xaiSignals.push(envelope);
  };

  observeEngineSignal = (signal: EngineSignal): void => {
    this.engineSignals.push(signal);
  };

  async commitSessionEstablished(event: SinkEvent<"commitSessionEstablished">): Promise<void> {
    this.sessions.push(event);
  }

  async commitPromptAccepted(event: SinkEvent<"commitPromptAccepted">): Promise<void> {
    this.accepted.push(event);
  }

  async commitUpdate(event: SinkEvent<"commitUpdate">): Promise<void> {
    this.updates.push(event);
  }

  async commitAuxiliaryUpdate(): Promise<void> {}

  async preparePermissionResponse(event: SinkEvent<"preparePermissionResponse">): Promise<
    Awaited<ReturnType<AcpV1AdapterSink["preparePermissionResponse"]>>
  > {
    this.permissionRequests.push(event);
    return {
      decision: { type: "selected", optionId: "allow" },
      delivery: { commandId: "command-1", version: 1, deliveryAttemptId: "attempt-1" },
    };
  }

  async commitPermissionResponseFlushed(): Promise<void> {}

  async commitPromptTerminal(event: SinkEvent<"commitPromptTerminal">): Promise<void> {
    this.terminals.push(event);
  }

  async commitCancelSent(): Promise<void> {}

  async commitTransportInterrupted(event: SinkEvent<"commitTransportInterrupted">): Promise<void> {
    this.interruptions.push(event);
  }

  async beginReplayBarrier(): Promise<{ barrierId: string }> {
    return { barrierId: "barrier-1" };
  }

  async commitReplayBarrier(): Promise<void> {}

  async abortReplayBarrier(): Promise<void> {}
}

/** Also able to attach agent-started turns: a Claude adapter must still never open one. */
class AgentTurnCapableSink extends RecordingSink {
  async commitAgentTurnStarted(event: SinkEvent<"commitAgentTurnStarted">): Promise<void> {
    this.agentTurns.push(event);
  }
}

function adapterOptions(process: FakeProcess, sink: RecordingSink): AcpV1AdapterOptions {
  return { adapterEpoch: 7, clock, process, sink, profile: CLAUDE_ENGINE_PROFILE };
}

const fixtureInitializeResult = (): unknown =>
  (fixture.frames.find((frame) => frame.dir === "<-" && frame.msg["id"] === 1)?.msg["result"]);

const fixtureSessionResult = (): unknown =>
  (fixture.frames.find((frame) => frame.dir === "<-" && frame.msg["id"] === 2)?.msg["result"]);

async function startClaude(
  process: FakeProcess,
  sink: RecordingSink,
  initializeResult: unknown = fixtureInitializeResult(),
  overrides: Partial<AcpV1AdapterOptions> = {},
): Promise<AcpV1Adapter> {
  const adapter = new AcpV1Adapter({ ...adapterOptions(process, sink), ...overrides });
  const starting = adapter.start();
  const initialize = await waitForOutbound(process, ACP_V1_METHODS.initialize);
  assert.deepEqual(initialize.params, {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "guild", title: "Guild", version: "3.1.0" },
  });
  process.emitMessages({ jsonrpc: "2.0", id: initialize.id, result: initializeResult } as WireMessage);
  await starting;
  return adapter;
}

async function newClaudeSession(
  adapter: AcpV1Adapter,
  process: FakeProcess,
  startOptions?: Parameters<AcpV1Adapter["newSession"]>[1],
): Promise<AcpV1AdapterSession> {
  const operation = adapter.newSession(FIXTURE_CWD, startOptions);
  const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
  process.emitMessages({ jsonrpc: "2.0", id: request.id, result: fixtureSessionResult() } as WireMessage);
  return operation;
}

function update(update: Record<string, unknown>, sessionId = FIXTURE_SESSION_ID): WireMessage {
  return { jsonrpc: "2.0", method: ACP_V1_METHODS.sessionUpdate, params: { sessionId, update } };
}

async function waitForOutbound(process: FakeProcess, method: string, occurrence = 0): Promise<WireMessage> {
  return bounded(async () => {
    for (;;) {
      const match = process.outbound().filter((message) => message.method === method)[occurrence];
      if (match !== undefined) return match;
      await immediate();
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await bounded(async () => {
    while (!predicate()) await immediate();
  });
}

async function bounded<T>(operation: () => Promise<T>, milliseconds = 2_000): Promise<T> {
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

function hasAdapterCode(code: AcpV1AdapterError["code"]): (cause: unknown) => boolean {
  return (cause) => cause instanceof AcpV1AdapterError && cause.code === code;
}

function timeoutObserver(observed: Map<string, number | null | undefined>): AcpV1AdapterOptions["peerFactory"] {
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
        observed.set(method, options?.responseTimeoutMs);
        return peer.sendRequest(method, params, options);
      },
      setNotificationHandler: peer.setNotificationHandler.bind(peer),
      setRequestHandler: peer.setRequestHandler.bind(peer),
    };
  };
}

describe("Claude dialect: initialize and authentication (PC-ENG-002)", () => {
  it("initializes against the recorded adapter result and reads the capabilities Guild needs", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startClaude(process, sink);
    assert.equal(adapter.engine, "claude");
    assert.equal(adapter.state, "ready");
    assert.deepEqual(adapter.features, {
      billing: false,
      steer: true,
      conversationRewind: false,
      xaiSignals: false,
      agentInitiatedTurns: false,
    });
    await adapter.close();
  });

  it("allows the Claude adapter's slow session/new more time than Grok gets", async () => {
    const claude = new Map<string, number | null | undefined>();
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink(), undefined, { peerFactory: timeoutObserver(claude) });
    await newClaudeSession(adapter, process);
    assert.equal(claude.get(ACP_V1_METHODS.initialize), 300_000);
    assert.equal(claude.get(ACP_V1_METHODS.sessionNew), 300_000);
    await adapter.close();

    const grok = new Map<string, number | null | undefined>();
    const grokProcess = new FakeProcess();
    const grokAdapter = new AcpV1Adapter({
      adapterEpoch: 1,
      clock,
      process: grokProcess,
      sink: new RecordingSink(),
      peerFactory: timeoutObserver(grok),
    });
    const starting = grokAdapter.start();
    const initialize = await waitForOutbound(grokProcess, ACP_V1_METHODS.initialize);
    grokProcess.emitMessages({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: 1 } });
    await starting;
    const opening = grokAdapter.newSession(FIXTURE_CWD);
    const request = await waitForOutbound(grokProcess, ACP_V1_METHODS.sessionNew);
    grokProcess.emitMessages({ jsonrpc: "2.0", id: request.id, result: { sessionId: "grok-session" } });
    await opening;
    assert.equal(grok.get(ACP_V1_METHODS.sessionNew), 30_000);
    await grokAdapter.close();
  });

  it("gives resume and load the long Claude window too, and Grok keeps its own", async () => {
    const claude = new Map<string, number | null | undefined>();
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink(), undefined, { peerFactory: timeoutObserver(claude) });
    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD);
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: fixtureSessionResult() } as WireMessage);
    await resuming;
    const loading = adapter.loadSession("other-session", FIXTURE_CWD);
    const load = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    process.emitMessages({ jsonrpc: "2.0", id: load.id, result: fixtureSessionResult() } as WireMessage);
    await loading;
    assert.equal(claude.get(ACP_V1_METHODS.sessionResume), 300_000);
    assert.equal(claude.get(ACP_V1_METHODS.sessionLoad), 300_000);
    await adapter.close();
  });

  it("accepts and ignores terminal auth methods, never authenticating", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const base = fixtureInitializeResult() as Record<string, unknown>;
    const adapter = await startClaude(process, sink, {
      ...base,
      authMethods: [
        { id: "claude-login", name: "Log in with Claude", type: "terminal", args: ["--cli"], env: { TOKEN: "do-not-echo" } },
        { id: "claude-login-console", name: "Console login", type: "terminal" },
        { id: "future", name: "Future method", type: "env_var" },
      ],
    });
    assert.equal(adapter.state, "ready");
    await assert.rejects(adapter.authenticate("claude-login"), hasAdapterCode("unsupported_for_engine"));
    assert.equal(process.outbound().some((message) => message.method === ACP_V1_METHODS.authenticate), false);
    // The session still opens: Guild only reports an auth-required failure when the agent says so.
    const session = await newClaudeSession(adapter, process);
    assert.equal(session.sessionId, FIXTURE_SESSION_ID);
    await adapter.close();
  });

  it("starts with an agent that advertises no auth methods and a bare initialize result", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink(), { protocolVersion: 1, authMethods: [] });
    assert.equal(adapter.state, "ready");
    assert.equal(adapter.features.steer, false, "steer needs the agent to advertise it");
    assert.deepEqual(await adapter.steer(await newClaudeSession(adapter, process), "x"), {
      status: "unsupported",
      reason: "engine",
    });
    assert.equal(process.outbound().some((message) => message.method === "_session/steering"), false);
    await adapter.close();
  });

  it("names a start that got no answer in time (request_timeout) instead of reporting a lost transport", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink(), undefined, { timeouts: { sessionMs: 25 } });
    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD);
    await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    await assert.rejects(resuming, hasAdapterCode("request_timeout"));
    assert.equal(adapter.state, "ready", "a slow resume does not fault the adapter");

    const loading = adapter.loadSession("old-session", FIXTURE_CWD);
    await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    await assert.rejects(loading, hasAdapterCode("request_timeout"));
    assert.equal(adapter.state, "ready");

    const creating = adapter.newSession(FIXTURE_CWD);
    await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
    await assert.rejects(creating, hasAdapterCode("request_timeout"));
    await adapter.close();

    // initialize faults the adapter when it times out, and still reads as a timeout.
    const startProcess = new FakeProcess();
    const starting = new AcpV1Adapter({ ...adapterOptions(startProcess, new RecordingSink()), timeouts: { initializeMs: 25 } });
    const initializing = starting.start();
    await waitForOutbound(startProcess, ACP_V1_METHODS.initialize);
    await assert.rejects(initializing, hasAdapterCode("request_timeout"));
  });

  it("answers the agent's own 'no such session' (ACP -32002) with session_not_found and nothing else", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const resuming = adapter.resumeSession("missing-session", FIXTURE_CWD);
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, error: { code: -32002, message: "Resource not found" } });
    await assert.rejects(resuming, hasAdapterCode("session_not_found"));
    assert.equal(adapter.state, "ready");

    // Any other error answer is not a statement about the session.
    const again = adapter.resumeSession("other-session", FIXTURE_CWD);
    const second = await waitForOutbound(process, ACP_V1_METHODS.sessionResume, 1);
    process.emitMessages({ jsonrpc: "2.0", id: second.id, error: { code: -32603, message: "Internal error" } });
    await assert.rejects(again, hasAdapterCode("operation_failed"));
    await adapter.close();
  });

  it("maps the ACP auth-required error of session/new to a named error without faulting", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startClaude(process, sink);
    const operation = adapter.newSession(FIXTURE_CWD);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } });
    await assert.rejects(operation, hasAdapterCode("auth_required"));
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("surfaces _auth/status_update as an identity summary without the account e-mail", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startClaude(process, sink);
    process.emitMessages({
      jsonrpc: "2.0",
      method: "_auth/status_update",
      params: {
        authStatus: {
          kind: "account",
          label: "Claude Max",
          account: { plan: "max", email: "someone@example.com", organization: "someone's Organization" },
        },
      },
    });
    await waitFor(() => sink.engineSignals.length === 1);
    assert.deepEqual(sink.engineSignals[0], {
      type: "auth_status",
      engine: "claude",
      status: { kind: "account", label: "Claude Max", plan: "max" },
    });
    const serialized = JSON.stringify(sink.engineSignals);
    assert.equal(serialized.includes("someone@example.com"), false);
    assert.equal(serialized.includes("Organization"), false);
    // Malformed or unknown out-of-session notifications are ignored, never faults.
    process.emitMessages(
      { jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: "nope" } },
      { jsonrpc: "2.0", method: "_auth/status_update" },
      { jsonrpc: "2.0", method: "_something/new", params: { anything: true } },
      { jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { sessionId: "s" } },
    );
    await immediate();
    assert.equal(sink.engineSignals.length, 1);
    assert.equal(sink.xaiSignals.length, 0, "no _x.ai signal exists for the Claude engine");
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });
});

describe("Claude dialect: sessions, catalog and start options", () => {
  it("builds the model catalog from the model and effort config options and sends a plain session/new", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startClaude(process, sink);
    const session = await newClaudeSession(adapter, process, { reasoningEffort: "high" });
    const request = process.outbound().find((message) => message.method === ACP_V1_METHODS.sessionNew);
    assert.deepEqual(request?.params, { cwd: FIXTURE_CWD, mcpServers: [] }, "no _meta.reasoningEffort for Claude");

    const catalog = session.modelCatalog;
    assert.ok(catalog !== undefined);
    assert.equal(catalog.runtimeDefaultModelId, "default");
    assert.equal(modelCatalogEngineOf(catalog), "claude");
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ["default", "opus", "fable", "sonnet", "haiku", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"],
    );
    const opus = catalog.models.find((model) => model.id === "opus");
    assert.equal(opus?.name, "Opus 5.5");
    assert.equal(opus?.description, "For complex work and everyday tasks");
    assert.deepEqual(opus?.reasoningEfforts, [], "efforts are attached to the selected model only");
    assert.deepEqual(
      catalog.models.find((model) => model.id === "default")?.reasoningEfforts.map((effort) => [effort.id, effort.label, effort.isDefault]),
      [["default", "Default", true], ["low", "Low", false], ["medium", "Medium", false], ["high", "High", false], ["xhigh", "Xhigh", false], ["max", "Max", false]],
    );
    assert.equal(session.contextWindowSize, undefined);
    assert.equal(session.modes?.currentModeId, "default");
    assert.deepEqual(session.configOptions?.map((option) => option.id), ["mode", "model", "effort", "fast"]);
    assert.equal(sink.sessions[0]?.state.modelCatalog, catalog);
    await adapter.close();
  });

  it("encodes _meta.claudeCode.options on session/new and session/resume without touching the caller's object", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startClaude(process, sink);
    const options = {
      settings: { modelPicker: { options: [{ model: "deepseek-v4[1m]", label: "DeepSeek V4" }] } },
    };
    const routed = { claudeCodeOptions: options };
    await newClaudeSession(adapter, process, routed);
    const created = process.outbound().find((message) => message.method === ACP_V1_METHODS.sessionNew);
    assert.deepEqual(created?.params, {
      cwd: FIXTURE_CWD,
      mcpServers: [],
      _meta: { claudeCode: { options } },
    });
    assert.equal(Object.isFrozen(options), false, "the caller's object stays the caller's");
    assert.equal(Object.isFrozen(options.settings), false);

    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD, routed);
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    assert.deepEqual(resume.params, {
      sessionId: "old-session",
      cwd: FIXTURE_CWD,
      mcpServers: [],
      _meta: { claudeCode: { options } },
    });
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: fixtureSessionResult() } as WireMessage);
    const resumed = await resuming;
    assert.equal(resumed.establishedBy, "resume");
    assert.ok(resumed.modelCatalog !== undefined, "resume also derives the catalog from configOptions");
    await adapter.close();
  });

  it("rejects claude-only start options for Grok and oversized or non-object options for Claude", async () => {
    const claude = new FakeProcess();
    const claudeAdapter = await startClaude(claude, new RecordingSink());
    await assert.rejects(
      claudeAdapter.newSession(FIXTURE_CWD, { claudeCodeOptions: [] as unknown as Record<string, unknown> }),
      hasAdapterCode("operation_failed"),
    );
    assert.equal(claude.outbound().some((message) => message.method === ACP_V1_METHODS.sessionNew), false);
    await claudeAdapter.close();

    const grok = new FakeProcess();
    const grokAdapter = new AcpV1Adapter({ adapterEpoch: 1, clock, process: grok, sink: new RecordingSink() });
    const starting = grokAdapter.start();
    const initialize = await waitForOutbound(grok, ACP_V1_METHODS.initialize);
    grok.emitMessages({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: 1 } });
    await starting;
    await assert.rejects(
      grokAdapter.newSession(FIXTURE_CWD, { claudeCodeOptions: { settings: {} } }),
      hasAdapterCode("invalid_adapter_options"),
    );
    await grokAdapter.close();
  });

  it("passes HTTP MCP servers through only when the agent advertised mcpCapabilities.http", async () => {
    const server = {
      type: "http" as const,
      name: "guild-browser",
      url: "http://127.0.0.1:43121/0123456789abcdef0123456789abcdef/mcp",
      headers: [] as const,
    };
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    await newClaudeSession(adapter, process, { mcpServers: [server] });
    const request = process.outbound().find((message) => message.method === ACP_V1_METHODS.sessionNew);
    assert.deepEqual((request?.params as { mcpServers: unknown }).mcpServers, [server]);
    await adapter.close();

    const noMcp = new FakeProcess();
    const base = fixtureInitializeResult() as { agentCapabilities: Record<string, unknown> };
    const plain = await startClaude(noMcp, new RecordingSink(), {
      ...base,
      agentCapabilities: { ...base.agentCapabilities, mcpCapabilities: { http: false } },
    });
    await assert.rejects(plain.newSession(FIXTURE_CWD, { mcpServers: [server] }), hasAdapterCode("capability_not_advertised"));
    assert.equal(noMcp.outbound().some((message) => message.method === ACP_V1_METHODS.sessionNew), false);
    await plain.close();

    const stdio = new FakeProcess();
    const strict = await startClaude(stdio, new RecordingSink());
    await assert.rejects(
      strict.newSession(FIXTURE_CWD, { mcpServers: [{ ...server, type: "stdio" } as unknown as typeof server] }),
      hasAdapterCode("operation_failed"),
    );
    await assert.rejects(
      strict.newSession(FIXTURE_CWD, { mcpServers: [{ ...server, url: "file:///etc/passwd" }] }),
      hasAdapterCode("operation_failed"),
    );
    await strict.close();
  });

  it("applies the permission mode as the mode config option after the session starts", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const session = await newClaudeSession(adapter, process);
    const changing = adapter.setPermissionMode(session, "acceptEdits");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption);
    assert.deepEqual(request.params, { sessionId: FIXTURE_SESSION_ID, configId: "mode", value: "acceptEdits" });
    const options = (fixtureSessionResult() as { configOptions: { id: string; currentValue: string }[] }).configOptions
      .map((option) => option.id === "mode" ? { ...option, currentValue: "acceptEdits" } : option);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { configOptions: options } });
    const applied = await changing;
    assert.equal(applied.find((option) => option.id === "mode")?.currentValue, "acceptEdits");
    const before = process.frames.length;
    await assert.rejects(
      adapter.setPermissionMode(session, "yolo" as unknown as "default"),
      hasAdapterCode("invalid_adapter_options"),
    );
    assert.equal(process.frames.length, before, "an unknown mode never reaches the adapter");
    await adapter.close();
  });
});

describe("Claude dialect: turns, late frames and liveness", () => {
  async function replayFixturePrompt(
    process: FakeProcess,
    adapter: AcpV1Adapter,
    session: AcpV1AdapterSession,
    separateLateFrame: boolean,
  ): Promise<void> {
    const prompting = adapter.prompt(session, "Reply with exactly: FIXTURE-OK");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    const promptIndex = fixture.frames.findIndex((frame) => frame.dir === "->" && frame.msg["method"] === "session/prompt");
    const inbound = fixture.frames.slice(promptIndex + 1).map((frame) => frame.msg);
    const responseIndex = inbound.findIndex((message) => message["id"] === 3);
    const beforeResponse = inbound.slice(0, responseIndex);
    const response = { ...inbound[responseIndex], id: request.id } as WireMessage;
    const afterResponse = inbound.slice(responseIndex + 1);
    for (const message of beforeResponse) process.emitMessages(message);
    if (separateLateFrame) {
      process.emitMessages(response);
      await prompting;
      for (const message of afterResponse) process.emitMessages(message);
    } else {
      // The response and the late frames in one chunk: the late frames race the terminal commit.
      process.emitMessages(response, ...afterResponse);
      await prompting;
    }
  }

  for (const separateLateFrame of [false, true]) {
    it(`replays the recorded prompt; the late session_info_update opens no Run (${separateLateFrame ? "separate" : "same"} chunk)`, async () => {
      const process = new FakeProcess();
      const sink = new AgentTurnCapableSink();
      const adapter = await startClaude(process, sink);
      // The recorded notifications that arrive around session/new.
      const preSession = fixture.frames.filter((frame) => frame.dir === "<-" && frame.msg["method"] === "_auth/status_update").slice(0, 2);
      const opening = adapter.newSession(FIXTURE_CWD);
      const sessionRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
      for (const frame of preSession) process.emitMessages(frame.msg);
      process.emitMessages({ jsonrpc: "2.0", id: sessionRequest.id, result: fixtureSessionResult() } as WireMessage);
      const session = await opening;

      await replayFixturePrompt(process, adapter, session, separateLateFrame);
      await waitFor(() => sink.updates.some((entry) => entry.update.type === "session_context" &&
        entry.update.payload.context.kind === "info"));

      assert.equal(adapter.state, "ready");
      assert.equal(sink.interruptions.length, 0);
      assert.equal(sink.agentTurns.length, 0, "a Claude adapter never opens an agent-initiated Run");
      assert.equal(sink.accepted.length, 1);
      assert.equal(sink.terminals.length, 1);
      assert.equal(sink.terminals[0]?.terminal.stopReason, "end_turn");
      assert.equal(sink.terminals[0]?.terminal.contextTokensUsed, undefined, "usage comes from usage_update, not the prompt result");
      assert.equal(sink.accepted[0]?.identity.promptSequence, 1);

      const kinds = sink.updates.map((entry) => entry.update.type === "turn" ? entry.update.payload.type : entry.update.type === "session_context" ? entry.update.payload.context.kind : entry.update.type);
      assert.deepEqual(kinds, ["usage", "agent_text_chunk", "agent_text_chunk", "usage", "usage", "info"]);
      const info = sink.updates[sink.updates.length - 1];
      assert.equal(info?.promptSequence, undefined, "the title is session metadata, not part of a Run");
      assert.equal(info?.ingestMode, "live");
      assert.deepEqual(
        sink.updates.slice(0, 5).map((entry) => entry.promptSequence),
        [1, 1, 1, 1, 1],
      );
      const usage = sink.updates[3]?.update;
      assert.ok(usage?.type === "session_context" && usage.payload.context.kind === "usage");
      assert.equal(usage.payload.context.size, 1_000_000);
      assert.equal(usage.payload.context.used, 38152);

      assert.deepEqual(
        sink.engineSignals.map((signal) => signal.type === "auth_status" ? signal.status.label : signal.type),
        ["Claude Max", "Claude Max", "Claude Max"],
      );
      assert.equal(JSON.stringify(sink.engineSignals).includes("example.com"), false);

      // The session takes a second prompt right away.
      const second = adapter.prompt(session, "again");
      const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt, 1);
      process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      assert.equal((await second).classification, "completed");
      assert.equal(sink.accepted[1]?.identity.promptSequence, 2);
      await adapter.close();
    });
  }

  it("applies every metadata update outside a prompt without a Run identity", async () => {
    const process = new FakeProcess();
    const sink = new AgentTurnCapableSink();
    const adapter = await startClaude(process, sink);
    await newClaudeSession(adapter, process);
    const options = (fixtureSessionResult() as { configOptions: unknown[] }).configOptions;
    process.emitMessages(
      update({ sessionUpdate: "session_info_update", title: "A title", updatedAt: "2026-10-12T04:18:06.421Z" }),
      update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact the conversation" }] }),
      update({ sessionUpdate: "config_option_update", configOptions: options }),
      update({ sessionUpdate: "usage_update", used: 10, size: 1_000_000 }),
      update({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    );
    await waitFor(() => sink.updates.length === 5);
    assert.deepEqual(
      sink.updates.map((entry) => entry.update.type === "session_context" ? entry.update.payload.context.kind : "other"),
      ["info", "commands", "config", "usage", "mode"],
    );
    assert.deepEqual(sink.updates.map((entry) => entry.promptSequence), [undefined, undefined, undefined, undefined, undefined]);
    assert.equal(sink.agentTurns.length, 0);
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("logs and drops content outside a prompt, including undecodable content, without a transport fault", async () => {
    const process = new FakeProcess();
    const sink = new AgentTurnCapableSink();
    const adapter = await startClaude(process, sink);
    await newClaudeSession(adapter, process);
    process.emitMessages(
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unprompted words" } }),
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Bash" }),
      update({ sessionUpdate: "agent_message_chunk", content: { type: "no-such-content-type" } }),
      update({ sessionUpdate: "plan", entries: "not-an-array" }),
    );
    await waitFor(() => sink.engineSignals.filter((signal) => signal.type === "late_update_dropped").length >= 4);
    await immediate();
    assert.equal(sink.updates.length, 0);
    assert.equal(sink.agentTurns.length, 0);
    assert.equal(adapter.state, "ready");
    assert.equal(sink.interruptions.length, 0);
    const dropped = sink.engineSignals.filter((signal) => signal.type === "late_update_dropped");
    assert.deepEqual(dropped.map((signal) => signal.type === "late_update_dropped" ? signal.discriminator : ""), [
      "agent_text_chunk",
      "tool_call_create",
      "agent_message_chunk",
      "plan",
    ], "decodable content is named by its payload type, undecodable content by its wire discriminator");
    assert.equal(JSON.stringify(dropped).includes("unprompted words"), false, "no content in the signal");

    // And a permission request outside any prompt is cancelled, not asked and not a fault.
    process.emitMessages({
      jsonrpc: "2.0",
      id: "late-permission",
      method: ACP_V1_METHODS.sessionRequestPermission,
      params: {
        sessionId: FIXTURE_SESSION_ID,
        toolCall: { toolCallId: "t1", title: "Run a command" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    });
    await waitFor(() => process.outbound().some((message) => message.id === "late-permission"));
    assert.deepEqual(process.outbound().find((message) => message.id === "late-permission"), {
      jsonrpc: "2.0",
      id: "late-permission",
      result: { outcome: { outcome: "cancelled" } },
    });
    assert.equal(sink.permissionRequests.length, 0);
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("counts a -32601 answer to _guild/ping as alive", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const probing = adapter.probeLiveness(500);
    const request = await waitForOutbound(process, "_guild/ping");
    process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    assert.equal(await probing, true);
    assert.equal(adapter.state, "ready");
    assert.equal(await adapter.probeLiveness(20), false, "silence is still not alive");
    await adapter.close();
  });
});

describe("Claude dialect: Steer through _session/steering (docs/20 section 3.8)", () => {
  async function steering(
    outcome: unknown,
  ): Promise<{ result: Awaited<ReturnType<AcpV1Adapter["steer"]>>; request: WireMessage; adapter: AcpV1Adapter; process: FakeProcess }> {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const session = await newClaudeSession(adapter, process);
    const sending = adapter.steer(session, "use the other file");
    const request = await waitForOutbound(process, "_session/steering");
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: outcome } as WireMessage);
    return { result: await sending, request, adapter, process };
  }

  it("encodes a text block with idleBehavior promptRequired and decodes each outcome", async () => {
    for (const outcome of ["injected", "promptRequired", "startedNewTurn"] as const) {
      const { result, request, adapter } = await steering(
        outcome === "promptRequired" ? { outcome, reason: "noRunningTurn" } : { outcome },
      );
      assert.deepEqual(request.params, {
        sessionId: FIXTURE_SESSION_ID,
        prompt: [{ type: "text", text: "use the other file" }],
        _meta: { steering: { idleBehavior: "promptRequired" } },
      });
      assert.deepEqual(result, { status: "ok", outcome });
      assert.equal(adapter.state, "ready");
      await adapter.close();
    }
  });

  it("treats an unknown outcome as a refused steer without faulting the transport", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const session = await newClaudeSession(adapter, process);
    const sending = adapter.steer(session, "x");
    const request = await waitForOutbound(process, "_session/steering");
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { outcome: "somethingNew" } });
    await assert.rejects(sending, hasAdapterCode("operation_failed"));
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("remembers -32601 as unsupported and surfaces other remote errors", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const session = await newClaudeSession(adapter, process);
    const first = adapter.steer(session, "x");
    const request = await waitForOutbound(process, "_session/steering");
    process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    assert.deepEqual(await first, { status: "unsupported", reason: "not_found" });
    assert.deepEqual(await adapter.steer(session, "y"), { status: "unsupported", reason: "not_found" });
    assert.equal(process.outbound().filter((message) => message.method === "_session/steering").length, 1);
    await adapter.close();

    const failing = new FakeProcess();
    const other = await startClaude(failing, new RecordingSink());
    const otherSession = await newClaudeSession(other, failing);
    const sending = other.steer(otherSession, "x");
    const failed = await waitForOutbound(failing, "_session/steering");
    failing.emitMessages({ jsonrpc: "2.0", id: failed.id, error: { code: -32602, message: "bad params" } });
    await assert.rejects(sending, (cause: unknown) => cause instanceof AcpV1ExtensionRequestError && cause.remoteCode === -32602);
    assert.equal(other.state, "ready");
    await other.close();
  });

  it("rejects empty text and never steers a Grok adapter through this request", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const session = await newClaudeSession(adapter, process);
    await assert.rejects(adapter.steer(session, ""), hasAdapterCode("invalid_adapter_options"));
    await adapter.close();

    const grok = new FakeProcess();
    const grokAdapter = new AcpV1Adapter({ adapterEpoch: 1, clock, process: grok, sink: new RecordingSink() });
    const starting = grokAdapter.start();
    const initialize = await waitForOutbound(grok, ACP_V1_METHODS.initialize);
    grok.emitMessages({ jsonrpc: "2.0", id: initialize.id, result: { protocolVersion: 1, _meta: { steering: { supported: true } } } });
    await starting;
    const opening = grokAdapter.newSession(FIXTURE_CWD);
    const sessionRequest = await waitForOutbound(grok, ACP_V1_METHODS.sessionNew);
    grok.emitMessages({ jsonrpc: "2.0", id: sessionRequest.id, result: { sessionId: "grok-session" } });
    assert.deepEqual(await grokAdapter.steer(await opening, "x"), { status: "unsupported", reason: "engine" });
    assert.equal(grok.outbound().some((message) => message.method === "_session/steering"), false);
    await grokAdapter.close();
  });
});

describe("Claude dialect: Grok-only features answer without a wire call (PC-FALLBACK-001)", () => {
  it("returns a typed unsupported-for-engine result for _x.ai requests, billing and set_model", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const session = await newClaudeSession(adapter, process);
    const before = process.frames.length;
    for (const method of ["_x.ai/interject", "_x.ai/rewind/preview", "_x.ai/usage"]) {
      assert.deepEqual(
        await adapter.sendExtensionRequest(method, { sessionId: session.sessionId }),
        { status: "unsupported", reason: "engine" },
        method,
      );
    }
    await assert.rejects(adapter.officialBilling(), hasAdapterCode("unsupported_for_engine"));
    await assert.rejects(adapter.setModel(session, "opus"), hasAdapterCode("unsupported_for_engine"));
    // A malformed method is still a caller bug, not an engine limitation.
    await assert.rejects(adapter.sendExtensionRequest("x.ai/bare", {}), hasAdapterCode("invalid_adapter_options"));
    assert.equal(process.frames.length, before, "nothing was written to the adapter");
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("resumes a native session whose model option names a routed id the list does not offer, without a protocol fault, and the next set_config_option fixes it [D-062]", async () => {
    // The live failure of the switch back to Claude: the adapter restored deepseek-v4-flash from the transcript.
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startClaude(process, sink);
    const recorded = fixtureSessionResult() as { configOptions: { id: string; currentValue: string }[] };
    const strayOptions = recorded.configOptions.map((option) =>
      option.id === "model" ? { ...option, currentValue: "deepseek-v4-flash" } : option);
    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD);
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: { ...recorded, configOptions: strayOptions } } as WireMessage);
    const resumed = await resuming;
    assert.equal(adapter.state, "ready", "the transport is not interrupted");
    assert.equal(resumed.establishedBy, "resume");
    const model = resumed.configOptions?.find((option) => option.category === "model");
    assert.ok(model?.type === "select" && model.unlisted === true && model.currentValue === "deepseek-v4-flash");
    assert.equal(resumed.modelCatalog?.models.some((entry) => entry.id === "deepseek-v4-flash"), false, "never a Claude model");
    assert.equal(resumed.modelCatalog?.models.length, 12);
    assert.equal(resumed.modelCatalog?.runtimeDefaultModelId, undefined);

    // Guild then applies the selected Claude model: the answer lists it and the flag is gone.
    const switching = adapter.setConfigOption(resumed, "model", "default");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption);
    const applied = strayOptions.map((option) => option.id === "model" ? { ...option, currentValue: "default" } : option);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { configOptions: applied } });
    const options = await switching;
    const after = options.find((option) => option.category === "model");
    assert.ok(after?.type === "select" && after.currentValue === "default" && !("unlisted" in after));
    await adapter.close();
  });

  it("switches the model with a plain set_config_option and re-derives the catalog from its result", async () => {
    const process = new FakeProcess();
    const adapter = await startClaude(process, new RecordingSink());
    const session = await newClaudeSession(adapter, process);
    const switching = adapter.setConfigOption(session, "model", "claude-opus-4-8");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption);
    assert.deepEqual(request.params, { sessionId: FIXTURE_SESSION_ID, configId: "model", value: "claude-opus-4-8" });
    const options = (fixtureSessionResult() as { configOptions: { id: string; currentValue: string }[] }).configOptions
      .map((option) => option.id === "model" ? { ...option, currentValue: "claude-opus-4-8" } : option);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { configOptions: options } });
    const applied = await switching;
    assert.equal(applied.find((option) => option.id === "model")?.currentValue, "claude-opus-4-8");
    await adapter.close();
  });
});
