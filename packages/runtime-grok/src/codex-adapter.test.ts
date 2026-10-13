import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { modelCatalogEngineOf, modelGroupOf } from "@guild/contracts";
import {
  AcpV1Adapter,
  AcpV1AdapterError,
  CODEX_ACP_ADAPTER_DEFAULT_TIMEOUTS,
  type AcpV1AdapterOptions,
  type AcpV1AdapterSession,
  type AcpV1AdapterSink,
  type AcpV1PeerPort,
  type AcpV1ProcessPort,
} from "./acp-adapter.js";
import { ACP_V1_METHODS } from "./acp-v1-methods.js";
import type { EngineSignal } from "./claude-dialect.js";
import { CODEX_ENGINE_PROFILE } from "./engine-profile.js";
import { JsonRpcPeer, type JsonRpcFrameWriter } from "./json-rpc-peer.js";
import type { ProcessHostEvent } from "./process-host.js";

/*
 * The Codex dialect against a transcript recorded from codex-acp 2.2.2 (docs/21 section 2): the frames are the
 * adapter's own, with the account, paths, command list and reply text replaced.
 */

type WireMessage = Record<string, unknown>;
type SinkEvent<Name extends keyof AcpV1AdapterSink> =
  Parameters<NonNullable<AcpV1AdapterSink[Name]>>[0];

type FixtureFrame = { readonly dir: "->" | "<-"; readonly msg: WireMessage };
const fixture = JSON.parse(
  readFileSync(new URL("../src/fixtures/codex-acp-2.2.2-session.json", import.meta.url), "utf8"),
) as { readonly frames: readonly FixtureFrame[] };

const FIXTURE_SESSION_ID = "019f0000-0000-7000-8000-00000000c0de";
const FIXTURE_CWD = "/tmp/guild-fixture-ws";

const clock = Object.freeze({
  monotonicMs: () => 123.5,
  wallClockIso: () => "2026-10-13T12:34:56.789Z",
});

class FakeProcess implements AcpV1ProcessPort {
  readonly frames: string[] = [];
  readonly listeners = new Set<(event: ProcessHostEvent) => void>();

  onEvent(listener: (event: ProcessHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<unknown> {
    return { type: "fake_started" };
  }

  async stop(): Promise<unknown> {
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
    const allowOnce = event.request.options.find((option) => option.kind === "allow_once");
    return {
      decision: { type: "selected", optionId: allowOnce?.optionId ?? "allow_once" },
      delivery: { commandId: `command-${this.permissionRequests.length}`, version: 1, deliveryAttemptId: `attempt-${this.permissionRequests.length}` },
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

/** Also able to attach agent-started turns: a Codex adapter must still never open one. */
class AgentTurnCapableSink extends RecordingSink {
  async commitAgentTurnStarted(event: SinkEvent<"commitAgentTurnStarted">): Promise<void> {
    this.agentTurns.push(event);
  }
}

function adapterOptions(process: FakeProcess, sink: RecordingSink): AcpV1AdapterOptions {
  return { adapterEpoch: 7, clock, process, sink, profile: CODEX_ENGINE_PROFILE };
}

const fixtureInitializeResult = (): unknown =>
  (fixture.frames.find((frame) => frame.dir === "<-" && frame.msg["id"] === 1)?.msg["result"]);

const fixtureSessionResult = (): Record<string, unknown> =>
  (fixture.frames.find((frame) => frame.dir === "<-" && frame.msg["id"] === 2)?.msg["result"]) as Record<string, unknown>;

async function startCodex(
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
    clientInfo: { name: "guild", title: "Guild", version: "3.0.5" },
  });
  process.emitMessages({ jsonrpc: "2.0", id: initialize.id, result: initializeResult } as WireMessage);
  await starting;
  return adapter;
}

async function newCodexSession(
  adapter: AcpV1Adapter,
  process: FakeProcess,
  startOptions?: Parameters<AcpV1Adapter["newSession"]>[1],
  result: Record<string, unknown> = fixtureSessionResult(),
): Promise<AcpV1AdapterSession> {
  const operation = adapter.newSession(FIXTURE_CWD, startOptions);
  const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
  process.emitMessages({ jsonrpc: "2.0", id: request.id, result } as WireMessage);
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

describe("Codex dialect: initialize and authentication (PC-ENG-003)", () => {
  it("initializes against the recorded adapter result and reads the capabilities Guild needs", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    assert.equal(adapter.engine, "codex");
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

  it("never authenticates: it advertises api-key and chat-gpt even when logged in, and both are ignored", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    // The recorded initialize result carries the adapter's two methods.
    const advertised = (fixtureInitializeResult() as { authMethods: { id: string }[] }).authMethods.map((method) => method.id);
    assert.deepEqual(advertised, ["api-key", "chat-gpt"]);
    await assert.rejects(adapter.authenticate("chat-gpt"), hasAdapterCode("unsupported_for_engine"));
    await assert.rejects(adapter.authenticate("api-key"), hasAdapterCode("unsupported_for_engine"));
    assert.equal(process.outbound().some((message) => message.method === ACP_V1_METHODS.authenticate), false);
    const session = await newCodexSession(adapter, process);
    assert.equal(session.sessionId, FIXTURE_SESSION_ID);
    await adapter.close();
  });

  it("gives the start requests a 180 s window, between Grok's 30 s and Claude's 300 s", async () => {
    assert.equal(CODEX_ACP_ADAPTER_DEFAULT_TIMEOUTS.initializeMs, 180_000);
    assert.equal(CODEX_ACP_ADAPTER_DEFAULT_TIMEOUTS.sessionMs, 180_000);
    const observed = new Map<string, number | null | undefined>();
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink(), undefined, { peerFactory: timeoutObserver(observed) });
    await newCodexSession(adapter, process);
    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD);
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: fixtureSessionResult() } as WireMessage);
    await resuming;
    const loading = adapter.loadSession("other-session", FIXTURE_CWD);
    const load = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    process.emitMessages({ jsonrpc: "2.0", id: load.id, result: fixtureSessionResult() } as WireMessage);
    await loading;
    for (const method of [ACP_V1_METHODS.initialize, ACP_V1_METHODS.sessionNew, ACP_V1_METHODS.sessionResume, ACP_V1_METHODS.sessionLoad]) {
      assert.equal(observed.get(method), 180_000, method);
    }
    await adapter.close();
  });

  it("names a start that got no answer in time (request_timeout) and keeps the adapter alive", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink(), undefined, { timeouts: { sessionMs: 25 } });
    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD);
    await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    await assert.rejects(resuming, hasAdapterCode("request_timeout"));
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("maps the ACP auth-required error of session/new to a named error without faulting", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const operation = adapter.newSession(FIXTURE_CWD);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } });
    await assert.rejects(operation, hasAdapterCode("auth_required"));
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("answers a missing thread (an internal error that says 'no rollout found') with session_not_found and nothing else", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const gone = adapter.resumeSession("01a13319-0000-7000-8000-000000000000", FIXTURE_CWD);
    const first = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    process.emitMessages({
      jsonrpc: "2.0",
      id: first.id,
      error: {
        code: -32603,
        message: "Internal error",
        data: { details: "no rollout found for thread id 01a13319-0000-7000-8000-000000000000" },
      },
    });
    await assert.rejects(gone, hasAdapterCode("session_not_found"));
    assert.equal(adapter.state, "ready");

    // Any other internal error is not a statement about the session, and neither is a plain -32603.
    for (const [index, error] of [
      { code: -32603, message: "Internal error", data: { details: "invalid session id: invalid character" } },
      { code: -32603, message: "Internal error" },
      { code: -32603, message: "Internal error", data: { details: 7 } },
      { code: -32602, message: "no rollout found for thread id x" },
    ].entries()) {
      const attempt = adapter.resumeSession(`other-${index}`, FIXTURE_CWD);
      const request = await waitForOutbound(process, ACP_V1_METHODS.sessionResume, index + 1);
      process.emitMessages({ jsonrpc: "2.0", id: request.id, error });
      await assert.rejects(attempt, hasAdapterCode("operation_failed"), JSON.stringify(error));
    }
    // ACP's own -32002 counts too.
    const standard = adapter.resumeSession("standard", FIXTURE_CWD);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionResume, 5);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "Resource not found" } });
    await assert.rejects(standard, hasAdapterCode("session_not_found"));
    await adapter.close();
  });

  it("surfaces _auth/status_update as an identity summary without the account e-mail", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startCodex(process, sink);
    const status = fixture.frames.find((frame) => frame.dir === "<-" && frame.msg["method"] === "_auth/status_update");
    assert.ok(status !== undefined);
    process.emitMessages(status.msg);
    await waitFor(() => sink.engineSignals.length === 1);
    assert.deepEqual(sink.engineSignals[0], {
      type: "auth_status",
      engine: "codex",
      status: { kind: "account", label: "ChatGPT Plus", plan: "plus" },
    });
    assert.equal(JSON.stringify(sink.engineSignals).includes("example.com"), false);
    // The other kinds the adapter defines.
    process.emitMessages(
      { jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: { kind: "api_key", label: "OpenAI API key" } } },
      { jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: { kind: "none", label: "Not logged in" } } },
      { jsonrpc: "2.0", method: "_auth/status_update", params: { authStatus: "nope" } },
      { jsonrpc: "2.0", method: "_x.ai/queue/changed", params: { sessionId: "s" } },
    );
    await waitFor(() => sink.engineSignals.length === 3);
    assert.deepEqual(sink.engineSignals.slice(1).map((signal) => signal.type === "auth_status" ? signal.status.kind : signal.type), ["api_key", "none"]);
    assert.equal(sink.xaiSignals.length, 0);
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });
});

describe("Codex dialect: sessions, catalog and start options", () => {
  it("sends a plain session/new and builds the picker catalog from the options and the per-effort model list", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startCodex(process, sink);
    const session = await newCodexSession(adapter, process, { reasoningEffort: "high" });
    const request = process.outbound().find((message) => message.method === ACP_V1_METHODS.sessionNew);
    assert.deepEqual(request?.params, { cwd: FIXTURE_CWD, mcpServers: [] }, "no _meta for Codex");

    const catalog = session.modelCatalog;
    assert.ok(catalog !== undefined);
    assert.equal(modelCatalogEngineOf(catalog), "codex");
    assert.equal(catalog.runtimeDefaultModelId, "gpt-6.1-sol");
    assert.deepEqual(catalog.models.map((model) => model.id), [
      "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    ]);
    assert.ok(catalog.models.every((model) => modelGroupOf(model) === "codex"));
    const sol = catalog.models.find((model) => model.id === "gpt-6.1-sol");
    assert.equal(sol?.name, "6.1 Sol");
    // The efforts of every model, not only the selected one, from the legacy `id[effort]` list.
    assert.deepEqual(sol?.reasoningEfforts.map((effort) => [effort.id, effort.label, effort.isDefault]), [
      ["low", "Low", false], ["medium", "Medium", false], ["high", "High", true],
      ["xhigh", "Xhigh", false], ["max", "Max", false], ["ultra", "Ultra", false],
    ]);
    const luna = catalog.models.find((model) => model.id === "gpt-5.6-luna");
    assert.deepEqual(luna?.reasoningEfforts.map((effort) => effort.id), ["low", "medium", "high", "xhigh", "max"], "no ultra on Luna");
    assert.deepEqual(luna?.reasoningEfforts.filter((effort) => effort.isDefault).map((effort) => effort.id), ["high"], "Codex has one configured effort, marked on every model that offers it");
    assert.deepEqual(session.configOptions?.map((option) => option.id), ["mode", "collaboration_mode", "model", "reasoning_effort", "fast-mode"]);
    assert.equal(session.modes?.currentModeId, "agent");
    assert.equal(sink.sessions[0]?.state.modelCatalog, catalog);
    await adapter.close();
  });

  it("derives a catalog from the options alone when the session response lacks the legacy list", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const { models: _models, ...withoutModels } = fixtureSessionResult();
    const session = await newCodexSession(adapter, process, undefined, withoutModels);
    const sol = session.modelCatalog?.models.find((model) => model.id === "gpt-6.1-sol");
    const terra = session.modelCatalog?.models.find((model) => model.id === "gpt-5.6-terra");
    assert.equal(sol?.reasoningEfforts.length, 6, "the selected model keeps the effort option's list");
    assert.deepEqual(terra?.reasoningEfforts, [], "the others are learned after a switch");
    await adapter.close();
  });

  it("accepts a configured default model the account no longer offers, as an unlisted value, and never makes it a model", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const recorded = fixtureSessionResult() as { configOptions: { id: string; currentValue: string }[] };
    const stray = recorded.configOptions.map((option) => option.id === "model" ? { ...option, currentValue: "gpt-4.1-retired" } : option);
    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD);
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: { ...recorded, configOptions: stray } } as WireMessage);
    const resumed = await resuming;
    assert.equal(adapter.state, "ready");
    const model = resumed.configOptions?.find((option) => option.category === "model");
    assert.ok(model?.type === "select" && model.unlisted === true && model.currentValue === "gpt-4.1-retired");
    assert.equal(resumed.modelCatalog?.models.some((entry) => entry.id === "gpt-4.1-retired"), false);
    assert.equal(resumed.modelCatalog?.runtimeDefaultModelId, undefined);
    await adapter.close();
  });

  it("refuses the Claude adapter's start options and passes HTTP MCP servers only when the agent advertised them", async () => {
    const server = {
      type: "http" as const,
      name: "guild-browser",
      url: "http://127.0.0.1:43121/0123456789abcdef0123456789abcdef/mcp",
      headers: [] as const,
    };
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    await assert.rejects(
      adapter.newSession(FIXTURE_CWD, { claudeCodeOptions: { settings: {} } }),
      hasAdapterCode("invalid_adapter_options"),
    );
    assert.equal(process.outbound().some((message) => message.method === ACP_V1_METHODS.sessionNew), false);
    await newCodexSession(adapter, process, { mcpServers: [server] });
    const request = process.outbound().find((message) => message.method === ACP_V1_METHODS.sessionNew);
    assert.deepEqual(request?.params, { cwd: FIXTURE_CWD, mcpServers: [server] });
    // Resume and load carry them too.
    const resuming = adapter.resumeSession("old-session", FIXTURE_CWD, { mcpServers: [server] });
    const resume = await waitForOutbound(process, ACP_V1_METHODS.sessionResume);
    assert.deepEqual(resume.params, { sessionId: "old-session", cwd: FIXTURE_CWD, mcpServers: [server] });
    process.emitMessages({ jsonrpc: "2.0", id: resume.id, result: fixtureSessionResult() } as WireMessage);
    await resuming;
    await adapter.close();

    const noMcp = new FakeProcess();
    const base = fixtureInitializeResult() as { agentCapabilities: Record<string, unknown> };
    const plain = await startCodex(noMcp, new RecordingSink(), {
      ...base,
      agentCapabilities: { ...base.agentCapabilities, mcpCapabilities: { http: false } },
    });
    await assert.rejects(plain.newSession(FIXTURE_CWD, { mcpServers: [server] }), hasAdapterCode("capability_not_advertised"));
    await plain.close();
  });

  it("applies the permission mode by Codex's own mode ids, and refuses a Claude mode", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const session = await newCodexSession(adapter, process);
    const changing = adapter.setPermissionMode(session, "read-only");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption);
    assert.deepEqual(request.params, { sessionId: FIXTURE_SESSION_ID, configId: "mode", value: "read-only" });
    const options = (fixtureSessionResult() as { configOptions: { id: string; currentValue: string }[] }).configOptions
      .map((option) => option.id === "mode" ? { ...option, currentValue: "read-only" } : option);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { configOptions: options } });
    assert.equal((await changing).find((option) => option.id === "mode")?.currentValue, "read-only");
    const before = process.frames.length;
    for (const bad of ["default", "bypassPermissions", "danger-full-access", ""]) {
      await assert.rejects(adapter.setPermissionMode(session, bad), hasAdapterCode("invalid_adapter_options"), bad);
    }
    assert.equal(process.frames.length, before, "an unknown mode never reaches the adapter");
    await adapter.close();
  });

  it("switches the model and then the effort with plain set_config_option calls", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const session = await newCodexSession(adapter, process);
    // The recorded answers of the model and effort changes (frames 7 and 9).
    const answers = fixture.frames.filter((frame) => frame.dir === "<-" && (frame.msg["id"] === 3 || frame.msg["id"] === 4))
      .map((frame) => (frame.msg["result"] as { configOptions: unknown[] }));
    const modelChange = adapter.setConfigOption(session, "model", "gpt-5.6-luna");
    const first = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption, 0);
    assert.deepEqual(first.params, { sessionId: FIXTURE_SESSION_ID, configId: "model", value: "gpt-5.6-luna" });
    process.emitMessages({ jsonrpc: "2.0", id: first.id, result: answers[0] } as WireMessage);
    const afterModel = await modelChange;
    assert.equal(afterModel.find((option) => option.category === "model")?.currentValue, "gpt-5.6-luna");
    const effortChange = adapter.setConfigOption(session, "reasoning_effort", "low");
    const second = await waitForOutbound(process, ACP_V1_METHODS.sessionSetConfigOption, 1);
    process.emitMessages({ jsonrpc: "2.0", id: second.id, result: answers[1] } as WireMessage);
    const afterEffort = await effortChange;
    const effort = afterEffort.find((option) => option.category === "thought_level");
    assert.equal(effort?.currentValue, "low");
    assert.ok(effort?.type === "select" && effort.choices.form === "flat" && !effort.choices.options.some((choice) => choice.value === "ultra"), "Luna offers no ultra");
    await adapter.close();
  });
});

describe("Codex dialect: the recorded turn, permissions and late frames", () => {
  async function replayRecordedPrompt(
    process: FakeProcess,
    adapter: AcpV1Adapter,
    session: AcpV1AdapterSession,
    sink: RecordingSink,
    separateLateFrame: boolean,
  ): Promise<void> {
    const prompting = adapter.prompt(session, "Create a file named hello.txt in the current directory containing exactly the text hi. Then reply with exactly: DONE");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    const promptIndex = fixture.frames.findIndex((frame) => frame.dir === "->" && frame.msg["method"] === "session/prompt");
    const inbound = fixture.frames.slice(promptIndex + 1).filter((frame) => frame.dir === "<-").map((frame) => frame.msg);
    const responseIndex = inbound.findIndex((message) => message["id"] === 6);
    const response = { ...inbound[responseIndex], id: request.id } as WireMessage;
    const beforeResponse = inbound.slice(0, responseIndex);
    const afterResponse = inbound.slice(responseIndex + 1);
    for (const message of beforeResponse) {
      if (message["method"] === "session/request_permission") {
        // The recorded request ids are numeric callbacks of the adapter; Guild answers each through the sink.
        const before = sink.permissionRequests.length;
        process.emitMessages(message);
        await waitFor(() => sink.permissionRequests.length === before + 1);
        await waitFor(() => process.outbound().some((outbound) => outbound.id === message["id"]));
      } else {
        process.emitMessages(message);
      }
    }
    if (separateLateFrame) {
      process.emitMessages(response);
      await prompting;
      for (const message of afterResponse) process.emitMessages(message);
    } else {
      process.emitMessages(response, ...afterResponse);
      await prompting;
    }
  }

  for (const separateLateFrame of [false, true]) {
    it(`replays the recorded tool turn: two permission cards, usage, a title and a late command list that opens no Run (${separateLateFrame ? "separate" : "same"} chunk)`, async () => {
      const process = new FakeProcess();
      const sink = new AgentTurnCapableSink();
      const adapter = await startCodex(process, sink);
      const opening = adapter.newSession(FIXTURE_CWD);
      const sessionRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
      for (const frame of fixture.frames.filter((candidate) => candidate.dir === "<-" && candidate.msg["method"] === "_auth/status_update")) {
        process.emitMessages(frame.msg);
      }
      process.emitMessages({ jsonrpc: "2.0", id: sessionRequest.id, result: fixtureSessionResult() } as WireMessage);
      const session = await opening;

      await replayRecordedPrompt(process, adapter, session, sink, separateLateFrame);
      await waitFor(() => sink.updates.some((entry) => entry.update.type === "session_context" &&
        entry.update.payload.context.kind === "commands" && entry.promptSequence === undefined));

      assert.equal(adapter.state, "ready");
      assert.equal(sink.interruptions.length, 0);
      assert.equal(sink.agentTurns.length, 0, "a Codex adapter never opens an agent-initiated Run");
      assert.equal(sink.accepted.length, 1);
      assert.equal(sink.terminals.length, 1);
      assert.equal(sink.terminals[0]?.terminal.stopReason, "end_turn");

      // Two permission cards: a command, with the persistent-rule option kept as the agent worded it.
      assert.equal(sink.permissionRequests.length, 2);
      const first = sink.permissionRequests[0]!.request;
      assert.equal(first.title, "Run command");
      assert.equal(first.toolCallId, "exec-fixture-1");
      assert.deepEqual(first.options.map((option) => [option.optionId, option.kind]), [
        ["allow_once", "allow_once"], ["accept_execpolicy_amendment", "allow_always"], ["cancel", "reject_once"],
      ]);
      assert.match(first.options[1]!.name, /^Yes, and don't ask again for commands that start with/u);
      // Guild's answer is the selected option, written back with the adapter's own request id.
      const answered = process.outbound().filter((message) => "result" in message && message["id"] !== undefined && typeof message["id"] === "number" && message["id"] < 1000 && (message["result"] as { outcome?: unknown }).outcome !== undefined);
      assert.deepEqual(answered.map((message) => message["result"]), [
        { outcome: { outcome: "selected", optionId: "allow_once" } },
        { outcome: { outcome: "selected", optionId: "allow_once" } },
      ]);

      const kinds = sink.updates.map((entry) => entry.update.type === "turn" ? entry.update.payload.type : entry.update.type === "session_context" ? entry.update.payload.context.kind : entry.update.type);
      assert.ok(kinds.includes("tool_call_create") && kinds.includes("tool_call_update") && kinds.includes("agent_thought_chunk"), JSON.stringify(kinds));
      const usage = sink.updates.filter((entry) => entry.update.type === "session_context" && entry.update.payload.context.kind === "usage");
      assert.equal(usage.length, 3);
      const lastUsage = usage[usage.length - 1]!.update;
      assert.ok(lastUsage.type === "session_context" && lastUsage.payload.context.kind === "usage");
      assert.equal(lastUsage.payload.context.size, 258400);
      // The title and the command list outside the turn are session metadata: no Run identity.
      const late = sink.updates[sink.updates.length - 1]!;
      assert.equal(late.promptSequence, undefined);
      assert.equal(late.ingestMode, "live");
      assert.equal(sink.engineSignals.some((signal) => signal.type === "late_update_dropped"), false, "metadata is applied, not dropped");
      assert.equal(JSON.stringify(sink.engineSignals).includes("example.com"), false);

      // The session takes a second prompt right away.
      const second = adapter.prompt(session, "again");
      const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt, 1);
      process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
      assert.equal((await second).classification, "completed");
      await adapter.close();
    });
  }

  it("applies the thread-status and title updates of a running turn as metadata, and an unknown _meta is harmless", async () => {
    const process = new FakeProcess();
    const sink = new AgentTurnCapableSink();
    const adapter = await startCodex(process, sink);
    await newCodexSession(adapter, process);
    process.emitMessages(
      update({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active", activeFlags: ["waitingOnApproval"] } } } }),
      update({ sessionUpdate: "session_info_update", title: "Fix the build" }),
      update({ sessionUpdate: "usage_update", used: 32376, size: 258400 }),
      update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "$documents:documents", description: "Documents" }, { name: "compact", description: "Compact" }] }),
    );
    await waitFor(() => sink.updates.length === 4);
    assert.deepEqual(sink.updates.map((entry) => entry.promptSequence), [undefined, undefined, undefined, undefined]);
    assert.equal(sink.agentTurns.length, 0);
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("drops what a cancelled command keeps sending after the prompt ended, and says so, without opening a Run", async () => {
    const process = new FakeProcess();
    const sink = new AgentTurnCapableSink();
    const adapter = await startCodex(process, sink);
    const session = await newCodexSession(adapter, process);
    const prompting = adapter.prompt(session, "count slowly");
    const prompt = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    process.emitMessages(update({
      sessionUpdate: "tool_call", toolCallId: "exec-1", kind: "execute", title: "for i in $(seq 1 200); do echo $i; sleep 1; done",
      status: "in_progress", content: [{ type: "terminal", terminalId: "exec-1" }], rawInput: { command: "for i in ...", cwd: FIXTURE_CWD },
    }));
    await waitFor(() => sink.updates.length === 1);
    const cancelling = adapter.cancel(session);
    const cancel = await waitForOutbound(process, ACP_V1_METHODS.sessionCancel);
    assert.deepEqual(cancel.params, { sessionId: FIXTURE_SESSION_ID });
    process.emitMessages({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } });
    await cancelling;
    assert.equal((await prompting).classification, "cancelled");
    // The command is still running in Codex and reports on: terminal updates and a permission it wants.
    process.emitMessages(
      update({ sessionUpdate: "tool_call_update", toolCallId: "exec-1", status: "in_progress", _meta: { terminal_output: { terminal_id: "exec-1", data: "4\n" } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "exec-1", status: "completed", _meta: { terminal_exit: { exit_code: 0, signal: null, terminal_id: "exec-1" } } }),
    );
    process.emitMessages({
      jsonrpc: "2.0", id: 901, method: ACP_V1_METHODS.sessionRequestPermission,
      params: { sessionId: FIXTURE_SESSION_ID, toolCall: { toolCallId: "exec-2", title: "Run command" }, options: [{ optionId: "allow_once", name: "Yes", kind: "allow_once" }] },
    });
    await waitFor(() => sink.engineSignals.filter((signal) => signal.type === "late_update_dropped").length >= 2);
    await waitFor(() => process.outbound().some((message) => message.id === 901));
    assert.deepEqual(process.outbound().find((message) => message.id === 901)?.result, { outcome: { outcome: "cancelled" } });
    assert.equal(sink.permissionRequests.length, 0, "nothing is asked of the user for work no turn owns");
    const dropped = sink.engineSignals.filter((signal) => signal.type === "late_update_dropped");
    assert.ok(dropped.every((signal) => signal.engine === "codex"));
    assert.equal(sink.agentTurns.length, 0);
    assert.equal(sink.updates.length, 1);
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("counts a -32601 answer to _guild/ping as alive", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const probing = adapter.probeLiveness(500);
    const request = await waitForOutbound(process, "_guild/ping");
    process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found", data: { method: "_guild/ping" } } });
    assert.equal(await probing, true);
    await adapter.close();
  });
});

describe("Codex dialect: Steer through _session/steering (docs/21 section 4.6)", () => {
  async function runningTurn(): Promise<{
    process: FakeProcess;
    adapter: AcpV1Adapter;
    session: AcpV1AdapterSession;
    prompting: ReturnType<AcpV1Adapter["prompt"]>;
    prompt: WireMessage;
  }> {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const session = await newCodexSession(adapter, process);
    const prompting = adapter.prompt(session, "do the long thing");
    const prompt = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    return { process, adapter, session, prompting, prompt };
  }

  async function steer(
    outcome: unknown,
  ): Promise<{ result: Awaited<ReturnType<AcpV1Adapter["steer"]>>; request: WireMessage; env: Awaited<ReturnType<typeof runningTurn>> }> {
    const env = await runningTurn();
    const sending = env.adapter.steer(env.session, "also add STEERED");
    const request = await waitForOutbound(env.process, "_session/steering");
    env.process.emitMessages({ jsonrpc: "2.0", id: request.id, result: outcome } as WireMessage);
    return { result: await sending, request, env };
  }

  async function finish(env: Awaited<ReturnType<typeof runningTurn>>): Promise<void> {
    env.process.emitMessages({ jsonrpc: "2.0", id: env.prompt.id, result: { stopReason: "end_turn" } });
    await env.prompting;
    await env.adapter.close();
  }

  it("injects into the turn Guild started, with the Claude request shape", async () => {
    const { result, request, env } = await steer({ outcome: "injected" });
    assert.deepEqual(request.params, {
      sessionId: FIXTURE_SESSION_ID,
      prompt: [{ type: "text", text: "also add STEERED" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    assert.deepEqual(result, { status: "ok", outcome: "injected" });
    assert.equal(env.process.outbound().some((message) => message.method === ACP_V1_METHODS.sessionCancel), false);
    await finish(env);
  });

  it("asks Codex only while Guild's own prompt is in flight: with none it answers promptRequired itself, because Codex would start a turn", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const session = await newCodexSession(adapter, process);
    assert.deepEqual(await adapter.steer(session, "x"), { status: "ok", outcome: "promptRequired" });
    assert.equal(process.outbound().some((message) => message.method === "_session/steering"), false, "no wire call");

    // After a finished turn too.
    const prompting = adapter.prompt(session, "one");
    const prompt = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    process.emitMessages({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await prompting;
    assert.deepEqual(await adapter.steer(session, "y"), { status: "ok", outcome: "promptRequired" });
    assert.equal(process.outbound().some((message) => message.method === "_session/steering"), false);
    await adapter.close();
  });

  it("cancels the turn Codex started when the turn had ended on its side (startedNewTurn), so the text is not run twice", async () => {
    const { result, env } = await steer({ outcome: "startedNewTurn" });
    assert.deepEqual(result, { status: "ok", outcome: "startedNewTurn" });
    const cancels = env.process.outbound().filter((message) => message.method === ACP_V1_METHODS.sessionCancel);
    assert.equal(cancels.length, 1);
    assert.deepEqual(cancels[0]?.params, { sessionId: FIXTURE_SESSION_ID });
    await finish(env);
  });

  it("treats Codex's own 'failed' (and anything unknown) as a refused steer without faulting the transport", async () => {
    for (const outcome of [{ outcome: "failed" }, { outcome: "somethingNew" }, {}]) {
      const env = await runningTurn();
      const sending = env.adapter.steer(env.session, "x");
      const request = await waitForOutbound(env.process, "_session/steering");
      env.process.emitMessages({ jsonrpc: "2.0", id: request.id, result: outcome } as WireMessage);
      await assert.rejects(sending, hasAdapterCode("operation_failed"), JSON.stringify(outcome));
      assert.equal(env.adapter.state, "ready");
      await finish(env);
    }
  });

  it("remembers -32601 as unsupported", async () => {
    const env = await runningTurn();
    const first = env.adapter.steer(env.session, "x");
    const request = await waitForOutbound(env.process, "_session/steering");
    env.process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    assert.deepEqual(await first, { status: "unsupported", reason: "not_found" });
    assert.deepEqual(await env.adapter.steer(env.session, "y"), { status: "unsupported", reason: "not_found" });
    assert.equal(env.process.outbound().filter((message) => message.method === "_session/steering").length, 1);
    await finish(env);
  });

  it("is unsupported without a wire call when the agent did not advertise steering", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink(), { protocolVersion: 1, authMethods: [] });
    const session = await newCodexSession(adapter, process);
    assert.equal(adapter.features.steer, false);
    assert.deepEqual(await adapter.steer(session, "x"), { status: "unsupported", reason: "engine" });
    assert.equal(process.outbound().some((message) => message.method === "_session/steering"), false);
    await adapter.close();
  });
});

describe("Codex dialect: Grok-only features answer without a wire call (PC-FALLBACK-001)", () => {
  it("returns typed unsupported results for _x.ai requests, billing and set_model", async () => {
    const process = new FakeProcess();
    const adapter = await startCodex(process, new RecordingSink());
    const session = await newCodexSession(adapter, process);
    const before = process.frames.length;
    for (const method of ["_x.ai/interject", "_x.ai/rewind/preview", "_x.ai/usage"]) {
      assert.deepEqual(await adapter.sendExtensionRequest(method, { sessionId: session.sessionId }), { status: "unsupported", reason: "engine" }, method);
    }
    await assert.rejects(adapter.officialBilling(), hasAdapterCode("unsupported_for_engine"));
    await assert.rejects(adapter.setModel(session, "gpt-6-sol"), hasAdapterCode("unsupported_for_engine"));
    assert.equal(process.frames.length, before, "nothing was written to the adapter");
    await adapter.close();
  });
});
