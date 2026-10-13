import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { modelCatalogEngineOf, modelGroupOf } from "@guild/contracts";
import {
  AcpV1Adapter,
  AcpV1AdapterError,
  AcpV1ConfigOptionRefusedError,
  GEMINI_ACP_ADAPTER_DEFAULT_TIMEOUTS,
  type AcpV1AdapterOptions,
  type AcpV1AdapterSession,
  type AcpV1AdapterSink,
  type AcpV1PeerPort,
  type AcpV1ProcessPort,
} from "./acp-adapter.js";
import { ACP_V1_METHODS } from "./acp-v1-methods.js";
import type { EngineSignal } from "./claude-dialect.js";
import { GEMINI_ENGINE_PROFILE } from "./engine-profile.js";
import { JsonRpcPeer, type JsonRpcFrameWriter } from "./json-rpc-peer.js";
import type { ProcessHostEvent } from "./process-host.js";

/*
 * The Gemini dialect against frames recorded from gemini-cli 0.63.0 (docs/21 section 7): the account and paths are
 * replaced, the command lists are shortened.
 */

type WireMessage = Record<string, unknown>;
type SinkEvent<Name extends keyof AcpV1AdapterSink> =
  Parameters<NonNullable<AcpV1AdapterSink[Name]>>[0];
type FixtureFrame = { readonly dir: "->" | "<-"; readonly msg: WireMessage };

const fixture = JSON.parse(
  readFileSync(new URL("../src/fixtures/gemini-cli-0.63.0-session.json", import.meta.url), "utf8"),
) as {
  readonly initialize: unknown;
  readonly sessionNewPlain: Record<string, unknown> & { sessionId: string };
  readonly sessionNewCustomtools: Record<string, unknown> & { sessionId: string };
  readonly toolTurn: readonly FixtureFrame[];
  readonly cancelWhilePermissionPending: readonly FixtureFrame[];
  readonly modeChanges: readonly FixtureFrame[];
  readonly loadReplay: { readonly request: Record<string, unknown>; readonly frames: readonly FixtureFrame[]; readonly result: Record<string, unknown> };
  readonly missingSessionErrors: readonly { code: number; message: string; data: unknown }[];
  readonly unknownModeError: { code: number; message: string; data: unknown };
};

const TOOL_SESSION_ID = fixture.sessionNewPlain.sessionId;
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
  readonly flushed: SinkEvent<"commitPermissionResponseFlushed">[] = [];
  readonly engineSignals: EngineSignal[] = [];
  readonly replayBarriers: SinkEvent<"commitReplayBarrier">[] = [];
  /** When true a permission request waits for the user (until its signal aborts) instead of being allowed at once. */
  holdPermissions = false;

  observeSignal = (): void => undefined;

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
    if (this.holdPermissions) {
      await new Promise<never>((_resolve, reject) => {
        event.signal.addEventListener("abort", () => reject(event.signal.reason), { once: true });
      });
    }
    const allowOnce = event.request.options.find((option) => option.kind === "allow_once");
    return {
      decision: { type: "selected", optionId: allowOnce?.optionId ?? "allow_once" },
      delivery: { commandId: `command-${this.permissionRequests.length}`, version: 1, deliveryAttemptId: `attempt-${this.permissionRequests.length}` },
    };
  }

  async commitPermissionResponseFlushed(event: SinkEvent<"commitPermissionResponseFlushed">): Promise<void> {
    this.flushed.push(event);
  }

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

  async commitReplayBarrier(event: SinkEvent<"commitReplayBarrier">): Promise<void> {
    this.replayBarriers.push(event);
  }

  async abortReplayBarrier(): Promise<void> {}
}

function adapterOptions(process: FakeProcess, sink: RecordingSink): AcpV1AdapterOptions {
  return { adapterEpoch: 7, clock, process, sink, profile: GEMINI_ENGINE_PROFILE };
}

async function startGemini(
  process: FakeProcess,
  sink: RecordingSink,
  initializeResult: unknown = fixture.initialize,
  overrides: Partial<AcpV1AdapterOptions> = {},
): Promise<AcpV1Adapter> {
  const adapter = new AcpV1Adapter({ ...adapterOptions(process, sink), ...overrides });
  const starting = adapter.start();
  const initialize = await waitForOutbound(process, ACP_V1_METHODS.initialize);
  assert.deepEqual(initialize.params, {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "guild", title: "Guild", version: "3.0.5" },
  }, "no client file system, no terminal");
  process.emitMessages({ jsonrpc: "2.0", id: initialize.id, result: initializeResult } as WireMessage);
  await starting;
  return adapter;
}

async function newGeminiSession(
  adapter: AcpV1Adapter,
  process: FakeProcess,
  result: Record<string, unknown> = fixture.sessionNewPlain,
  startOptions?: Parameters<AcpV1Adapter["newSession"]>[1],
): Promise<AcpV1AdapterSession> {
  const operation = adapter.newSession(FIXTURE_CWD, startOptions);
  const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew);
  process.emitMessages({ jsonrpc: "2.0", id: request.id, result } as WireMessage);
  return operation;
}

function update(update: Record<string, unknown>, sessionId = TOOL_SESSION_ID): WireMessage {
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

describe("Gemini dialect: initialize and authentication (PC-ENG-004)", () => {
  it("initializes against the recorded result and reads the capabilities Guild needs", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    assert.equal(adapter.engine, "gemini");
    assert.equal(adapter.state, "ready");
    assert.deepEqual(adapter.features, {
      billing: false,
      steer: false,
      conversationRewind: false,
      xaiSignals: false,
      agentInitiatedTurns: false,
    });
    await adapter.close();
  });

  it("never authenticates: oauth-personal, vertex-ai and gateway are advertised and none can be chosen", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const advertised = (fixture.initialize as { authMethods: { id: string }[] }).authMethods.map((method) => method.id);
    assert.deepEqual(advertised, ["oauth-personal", "gemini-api-key", "vertex-ai", "gateway"]);
    for (const id of advertised) await assert.rejects(adapter.authenticate(id), hasAdapterCode("unsupported_for_engine"), id);
    assert.equal(process.outbound().some((message) => message.method === ACP_V1_METHODS.authenticate), false);
    await adapter.close();
  });

  it("gives the start requests a 180 s window", async () => {
    assert.equal(GEMINI_ACP_ADAPTER_DEFAULT_TIMEOUTS.initializeMs, 180_000);
    assert.equal(GEMINI_ACP_ADAPTER_DEFAULT_TIMEOUTS.sessionMs, 180_000);
    const observed = new Map<string, number | null | undefined>();
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink(), undefined, { peerFactory: timeoutObserver(observed) });
    await newGeminiSession(adapter, process);
    const loading = adapter.loadSession("other-session", FIXTURE_CWD);
    const load = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    process.emitMessages({ jsonrpc: "2.0", id: load.id, result: fixture.loadReplay.result } as WireMessage);
    await loading;
    for (const method of [ACP_V1_METHODS.initialize, ACP_V1_METHODS.sessionNew, ACP_V1_METHODS.sessionLoad]) {
      assert.equal(observed.get(method), 180_000, method);
    }
    await adapter.close();
  });

  it("maps a missing key and a missing sign-in method (-32000) to auth_required without faulting", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    for (const [index, message] of ["Gemini API key is missing or not configured.", "Authentication required"].entries()) {
      const operation = adapter.newSession(FIXTURE_CWD);
      const request = await waitForOutbound(process, ACP_V1_METHODS.sessionNew, index);
      process.emitMessages({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
      await assert.rejects(operation, hasAdapterCode("auth_required"), message);
    }
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("answers a project without that session (-32603 with the CLI's own wording) with session_not_found and nothing else", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    for (const [index, error] of fixture.missingSessionErrors.entries()) {
      const attempt = adapter.loadSession(`gone-${index}`, FIXTURE_CWD);
      const request = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad, index);
      process.emitMessages({ jsonrpc: "2.0", id: request.id, error });
      await assert.rejects(attempt, hasAdapterCode("session_not_found"), JSON.stringify(error));
    }
    assert.equal(adapter.state, "ready");
    // Any other failure keeps the session: it says nothing about whether the session exists.
    for (const [offset, error] of [
      { code: -32603, message: "Internal error", data: { details: "EACCES: permission denied" } },
      { code: -32603, message: "Internal error" },
      { code: -32602, message: "No previous sessions found for this project." },
    ].entries()) {
      const index = fixture.missingSessionErrors.length + offset;
      const attempt = adapter.loadSession(`other-${index}`, FIXTURE_CWD);
      const request = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad, index);
      process.emitMessages({ jsonrpc: "2.0", id: request.id, error });
      await assert.rejects(attempt, hasAdapterCode("operation_failed"), JSON.stringify(error));
    }
    await adapter.close();
  });

  it("does not advertise session/resume, so there is nothing to resume with", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    await assert.rejects(adapter.resumeSession("any", FIXTURE_CWD), hasAdapterCode("capability_not_advertised"));
    assert.equal(process.outbound().some((message) => message.method === ACP_V1_METHODS.sessionResume), false);
    await adapter.close();
  });
});

describe("Gemini dialect: sessions, models and modes", () => {
  it("sends a plain session/new and presents the models and modes as the two options other adapters have", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startGemini(process, sink);
    const session = await newGeminiSession(adapter, process);
    const request = process.outbound().find((message) => message.method === ACP_V1_METHODS.sessionNew);
    assert.deepEqual(request?.params, { cwd: FIXTURE_CWD, mcpServers: [] }, "no _meta for Gemini");

    assert.deepEqual(session.configOptions?.map((option) => [option.id, option.category]), [["model", "model"], ["mode", "mode"]]);
    const model = session.configOptions?.[0];
    assert.ok(model?.type === "select" && model.currentValue === "auto" && model.unlisted === true, "a session on auto is unlisted");
    assert.deepEqual(
      model.choices.form === "flat" ? model.choices.options.map((choice) => choice.value) : [],
      ["gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.5-flash-lite"],
      "auto is never a choice",
    );
    assert.equal(session.modes?.currentModeId, "default");
    assert.deepEqual(session.modes?.availableModes.map((mode) => mode.id), ["default", "autoEdit", "yolo", "plan"]);

    const catalog = session.modelCatalog;
    assert.ok(catalog !== undefined);
    assert.equal(modelCatalogEngineOf(catalog), "gemini");
    assert.equal(catalog.runtimeDefaultModelId, "gemini-3.5-flash-lite");
    assert.ok(catalog.models.every((entry) => modelGroupOf(entry) === "gemini" && entry.reasoningEfforts.length === 0));
    assert.equal(sink.sessions[0]?.state.modelCatalog, catalog);
    await adapter.close();
  });

  it("knows the Pro model by one id whichever way the session spells it", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const session = await newGeminiSession(adapter, process, fixture.sessionNewCustomtools);
    const ids = session.modelCatalog?.models.map((entry) => entry.id);
    assert.ok(ids?.includes("gemini-3.1-pro-preview") && !ids.some((id) => id.endsWith("-customtools")), JSON.stringify(ids));
    // The recorded session started on a model its own list does not offer (settings named it): unlisted, never a model.
    const model = session.configOptions?.[0];
    assert.ok(model?.type === "select" && model.currentValue === "gemini-2.5-flash-lite" && model.unlisted === true);
    assert.equal(ids?.includes("gemini-2.5-flash-lite"), false);
    await adapter.close();
  });

  it("changes the model with session/set_model and reports the new current value, listed from then on", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const session = await newGeminiSession(adapter, process);
    const changing = adapter.setConfigOption(session, "model", "gemini-3.5-flash-lite");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetModel);
    assert.deepEqual(request.params, { sessionId: TOOL_SESSION_ID, modelId: "gemini-3.5-flash-lite" });
    assert.equal(process.outbound().some((message) => message.method === ACP_V1_METHODS.sessionSetConfigOption), false);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: {} });
    const options = await changing;
    const model = options.find((option) => option.category === "model");
    assert.ok(model?.type === "select" && model.currentValue === "gemini-3.5-flash-lite" && model.unlisted === undefined);
    assert.equal(options.find((option) => option.category === "mode")?.type === "select" && options.find((option) => option.category === "mode")?.currentValue, "default");

    // The next change starts from what the CLI confirmed, and the mode keeps the model.
    const modeChange = adapter.setPermissionMode(session, "autoEdit");
    const modeRequest = await waitForOutbound(process, ACP_V1_METHODS.sessionSetMode);
    assert.deepEqual(modeRequest.params, { sessionId: TOOL_SESSION_ID, modeId: "autoEdit" });
    process.emitMessages({ jsonrpc: "2.0", id: modeRequest.id, result: {} });
    const afterMode = await modeChange;
    assert.equal(afterMode.find((option) => option.category === "mode")?.currentValue, "autoEdit");
    assert.equal(afterMode.find((option) => option.category === "model")?.currentValue, "gemini-3.5-flash-lite");
    await adapter.close();
  });

  it("refuses a model or mode the session did not list, and any other option, before a wire call", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const session = await newGeminiSession(adapter, process);
    const before = process.frames.length;
    for (const [configId, value] of [
      ["model", "auto"], ["model", "gemini-9-ultra"], ["model", ""], ["mode", "bogus"], ["reasoning_effort", "high"], ["model", true],
    ] as const) {
      await assert.rejects(
        adapter.setConfigOption(session, configId, value),
        (cause: unknown) => cause instanceof AcpV1ConfigOptionRefusedError && cause.reason === "invalid_value",
        `${configId}=${String(value)}`,
      );
    }
    for (const bad of ["acceptEdits", "read-only", "bypassPermissions", "AUTOEDIT", ""]) {
      await assert.rejects(adapter.setPermissionMode(session, bad), hasAdapterCode("invalid_adapter_options"), bad);
    }
    assert.equal(process.frames.length, before, "nothing reached the CLI");
    await adapter.close();
  });

  it("keeps the previous value when the CLI refuses a change", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const session = await newGeminiSession(adapter, process);
    const changing = adapter.setConfigOption(session, "mode", "yolo");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetMode);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, error: fixture.unknownModeError });
    await assert.rejects(changing, (cause: unknown) => cause instanceof AcpV1ConfigOptionRefusedError);
    assert.equal(adapter.state, "ready");
    // A later change to a different, valid mode still starts from "default".
    const again = adapter.setConfigOption(session, "mode", "plan");
    const second = await waitForOutbound(process, ACP_V1_METHODS.sessionSetMode, 1);
    process.emitMessages({ jsonrpc: "2.0", id: second.id, result: {} });
    const options = await again;
    assert.equal(options.find((option) => option.category === "mode")?.currentValue, "plan");
    await adapter.close();
  });

  it("refuses a change while a turn runs", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const session = await newGeminiSession(adapter, process);
    const prompting = adapter.prompt(session, "hello");
    const prompt = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    await assert.rejects(adapter.setConfigOption(session, "model", "gemini-3.5-flash-lite"), hasAdapterCode("overlapping_prompt"));
    process.emitMessages({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "end_turn" } });
    await prompting;
    await adapter.close();
  });

  it("passes HTTP MCP servers when the CLI advertised them, refuses the Claude start options, and carries them on load", async () => {
    const server = {
      type: "http" as const,
      name: "guild-browser",
      url: "http://127.0.0.1:43121/0123456789abcdef0123456789abcdef/mcp",
      headers: [] as const,
    };
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    await assert.rejects(adapter.newSession(FIXTURE_CWD, { claudeCodeOptions: { settings: {} } }), hasAdapterCode("invalid_adapter_options"));
    await newGeminiSession(adapter, process, fixture.sessionNewPlain, { mcpServers: [server] });
    assert.deepEqual(process.outbound().find((message) => message.method === ACP_V1_METHODS.sessionNew)?.params, { cwd: FIXTURE_CWD, mcpServers: [server] });
    const loading = adapter.loadSession("old-session", FIXTURE_CWD, { mcpServers: [server] });
    const load = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    assert.deepEqual(load.params, { sessionId: "old-session", cwd: FIXTURE_CWD, mcpServers: [server] });
    process.emitMessages({ jsonrpc: "2.0", id: load.id, result: fixture.loadReplay.result } as WireMessage);
    await loading;
    await adapter.close();
  });
});

describe("Gemini dialect: the recorded tool turn and cancel (PC-ENG-004)", () => {
  /** The frames the CLI sent after the prompt, addressed to the session of this test (the recording had its own). */
  function inboundAfterPrompt(frames: readonly FixtureFrame[]): { prompt: WireMessage; inbound: WireMessage[] } {
    const promptIndex = frames.findIndex((frame) => frame.dir === "->" && frame.msg["method"] === "session/prompt");
    const rebase = (message: WireMessage): WireMessage => {
      const params = message["params"];
      return params !== null && typeof params === "object" && "sessionId" in params
        ? { ...message, params: { ...(params as Record<string, unknown>), sessionId: TOOL_SESSION_ID } }
        : message;
    };
    return {
      prompt: frames[promptIndex]!.msg,
      inbound: frames.slice(promptIndex + 1).filter((frame) => frame.dir === "<-").map((frame) => rebase(frame.msg)),
    };
  }

  it("replays the recorded turn: a permission card by kind, the quota as the turn's tokens, and no trace of mode narration", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startGemini(process, sink);
    const session = await newGeminiSession(adapter, process);
    const prompting = adapter.prompt(session, "Use your file-writing tool to create a file named hello.txt ...");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    const { inbound } = inboundAfterPrompt(fixture.toolTurn);
    const resultIndex = inbound.findIndex((message) => "result" in message && typeof message["id"] === "number" && message["result"] !== null &&
      (message["result"] as { stopReason?: unknown }).stopReason !== undefined);
    assert.ok(resultIndex > 0);
    for (const message of inbound.slice(0, resultIndex)) {
      if (message["method"] === "session/request_permission") {
        const before = sink.permissionRequests.length;
        process.emitMessages(message);
        await waitFor(() => sink.permissionRequests.length === before + 1);
        await waitFor(() => process.outbound().some((outbound) => outbound.id === message["id"]));
      } else {
        process.emitMessages(message);
      }
    }
    // A mode narration in the middle of a turn is not part of it.
    process.emitMessages(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[MODE_UPDATE] yolo" } }));
    process.emitMessages({ ...inbound[resultIndex]!, id: request.id } as WireMessage);
    const terminal = await prompting;

    assert.equal(terminal.stopReason, "end_turn");
    assert.equal(terminal.contextTokensUsed, 22065 + 25, "the quota's input and output tokens");
    assert.equal(adapter.state, "ready");
    assert.equal(sink.interruptions.length, 0);
    assert.equal(sink.permissionRequests.length, 1);
    const permission = sink.permissionRequests[0]!.request;
    assert.equal(permission.title, "Writing to hello.txt");
    assert.deepEqual(permission.options.map((option) => [option.optionId, option.kind]), [
      ["proceed_always", "allow_always"], ["proceed_once", "allow_once"], ["cancel", "reject_once"],
    ]);
    // Guild answers with the agent's own id for the kind it chose.
    const answered = process.outbound().find((message) => message.id === 0 && "result" in message);
    assert.deepEqual(answered?.result, { outcome: { outcome: "selected", optionId: "proceed_once" } });
    const texts = sink.updates.flatMap((entry) => entry.update.type === "turn" && entry.update.payload.type === "agent_text_chunk" ? [entry.update.payload.text] : []);
    assert.deepEqual(texts, ["done\n"], "the narration is not conversation text");
    const kinds = sink.updates.map((entry) => entry.update.type === "turn" ? entry.update.payload.type : entry.update.type);
    assert.ok(kinds.includes("tool_call_create") && kinds.includes("tool_call_update") && kinds.includes("agent_thought_chunk"), JSON.stringify(kinds));
    await adapter.close();
  });

  it("gives a turn without usage no token count, as a cancelled turn has none", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const session = await newGeminiSession(adapter, process);
    const prompting = adapter.prompt(session, "x");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: { stopReason: "cancelled" } });
    const terminal = await prompting;
    assert.equal(terminal.contextTokensUsed, undefined);
    assert.equal(terminal.classification, "cancelled");
    await adapter.close();
  });

  it("answers a permission request still pending when the turn is cancelled with the cancelled outcome, so the CLI can end the prompt", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    sink.holdPermissions = true;
    const adapter = await startGemini(process, sink);
    const session = await newGeminiSession(adapter, process);
    const prompting = adapter.prompt(session, "Use your file-writing tool to create held.txt");
    const prompt = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt);
    const { inbound } = inboundAfterPrompt(fixture.cancelWhilePermissionPending);
    for (const message of inbound) {
      if (message["method"] === "session/request_permission") {
        process.emitMessages(message);
        await waitFor(() => sink.permissionRequests.length === 1);
        break;
      }
      process.emitMessages(message);
    }
    const pendingId = (inbound.find((message) => message["method"] === "session/request_permission") as WireMessage)["id"];
    assert.equal(process.outbound().some((message) => message.id === pendingId && "result" in message), false, "the user has not decided");

    const cancelling = adapter.cancel(session);
    await waitForOutbound(process, ACP_V1_METHODS.sessionCancel);
    await cancelling;
    await waitFor(() => process.outbound().some((message) => message.id === pendingId && "result" in message));
    assert.deepEqual(process.outbound().find((message) => message.id === pendingId && "result" in message)?.result, { outcome: { outcome: "cancelled" } });
    // The CLI now ends the prompt; Guild's transport is healthy and the session takes the next prompt.
    process.emitMessages({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } });
    assert.equal((await prompting).classification, "cancelled");
    assert.equal(adapter.state, "ready");
    assert.equal(sink.interruptions.length, 0);
    assert.equal(sink.flushed.length, 0, "no decision was recorded for it");

    sink.holdPermissions = false;
    const next = adapter.prompt(session, "Reply with exactly: AFTER-CANCEL-OK");
    const second = await waitForOutbound(process, ACP_V1_METHODS.sessionPrompt, 1);
    process.emitMessages({ jsonrpc: "2.0", id: second.id, result: { stopReason: "end_turn", _meta: { quota: { token_count: { input_tokens: 10873, output_tokens: 5 } } } } });
    assert.equal((await next).contextTokensUsed, 10878);
    await adapter.close();
  });

  it("applies the mode narration of a set_mode call as nothing at all", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startGemini(process, sink);
    const session = await newGeminiSession(adapter, process);
    const changing = adapter.setPermissionMode(session, "yolo");
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionSetMode);
    // The CLI answers a mode change with a chat message first and the result after.
    process.emitMessages(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "[MODE_UPDATE] yolo" } }));
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: {} });
    await changing;
    assert.equal(sink.updates.some((entry) => entry.update.type === "turn"), false);
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("drops late frames and unowned permission requests without a Run, and says so", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startGemini(process, sink);
    await newGeminiSession(adapter, process);
    // available_commands_update arrives after session/new, outside any turn: session metadata.
    process.emitMessages(update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "memory", description: "Manage memory." }] }));
    await waitFor(() => sink.updates.length === 1);
    assert.equal(sink.updates[0]?.promptSequence, undefined);
    process.emitMessages(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stray" } }));
    process.emitMessages({
      jsonrpc: "2.0", id: 901, method: ACP_V1_METHODS.sessionRequestPermission,
      params: { sessionId: TOOL_SESSION_ID, toolCall: { toolCallId: "t-1", title: "Run" }, options: [{ optionId: "proceed_once", name: "Allow", kind: "allow_once" }] },
    });
    await waitFor(() => sink.engineSignals.some((signal) => signal.type === "late_update_dropped"));
    await waitFor(() => process.outbound().some((message) => message.id === 901));
    assert.deepEqual(process.outbound().find((message) => message.id === 901)?.result, { outcome: { outcome: "cancelled" } });
    assert.equal(sink.permissionRequests.length, 0);
    assert.ok(sink.engineSignals.every((signal) => signal.type !== "late_update_dropped" || signal.engine === "gemini"));
    assert.equal(adapter.state, "ready");
    await adapter.close();
  });

  it("has no steering, no extensions and no billing: they answer without a wire call (PC-FALLBACK-001)", async () => {
    const process = new FakeProcess();
    const adapter = await startGemini(process, new RecordingSink());
    const session = await newGeminiSession(adapter, process);
    const before = process.frames.length;
    assert.deepEqual(await adapter.steer(session, "x"), { status: "unsupported", reason: "engine" });
    assert.deepEqual(await adapter.sendExtensionRequest("_x.ai/interject", { sessionId: session.sessionId }), { status: "unsupported", reason: "engine" });
    await assert.rejects(adapter.officialBilling(), hasAdapterCode("unsupported_for_engine"));
    await assert.rejects(adapter.setModel(session, "gemini-3.5-flash-lite"), hasAdapterCode("unsupported_for_engine"));
    assert.equal(process.frames.length, before);
    await adapter.close();
  });
});

describe("Gemini dialect: loading a session (docs/21 section 8.6)", () => {
  it("replays a loaded history without the CLI's invented user messages, and keeps the user prompt and the answer", async () => {
    const process = new FakeProcess();
    const sink = new RecordingSink();
    const adapter = await startGemini(process, sink);
    const loading = adapter.loadSession(TOOL_SESSION_ID, FIXTURE_CWD);
    const request = await waitForOutbound(process, ACP_V1_METHODS.sessionLoad);
    assert.deepEqual(request.params, { sessionId: TOOL_SESSION_ID, cwd: FIXTURE_CWD, mcpServers: [] });
    // The CLI replays the history, then answers.
    for (const frame of fixture.loadReplay.frames) process.emitMessages(frame.msg);
    process.emitMessages({ jsonrpc: "2.0", id: request.id, result: fixture.loadReplay.result } as WireMessage);
    const session = await loading;

    assert.equal(session.establishedBy, "load");
    assert.equal(sink.replayBarriers.length, 1);
    const replayed = sink.updates.filter((entry) => entry.ingestMode === "replay");
    assert.equal(replayed.length, sink.updates.length, "everything arrived inside the replay barrier");
    const users = replayed.flatMap((entry) => entry.update.type === "turn" && entry.update.payload.type === "user_text_chunk" ? [entry.update.payload.text] : []);
    assert.deepEqual(users, ["Use your file-writing tool to create a file named hello.txt in the current directory containing exactly: spike-ok. Then reply with the single word: done."],
      "neither <session_context> nor [Function Response: ...] is a user message");
    const answers = replayed.flatMap((entry) => entry.update.type === "turn" && entry.update.payload.type === "agent_text_chunk" ? [entry.update.payload.text] : []);
    assert.deepEqual(answers, ["done"]);
    assert.equal(adapter.state, "ready");

    // The loaded session comes back on auto with its models and modes: the options say so, and Guild answers by choosing.
    const model = session.configOptions?.[0];
    assert.ok(model?.type === "select" && model.currentValue === "auto" && model.unlisted === true);
    assert.equal(session.modelCatalog?.runtimeDefaultModelId, "gemini-3.5-flash-lite");
    assert.ok(session.modelCatalog?.models.some((entry) => entry.id === "gemini-3.1-pro-preview"), "the customtools spelling is normalised");
    await adapter.close();
  });
});
