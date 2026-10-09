import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  DesktopBootstrapProjection,
  GuildGrokModel,
  GuildGrokReasoningEffort,
  RuntimeConfigOption,
  RuntimePromptTerminalPayload,
  StreamDeltaEvent,
} from "@guild/contracts";
import type {
  AcpV1AdapterSession,
  AcpV1AdapterSink,
  AcpV1DecodedUpdate,
  AcpV1InitializeResult,
  JsonRpcWriteReceipt,
  JsonValue,
  XaiExtensionOutcome,
} from "@guild/runtime-grok";
import {
  createLiveDesktopService,
  type RuntimeAdapterPort,
  type RuntimeFactory,
} from "./live-service.js";

const services: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
});

type Emit = (payload: Record<string, unknown>) => Promise<void>;
type PromptScript = (context: {
  readonly text: string;
  readonly emit: Emit;
  readonly sink: AcpV1AdapterSink;
}) => Promise<void>;

describe("live desktop service streaming publication", () => {
  it("sends contiguous, ordered text deltas for the active task and converges on the stored text", async () => {
    const harness = await startHarness(async ({ emit }) => {
      await emit({ type: "agent_thought_chunk", text: "thinking " });
      await emit({ type: "agent_thought_chunk", text: "hard" });
      for (let index = 0; index < 60; index += 1) {
        await emit({ type: "agent_text_chunk", messageId: "m1", text: `part-${index};` });
        if (index % 10 === 9) await pause(20);
      }
    });
    await harness.send("stream");
    await harness.completed();

    const answer = harness.finalEntry("assistant");
    const expected = Array.from({ length: 60 }, (_, index) => `part-${index};`).join("");
    assert.equal(answer, expected);
    const assistantDeltas = harness.deltas.filter((delta) => delta.kind === "assistant");
    assert.ok(assistantDeltas.length > 0);
    let cursor = 0;
    let previousRevision = 0;
    for (const delta of assistantDeltas) {
      assert.equal(delta.taskId, harness.taskId);
      assert.equal(delta.entryId, assistantDeltas[0]!.entryId);
      assert.equal(delta.offset, cursor, "deltas are contiguous with no gap or overlap");
      assert.ok(delta.revision > previousRevision, "revision strictly increases");
      cursor += delta.appendText.length;
      previousRevision = delta.revision;
    }
    assert.equal(assistantDeltas.map((delta) => delta.appendText).join(""), expected);
    assert.equal(assistantDeltas.at(-1)!.revision, 60, "revision counts runtime chunks");
    const thoughtDeltas = harness.deltas.filter((delta) => delta.kind === "thought");
    assert.equal(thoughtDeltas.map((delta) => delta.appendText).join(""), "thinking hard");
    assert.equal(thoughtDeltas[0]!.offset, 0);
  });

  it("coalesces a same-tick burst into a few frame-sized deltas", async () => {
    const harness = await startHarness(async ({ emit }) => {
      for (let index = 0; index < 200; index += 1) {
        await emit({ type: "agent_text_chunk", messageId: "m1", text: `${index},` });
      }
    });
    const startedAt = performance.now();
    await harness.send("burst");
    await harness.completed();
    const elapsedMs = performance.now() - startedAt;
    const assistantDeltas = harness.deltas.filter((delta) => delta.kind === "assistant");
    assert.ok(assistantDeltas.length >= 1);
    // At most one delta per 16 ms window (plus the flush at publication), however slow the host is.
    assert.ok(
      assistantDeltas.length <= Math.ceil(elapsedMs / 12) + 3 && assistantDeltas.length < 100,
      `expected coalescing, saw ${assistantDeltas.length} deltas in ${elapsedMs.toFixed(0)} ms for 200 chunks`,
    );
    assert.equal(
      assistantDeltas.map((delta) => delta.appendText).join(""),
      Array.from({ length: 200 }, (_, index) => `${index},`).join(""),
    );
  });

  it("emits no deltas for a task the user is not viewing, but still projects it", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const harness = await startHarness(async ({ emit }) => {
      await gate;
      for (let index = 0; index < 20; index += 1) {
        await emit({ type: "agent_text_chunk", messageId: "m1", text: `x${index} ` });
        await pause(5);
      }
    });
    await harness.send("background");
    // Switch the view to a different task before the first one streams.
    const other = await harness.service.createTask(harness.workspaceId);
    openGate();
    await harness.completed(harness.taskId);
    assert.equal(harness.deltas.length, 0, "deltas follow the active task only");
    const view = await harness.service.openTask(harness.taskId);
    assert.ok(view.timeline.some((item) => item.kind === "assistant" && item.text.startsWith("x0 ")));
    assert.notEqual(other.task.taskId, harness.taskId);
  });

  it("throttles full projections to one per interval while text streams", async () => {
    const harness = await startHarness(async ({ emit }) => {
      await emit({ type: "agent_text_chunk", messageId: "m1", text: "start " });
      // 100 chunks over about 1.2 s.
      for (let index = 0; index < 100; index += 1) {
        await emit({ type: "agent_text_chunk", messageId: "m1", text: `w${index} ` });
        await pause(12);
      }
    });
    await harness.send("slow-stream");
    await harness.completed();
    const streaming = harness.projections.filter((entry) => {
      const item = entry.projection.activeTask?.timeline.find((candidate) => candidate.kind === "assistant");
      return item?.status === "streaming";
    });
    // Old behaviour republished after almost every 16 ms window (about 60 per second).
    assert.ok(streaming.length >= 2, `expected periodic resync projections, saw ${streaming.length}`);
    const spanMs = streaming.at(-1)!.atMs - streaming[0]!.atMs;
    assert.ok(
      streaming.length <= Math.ceil(spanMs / 230) + 1,
      `expected at most one per 250 ms, saw ${streaming.length} in ${spanMs.toFixed(0)} ms`,
    );
    for (let index = 2; index < streaming.length; index += 1) {
      const gap = streaming[index]!.atMs - streaming[index - 1]!.atMs;
      assert.ok(gap >= 230, `stream-driven projections are at least ~250 ms apart (gap ${gap.toFixed(0)} ms)`);
    }
    // Partial text still reaches projections, and every projection is a prefix of the final text.
    const texts = streaming.map((entry) => assistantText(entry.projection));
    const final = harness.finalEntry("assistant");
    assert.ok(texts.every((text) => final.startsWith(text)));
    assert.ok(texts.some((text) => text.length > 0 && text.length < final.length));
  });

  it("publishes tool updates without holding the update queue", async () => {
    let projectionsWhenToolCommitResolved = -1;
    let projectionsBeforeTool = -1;
    const harness = await startHarness(async ({ emit }) => {
      await emit({ type: "agent_text_chunk", messageId: "m1", text: "before tool" });
      await pause(60);
      projectionsBeforeTool = harness.projections.length;
      await emit({
        type: "tool_call_create",
        toolCallId: "tool-1",
        title: "Read file",
        kind: "read",
        status: "in_progress",
      });
      projectionsWhenToolCommitResolved = harness.projections.length;
      await emit({
        type: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        content: [{ type: "text", text: "file body" }],
      });
    });
    await harness.send("tool");
    await harness.completed();
    assert.ok(projectionsBeforeTool >= 0);
    assert.equal(
      projectionsWhenToolCommitResolved,
      projectionsBeforeTool,
      "the commit resolves before the scheduled projection is built",
    );
    const projection = (await harness.service.bootstrap()).activeTask!;
    const tool = projection.timeline.find((item) => item.kind === "tool");
    assert.equal(tool?.kind === "tool" ? tool.toolStatus : "", "completed");
    const delivered = harness.projections.at(-1)!.projection.activeTask!.timeline.find((item) => item.kind === "tool");
    assert.equal(delivered?.kind === "tool" ? delivered.toolStatus : "", "completed");
  });

  it("starts the prompt promptly and shows the new message without waiting on projections", async () => {
    // Sending may give the start checkpoint a short head start, during which a scheduled projection
    // can already show the message; what matters is that the prompt reaches the runtime quickly and
    // that the message is visible, not which of the two happens first.
    let promptAt: number | undefined;
    let shownAt: number | undefined;
    const harness = await startHarness(async () => undefined, (projection) => {
      const user = projection.activeTask?.timeline.find((item) => item.kind === "user" && item.text === "ordering");
      if (user !== undefined && shownAt === undefined) shownAt = performance.now();
    }, (text) => {
      if (text === "ordering" && promptAt === undefined) promptAt = performance.now();
    });
    const sentAt = performance.now();
    await harness.send("ordering");
    await harness.completed();
    assert.ok(promptAt !== undefined && shownAt !== undefined, "prompt started and message shown");
    assert.ok(promptAt - sentAt < 1_500, `prompt started ${Math.round(promptAt - sentAt)} ms after send`);
  });

  it("refreshes the sidebar for structural changes that happen while another task streams", async () => {
    const harness = await startHarness(async ({ text, emit }) => {
      if (text !== "stream-while-renaming") return;
      for (let index = 0; index < 40; index += 1) {
        await emit({ type: "agent_text_chunk", messageId: "m1", text: `s${index} ` });
        await pause(15);
      }
    });
    // A task with history is not provisional, so creating a sibling keeps it.
    await harness.send("init");
    await harness.completed();
    const sibling = await harness.service.createTask(harness.workspaceId);
    await harness.service.updateTask({ taskId: sibling.task.taskId, action: "rename", title: "Before" });
    await harness.service.openTask(harness.taskId);
    await harness.send("stream-while-renaming");
    // Wait until streamed text has reached a projection, then rename mid-stream.
    for (let attempt = 0; attempt < 200 && !harness.projections.some((entry) => assistantText(entry.projection).length > 0); attempt += 1) {
      await pause(10);
    }
    await harness.service.updateTask({ taskId: sibling.task.taskId, action: "rename", title: "After rename" });
    await harness.completed();
    const last = harness.projections.at(-1)!.projection;
    const titles = last.workspaces.flatMap((workspace) => workspace.tasks.map((task) => task.title));
    assert.ok(titles.includes("After rename"), `sidebar must show the rename, saw ${titles.join(" | ")}`);
    assert.ok(!titles.includes("Before"));
    const streamingTitles = harness.projections
      .filter((entry) => assistantText(entry.projection).length > 0)
      .map((entry) => entry.projection.workspaces.flatMap((workspace) => workspace.tasks.map((task) => task.title)));
    assert.ok(streamingTitles.some((list) => list.includes("Before")), "earlier stream projections predate the rename");
    assert.ok(streamingTitles.at(-1)!.includes("After rename"));
  });
});

async function startHarness(
  script: PromptScript,
  onProjection?: (projection: DesktopBootstrapProjection) => void,
  onPrompt?: (text: string) => void,
) {
  const root = await mkdtemp(join(tmpdir(), "guild-stream-publication-"));
  const workspace = join(root, "Workspace");
  await mkdir(workspace);
  const service = createLiveDesktopService({
    appVersion: "2.2.0-test",
    databasePath: join(root, "guild.sqlite3"),
    stagingRoot: join(root, "staging"),
    chooseWorkspace: async () => workspace,
    runtimeFactory: scriptedRuntimeFactory(script, onPrompt),
  });
  services.push(service);
  const initial = await service.chooseWorkspace();
  const workspaceId = initial.workspaces[0]!.workspaceId;
  const created = await service.createTask(workspaceId);
  const taskId = created.task.taskId;
  const projections: { readonly atMs: number; readonly projection: DesktopBootstrapProjection }[] = [];
  const deltas: StreamDeltaEvent[] = [];
  const runProgress = new Map<string, { live: boolean; done: boolean }>();
  service.subscribe((projection) => {
    projections.push({ atMs: performance.now(), projection });
    for (const task of projection.workspaces.flatMap((workspace) => workspace.tasks)) {
      const progress = runProgress.get(task.taskId) ?? { live: false, done: false };
      if (task.activeRunState !== undefined && task.activeRunState !== "completed") progress.live = true;
      if (progress.live && task.activeRunState === "completed") progress.done = true;
      runProgress.set(task.taskId, progress);
    }
    onProjection?.(projection);
  });
  service.subscribeStreamDeltas((delta) => { deltas.push(delta); });
  return {
    service,
    workspaceId,
    taskId,
    projections,
    deltas,
    send: async (text: string) => {
      runProgress.delete(taskId);
      await service.sendMessage(taskId, text);
    },
    /** Resolves once a pushed projection reports the Run finished; never queries the service. */
    completed: async (watchedTaskId: string = taskId) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (runProgress.get(watchedTaskId)?.done === true) {
          await pause(40);
          return;
        }
        await pause(10);
      }
      assert.fail("run did not complete");
    },
    finalEntry: (kind: "assistant" | "thought"): string => {
      const last = projections.at(-1)!.projection.activeTask!;
      const item = last.timeline.find((candidate) => candidate.kind === kind);
      return item !== undefined && "text" in item ? item.text : "";
    },
  };
}

function assistantText(projection: DesktopBootstrapProjection): string {
  const item = projection.activeTask?.timeline.find((candidate) => candidate.kind === "assistant");
  return item !== undefined && "text" in item ? item.text : "";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scriptedRuntimeFactory(
  script: PromptScript,
  onPrompt?: (text: string) => void,
): RuntimeFactory {
  return async ({ adapterEpoch, sink }) => ({
    runtimeVersion: "Scripted Grok 1.0",
    adapter: new ScriptedAdapter(adapterEpoch, sink, script, onPrompt),
  });
}

class ScriptedAdapter implements RuntimeAdapterPort {
  state = "created";
  private promptSequence = 0;
  private readonly sessionId = "scripted-session";

  constructor(
    private readonly adapterEpoch: number,
    private readonly sink: AcpV1AdapterSink,
    private readonly script: PromptScript,
    private readonly onPrompt?: (text: string) => void,
  ) {}

  async start(): Promise<AcpV1InitializeResult> {
    this.state = "ready";
    return Object.freeze({
      protocolVersion: 1,
      agentCapabilities: Object.freeze({
        loadSession: false,
        resumeSession: true,
        prompt: Object.freeze({ image: false, audio: false, embeddedContent: false }),
      }),
      authMethods: Object.freeze([]),
      agentInfo: Object.freeze({ name: "Scripted Grok", version: "1.0" }),
    }) as unknown as AcpV1InitializeResult;
  }
  async authenticate(): Promise<void> {}
  async officialBilling() { return Object.freeze({ creditUsagePercent: 0 }); }
  async setModel(_session: AcpV1AdapterSession, _model: GuildGrokModel): Promise<void> {}
  async setMode(
    _session: AcpV1AdapterSession,
    _model: GuildGrokModel,
    _effort: GuildGrokReasoningEffort,
  ): Promise<void> {}
  async setConfigOption(): Promise<readonly RuntimeConfigOption[]> { return Object.freeze([]); }
  async newSession(): Promise<AcpV1AdapterSession> {
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "new",
      state: {},
    });
    return this.makeSession("new");
  }
  async resumeSession(): Promise<AcpV1AdapterSession> {
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "resume",
      state: {},
    });
    return this.makeSession("resume");
  }
  async loadSession(): Promise<AcpV1AdapterSession> { throw new Error("not supported"); }
  async cancel(): Promise<JsonRpcWriteReceipt> { return writeReceipt(); }
  async close(): Promise<void> { this.state = "closed"; }
  async probeLiveness(): Promise<boolean> { return this.state === "ready"; }
  async sendExtensionRequest(): Promise<XaiExtensionOutcome<JsonValue>> {
    return Object.freeze({ status: "unsupported" as const });
  }

  async prompt(session: AcpV1AdapterSession, text: string) {
    this.onPrompt?.(text);
    this.promptSequence += 1;
    const promptSequence = this.promptSequence;
    const identity = {
      adapterEpoch: this.adapterEpoch,
      sessionId: session.sessionId,
      promptSequence,
    };
    await this.sink.commitPromptAccepted({ identity, write: writeReceipt() });
    const emit: Emit = (payload) => this.sink.commitUpdate({
      identity,
      ingestMode: "live",
      promptSequence,
      update: {
        type: "turn",
        payload: { sessionId: session.sessionId, received: received(), ...payload },
      } as unknown as AcpV1DecodedUpdate,
    });
    await this.script({ text, emit, sink: this.sink });
    const terminal = Object.freeze({
      type: "prompt_terminal",
      sessionId: session.sessionId,
      stopReason: "end_turn",
      classification: "completed",
      received: received(),
    }) as RuntimePromptTerminalPayload;
    await this.sink.commitPromptTerminal({ identity, terminal });
    return terminal;
  }

  private makeSession(establishedBy: "new" | "resume"): AcpV1AdapterSession {
    return Object.freeze({
      adapterEpoch: this.adapterEpoch,
      sessionId: this.sessionId,
      establishedBy,
    });
  }
}

function received() {
  return Object.freeze({ wallClockIso: new Date().toISOString(), monotonicMs: performance.now() });
}

function writeReceipt(): JsonRpcWriteReceipt {
  return Object.freeze({
    type: "write_completed",
    messageType: "request",
    requestId: 1,
    bytes: 1,
    evidence: "local_writer_completion",
    remoteAcceptance: "not_evidenced",
  });
}
