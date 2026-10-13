import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  DesktopBootstrapProjection,
  GuildEngine,
  RuntimeConfigOption,
  RuntimePromptTerminalPayload,
  TaskId,
  TaskViewProjection,
  WorkspaceId,
} from "@guild/contracts";
import { freezeModelCatalog, sessionSelectionOf } from "@guild/contracts";
import {
  AcpV1AdapterError,
  AcpV1ConfigOptionRefusedError,
  engineProfileFor,
  type AcpV1AdapterSession,
  type AcpV1AdapterSink,
  type AcpV1InitializeResult,
  type AcpV1OfficialBillingSnapshot,
  type AcpV1SessionStartOptions,
  type AcpV1SteerResult,
  type EngineFeatureFlags,
  type JsonRpcWriteReceipt,
  type JsonValue,
  type XaiExtensionOutcome,
} from "@guild/runtime-grok";
import { ClaudeEngineIntegrityError, ClaudeLocatorError } from "./claude-locator.js";
import { CodexEngineIntegrityError, CodexLocatorError } from "./codex-locator.js";
import type { GitCheckpointPort } from "./git-checkpoints.js";
import { toDesktopIpcFailure } from "./workspace-folder.js";
import type { BrowserMcpPort, ModelRouterHostPort, RoutedModelInfo } from "./engine-ports.js";
import { openGuildPersistence, type GuildPersistence } from "@guild/persistence";
import { createFixtureDesktopService } from "./fixture-service.js";
import {
  createLiveDesktopService,
  type LiveDesktopServiceOptions,
  type RuntimeAdapterPort,
  type RuntimeFactory,
} from "./live-service.js";

const services: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
});

const ROUTER_URL = "http://127.0.0.1:43210/0123456789abcdef0123456789abcdef/";
const BROWSER_URL = "http://127.0.0.1:43211/fedcba9876543210fedcba9876543210/mcp";
const NATIVE_MODELS = ["default", "opus", "sonnet", "haiku"] as const;
const DEEPSEEK: RoutedModelInfo = {
  id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", group: "online",
  sourceId: "deepseek", sourceLabel: "DeepSeek", contextWindow: 128_000, supportsImages: true,
};
const LOCAL_MODEL: RoutedModelInfo = {
  id: "local-27b-model", label: "Local 27B", group: "local",
  sourceId: "llama", sourceLabel: "Local llama.cpp",
};

/**
 * What a routed Claude process is spawned with (D-061): the router URL, a throwaway auth token that is never the
 * Claude login, no API key, no non-essential traffic, and background requests and subagents on the routed model applied then.
 */
function assertRoutedEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
  modelId: string | undefined,
): void {
  assert.ok(environment !== undefined, "a routed process gets a per-spawn environment");
  const { ANTHROPIC_AUTH_TOKEN: token, ...rest } = environment;
  assert.match(token ?? "", /^guild-router-[0-9a-f]{32}$/u);
  const models = modelId === undefined ? {} : {
    ANTHROPIC_SMALL_FAST_MODEL: modelId,
    CLAUDE_CODE_SUBAGENT_MODEL: modelId,
  };
  assert.deepEqual(rest, {
    ANTHROPIC_BASE_URL: ROUTER_URL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_TOOL_SEARCH: "true",
    OPENVIKING_AUTO_CAPTURE: "false",
    ...models,
  });
  assert.equal(Object.hasOwn(environment, "ANTHROPIC_API_KEY"), false);
}

describe("dual engine orchestration [PC-ENG-001, PC-MODEL-001]", () => {
  it("persists the engine at create, projects it, and fixes it once the task has run [PC-ENG-001]", async () => {
    const h = await harness();
    const grokTask = await h.service.createTask(h.workspaceId);
    const claudeTask = await h.service.createTask(h.workspaceId, undefined, "claude");
    assert.equal(grokTask.task.engine, "grok", "no engine means grok");
    assert.equal(claudeTask.task.engine, "claude");

    // Before the first turn the engine can still change; the picker's choice is the task's engine.
    const changed = await h.service.setTaskEngine(claudeTask.task.taskId, "grok");
    assert.equal(changed.task.engine, "grok");
    assert.equal((await h.service.setTaskEngine(claudeTask.task.taskId, "claude")).task.engine, "claude");

    await h.send(claudeTask.task.taskId, "hello");
    await h.completed();
    const sidebar = (await h.service.bootstrap()).workspaces[0]!.tasks;
    assert.equal(sidebar.find((task) => task.taskId === claudeTask.task.taskId)?.engine, "claude");
    // PC-TASK-001: no silent rebinding once a Run exists.
    await assert.rejects(h.service.setTaskEngine(claudeTask.task.taskId, "grok"), /task_engine_locked/u);
    assert.equal((await h.service.openTask(claudeTask.task.taskId)).task.engine, "claude");

    // The engine survives a restart.
    await h.restart();
    assert.equal((await h.service.openTask(claudeTask.task.taskId)).task.engine, "claude");
  });

  it("starts a session over when the engine changes after a slash-command menu opened one [PC-ENG-001]", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId);
    await h.service.loadSlashCommands(task.task.taskId);
    assert.equal(h.world.adapters.length, 1);
    assert.equal(h.world.adapters[0]!.engine, "grok");

    const changed = await h.service.setTaskEngine(task.task.taskId, "claude");
    assert.equal(changed.task.engine, "claude");
    assert.equal(h.world.adapters[0]!.state, "closed", "the Grok process of the abandoned session is stopped");

    await h.send(task.task.taskId, "hi");
    await h.completed();
    assert.equal(h.world.adapters.length, 2);
    assert.equal(h.world.inputs[1]!.engine, "claude");
    assert.deepEqual(h.world.adapters[1]!.startCalls.map((call) => call.kind), ["new"], "a fresh session, not a resume");
    assert.deepEqual(h.world.adapters[1]!.prompts, ["hi"]);
  });

  it("projects Claude's own models with the router's Online and Local ones [PC-MODEL-001]", async () => {
    const router = new FakeRouterHost([DEEPSEEK, LOCAL_MODEL]);
    const h = await harness({ modelRouterHost: router });
    const before = (await h.service.bootstrap()).runtimeSettings;
    assert.equal(before.modelCatalogs?.claude.models.map((model) => model.id).join(), "deepseek-v4-flash,local-27b-model",
      "before any session only the router's models are known");

    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "hello");
    await h.completed();

    const catalogs = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!;
    const claude = catalogs.claude;
    assert.equal(claude.engine, "claude");
    assert.deepEqual(
      claude.models.map((model) => [model.id, model.group]),
      [...NATIVE_MODELS.map((id) => [id, "claude"]), ["deepseek-v4-flash", "online"], ["local-27b-model", "local"]],
    );
    assert.equal(claude.runtimeDefaultModelId, "default");
    assert.equal(claude.models.find((model) => model.id === "deepseek-v4-flash")?.name, "DeepSeek V4 Flash");
    assert.deepEqual(claude.models.find((model) => model.id === "deepseek-v4-flash")?.contextWindows, [128_000]);
    // Image support the source states reaches the picker row; a source that says nothing leaves the field out.
    assert.equal(claude.models.find((model) => model.id === "deepseek-v4-flash")?.supportsImages, true);
    assert.equal("supportsImages" in claude.models.find((model) => model.id === "local-27b-model")!, false);
    assert.deepEqual(catalogs.grok.models, [], "the Grok list is not touched by a Claude session");

    // A source change reaches the picker without a restart of anything.
    const seen: string[][] = [];
    const unsubscribe = h.service.subscribe((projection) => {
      seen.push(projection.runtimeSettings.modelCatalogs?.claude.models.map((model) => model.id) ?? []);
    });
    router.models = [DEEPSEEK];
    router.emitChange();
    await eventually(() => seen.some((ids) => ids.includes("deepseek-v4-flash") && !ids.includes("local-27b-model")));
    unsubscribe();
    router.models = [];
    router.emitChange();
    await eventually(async () =>
      (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.models.length === NATIVE_MODELS.length);

    // The adapter's list is cached per engine, so the picker is not empty after a restart.
    await h.restart({ modelRouterHost: undefined });
    const cached = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude;
    assert.deepEqual(cached.models.map((model) => model.id), [...NATIVE_MODELS]);
    assert.equal(cached.models.find((model) => model.id === "default")?.reasoningEfforts.length, 3,
      "efforts seen for a model are remembered");
  });

  it("applies the Claude defaults and the task choice through permission mode and config options [PC-MODEL-001]", async () => {
    const h = await harness();
    await h.service.setClaudeSettings("opus", "high", "plan");
    const settings = (await h.service.bootstrap()).runtimeSettings;
    assert.deepEqual(settings.claude, {
      model: "opus", reasoningEffort: "high", permissionMode: "plan",
      availablePermissionModes: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
    });
    await assert.rejects(h.service.setClaudeSettings("bad model", null, "default"), /runtime_settings_change_unavailable/u);
    await assert.rejects(h.service.setClaudeSettings(null, "high", "default"), /runtime_settings_change_unavailable/u);
    await assert.rejects(h.service.setClaudeSettings("opus", null, "yolo" as never));

    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "one");
    await h.completed();
    await h.idle();
    const adapter = h.world.adapters[0]!;
    const fromMode = adapter.log.slice(adapter.log.indexOf("mode=plan"));
    assert.deepEqual(fromMode, ["mode=plan", "config:model=opus", "config:effort=high", "prompt:one"],
      "permission mode first, then model and effort, then the turn");
    assert.equal((await h.service.openTask(task.task.taskId)).modelSelection.source, "global");

    // The task's own choice comes before the global default; clearing it falls back.
    const saved = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "sonnet", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(saved.status, "applied");
    assert.equal(saved.task.modelSelection.source, "task");
    assert.equal(saved.task.modelSelection.modelId, "sonnet");
    assert.ok(adapter.log.includes("config:model=sonnet"));
    const cleared = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: null, reasoningEffort: null, contextWindow: null,
    });
    assert.equal(cleared.status, "applied");
    assert.equal(cleared.task.modelSelection.source, "global");
    assert.equal(cleared.task.modelSelection.modelId, "opus");
    assert.equal(adapter.log.at(-1), "config:model=opus");

    // A model neither the engine nor the router offers is refused and nothing is stored.
    const refused = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "gpt-9", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(refused.status, "refused");
    assert.equal(refused.status === "refused" ? refused.reason : "", "unsupported_value");
    assert.equal((await h.service.openTask(task.task.taskId)).modelSelection.source, "global");
    // A Claude task has no context-window choice.
    const window = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "haiku", reasoningEffort: null, contextWindow: 100_000,
    });
    assert.equal(window.status, "refused");
  });

  it("never loosens a session below the permission mode setting, and a mode refusal stops the start [PC-ENG-002]", async () => {
    const h = await harness({}, { claude: { refuseMode: true } });
    await h.service.setClaudeSettings(null, null, "bypassPermissions");
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await assert.rejects(h.send(task.task.taskId, "x"), /runtime_start_session_permission_mode/u);
    assert.equal(h.world.adapters[0]!.state, "closed", "the half-started process is closed");
    assert.deepEqual(h.world.adapters[0]!.prompts, []);

    // The default mode needs no call at all.
    const quiet = await harness();
    const other = await quiet.service.createTask(quiet.workspaceId, undefined, "claude");
    await quiet.send(other.task.taskId, "x");
    await quiet.completed();
    assert.equal(quiet.world.adapters[0]!.log.some((entry) => entry.startsWith("mode=")), false);
  });

  it("adds OPENVIKING_AUTO_CAPTURE=false to native Claude spawns only when the dev capture hook is on [PC-OV-001]", async () => {
    const off = await harness({ claudeCaptureOff: true });
    const claudeTask = await off.service.createTask(off.workspaceId, undefined, "claude");
    await off.send(claudeTask.task.taskId, "native turn");
    await off.completed();
    assert.deepEqual(off.world.inputs[0]!.extraEnvironment, { OPENVIKING_AUTO_CAPTURE: "false" });
    const grokTask = await off.service.createTask(off.workspaceId, undefined, "grok");
    await off.send(grokTask.task.taskId, "grok turn");
    await off.completed();
    const grokInput = off.world.inputs.find((input) => input.engine === "grok");
    assert.equal(grokInput?.extraEnvironment, undefined, "the Grok engine never gets the Claude variable");

    const normal = await harness();
    const task = await normal.service.createTask(normal.workspaceId, undefined, "claude");
    await normal.send(task.task.taskId, "native turn");
    await normal.completed();
    assert.equal(normal.world.inputs[0]!.extraEnvironment, undefined, "off by default");
  });

  it("switches a native session to the router between turns and marks the task once it has used a routed model [PC-ROUTE-002, docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK, LOCAL_MODEL]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    const marked = (): boolean => store.loadTaskMetadata(taskId).routedAtMs !== undefined;
    const markedAtSpawn: boolean[] = [];
    h.world.onSpawn = async () => { markedAtSpawn.push(marked()); };
    const markedAtModel: boolean[] = [];
    h.world.onConfigOption = async (_label, configId) => { if (configId === "model") markedAtModel.push(marked()); };
    await h.send(taskId, "native turn");
    await h.completed();
    await h.idle();
    assert.equal(h.world.inputs[0]!.extraEnvironment, undefined, "a Claude session starts native");
    assert.equal(h.world.adapters[0]!.startCalls[0]!.options?.claudeCodeOptions, undefined);
    assert.equal(marked(), false);

    const switched = await h.service.setTaskRuntimeSettings({
      taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(switched.status, "applied");
    assert.equal(marked(), true);

    // The sequence: router up, native process closed, routed process, resume, then the model.
    const order = ["router.ensureStarted", "claude-1.close", "spawn:claude:routed", "claude-2.resume", "claude-2.config:model=deepseek-v4-flash"]
      .map((entry) => h.world.log.indexOf(entry));
    assert.ok(order.every((index) => index >= 0), `every step happened: ${order.join()}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
    assert.deepEqual(markedAtSpawn.slice(-1), [false], "no marker while the routed process is only starting");
    assert.deepEqual(markedAtModel, [false], "nor while it is taking the model: the marker follows the applied selection");
    assert.equal(h.world.adapters.length, 2);
    assertRoutedEnvironment(h.world.inputs[1]!.extraEnvironment, "deepseek-v4-flash");
    const resume = h.world.adapters[1]!.startCalls[0]!;
    assert.equal(resume.kind, "resume");
    assert.equal(resume.sessionId, "claude-session", "the same session continues");
    assert.deepEqual(resume.options?.claudeCodeOptions, {
      settings: { modelPicker: { options: [
        { model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        { model: "local-27b-model", label: "Local 27B" },
      ] } },
    });

    await h.send(taskId, "routed turn");
    await h.completed(2);
    await h.idle();
    assert.deepEqual(h.world.adapters[1]!.prompts, ["routed turn"]);
    // The routed session's picker models never become Claude's own.
    const claudeModels = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.models;
    assert.deepEqual(claudeModels.filter((model) => model.group === "claude").map((model) => model.id), [...NATIVE_MODELS]);

    // Switching among models of a routed session is a plain config option, with no restart.
    const among = await h.service.setTaskRuntimeSettings({
      taskId, model: "local-27b-model", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(among.status, "applied");
    assert.equal(h.world.adapters.length, 2);
    assert.equal(h.world.adapters[1]!.log.at(-1), "config:model=local-27b-model");

    // A crash recovery starts the task routed again, on the model it runs now, with a token of its own.
    await h.world.adapters[1]!.emitTransportInterrupted();
    await eventually(() => h.world.adapters.length === 3 && h.world.adapters[2]!.session !== undefined);
    assertRoutedEnvironment(h.world.inputs[2]!.extraEnvironment, "local-27b-model");
    assert.notEqual(
      h.world.inputs[2]!.extraEnvironment?.["ANTHROPIC_AUTH_TOKEN"],
      h.world.inputs[1]!.extraEnvironment?.["ANTHROPIC_AUTH_TOKEN"],
      "the throwaway token is new for every process start",
    );
    assert.equal(h.world.adapters[2]!.startCalls[0]!.kind, "resume");

    // And so does a new Guild process.
    const restartedWorld = await h.restart();
    await h.service.openTask(taskId);
    await h.send(taskId, "after restart");
    await h.completed(3);
    const restartedInput = restartedWorld.inputs.find((input) => input.engine === "claude");
    assertRoutedEnvironment(restartedInput?.extraEnvironment, "local-27b-model");
    assert.equal(restartedWorld.adapters.find((adapter) => adapter.engine === "claude")?.startCalls[0]?.options
      ?.claudeCodeOptions !== undefined, true);

    // The router URL carries the token and is never logged.
    await h.restart();
    const diagnostics = await readFile(join(h.root, "diagnostics", "runtime.jsonl"), "utf8");
    assert.ok(diagnostics.includes("task_routed"), "the switch itself is logged");
    assert.equal(diagnostics.includes("43210"), false);
    assert.equal(diagnostics.includes("0123456789abcdef"), false);
    assert.equal(diagnostics.includes("guild-router-"), false, "the throwaway token is never logged");
  });

  it("switches a routed session back to a Claude model with a native restart that resumes the same session [D-062, docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK, LOCAL_MODEL]);
    let store!: GuildPersistence;
    const spec: EngineSpec = { mcpHttp: true, restoreTranscriptModel: true };
    const h = await harness({ modelRouterHost: router, browserMcp: new FakeBrowserMcp() }, { claude: spec }, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native turn");
    await h.completed();
    await h.idle();
    const toRouted = await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    assert.equal(toRouted.status, "applied");
    await h.send(taskId, "routed turn");
    await h.completed(2);
    await h.idle();
    const markedAt = store.loadTaskMetadata(taskId).routedAtMs;
    assert.notEqual(markedAt, undefined);
    const routerCalls = router.calls;

    const back = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(back.status, "applied");
    assert.equal(back.task.modelSelection.modelId, "opus");
    assert.equal(router.calls, routerCalls, "a switch back to Claude never touches the router");

    // The sequence: routed process closed, native process, resume of the same session, then the model.
    const order = ["claude-2.close", "spawn:claude:native", "claude-3.resume", "claude-3.config:model=opus"]
      .map((entry) => h.world.log.lastIndexOf(entry));
    assert.ok(order.every((index) => index >= 0), `every step happened: ${order.join()}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
    assert.equal(h.world.adapters.length, 3);
    // No routed variable at all; the task has used a routed model, so only the capture switch is set.
    assert.deepEqual(h.world.inputs[2]!.extraEnvironment, { OPENVIKING_AUTO_CAPTURE: "false" });
    const resume = h.world.adapters[2]!.startCalls[0]!;
    assert.equal(resume.kind, "resume");
    assert.equal(resume.sessionId, "claude-session");
    assert.equal(resume.options?.claudeCodeOptions, undefined, "no routed modelPicker");
    assert.deepEqual(resume.options?.mcpServers, [{ type: "http", name: "guild-browser", url: BROWSER_URL, headers: [] }],
      "the browser server stays");
    assert.equal(store.loadTaskMetadata(taskId).routedAtMs, markedAt, "the marker stays: the task has used a routed model");

    await h.send(taskId, "back on Claude");
    await h.completed(3);
    await h.idle();
    assert.deepEqual(h.world.adapters[1]!.prompts, ["routed turn"], "the routed process took no further turn");
    assert.deepEqual(h.world.adapters[2]!.prompts, ["back on Claude"]);

    // Claude <-> Claude keeps the process, and so does going from one Claude model to another.
    const sonnet = await h.service.setTaskRuntimeSettings({ taskId, model: "sonnet", reasoningEffort: null, contextWindow: null });
    assert.equal(sonnet.status, "applied");
    assert.equal(h.world.adapters.length, 3, "no restart between Claude models");

    // And forth again: a routed process with a token of its own, the picker, and the capture switch.
    const again = await h.service.setTaskRuntimeSettings({ taskId, model: "local-27b-model", reasoningEffort: null, contextWindow: null });
    assert.equal(again.status, "applied");
    assert.equal(h.world.adapters.length, 4);
    assertRoutedEnvironment(h.world.inputs[3]!.extraEnvironment, "local-27b-model");
    assert.notEqual(
      h.world.inputs[3]!.extraEnvironment?.["ANTHROPIC_AUTH_TOKEN"],
      h.world.inputs[1]!.extraEnvironment?.["ANTHROPIC_AUTH_TOKEN"],
    );
    assert.equal(h.world.adapters[3]!.startCalls[0]!.kind, "resume");
    assert.ok(router.calls > routerCalls, "a switch to a routed model does");
  });

  it("clears the choice of a routed task back to Claude's default with a native restart, and never leaves the routed model on the session [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const spec: EngineSpec = { restoreTranscriptModel: true };
    const h = await harness({ modelRouterHost: router }, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native turn");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "routed turn");
    await h.completed(2);
    await h.idle();

    const cleared = await h.service.setTaskRuntimeSettings({ taskId, model: null, reasoningEffort: null, contextWindow: null });
    assert.equal(cleared.status, "applied");
    assert.equal(h.world.adapters.length, 3, "the default is a Claude model, so the process restarts natively");
    assert.equal(h.world.inputs[2]!.extraEnvironment?.["ANTHROPIC_BASE_URL"], undefined);
    // The resumed session came back on deepseek-v4-flash, which Claude does not offer: the default is applied.
    assert.deepEqual(h.world.adapters[2]!.log.filter((entry) => entry.startsWith("config:model=")), ["config:model=default"]);
    assert.equal(cleared.task.modelSelection.modelId, "default");
    assert.equal(cleared.task.modelSelection.source, "runtime");

    // The routed id the resumed session reported is never one of Claude's own models.
    const native = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.models;
    assert.deepEqual(native.filter((model) => model.group === "claude").map((model) => model.id), [...NATIVE_MODELS]);
    assert.equal(native.filter((model) => model.id === "deepseek-v4-flash").every((model) => model.group === "online"), true);
    assert.equal((await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.runtimeDefaultModelId, "default");

    await h.send(taskId, "default turn");
    await h.completed(3);
    assert.deepEqual(h.world.adapters[2]!.prompts, ["default turn"]);
  });

  it("applies the selected Claude model, or the default, after a resume whose transcript ended on the other mode, also after a Guild restart [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const spec: EngineSpec = { restoreTranscriptModel: true };
    const h = await harness({ modelRouterHost: router }, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    await h.send(taskId, "routed");
    await h.completed(2);
    await h.idle();
    // The choice is cleared (Claude's default); the transcript's last turn is still DeepSeek's.
    await h.service.setTaskRuntimeSettings({ taskId, model: null, reasoningEffort: null, contextWindow: null });
    await h.idle();

    // A Guild restart resumes natively on the DeepSeek id: the default is applied before the first prompt.
    const restarted = await h.restart();
    await h.service.openTask(taskId);
    await h.send(taskId, "after restart");
    await h.completed(3);
    const native = restarted.adapters[0]!;
    assert.equal(restarted.inputs[0]!.extraEnvironment?.["ANTHROPIC_BASE_URL"], undefined);
    const modelCalls = native.log.filter((entry) => entry.startsWith("config:model="));
    assert.deepEqual(modelCalls, ["config:model=default"]);
    assert.ok(native.log.indexOf("config:model=default") < native.log.indexOf("prompt:after restart"));
    await h.idle();

    // A pinned Claude model is applied the same way when the transcript ended on a routed turn.
    await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    await h.send(taskId, "routed again");
    await h.completed(4);
    await h.idle();
    await h.service.setTaskRuntimeSettings({ taskId, model: "sonnet", reasoningEffort: null, contextWindow: null });
    const second = await h.restart();
    await h.service.openTask(taskId);
    await h.send(taskId, "sonnet after restart");
    await h.completed(5);
    assert.deepEqual(second.adapters[0]!.log.filter((entry) => entry.startsWith("config:model=")), ["config:model=sonnet"]);
    assert.deepEqual(second.adapters[0]!.prompts, ["sonnet after restart"]);
  });

  it("resumes a routed process whose transcript ended on a Claude id its list does not offer, and applies the routed selection [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const spec: EngineSpec = {};
    const h = await harness({ modelRouterHost: router }, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    // The adapter restores a dated Claude id (no row of the list has it) from the transcript.
    spec.resumedModel = "claude-opus-5-5-20260101";
    const switched = await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    assert.equal(switched.status, "applied");
    assert.equal(h.world.adapters.length, 2);
    assertRoutedEnvironment(h.world.inputs[1]!.extraEnvironment, "deepseek-v4-flash");
    assert.deepEqual(h.world.adapters[1]!.log.filter((entry) => entry.startsWith("config:model=")), ["config:model=deepseek-v4-flash"]);
    // The unlisted Claude id is no model of the catalog either.
    const ids = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.models.map((model) => model.id);
    assert.equal(ids.includes("claude-opus-5-5-20260101"), false);
    await h.send(taskId, "routed");
    await h.completed(2);
    assert.deepEqual(h.world.adapters[1]!.prompts, ["routed"]);
  });

  it("starts every process in the mode of the selected model: crash recovery and a Guild restart, both directions [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const spec: EngineSpec = { restoreTranscriptModel: true };
    const h = await harness({ modelRouterHost: router }, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native turn");
    await h.completed();
    await h.idle();
    await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    await h.send(taskId, "routed turn");
    await h.completed(2);
    await h.idle();
    await h.service.setTaskRuntimeSettings({ taskId, model: "sonnet", reasoningEffort: null, contextWindow: null });
    assert.equal(h.world.adapters.length, 3);

    // A native model after routed turns: the crash recovery is native, with capture off and no routed variable.
    await h.world.adapters[2]!.emitTransportInterrupted();
    await eventually(() => h.world.adapters.length === 4 && h.world.adapters[3]!.session !== undefined);
    assert.deepEqual(h.world.inputs[3]!.extraEnvironment, { OPENVIKING_AUTO_CAPTURE: "false" });
    assert.equal(h.world.adapters[3]!.startCalls[0]!.options?.claudeCodeOptions, undefined);
    assert.ok(h.world.adapters[3]!.log.includes("config:model=sonnet"), "the model is applied to the resumed session");

    // So is a new Guild process.
    const afterRestart = await h.restart();
    await h.service.openTask(taskId);
    await h.send(taskId, "after restart");
    await h.completed(3);
    const nativeInput = afterRestart.inputs.find((input) => input.engine === "claude");
    assert.deepEqual(nativeInput?.extraEnvironment, { OPENVIKING_AUTO_CAPTURE: "false" });
    assert.equal(afterRestart.adapters[0]!.log.filter((entry) => entry.startsWith("prompt:")).join(), "prompt:after restart");
    await h.idle();

    // The other way: a routed model after native turns starts a routed process, also after a restart.
    await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    const routedWorld = await h.restart();
    await h.service.openTask(taskId);
    await h.send(taskId, "routed after restart");
    await h.completed(4);
    assertRoutedEnvironment(routedWorld.inputs.find((input) => input.engine === "claude")?.extraEnvironment, "deepseek-v4-flash");
    await h.idle();
    await h.service.setTaskRuntimeSettings({ taskId, model: "haiku", reasoningEffort: null, contextWindow: null });
    const nativeWorld = await h.restart();
    await h.service.openTask(taskId);
    await h.send(taskId, "native after restart");
    await h.completed(5);
    assert.deepEqual(nativeWorld.inputs.find((input) => input.engine === "claude")?.extraEnvironment, { OPENVIKING_AUTO_CAPTURE: "false" });
    assert.ok(nativeWorld.adapters[0]!.log.includes("config:model=haiku"));
  });

  it("keeps OpenViking capture on for a task that never used a routed model and off for one that did [D-062, PC-OV-001]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const never = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(never.task.taskId, "x");
    await h.completed();
    await h.idle();
    assert.equal(h.world.inputs[0]!.extraEnvironment, undefined, "capture follows the user's OpenViking setup");
    // Claude to Claude and a crash recovery of a task that never routed stay as they were.
    await h.service.setTaskRuntimeSettings({ taskId: never.task.taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    await h.world.adapters[0]!.emitTransportInterrupted();
    await eventually(() => h.world.adapters.length === 2 && h.world.adapters[1]!.session !== undefined);
    assert.equal(h.world.inputs[1]!.extraEnvironment, undefined);

    const used = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.service.setTaskRuntimeSettings({ taskId: used.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    await h.send(used.task.taskId, "y");
    await h.completed();
    await h.idle();
    await h.service.setTaskRuntimeSettings({ taskId: used.task.taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    const environments = h.world.inputs.slice(2).map((input) => input.extraEnvironment);
    assert.equal(environments.length, 2);
    assertRoutedEnvironment(environments[0], "deepseek-v4-flash");
    assert.deepEqual(environments[1], { OPENVIKING_AUTO_CAPTURE: "false" });
    for (const environment of environments) {
      assert.equal(Object.keys(environment ?? {}).some((key) => key === "ANTHROPIC_API_KEY"), false);
    }
    assert.equal(Object.hasOwn(environments[1] ?? {}, "ANTHROPIC_AUTH_TOKEN"), false);
    assert.equal(Object.hasOwn(environments[1] ?? {}, "ANTHROPIC_BASE_URL"), false);
  });

  it("starts a new task whose first model is routed through the router from its first process [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const markedAtModel: boolean[] = [];
    h.world.onConfigOption = async (_label, configId) => {
      if (configId === "model") markedAtModel.push(store.loadTaskMetadata(task.task.taskId).routedAtMs !== undefined);
    };
    const saved = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(saved.status, "saved", "no session yet: the choice waits for the first process");
    await h.send(task.task.taskId, "first");
    await h.completed();
    assert.equal(h.world.adapters.length, 1, "no native process to throw away");
    assert.equal(h.world.inputs[0]!.extraEnvironment?.["ANTHROPIC_BASE_URL"], ROUTER_URL);
    assert.deepEqual(h.world.adapters[0]!.startCalls.map((call) => call.kind), ["new"]);
    assert.deepEqual(
      (h.world.adapters[0]!.startCalls[0]!.options?.claudeCodeOptions as { settings: { modelPicker: { options: unknown[] } } })
        .settings.modelPicker.options,
      [{ model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
    );
    assert.equal(h.world.adapters[0]!.log.includes("config:model=deepseek-v4-flash"), true);
    assert.deepEqual(markedAtModel, [false], "the marker follows the applied model");
    assert.notEqual(store.loadTaskMetadata(task.task.taskId).routedAtMs, undefined);
  });

  it("replaces a Claude session that never had a prompt instead of resuming it [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.service.loadSlashCommands(task.task.taskId);
    assert.equal(h.world.adapters.length, 1);

    const switched = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(switched.status, "applied");
    assert.equal(h.world.adapters.length, 2);
    assert.deepEqual(h.world.adapters[1]!.startCalls.map((call) => call.kind), ["new"],
      "the adapter cannot resume a session with no transcript");
    await h.send(task.task.taskId, "hi");
    await h.completed();
    assert.deepEqual(h.world.adapters[1]!.prompts, ["hi"], "no recovery capsule is wrapped around the first message");
    const view = await h.service.openTask(task.task.taskId);
    assert.equal(view.timeline.some((item) => item.kind === "notice"), false);
  });

  it("keeps the working session when the router cannot start, and refuses the routed model [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "native");
    await h.completed();
    await h.idle();
    router.failStart = true;
    const refused = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(refused.status, "refused");
    assert.equal(refused.status === "refused" ? refused.reason : "", "unavailable");
    assert.equal(h.world.adapters.length, 1);
    assert.equal(h.world.adapters[0]!.state, "ready", "the native session is untouched");
    assert.equal(refused.task.modelSelection.source, "runtime", "nothing was stored");

    // A routed task whose router is gone fails its start with a named code, never a native fallback.
    router.failStart = false;
    const routed = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(routed.status, "applied");
    assert.equal(h.world.adapters.length, 2);
    await h.idle();
    router.failStart = true;
    await h.world.adapters[1]!.emitTransportInterrupted();
    await eventually(async () => (await h.service.bootstrap()).activeTask?.sessionRecovery === "available");
    await assert.rejects(h.send(task.task.taskId, "again"), /^Error: model_router_unavailable$/u);
    assert.equal(h.world.adapters.length, 2, "no native process is started for a routed task");
    assert.deepEqual(h.world.adapters[0]!.prompts, ["native"]);
    assert.deepEqual(h.world.adapters[1]!.prompts, []);
  });

  it("joins the routed switch instead of racing it: prompts that arrive while the router starts run on the routed process [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    const markedAtModel: boolean[] = [];
    h.world.onConfigOption = async (_label, configId) => {
      if (configId === "model") markedAtModel.push(store.loadTaskMetadata(taskId).routedAtMs !== undefined);
    };
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();

    // The command's own pre-check is the first router call; the switch's is the second, and it is held.
    const gate = router.holdCall(router.calls + 2);
    const switching = h.service.setTaskRuntimeSettings({
      taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    await eventually(() => router.waiting);
    const first = h.send(taskId, "first");
    const second = h.send(taskId, "second");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(h.world.adapters[0]!.prompts, ["native"], "nothing runs on the native process with a routed selection");
    assert.equal(h.world.adapters.length, 1, "and the native process is not closed before the router is up");
    assert.equal(store.loadTaskMetadata(taskId).routedAtMs, undefined, "the task is not marked yet");

    gate.open();
    assert.equal((await switching).status, "applied");
    await Promise.all([first, second]);
    await h.completed(3);
    await h.idle();
    assert.deepEqual(h.world.adapters[0]!.prompts, ["native"]);
    assert.deepEqual([...h.world.adapters[1]!.prompts].sort(), ["first", "second"]);
    assert.equal(h.world.adapters.length, 2, "one switch, however many callers joined it");
    assert.deepEqual(markedAtModel, [false], "the marker follows the applied model");
    assert.notEqual(store.loadTaskMetadata(taskId).routedAtMs, undefined);
    const turnLog = h.world.adapters[1]!.log;
    assert.ok(
      turnLog.indexOf("config:model=deepseek-v4-flash") < turnLog.findIndex((entry) => entry.startsWith("prompt:")),
      "the model is applied before the first turn of the routed process",
    );
  });

  it("marks the task last: a publish failure before the marker leaves it unmarked and the selection rolled back [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();

    // Publishing fails once after the routed process took the model.
    let armed = false;
    h.world.onConfigOption = async (_label, configId, value) => {
      if (configId === "model" && value === "deepseek-v4-flash") armed = true;
    };
    h.service.subscribe(() => {
      if (armed) { armed = false; throw new Error("projection_failed"); }
    });
    const refused = await h.service.setTaskRuntimeSettings({
      taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(refused.status, "refused", "the switch failed ...");
    assert.equal(store.loadTaskMetadata(taskId).routedAtMs, undefined, "... and the task was never marked");
    assert.equal(refused.task.modelSelection.source, "runtime", "the previous choice is back, consistently");

    // Native again for the next turn, exactly like any other failed switch.
    await h.send(taskId, "again");
    await h.completed(2);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, ["again"]);
    assert.equal(h.world.inputs.at(-1)!.extraEnvironment, undefined);
  });

  it("does not fail a switch whose routed process is valid when only showing the marker fails [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();

    // The first two projections after the marker cannot be built.
    let failures = 2;
    h.service.subscribe(() => {
      if (failures > 0 && store.loadTaskMetadata(taskId).routedAtMs !== undefined) {
        failures -= 1;
        throw new Error("projection_failed");
      }
    });
    const switched = await h.service.setTaskRuntimeSettings({
      taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(switched.status, "applied", "the routed process runs the model, so the selection is reported as applied");
    assert.equal(switched.task.modelSelection.modelId, "deepseek-v4-flash");
    assert.notEqual(store.loadTaskMetadata(taskId).routedAtMs, undefined);
    await h.send(taskId, "after");
    await h.completed(2);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, ["after"]);
    assert.equal(h.world.adapters.length, 2, "no second restart");
  });

  it("does not route a process because the task is marked: the mode follows the selected model [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    const opus = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(opus.status, "applied");

    // A marker with a native model behind it: a task a 3.0.1 build routed and the user took back to Claude, say.
    store.markTaskRouted({ taskId });
    const reopened = await h.service.openTask(taskId);
    assert.equal(reopened.modelSelection.modelId, "opus", "the Claude choice is shown and kept");
    await h.send(taskId, "after");
    await h.completed(2);
    assert.equal(h.world.adapters.length, 1, "no restart: the live process is native, like the model");
    assert.deepEqual(h.world.adapters[0]!.prompts, ["native", "after"]);

    // The next native process of a marked task keeps capture off and has no routed variable.
    await h.world.adapters[0]!.emitTransportInterrupted();
    await eventually(() => h.world.adapters.length === 2 && h.world.adapters[1]!.session !== undefined);
    assert.deepEqual(h.world.inputs[1]!.extraEnvironment, { OPENVIKING_AUTO_CAPTURE: "false" });
    assert.equal(router.calls, 0, "the router is not even started");
  });

  it("rolls a failed switch back to Claude back to the routed selection, keeps the marker and never sends the turn to the wrong backend [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, { claude: { refuseModel: "opus" } }, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "routed");
    await h.completed(2);
    await h.idle();
    const markedAt = store.loadTaskMetadata(taskId).routedAtMs;

    // The native process comes up and resumes, but cannot take the model: the selection is refused as a failed one.
    const refused = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(refused.status, "refused");
    assert.equal(refused.status === "refused" ? refused.reason : "", "unavailable");
    assert.equal(refused.task.modelSelection.modelId, "deepseek-v4-flash", "the previous choice is back");
    assert.equal(refused.task.modelSelection.source, "task");
    assert.equal(h.world.adapters.length, 3);
    assert.equal(h.world.adapters[2]!.state, "closed", "the half-started native process is closed");
    assert.equal(h.world.inputs[2]!.extraEnvironment?.["ANTHROPIC_BASE_URL"], undefined);
    assert.equal(store.loadTaskMetadata(taskId).routedAtMs, markedAt, "the marker is untouched");

    // The next turn starts a process in the mode of the restored selection: routed, on DeepSeek.
    await h.send(taskId, "again");
    await h.completed(3);
    assert.equal(h.world.adapters.length, 4);
    assertRoutedEnvironment(h.world.inputs[3]!.extraEnvironment, "deepseek-v4-flash");
    assert.deepEqual(h.world.adapters[3]!.prompts, ["again"]);
    assert.deepEqual(h.world.adapters[2]!.prompts, [], "the native process never ran a turn");

    // The same the other way: a routed process that cannot take the model leaves the native task as it was.
    const native = await harness({ modelRouterHost: router }, { claude: { refuseModel: "deepseek-v4-flash" } });
    const second = await native.service.createTask(native.workspaceId, undefined, "claude");
    await native.send(second.task.taskId, "native");
    await native.completed();
    await native.idle();
    const failed = await native.service.setTaskRuntimeSettings({
      taskId: second.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(failed.status, "refused");
    assert.equal(failed.task.modelSelection.source, "runtime");
    await native.send(second.task.taskId, "after");
    await native.completed(2);
    assert.deepEqual(native.world.adapters.at(-1)!.prompts, ["after"]);
    assert.equal(native.world.inputs.at(-1)!.extraEnvironment, undefined);
  });

  it("keeps the session when the resume of a switch back to Claude times out, and replaces it only when the agent says it is gone [D-062, PC-ENG-002]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const spec: EngineSpec = {};
    const h = await harness({ modelRouterHost: router }, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.idle();

    resumeFailureCodes.set(spec, ["request_timeout"]);
    const timedOut = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(timedOut.status, "refused");
    assert.equal(timedOut.task.modelSelection.modelId, "deepseek-v4-flash", "rolled back");
    const retained = await h.service.openTask(taskId);
    assert.equal(retained.sessionRecovery, "available", "a timeout never asks for a replacement session");
    assert.equal(retained.canSend, true);
    await h.send(taskId, "still here");
    await h.completed(2);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, ["still here"]);
    assertRoutedEnvironment(h.world.inputs.at(-1)!.extraEnvironment, "deepseek-v4-flash");
    await h.idle();

    resumeFailureCodes.set(spec, ["session_not_found"]);
    const gone = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(gone.status, "refused");
    assert.equal(gone.task.modelSelection.modelId, "deepseek-v4-flash", "rolled back");
    assert.equal((await h.service.openTask(taskId)).sessionRecovery, "replacement_required",
      "the agent's own no-such-session answer is the one thing that replaces the session");
  });

  it("holds prompts that arrive during a switch back to Claude and runs them on the native process only [D-062, docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const spec: EngineSpec = {};
    const h = await harness({ modelRouterHost: router }, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "routed");
    await h.completed(2);
    await h.idle();

    // The native process resumes slowly: the switch is held at the resume.
    let open!: () => void;
    spec.resumeGate = new Promise<void>((resolve) => { open = resolve; });
    const switching = h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    await eventually(() => h.world.adapters.length === 3 && h.world.adapters[2]!.startCalls.length === 1);
    const first = h.send(taskId, "first");
    const second = h.send(taskId, "second");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(h.world.adapters[1]!.prompts, ["routed"], "nothing runs on the routed process while the switch is in flight");
    assert.deepEqual(h.world.adapters[2]!.prompts, []);
    assert.equal(h.world.adapters[1]!.state, "closed", "the routed process is already gone");

    open();
    assert.equal((await switching).status, "applied");
    await Promise.all([first, second]);
    await h.completed(4);
    await h.idle();
    assert.deepEqual([...h.world.adapters[2]!.prompts].sort(), ["first", "second"], "both ran on the native process");
    assert.deepEqual(h.world.adapters[1]!.prompts, ["routed"]);
    assert.equal(h.world.adapters.length, 3, "one switch, however many callers joined it");
    const turnLog = h.world.adapters[2]!.log;
    assert.ok(
      turnLog.indexOf("config:model=opus") < turnLog.findIndex((entry) => entry.startsWith("prompt:")),
      "the model is applied before the first turn of the native process",
    );
  });

  it("applies the Claude global default again once a routed task's own choice is cleared, with a native restart [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    await h.service.setClaudeSettings("sonnet", null, "default");
    const switched = await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    assert.equal(switched.status, "applied");
    assert.equal(switched.task.modelSelection.source, "task");

    const cleared = await h.service.setTaskRuntimeSettings({ taskId, model: null, reasoningEffort: null, contextWindow: null });
    assert.equal(cleared.status, "applied");
    assert.equal(cleared.task.modelSelection.source, "global");
    assert.equal(cleared.task.modelSelection.modelId, "sonnet");
    assert.equal(h.world.adapters.length, 3);
    assert.equal(h.world.inputs[2]!.extraEnvironment?.["ANTHROPIC_BASE_URL"], undefined);
    assert.ok(h.world.adapters[2]!.log.includes("config:model=sonnet"));
    await h.send(taskId, "on the default");
    await h.completed(2);
    assert.deepEqual(h.world.adapters[2]!.prompts, ["on the default"]);
  });

  it("ends a turn by name when the routed model's source is gone, and a Claude model is the way out [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.idle();

    router.models = [];
    router.emitChange();
    await assert.rejects(h.send(taskId, "no source"), /^Error: model_selection_failed$/u);
    assert.equal(h.world.adapters.length, 3, "the stale routed process was replaced by a native one, which does not offer the model");
    assert.deepEqual(h.world.adapters[1]!.prompts, [], "nothing went to the routed process");
    assert.deepEqual(h.world.adapters[2]!.prompts, [], "nor to the native one");
    assert.equal(h.world.adapters[2]!.state, "closed");

    // A Claude model is the way out, and the next turn starts natively.
    const out = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(out.status, "saved");
    await h.send(taskId, "again");
    await h.completed(2);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, ["again"]);
    assert.equal(h.world.inputs.at(-1)!.extraEnvironment?.["ANTHROPIC_BASE_URL"], undefined);
  });

  it("never writes a prompt to a process of the wrong mode, even when the selection changes under a started turn [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    let store!: GuildPersistence;
    let flip: (() => void) | undefined;
    // The start checkpoint is the one await between the send's gating and the prompt: the selection changes there.
    const unavailable = { status: "unavailable", reason: "git_failed" } as const;
    const checkpoints: GitCheckpointPort = {
      capture: async () => { flip?.(); return unavailable; },
      summarize: async () => unavailable,
      fileDiff: async () => unavailable,
      planRewind: async () => unavailable,
      restore: async () => ({ restored: [], removed: [], failed: [] }),
    };
    const h = await harness({ modelRouterHost: router, checkpoints }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.idle();

    // The routed process is live; the stored choice becomes a Claude model under the started turn. The routed
    // session offers that model too (its list holds Claude's own), so only the mode check keeps the prompt back.
    flip = () => {
      flip = undefined;
      store.saveTaskRuntimeSettings({
        taskId, expectedRevision: store.loadTaskRuntimeSettings(taskId)?.revision ?? 0,
        modelId: "opus", reasoningEffort: null, contextWindow: null,
      });
    };
    await h.send(taskId, "second");
    const failed = await eventuallyValue(async () => {
      const view = (await h.service.bootstrap()).activeTask;
      return view?.timeline.some((item) =>
        item.kind === "error" && /could not switch to the model|未能切换到这个任务选择的模型/u.test(item.text)) === true
        ? view
        : undefined;
    });
    assert.equal(failed.task.activeRunState, "failed");
    assert.deepEqual(h.world.adapters[1]!.prompts, [], "the turn never reached the routed process with a Claude selection");
    assert.ok(!h.world.adapters[1]!.log.includes("config:model=opus"), "and the Claude model was not even applied to it");

    // The stored choice is what the next turn follows: the process is replaced by a native one first.
    await h.idle();
    await h.send(taskId, "third");
    await h.completed(2);
    assert.equal(h.world.adapters.length, 3);
    assert.equal(h.world.inputs.at(-1)!.extraEnvironment?.["ANTHROPIC_BASE_URL"], undefined);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, ["third"]);
    assert.deepEqual(h.world.adapters[1]!.prompts, []);
  });

  it("refuses the prompt with model_selection_failed when the session cannot take the selected Claude model [docs/20 3.3]", async () => {
    const h = await harness({}, { claude: { refuseModel: "opus" } });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "first");
    await h.completed();
    await h.idle();
    await h.service.setClaudeSettings("opus", null, "default");
    await h.send(taskId, "second");
    const failed = await eventuallyValue(async () => {
      const view = (await h.service.bootstrap()).activeTask;
      return view?.timeline.some((item) =>
        item.kind === "error" && /could not switch to the model|未能切换到这个任务选择的模型/u.test(item.text)) === true
        ? view
        : undefined;
    });
    assert.equal(failed.task.activeRunState, "failed");
    assert.deepEqual(h.world.adapters[0]!.prompts, ["first"], "the turn never reached the agent on another model");
    assert.equal(failed.modelSelection.modelId, "default", "the projection shows the model the session really runs");

    // Switching the live session is refused the same way and never reported as applied.
    await h.idle();
    const refused = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(refused.status, "refused");
    assert.equal((await h.service.openTask(taskId)).modelSelection.source, "global", "nothing was stored for the task");
  });

  it("fails the routed switch by name and does not mark the task when the routed process cannot take the model [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router }, { claude: { refuseModel: "deepseek-v4-flash" } });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    const refused = await h.service.setTaskRuntimeSettings({
      taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(refused.status, "refused", "the selection is never reported as applied");
    assert.equal(refused.task.modelSelection.source, "runtime", "the previous choice is back");
    assert.equal(h.world.adapters.length, 2);
    assert.equal(h.world.adapters[1]!.state, "closed", "the half-started routed process is closed");

    // Native again for the next turn: the marker was never written.
    await h.send(taskId, "again");
    await h.completed(2);
    assert.equal(h.world.adapters.length, 3);
    assert.equal(h.world.inputs[2]!.extraEnvironment, undefined);
    assert.deepEqual(h.world.adapters[2]!.prompts, ["again"]);

    // A task whose first model is routed surfaces the named code from its first send.
    const fresh = await h.service.createTask(h.workspaceId, undefined, "claude");
    const saved = await h.service.setTaskRuntimeSettings({
      taskId: fresh.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(saved.status, "saved");
    await assert.rejects(h.send(fresh.task.taskId, "hi"), /^Error: model_selection_failed$/u);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, []);
    assert.equal(h.world.adapters.at(-1)!.state, "closed");
  });

  it("gives the session/load fallback the routed picker and the browser server a resume gets [docs/20 3.3]", async () => {
    // Claude's adapter resumes; session/load is the way back only for one that does not advertise resume.
    const spec: EngineSpec = { mcpHttp: true, loadSession: true, resume: false };
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router, browserMcp: new FakeBrowserMcp() }, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    await h.send(task.task.taskId, "first");
    await h.completed();
    await h.world.adapters[0]!.emitTransportInterrupted();
    await eventually(() => h.world.adapters.length === 2 && h.world.adapters[1]!.session !== undefined);
    const calls = h.world.adapters[1]!.startCalls;
    assert.deepEqual(calls.map((call) => call.kind), ["load"], "no resume is advertised, so the load is the way back");
    const server = { type: "http", name: "guild-browser", url: BROWSER_URL, headers: [] };
    assert.deepEqual(calls[0]!.options?.mcpServers, [server]);
    assert.deepEqual(calls[0]!.options?.claudeCodeOptions, {
      settings: { modelPicker: { options: [{ model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }] } },
    });
    assert.deepEqual(h.world.inputs[1]!.extraEnvironment?.["ANTHROPIC_BASE_URL"], ROUTER_URL);
  });

  it("never defaults a Claude task to a routed or a Grok model before Claude has started, and saves a native alias [PC-MODEL-001]", async () => {
    const router = new FakeRouterHost([DEEPSEEK, LOCAL_MODEL]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    // The Claude catalog is still empty (the adapter has not reported its list) and the router offers two models.
    const created = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = created.task.taskId;
    assert.equal(created.modelSelection.modelId, null, "Claude Code's own default, not DeepSeek or a Grok model");
    assert.equal(created.modelSelection.source, "runtime");
    assert.equal((await h.service.openTask(taskId)).modelSelection.modelId, null);

    // A stale Grok default (the Claude grammar accepts any id) never shows on a Claude task.
    store.updateAppSettings({ expectedRevision: store.loadAppSettings().revision, claudeModel: "grok-4.5" });
    assert.equal((await h.service.openTask(taskId)).modelSelection.modelId, null);
    store.updateAppSettings({ expectedRevision: store.loadAppSettings().revision, claudeModel: null });

    // A known native alias can be saved as the task's choice before the first session, a Grok model and an unknown id cannot.
    const alias = await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    assert.equal(alias.status, "saved");
    assert.equal(alias.task.modelSelection.modelId, "opus");
    assert.equal(alias.task.modelSelection.source, "task");
    for (const model of ["grok-4.5", "gpt-nope"]) {
      const refused = await h.service.setTaskRuntimeSettings({ taskId, model, reasoningEffort: null, contextWindow: null });
      assert.equal(refused.status, "refused", model);
    }
    // The same for the global Claude default.
    const defaults = await h.service.setClaudeSettings("sonnet", null, "default");
    assert.equal(defaults.runtimeSettings.claude?.model, "sonnet");
    await assert.rejects(h.service.setClaudeSettings("grok-4.5", null, "default"), /runtime_settings_change_unavailable/u);
    await assert.rejects(h.service.setClaudeSettings("deepseek-v4-flash", null, "default"), /claude_default_must_be_native/u);
    await h.service.setClaudeSettings(null, null, "default");

    // The alias is applied when the session starts.
    await h.send(taskId, "first");
    await h.completed();
    assert.ok(h.world.adapters[0]!.log.includes("config:model=opus"));
    assert.equal((await h.service.openTask(taskId)).modelSelection.modelId, "opus");

    // Once the adapter reported its list, only what it (or the router) offers can be chosen.
    await h.idle();
    const unknown = await h.service.setTaskRuntimeSettings({ taskId, model: "fable", reasoningEffort: null, contextWindow: null });
    assert.equal(unknown.status, "refused", "fable is an alias, but this adapter did not list it");
  });

  it("saves a native alias for a task whose adapter list is still unknown and fails by name if it is not offered [PC-MODEL-001]", async () => {
    const h = await harness({ modelRouterHost: new FakeRouterHost([DEEPSEEK]) });
    const created = await h.service.createTask(h.workspaceId, undefined, "claude");
    const saved = await h.service.setTaskRuntimeSettings({
      taskId: created.task.taskId, model: "fable", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(saved.status, "saved");
    // The fake adapter lists default, opus, sonnet and haiku: fable is not there.
    await assert.rejects(h.send(created.task.taskId, "hi"), /^Error: model_selection_failed$/u);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, [], "no turn runs on another model");
  });

  it("keeps a Grok task running when its pinned model is not offered [PC-MODEL-001]", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId);
    const saved = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "grok-4.5", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(saved.status, "saved");
    await h.send(task.task.taskId, "hi");
    await h.completed();
    assert.deepEqual(h.world.adapters[0]!.prompts, ["hi"], "a refusal never blocks a Grok turn");
    const view = await h.service.openTask(task.task.taskId);
    assert.equal(view.timeline.some((item) => item.kind === "error"), false);
  });

  it("refuses an Online or Local model as the Claude global default with a named code [PC-MODEL-001]", async () => {
    const router = new FakeRouterHost([DEEPSEEK, LOCAL_MODEL]);
    const h = await harness({ modelRouterHost: router });
    await assert.rejects(h.service.setClaudeSettings("deepseek-v4-flash", null, "default"), /^Error: claude_default_must_be_native$/u);
    await assert.rejects(h.service.setClaudeSettings("local-27b-model", "high", "plan"), /^Error: claude_default_must_be_native$/u);
    assert.equal((await h.service.bootstrap()).runtimeSettings.claude?.model, null, "nothing was stored");
    // A native model still passes, also once a session has reported the adapter's list.
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "x");
    await h.completed();
    await assert.rejects(h.service.setClaudeSettings("deepseek-v4-flash", null, "default"), /^Error: claude_default_must_be_native$/u);
    await h.service.setClaudeSettings("opus", "high", "plan");
    assert.equal((await h.service.bootstrap()).runtimeSettings.claude?.model, "opus");
    // The named codes reach the renderer as they are.
    for (const code of ["claude_default_must_be_native", "model_selection_failed", "model_router_unavailable"]) {
      assert.equal(toDesktopIpcFailure(new Error(code)).message, code);
    }
  });

  it("hands the browser MCP server only to agents that advertised HTTP MCP [PC-BROWSER-002]", async () => {
    const withMcp = await harness({ browserMcp: new FakeBrowserMcp() }, { claude: { mcpHttp: true }, grok: { mcpHttp: true } });
    const claudeTask = await withMcp.service.createTask(withMcp.workspaceId, undefined, "claude");
    await withMcp.send(claudeTask.task.taskId, "x");
    await withMcp.completed();
    const server = { type: "http", name: "guild-browser", url: BROWSER_URL, headers: [] };
    assert.deepEqual(withMcp.world.adapters[0]!.startCalls[0]!.options?.mcpServers, [server]);
    // Also on resume, after a crash.
    await withMcp.world.adapters[0]!.emitTransportInterrupted();
    await eventually(() => withMcp.world.adapters.length === 2 && withMcp.world.adapters[1]!.session !== undefined);
    assert.equal(withMcp.world.adapters[1]!.startCalls[0]!.kind, "resume");
    assert.deepEqual(withMcp.world.adapters[1]!.startCalls[0]!.options?.mcpServers, [server]);
    // Grok gets it too when it advertised HTTP MCP.
    const grokTask = await withMcp.service.createTask(withMcp.workspaceId);
    await withMcp.send(grokTask.task.taskId, "y");
    await withMcp.completed();
    assert.deepEqual(withMcp.world.adapters.at(-1)!.startCalls[0]!.options?.mcpServers, [server]);

    const without = await harness({ browserMcp: new FakeBrowserMcp() }, { claude: { mcpHttp: false }, grok: { mcpHttp: false } });
    for (const engine of ["claude", "grok"] as const) {
      const task = await without.service.createTask(without.workspaceId, undefined, engine);
      await without.send(task.task.taskId, "z");
      await without.completed();
    }
    assert.deepEqual(without.world.adapters.map((adapter) => adapter.startCalls[0]!.options?.mcpServers), [undefined, undefined]);

    // A browser server that cannot start never blocks a task.
    const broken = new FakeBrowserMcp();
    broken.fail = true;
    const tolerant = await harness({ browserMcp: broken }, { claude: { mcpHttp: true } });
    const task = await tolerant.service.createTask(tolerant.workspaceId, undefined, "claude");
    await tolerant.send(task.task.taskId, "w");
    await tolerant.completed();
    assert.equal(tolerant.world.adapters[0]!.startCalls[0]!.options?.mcpServers, undefined);
  });

  it("asks only Grok adapters for official usage [PC-FALLBACK-001]", async () => {
    const fetched: string[] = [];
    const usageFetcher = async (): Promise<AcpV1OfficialBillingSnapshot> => {
      fetched.push("dedicated");
      return { creditUsagePercent: 12 };
    };
    // Only a Claude task is live: nothing to borrow, the dedicated Grok probe answers.
    const claudeOnly = await harness({ usageFetcher });
    const claudeTask = await claudeOnly.service.createTask(claudeOnly.workspaceId, undefined, "claude");
    await claudeOnly.send(claudeTask.task.taskId, "x");
    await claudeOnly.completed();
    await claudeOnly.service.refreshUsage();
    assert.deepEqual(fetched, ["dedicated"]);
    assert.equal(claudeOnly.world.adapters[0]!.billingCalls, 0);

    // A Grok task is live next to it: the Grok adapter is borrowed.
    const both = await harness({ usageFetcher });
    const claudeFirst = await both.service.createTask(both.workspaceId, undefined, "claude");
    await both.send(claudeFirst.task.taskId, "x");
    await both.completed();
    const grokTask = await both.service.createTask(both.workspaceId, undefined, "grok");
    await both.send(grokTask.task.taskId, "y");
    await both.completed();
    fetched.length = 0;
    await both.service.refreshUsage();
    assert.deepEqual(fetched, []);
    assert.equal(both.world.adapters.find((adapter) => adapter.engine === "grok")!.billingCalls, 1);
    assert.equal(both.world.adapters.find((adapter) => adapter.engine === "claude")!.billingCalls, 0);
  });

  it("shows context usage and the account label for Claude and nothing for Grok [PC-FALLBACK-001]", async () => {
    const h = await harness();
    const claudeTask = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(claudeTask.task.taskId, "x");
    await h.completed();
    const adapter = h.world.adapters[0]!;
    assert.equal((await h.service.openTask(claudeTask.task.taskId)).engineStatus, undefined);
    adapter.emitAuthStatus({ kind: "account", label: "Claude Max", plan: "max" });
    await adapter.emitContextUsage(52_000, 200_000);
    const view = await eventuallyValue(async () => {
      const current = (await h.service.bootstrap()).activeTask;
      return current?.engineStatus?.accountLabel === "Claude Max" ? current : undefined;
    });
    assert.deepEqual(view.engineStatus, { accountLabel: "Claude Max" });
    assert.deepEqual(view.contextWindow, { status: "available", used: 52_000, size: 200_000 });

    const grokTask = await h.service.createTask(h.workspaceId, undefined, "grok");
    assert.equal(grokTask.engineStatus, undefined);
  });

  it("keeps the subscription's account label in either mode: a routed process reports its throwaway identity and none of it is shown [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const claudeReport = async () => {
      const bootstrap = await h.service.bootstrap();
      return { settings: bootstrap.runtimeSettings.claude, task: bootstrap.activeTask?.engineStatus };
    };
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    h.world.adapters[0]!.emitAuthStatus({ kind: "account", label: "Claude Max", plan: "max" });
    await eventually(async () => (await claudeReport()).settings?.accountLabel === "Claude Max");
    await h.idle();

    // The routed process authenticates with the throwaway token; whatever it says about itself is not the subscription.
    const switched = await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    assert.equal(switched.status, "applied");
    const routed = h.world.adapters[1]!;
    for (const status of [
      { kind: "api_key", label: "Anthropic API key" },
      { kind: "gateway", label: "Custom model gateway" },
      { kind: "none", label: "Not logged in" },
    ]) {
      routed.emitAuthStatus(status);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const report = await claudeReport();
      assert.equal(report.settings?.accountLabel, "Claude Max", status.kind);
      assert.equal(report.settings?.status, "ready", `${status.kind} does not turn into a login prompt`);
      assert.deepEqual(report.task, { accountLabel: "Claude Max" }, status.kind);
    }

    // And back: the native process is the one that reports the subscription.
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null })).status, "applied");
    h.world.adapters[2]!.emitAuthStatus({ kind: "account", label: "Claude Pro", plan: "pro" });
    await eventually(async () => (await claudeReport()).settings?.accountLabel === "Claude Pro");
    h.world.adapters[2]!.emitAuthStatus({ kind: "none", label: "Not logged in" });
    await eventually(async () => (await claudeReport()).settings?.status === "not_logged_in", );
    h.world.adapters[2]!.emitAuthStatus({ kind: "account", label: "Claude Max", plan: "max" });
    await eventually(async () => (await claudeReport()).settings?.accountLabel === "Claude Max");
  });

  it("shows no account label rather than a throwaway-derived one when only a routed process has started since Guild opened [D-062]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    await h.send(taskId, "routed first");
    await h.completed();
    await h.idle();
    const restarted = await h.restart();
    await h.service.openTask(taskId);
    await eventually(() => restarted.adapters.length === 1 && restarted.adapters[0]!.session !== undefined);
    assertRoutedEnvironment(restarted.inputs[0]!.extraEnvironment, "deepseek-v4-flash");
    restarted.adapters[0]!.emitAuthStatus({ kind: "api_key", label: "Anthropic API key" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const report = (await h.service.bootstrap()).runtimeSettings.claude;
    assert.equal(report?.accountLabel, undefined, "unknown, not a label from the throwaway token");
    assert.notEqual(report?.status, "not_logged_in");
  });

  it("keeps the native Claude model list when a routed process reports its degraded one, in the picker and in the cache [PC-MODEL-001, D-064]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router }, {
      claude: { routedNativeList: { models: ["default", "opus"], defaultDescription: "Opus" } },
    });
    const nativeRows = async () => (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.models
      .filter((model) => model.group === "claude")
      .map((model) => [model.id, model.description]);
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "native");
    await h.completed();
    await h.idle();
    const full = await nativeRows();
    assert.deepEqual(full.map(([id]) => id), [...NATIVE_MODELS]);
    assert.deepEqual(full[0], ["default", "Opus 5.5"]);

    // The routed process lists a poorer set of Claude's models; none of it reaches the picker.
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "routed");
    await h.completed(2);
    await h.idle();
    const routed = h.world.adapters[1]!;
    assert.deepEqual(routed.modelValues(), ["default", "opus", "deepseek-v4-flash"], "the routed process really lists the degraded set");
    assert.deepEqual(await nativeRows(), full);
    // Nor does it reach the persisted list: a Guild that starts again shows the native one.
    await h.restart({ modelRouterHost: undefined });
    assert.deepEqual(await nativeRows(), full);

    // The native process is the one that updates it, also after the routed one.
    await h.restart({ modelRouterHost: router });
    await h.service.openTask(taskId);
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "sonnet", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "native again");
    await h.completed(3);
    assert.deepEqual(await nativeRows(), full);
  });

  it("leaves the native Claude list empty when only a routed process has reported since Guild opened, and takes the native one when it comes [PC-MODEL-001, D-064]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router }, {
      claude: { routedNativeList: { models: ["default", "opus"], defaultDescription: "Opus" } },
    });
    const claudeIds = async () => (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.models.map((model) => model.id);
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null });
    await h.send(taskId, "routed first");
    await h.completed();
    await h.idle();
    assert.deepEqual(h.world.adapters[0]!.modelValues(), ["default", "opus", "deepseek-v4-flash"]);
    assert.deepEqual(await claudeIds(), ["deepseek-v4-flash"], "the routed list is not Claude's own list");
    await h.restart({ modelRouterHost: undefined });
    assert.deepEqual(await claudeIds(), [], "and nothing of it was cached");

    await h.restart({ modelRouterHost: router });
    await h.service.openTask(taskId);
    await h.service.setTaskRuntimeSettings({ taskId, model: "opus", reasoningEffort: null, contextWindow: null });
    await h.send(taskId, "native");
    await h.completed(2);
    assert.deepEqual(await claudeIds(), [...NATIVE_MODELS, "deepseek-v4-flash"]);
  });

  it("maps Steer to the Claude steering request and queues what it cannot inject [docs/20 3.8]", async () => {
    // injected
    const injected = await harness();
    const task = await injected.service.createTask(injected.workspaceId, undefined, "claude");
    await injected.send(task.task.taskId, "hold");
    await runningTurn(injected);
    assert.deepEqual((await injected.service.bootstrap()).activeTask?.steer, { available: true });
    const steered = await injected.service.steerMessage(task.task.taskId, "also this");
    assert.equal(steered.status, "steered");
    assert.deepEqual(injected.world.adapters[0]!.steers, ["also this"]);
    assert.equal(injected.world.adapters[0]!.extensionCalls, 0, "no _x.ai request is ever sent to Claude");
    injected.world.adapters[0]!.release();
    await injected.completed();

    // promptRequired: the turn had already ended, the text was not sent, so it goes the ordinary way.
    const missed = await harness({}, { claude: { steerResult: { status: "ok", outcome: "promptRequired" } } });
    const missedTask = await missed.service.createTask(missed.workspaceId, undefined, "claude");
    await missed.send(missedTask.task.taskId, "hold");
    await runningTurn(missed);
    const fallback = await missed.service.steerMessage(missedTask.task.taskId, "late idea");
    assert.equal(fallback.status, "queued");
    assert.equal(fallback.status === "queued" ? fallback.reason : "", "turn_not_running");
    missed.world.adapters[0]!.release();
    await eventually(() => missed.world.adapters[0]!.prompts.includes("late idea"));

    // unsupported: Steer is withdrawn for this process.
    const unsupported = await harness({}, { claude: { steerResult: { status: "unsupported", reason: "not_found" } } });
    const unsupportedTask = await unsupported.service.createTask(unsupported.workspaceId, undefined, "claude");
    await unsupported.send(unsupportedTask.task.taskId, "hold");
    await runningTurn(unsupported);
    const refused = await unsupported.service.steerMessage(unsupportedTask.task.taskId, "nope");
    assert.equal(refused.status, "queued");
    assert.equal(refused.status === "queued" ? refused.reason : "", "unsupported");
    assert.deepEqual((await unsupported.service.bootstrap()).activeTask?.steer, { available: false, reason: "unsupported" });
    const explanation = (await unsupported.service.openTask(unsupportedTask.task.taskId)).timeline
      .find((item) => item.kind === "notice");
    assert.ok(explanation?.kind === "notice" && explanation.text.includes("Claude") && !explanation.text.includes("Grok"),
      "the fallback notice names the engine the task runs on");

    // Not advertised at initialize: not offered, and no request is made.
    const silent = await harness({}, { claude: { steering: false } });
    const silentTask = await silent.service.createTask(silent.workspaceId, undefined, "claude");
    await silent.send(silentTask.task.taskId, "hold");
    await runningTurn(silent);
    assert.deepEqual((await silent.service.bootstrap()).activeTask?.steer, { available: false, reason: "unsupported" });
    const queued = await silent.service.steerMessage(silentTask.task.taskId, "x");
    assert.equal(queued.status, "queued");
    assert.deepEqual(silent.world.adapters[0]!.steers, []);
  });

  it("names the login state instead of failing blind [PC-ENG-002]", async () => {
    // The adapter reports no login at session/new.
    const h = await harness({}, { claude: { advertiseAuthMethod: true, authRequiredOnNewSession: true } });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await assert.rejects(h.send(task.task.taskId, "hi"), /^Error: claude_login_required$/u);
    assert.equal(h.world.adapters[0]!.authenticateCalls, 0, "Guild never authenticates for Claude");
    const reduced = await h.service.openTask(task.task.taskId);
    assert.equal(reduced.engineStatus?.loginRequired, true);
    assert.equal(reduced.canSend, true, "the task stays usable once the user has logged in");

    // The engine's own account notice clears it, and a later "none" brings it back.
    const loggedIn = await harness();
    const second = await loggedIn.service.createTask(loggedIn.workspaceId, undefined, "claude");
    await loggedIn.send(second.task.taskId, "x");
    await loggedIn.completed();
    const adapter = loggedIn.world.adapters[0]!;
    adapter.emitAuthStatus({ kind: "none" });
    assert.equal((await eventuallyValue(async () => {
      const current = (await loggedIn.service.bootstrap()).activeTask;
      return current?.engineStatus?.loginRequired === true ? current : undefined;
    })).engineStatus?.accountLabel, undefined);
    adapter.emitAuthStatus({ kind: "account", label: "Claude Pro" });
    await eventually(async () => (await loggedIn.service.bootstrap()).activeTask?.engineStatus?.accountLabel === "Claude Pro");

    // A login that expires mid-session surfaces as the same named state in the timeline.
    const expiring = await harness({}, { claude: { authRequiredOnPrompt: true } });
    const third = await expiring.service.createTask(expiring.workspaceId, undefined, "claude");
    await expiring.send(third.task.taskId, "login-expired");
    await eventually(async () => {
      const view = (await expiring.service.bootstrap()).activeTask;
      return view?.timeline.some((item) => item.kind === "error" && item.text.includes("`claude`")) === true;
    });
    assert.equal((await expiring.service.bootstrap()).activeTask?.engineStatus?.loginRequired, true);
  });

  it("keeps a resumable session when a lapsed login makes the resume fail [PC-ENG-002]", async () => {
    const spec: EngineSpec = { authRequiredOnResume: 1 };
    lapsedResumes.set(spec, 1);
    const h = await harness({}, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "first");
    await h.completed();
    await h.world.adapters[0]!.emitTransportInterrupted();
    // The automatic recovery meets the lapsed login and reports it by name.
    await eventually(async () => (await h.service.bootstrap()).activeTask?.engineStatus?.loginRequired === true);
    const lapsed = (await h.service.bootstrap()).activeTask!;
    assert.equal(lapsed.sessionRecovery, "available", "the session is not declared lost");
    assert.equal(lapsed.canSend, true);

    // After the user logged in the same session resumes.
    await h.send(task.task.taskId, "second");
    await h.completed(2);
    const resumes = h.world.adapters.flatMap((adapter) => adapter.startCalls).filter((call) => call.kind === "resume");
    assert.equal(resumes.length, 2);
    assert.equal(new Set(resumes.map((call) => call.sessionId)).size, 1, "the same session both times");
    assert.equal(h.world.adapters.at(-1)!.prompts.at(-1), "second");
    assert.equal(
      (await h.service.bootstrap()).activeTask!.timeline.some((item) => item.kind === "notice"),
      false,
      "no replacement session, no recovery capsule",
    );
  });

  it("keeps the session when a Claude resume times out or loses its process, names the state, and the next send resumes it [PC-ENG-002]", async () => {
    const spec: EngineSpec = { loadSession: true };
    // The automatic recovery loses its process before an answer; the send then runs into a timeout.
    resumeFailureCodes.set(spec, ["transport_lost", "request_timeout"]);
    const h = await harness({}, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "first");
    await h.completed();
    // Another task is the active one, so the only starts are the recovery and the sends (no background prewarm).
    await h.service.createTask(h.workspaceId, undefined, "claude");
    const resumes = () => h.world.adapters.flatMap((adapter) => adapter.startCalls).filter((call) => call.kind === "resume");
    await h.world.adapters[0]!.emitTransportInterrupted();
    await recoveryFailures(h, 1);
    assert.equal(resumes().length, 1);

    const timedOut = await h.send(taskId, "second").then(() => undefined, (cause: unknown) => cause);
    assert.match(String(timedOut), /^Error: claude_start_timeout$/u);
    assert.equal(toDesktopIpcFailure(timedOut).message, "claude_start_timeout", "the code survives the IPC allowlist");
    const retained = await h.service.openTask(taskId);
    assert.equal(retained.sessionRecovery, "available", "a lost process or a timeout never asks for a replacement session");
    assert.equal(retained.canSend, true);
    assert.equal(retained.timeline.some((item) => item.kind === "user" && item.text === "second"), false, "nothing was sent");
    assert.equal(h.world.adapters.flatMap((adapter) => adapter.startCalls).some((call) => call.kind === "load"), false,
      "no session/load is started after a resume that got no answer");

    // The next send retries the resume of the same session and runs.
    await h.send(taskId, "third");
    await h.completed(2);
    assert.ok(resumes().length >= 3);
    assert.equal(new Set(resumes().map((call) => call.sessionId)).size, 1, "the same session every time");
    assert.equal(h.world.adapters.at(-1)!.prompts.at(-1), "third");
    const finished = await h.service.openTask(taskId);
    assert.equal(finished.sessionRecovery, "available");
    assert.equal(finished.timeline.some((item) => item.kind === "notice"), false, "no replacement session, no recovery capsule");
  });

  it("declares a Claude session lost only when the agent answers that it has no such session [PC-ENG-002]", async () => {
    const spec: EngineSpec = { loadSession: true };
    resumeFailureCodes.set(spec, ["session_not_found"]);
    const h = await harness({}, { claude: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "first");
    await h.completed();
    await h.world.adapters[0]!.emitTransportInterrupted();
    await eventually(async () => (await h.service.bootstrap()).activeTask?.sessionRecovery === "replacement_required");
    const calls = h.world.adapters.flatMap((adapter) => adapter.startCalls);
    assert.deepEqual(calls.map((call) => call.kind), ["new", "resume"], "no second window is spent on session/load");
    await assert.rejects(h.send(taskId, "second"), /session_replacement_requires_user_authorization/u);

    // Any other failure of the resume is not an answer about the session: it stays and is retried.
    const other: EngineSpec = {};
    resumeFailureCodes.set(other, ["operation_failed", "operation_failed"]);
    const o = await harness({}, { claude: other });
    const kept = await o.service.createTask(o.workspaceId, undefined, "claude");
    await o.send(kept.task.taskId, "first");
    await o.completed();
    await o.service.createTask(o.workspaceId, undefined, "claude");
    await o.world.adapters[0]!.emitTransportInterrupted();
    await recoveryFailures(o, 1);
    const failed = await o.send(kept.task.taskId, "second").then(() => undefined, (cause: unknown) => cause);
    assert.match(String(failed), /runtime_start_session_resume/u, "a plain failure stays a plain failure, not the start timeout");
    assert.equal((await o.service.openTask(kept.task.taskId)).sessionRecovery, "available");
    await o.send(kept.task.taskId, "third");
    await o.completed(2);
    assert.equal(o.world.adapters.at(-1)!.prompts.at(-1), "third");
  });

  it("names a Claude start that got no answer at initialize, and leaves a process that cannot start a plain failure [PC-ENG-002]", async () => {
    const slow = await harness({}, { claude: { initializeFailure: "request_timeout" } });
    const task = await slow.service.createTask(slow.workspaceId, undefined, "claude");
    const timedOut = await slow.send(task.task.taskId, "hi").then(() => undefined, (cause: unknown) => cause);
    assert.match(String(timedOut), /^Error: claude_start_timeout$/u);
    assert.equal((await slow.service.openTask(task.task.taskId)).sessionRecovery, "available");

    const dead = await harness({}, { claude: { initializeFailure: "transport_lost" } });
    const second = await dead.service.createTask(dead.workspaceId, undefined, "claude");
    const failed = await dead.send(second.task.taskId, "hi").then(() => undefined, (cause: unknown) => cause);
    assert.match(String(failed), /runtime_start_initialize/u);
    assert.doesNotMatch(String(failed), /claude_start_timeout/u);
  });

  it("keeps declaring a Grok session lost when its resume gets no answer [PC-ENG-001]", async () => {
    const spec: EngineSpec = {};
    resumeFailureCodes.set(spec, ["request_timeout"]);
    const h = await harness({}, { grok: spec });
    const task = await h.service.createTask(h.workspaceId);
    await h.send(task.task.taskId, "first");
    await h.completed();
    await h.world.adapters[0]!.emitTransportInterrupted();
    await eventually(async () => (await h.service.bootstrap()).activeTask?.sessionRecovery === "replacement_required");
  });

  it("reports whether Claude Code can run, which account it is and which version, never an address [PC-ENG-002]", async () => {
    const ready = await harness({ claudeEngineProbe: async () => ({ version: "2.1.291" }) });
    const readySettings = await eventuallyValue(async () => {
      const claude = (await ready.service.bootstrap()).runtimeSettings.claude;
      return claude?.status === "ready" ? claude : undefined;
    });
    assert.equal(readySettings.version, "2.1.291");
    assert.equal(readySettings.accountLabel, undefined, "no login seen yet");
    const task = await ready.service.createTask(ready.workspaceId, undefined, "claude");
    await ready.send(task.task.taskId, "x");
    await ready.completed();
    ready.world.adapters[0]!.emitAuthStatus({ kind: "account", label: "Claude Max", plan: "max" });
    await eventually(async () => (await ready.service.bootstrap()).runtimeSettings.claude?.accountLabel === "Claude Max");
    // A login the engine reports as gone beats "ready" and drops the label.
    ready.world.adapters[0]!.emitAuthStatus({ kind: "none" });
    const loggedOut = await eventuallyValue(async () => {
      const claude = (await ready.service.bootstrap()).runtimeSettings.claude;
      return claude?.status === "not_logged_in" ? claude : undefined;
    });
    assert.equal(loggedOut.accountLabel, undefined);
    assert.equal(loggedOut.version, "2.1.291");

    const missing = await harness({
      claudeEngineProbe: async () => { throw new ClaudeLocatorError("adapter_missing"); },
    });
    await eventually(async () => (await missing.service.bootstrap()).runtimeSettings.claude?.status === "not_found");
    const broken = await harness({ claudeEngineProbe: async () => { throw new Error("EACCES"); } });
    await eventually(async () => (await broken.service.bootstrap()).runtimeSettings.claude?.status === "unavailable");
    // Pinned files that changed without an update are not a missing install: the periodic probe says so by name.
    for (const component of ["node", "adapter", "claude"] as const) {
      const changed = await harness({
        claudeEngineProbe: async () => { throw new ClaudeEngineIntegrityError(component); },
      });
      await eventually(async () => (await changed.service.bootstrap()).runtimeSettings.claude?.status === "integrity_changed");
    }

    // Without a probe the status is learned from the engine: a missing piece at start, a session that runs.
    const failing = await harness({
      runtimeFactory: async () => { throw new ClaudeLocatorError("claude_missing"); },
    });
    assert.equal((await failing.service.bootstrap()).runtimeSettings.claude?.status, undefined, "nothing known yet");
    const failingTask = await failing.service.createTask(failing.workspaceId, undefined, "claude");
    await assert.rejects(failing.send(failingTask.task.taskId, "x"), /runtime_start_runtime_factory/u);
    assert.equal((await failing.service.bootstrap()).runtimeSettings.claude?.status, "not_found");
    const learned = await harness();
    const learnedTask = await learned.service.createTask(learned.workspaceId, undefined, "claude");
    await learned.send(learnedTask.task.taskId, "x");
    await learned.completed();
    const learnedSettings = (await learned.service.bootstrap()).runtimeSettings.claude;
    assert.equal(learnedSettings?.status, "ready");
    assert.equal(learnedSettings?.version, "2.1.291");
  });

  it("refuses a Claude start whose pinned files changed, names the reduced state and the IPC code, then recovers [PC-ENG-002]", async () => {
    const world = newWorld();
    const base = engineFactory(world, {});
    let refuse = true;
    const h = await harness({
      runtimeFactory: async (input) => {
        const created = await base(input);
        if (input.engine !== "claude" || !refuse) return created;
        // The real process port fails its start and remembers why; the adapter reports it as a plain failure.
        (created.adapter as EngineFake).start = async () => { throw new AcpV1AdapterError("operation_failed"); };
        return { ...created, refusedForIntegrity: () => true };
      },
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const refused = await h.send(task.task.taskId, "x").then(() => undefined, (cause: unknown) => cause);
    assert.match(String(refused), /^Error: engine_integrity_changed$/u);
    assert.equal(toDesktopIpcFailure(refused).message, "engine_integrity_changed", "the code survives the IPC allowlist");
    assert.equal((await h.service.bootstrap()).runtimeSettings.claude?.status, "integrity_changed");
    assert.equal(world.adapters[0]!.prompts.length, 0, "nothing was run");

    // Once the files pin again and a session opens, the reduced state is gone.
    refuse = false;
    await h.send(task.task.taskId, "again");
    await h.completed();
    assert.equal((await h.service.bootstrap()).runtimeSettings.claude?.status, "ready");
  });

  it("shows the permission mode of a Claude session as its session mode [PC-SET-002]", async () => {
    const h = await harness();
    await h.service.setClaudeSettings(null, null, "plan");
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    assert.equal((await h.service.bootstrap()).activeTask?.sessionModes, null, "no session yet");
    await h.send(task.task.taskId, "x");
    await h.completed();
    await h.idle();
    const view = (await h.service.bootstrap()).activeTask!;
    assert.equal(view.sessionModes?.currentModeId, "plan");
    assert.deepEqual(
      view.sessionModes?.availableModes.map((mode) => mode.id),
      ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
    );
    // A later default reaches the idle session at its next turn and moves the shown mode with it.
    await h.service.setClaudeSettings(null, null, "acceptEdits");
    await h.send(task.task.taskId, "y");
    await h.completed(2);
    assert.equal((await h.service.bootstrap()).activeTask?.sessionModes?.currentModeId, "acceptEdits");
    // The mode is not a free choice of the generic option channel: the setting decides.
    await assert.rejects(h.service.setSessionConfigOption(task.task.taskId, "mode", "default"));
  });

  it("offers only the files half of a rewind to Claude and sends it no _x.ai request [docs/20 3.8]", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "x");
    await h.completed();
    const view = await h.service.openTask(task.task.taskId);
    const runId = view.timeline.find((item) => item.runId !== undefined)!.runId!;
    const preview = await h.service.previewRewind(task.task.taskId, runId);
    assert.deepEqual(preview, { status: "refused", reason: "conversation_rewind_unsupported" });
    assert.equal(h.world.adapters[0]!.extensionCalls, 0);
    const executed = await h.service.executeRewind({ taskId: task.task.taskId, runId, scope: "conversation_and_files" });
    assert.deepEqual(executed, { status: "refused", reason: "conversation_rewind_unsupported" });
    assert.equal(h.world.adapters[0]!.extensionCalls, 0);
  });

  it("keeps the Grok version label and the Grok list out of Claude sessions [PC-ENG-001]", async () => {
    const h = await harness();
    const grokTask = await h.service.createTask(h.workspaceId);
    await h.send(grokTask.task.taskId, "g");
    await h.completed();
    const grokVersion = (await h.service.bootstrap()).runtimeVersion;
    assert.equal(grokVersion, "Fake Grok 1.0");
    const claudeTask = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(claudeTask.task.taskId, "c");
    await h.completed();
    assert.equal((await h.service.bootstrap()).runtimeVersion, "Fake Grok 1.0");
  });

  it("forks a Claude task into a Claude task", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "x");
    await h.completed();
    const branch = await h.service.forkTask(task.task.taskId);
    assert.equal(branch.task.engine, "claude");
  });

  it("serves the engine fields from the fixture service", async () => {
    const fixture = createFixtureDesktopService();
    const projection = await fixture.bootstrap();
    assert.deepEqual(Object.keys(projection.runtimeSettings.modelCatalogs ?? {}).sort(), ["claude", "codex", "grok"]);
    assert.deepEqual(
      projection.runtimeSettings.modelCatalogs!.claude.models.map((model) => model.group),
      ["claude", "claude", "claude", "claude", "online", "local"],
    );
    assert.equal(projection.runtimeSettings.claude?.permissionMode, "default");
    assert.equal(projection.generalSettings.dockIcon, "dark");
    assert.equal((await fixture.setGeneralSettings(true, "ask", false, true, "light")).generalSettings.dockIcon, "light");
    const workspaceId = projection.workspaces[0]!.workspaceId;
    const created = await fixture.createTask(workspaceId, undefined, "claude");
    assert.equal(created.task.engine, "claude");
    assert.equal(created.engineStatus?.accountLabel, "Claude Max");
    assert.equal(created.modelSelection.modelId, "default");
    const grok = await fixture.setTaskEngine(created.task.taskId, "grok");
    assert.equal(grok.task.engine, "grok");
    assert.equal(grok.engineStatus, undefined);
    const settings = await fixture.setClaudeSettings("opus", null, "plan");
    assert.equal(settings.runtimeSettings.claude?.model, "opus");
    await fixture.sendMessage(created.task.taskId, "hi");
    await assert.rejects(fixture.setTaskEngine(created.task.taskId, "claude"), /task_engine_locked/u);

    // The Codex engine (PC-ENG-003): its own list, account label, defaults and permission modes.
    assert.deepEqual(projection.runtimeSettings.modelCatalogs!.codex.models.map((model) => model.group), ["codex", "codex"]);
    assert.equal(projection.runtimeSettings.engines?.codex?.permissionMode, "workspace-write");
    assert.equal(projection.runtimeSettings.engines?.codex?.status, "ready");
    const codexTask = await fixture.createTask(workspaceId, undefined, "codex");
    assert.equal(codexTask.task.engine, "codex");
    assert.equal(codexTask.engineStatus?.accountLabel, "ChatGPT Plus");
    assert.equal(codexTask.modelSelection.modelId, "gpt-6.1-sol", "the engine's own pick");
    const codexSettings = await fixture.setEngineSettings("codex", "gpt-5.6-luna", "low", "read-only");
    assert.deepEqual(
      [codexSettings.runtimeSettings.engines?.codex?.model, codexSettings.runtimeSettings.engines?.codex?.permissionMode],
      ["gpt-5.6-luna", "read-only"],
    );
    assert.equal((await fixture.openTask(codexTask.task.taskId)).modelSelection.modelId, "gpt-5.6-luna");
  });
});

// -------------------------------------------------------------------------------------------------
// Harness and fakes
// -------------------------------------------------------------------------------------------------

type EngineSpec = {
  readonly mcpHttp?: boolean;
  /** Claude: whether `initialize` advertises `_meta.steering`; default true. */
  readonly steering?: boolean;
  readonly steerResult?: AcpV1SteerResult;
  readonly advertiseAuthMethod?: boolean;
  readonly authRequiredOnNewSession?: boolean;
  readonly authRequiredOnPrompt?: boolean;
  /** The first N resumes answer "auth required": the login lapsed while Guild was closed. */
  readonly authRequiredOnResume?: number;
  readonly refuseMode?: boolean;
  /** `set_config_option model=<this>` is refused although the session lists it. */
  readonly refuseModel?: string;
  /** `initialize` advertises `loadSession`, the fallback of an adapter that does not advertise resume. */
  readonly loadSession?: boolean;
  /** `initialize` advertises `resumeSession`; default true. A Claude adapter without it falls back to `session/load`. */
  readonly resume?: boolean;
  /** `initialize` fails with this adapter error code (a start that got no answer in time, for example). */
  readonly initializeFailure?: AcpV1AdapterError["code"];
  /**
   * A resumed session comes back on the model of its last turn, as the real adapter reads it from the
   * transcript: an Online / Local id after routed turns, which a native model list does not offer.
   */
  readonly restoreTranscriptModel?: boolean;
  /** A resumed session comes back on this model whatever the transcript says (listed or not). */
  resumedModel?: string;
  /** A resume waits for this promise, so a test can hold a mode switch half way. */
  resumeGate?: Promise<void>;
  /** Claude: the Default row describes no model (the real adapter does, but a version of it may not). */
  readonly vagueDefault?: boolean;
  /**
   * Claude: what a routed process (one started with a modelPicker) lists as Claude's own models. It runs on an
   * API token, so the real list is a degraded one: fewer models and a Default row that only says "Opus".
   */
  readonly routedNativeList?: { readonly models: readonly string[]; readonly defaultDescription: string };
};

type World = {
  readonly log: string[];
  readonly adapters: EngineFake[];
  readonly inputs: Parameters<RuntimeFactory>[0][];
  onSpawn: ((input: Parameters<RuntimeFactory>[0]) => Promise<void>) | undefined;
  /** Called after a config option was applied on any adapter of the world. */
  onConfigOption: ((adapterLabel: string, configId: string, value: string | boolean) => Promise<void>) | undefined;
  /** Called as a prompt reaches any adapter of the world, before it is answered. */
  onPrompt: ((text: string) => void) | undefined;
};

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(
  givenOverrides: Partial<LiveDesktopServiceOptions> = {},
  specs: Partial<Record<GuildEngine, EngineSpec>> = {},
  /** Opens the store the service uses, for a test that must write to it directly. */
  openStore?: (path: string) => GuildPersistence,
) {
  const root = await mkdtemp(join(tmpdir(), "guild-engines-"));
  const workspace = join(root, "Workspace");
  await mkdir(workspace);
  let overrides: Partial<LiveDesktopServiceOptions> = openStore === undefined
    ? givenOverrides
    : { ...givenOverrides, persistence: openStore(join(root, "guild.sqlite3")) };
  let world = newWorld();
  bindRouter(overrides.modelRouterHost, world);
  const baseOptions = (): LiveDesktopServiceOptions => ({
    appVersion: "3.0.0-test",
    databasePath: join(root, "guild.sqlite3"),
    stagingRoot: join(root, "staging"),
    chooseWorkspace: async () => workspace,
    runtimeFactory: engineFactory(world, specs),
    ...overrides,
  });
  const state = { service: createLiveDesktopService(baseOptions()) };
  services.push(state.service);
  const initial = await state.service.chooseWorkspace();
  const workspaceId = initial.workspaces[0]!.workspaceId as WorkspaceId;
  const harnessValue = {
    root,
    workspaceId,
    get service() { return state.service; },
    get world() { return world; },
    send: (taskId: TaskId, text: string) => state.service.sendMessage(taskId, text),
    completed: (expectedAssistants = 1) => waitForCompleted(state.service, expectedAssistants),
    /** The turn has settled and the task takes a model change again. */
    idle: () => eventually(async () => (await state.service.bootstrap()).activeTask?.modelSelection.canChange === true),
    /** Closes the service and opens a new one on the same data, like quitting and starting Guild. */
    restart: async (changes: Partial<LiveDesktopServiceOptions> = {}) => {
      await state.service.close();
      services.splice(services.indexOf(state.service), 1);
      world = newWorld();
      bindRouter(changes.modelRouterHost ?? overrides.modelRouterHost, world);
      // The service closed the shared store with itself: a new one for the new process.
      if (openStore !== undefined) overrides = { ...overrides, persistence: openStore(join(root, "guild.sqlite3")) };
      state.service = createLiveDesktopService({ ...baseOptions(), ...changes, runtimeFactory: engineFactory(world, specs) });
      services.push(state.service);
      await state.service.bootstrap();
      return world;
    },
  };
  return harnessValue;
}

/** Router calls land in the world's ordered log, so the switch sequence can be asserted. */
function bindRouter(router: ModelRouterHostPort | undefined, world: World): void {
  if (router instanceof FakeRouterHost) router.shared = world.log;
}

function newWorld(): World {
  return { log: [], adapters: [], inputs: [], onSpawn: undefined, onConfigOption: undefined, onPrompt: undefined };
}

function engineFactory(world: World, specs: Partial<Record<GuildEngine, EngineSpec>>): RuntimeFactory {
  const counts: Record<GuildEngine, number> = { grok: 0, claude: 0, codex: 0 };
  return async (input) => {
    world.inputs.push(input);
    await world.onSpawn?.(input);
    counts[input.engine] += 1;
    world.log.push(`spawn:${input.engine}:${input.extraEnvironment?.["ANTHROPIC_BASE_URL"] === undefined ? "native" : "routed"}`);
    const adapter = new EngineFake(
      input.engine,
      input.adapterEpoch,
      input.sink,
      specs[input.engine] ?? {},
      world.log,
      `${input.engine}-${world.adapters.filter((candidate) => candidate.engine === input.engine).length + 1}`,
      world,
    );
    world.adapters.push(adapter);
    return {
      runtimeVersion: input.engine === "claude" ? "Claude Code 2.1.291" : input.engine === "codex" ? "Codex 0.160.1" : "Fake Grok 1.0",
      adapter,
    };
  };
}

class FakeRouterHost implements ModelRouterHostPort {
  models: readonly RoutedModelInfo[];
  failStart = false;
  /** Successful `ensureStarted` calls so far. */
  calls = 0;
  /** True while a held call waits for its gate. */
  waiting = false;
  private heldCall: { readonly at: number; readonly gate: Promise<void> } | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(models: readonly RoutedModelInfo[]) { this.models = models; }
  listRoutedModels(): readonly RoutedModelInfo[] { return this.models; }
  async ensureStarted(): Promise<{ readonly baseUrl: string }> {
    if (this.failStart) throw new Error(`cannot listen on ${ROUTER_URL}`);
    this.calls += 1;
    if (this.heldCall?.at === this.calls) {
      this.waiting = true;
      await this.heldCall.gate;
      this.waiting = false;
    }
    this.shared?.push("router.ensureStarted");
    return { baseUrl: ROUTER_URL };
  }
  /** The call with this number (counting from `calls`) waits until `open()`. */
  holdCall(at: number): { open(): void } {
    let open!: () => void;
    this.heldCall = { at, gate: new Promise<void>((resolve) => { open = resolve; }) };
    return { open };
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {}
  emitChange(): void { for (const listener of [...this.listeners]) listener(); }
  /** Set by the harness so router calls land in the world's ordered log. */
  shared: string[] | undefined;
}

class FakeBrowserMcp implements BrowserMcpPort {
  fail = false;
  async ensureStarted(): Promise<{ readonly url: string }> {
    if (this.fail) throw new Error("browser mcp unavailable");
    return { url: BROWSER_URL };
  }
}

class EngineFake implements RuntimeAdapterPort {
  state = "created";
  readonly startCalls: Array<{
    readonly kind: "new" | "resume" | "load";
    readonly sessionId?: string;
    readonly options: AcpV1SessionStartOptions | undefined;
  }> = [];
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  billingCalls = 0;
  extensionCalls = 0;
  authenticateCalls = 0;
  session: AcpV1AdapterSession | undefined;
  private options: readonly RuntimeConfigOption[] = [];
  private held: (() => void) | undefined;
  private releaseRequested = false;
  private promptSequence = 0;

  constructor(
    readonly engine: GuildEngine,
    private readonly adapterEpoch: number,
    private readonly sink: AcpV1AdapterSink,
    private readonly spec: EngineSpec,
    private readonly shared: string[],
    private readonly label: string,
    private readonly world: World,
  ) {}

  get features(): EngineFeatureFlags {
    const base = engineProfileFor(this.engine).features;
    return this.engine === "claude" ? { ...base, steer: this.spec.steering ?? true } : base;
  }

  private note(entry: string): void {
    this.log.push(entry);
    this.shared.push(`${this.label}.${entry}`);
  }

  readonly log: string[] = [];

  async start(): Promise<AcpV1InitializeResult> {
    if (this.spec.initializeFailure !== undefined) {
      this.state = "faulted";
      throw new AcpV1AdapterError(this.spec.initializeFailure);
    }
    this.state = "ready";
    return Object.freeze({
      protocolVersion: 1,
      agentCapabilities: Object.freeze({
        loadSession: this.spec.loadSession === true,
        resumeSession: this.spec.resume !== false,
        prompt: Object.freeze({ image: false, audio: false, embeddedContext: false }),
      }),
      authMethods: Object.freeze(this.spec.advertiseAuthMethod === true
        ? [{ id: `${this.engine}-login`, name: `Log in with ${this.engine}`, type: "terminal" as const }] as never
        : []),
      ...(this.spec.mcpHttp === true ? { mcpCapabilities: { http: true, sse: false } } : {}),
      ...(this.engine === "claude" ? { steering: { supported: this.spec.steering ?? true } } : {}),
    });
  }

  async authenticate(): Promise<void> {
    this.authenticateCalls += 1;
    if (this.engine !== "grok") throw new AcpV1AdapterError("unsupported_for_engine");
  }

  async officialBilling(): Promise<AcpV1OfficialBillingSnapshot> {
    this.billingCalls += 1;
    if (!this.features.billing) throw new AcpV1AdapterError("unsupported_for_engine");
    return Object.freeze({ creditUsagePercent: 3 });
  }

  async setModel(): Promise<void> {}

  async sendExtensionRequest(): Promise<XaiExtensionOutcome<JsonValue>> {
    this.extensionCalls += 1;
    return Object.freeze({ status: "unsupported" as const });
  }

  async steer(_session: AcpV1AdapterSession, text: string): Promise<AcpV1SteerResult> {
    this.steers.push(text);
    if (this.engine === "grok" || !this.features.steer) {
      return Object.freeze({ status: "unsupported" as const, reason: "engine" as const });
    }
    return this.spec.steerResult ?? Object.freeze({ status: "ok" as const, outcome: "injected" as const });
  }

  async setConfigOption(
    _session: AcpV1AdapterSession,
    configId: string,
    value: string | boolean,
  ): Promise<readonly RuntimeConfigOption[]> {
    const target = this.options.find((option) => option.id === configId);
    if (
      target?.type === "select" &&
      !(target.choices.form === "flat" ? target.choices.options : target.choices.groups.flatMap((group) => group.options))
        .some((choice) => choice.value === value)
    ) {
      throw new AcpV1ConfigOptionRefusedError("invalid_value", -32602);
    }
    if (configId === "model" && value === this.spec.refuseModel) {
      throw new AcpV1ConfigOptionRefusedError("invalid_value", -32602);
    }
    this.note(`config:${configId}=${String(value)}`);
    // The answer lists the value it was given: no option is `unlisted` after a set.
    this.options = Object.freeze(this.options.map((option) => {
      if (option.id !== configId) return option;
      const { unlisted: _unlisted, ...rest } = option as RuntimeConfigOption & { unlisted?: true };
      return Object.freeze({ ...rest, currentValue: value }) as RuntimeConfigOption;
    }));
    if (this.engine === "codex") this.options = codexOptions(this.options);
    await this.world.onConfigOption?.(this.label, configId, value);
    return this.options;
  }

  async setPermissionMode(_session: AcpV1AdapterSession, mode: string): Promise<readonly RuntimeConfigOption[]> {
    if (this.engine === "grok") throw new AcpV1AdapterError("unsupported_for_engine");
    if (this.spec.refuseMode === true) throw new AcpV1ConfigOptionRefusedError("invalid_value", -32602);
    this.note(`mode=${mode}`);
    this.options = Object.freeze(this.options.map((option) =>
      option.id === "mode" ? Object.freeze({ ...option, currentValue: mode }) as RuntimeConfigOption : option));
    return this.options;
  }

  async newSession(_cwd?: string, startOptions?: AcpV1SessionStartOptions): Promise<AcpV1AdapterSession> {
    this.note("new");
    this.startCalls.push({ kind: "new", options: startOptions });
    if (this.spec.authRequiredOnNewSession === true) throw new AcpV1AdapterError("auth_required");
    return this.open("new", `${this.engine}-session`, startOptions);
  }

  async resumeSession(sessionId: string, _cwd?: string, startOptions?: AcpV1SessionStartOptions): Promise<AcpV1AdapterSession> {
    this.note("resume");
    this.startCalls.push({ kind: "resume", sessionId, options: startOptions });
    await this.spec.resumeGate;
    if (lapsedResumes.get(this.spec) !== undefined && lapsedResumes.get(this.spec)! > 0) {
      lapsedResumes.set(this.spec, lapsedResumes.get(this.spec)! - 1);
      throw new AcpV1AdapterError("auth_required");
    }
    const failure = resumeFailureCodes.get(this.spec)?.shift();
    if (failure !== undefined) {
      // A process that died before it answered is no longer ready; a timeout or an answer leaves it ready.
      if (failure === "transport_lost") this.state = "faulted";
      throw new AcpV1AdapterError(failure);
    }
    return this.open("resume", sessionId, startOptions);
  }

  async loadSession(sessionId: string, _cwd?: string, startOptions?: AcpV1SessionStartOptions): Promise<AcpV1AdapterSession> {
    if (this.spec.loadSession !== true) throw new Error("load is not advertised");
    this.note("load");
    this.startCalls.push({ kind: "load", sessionId, options: startOptions });
    // The replay barrier is not needed by these tests: the session is established like a resume.
    return this.open("resume", sessionId, startOptions);
  }

  private async open(
    establishedBy: "new" | "resume",
    sessionId: string,
    startOptions: AcpV1SessionStartOptions | undefined,
  ): Promise<AcpV1AdapterSession> {
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId },
      establishedBy,
      state: {},
    });
    if (this.engine === "claude") {
      // The adapter lists whatever the session's modelPicker adds next to its own models.
      const picker = (startOptions?.claudeCodeOptions as
        { settings?: { modelPicker?: { options?: Array<{ model: string }> } } } | undefined)
        ?.settings?.modelPicker?.options?.map((entry) => entry.model) ?? [];
      const routedList = picker.length > 0 ? this.spec.routedNativeList : undefined;
      this.options = claudeOptions(
        [...(routedList?.models ?? NATIVE_MODELS), ...picker],
        this.options,
        this.spec.vagueDefault === true,
        routedList?.defaultDescription,
      );
      const lastModel = establishedBy !== "resume"
        ? undefined
        : this.spec.resumedModel ??
          (this.spec.restoreTranscriptModel === true ? transcriptModels.get(this.spec)?.get(sessionId) : undefined);
      if (lastModel !== undefined) {
        // Like the codec: a current value the list does not offer is accepted and marked `unlisted`.
        this.options = Object.freeze(this.options.map((option) => option.id === "model" && option.type === "select"
          ? Object.freeze({
              ...option,
              currentValue: lastModel,
              ...(optionOffersValue(option, lastModel) ? {} : { unlisted: true as const }),
            }) as RuntimeConfigOption
          : option));
      }
    } else if (this.engine === "codex") {
      // Like the real adapter: a new and a resumed session both come back on the user's own Codex configuration
      // (Auto review, the first model, its configured effort). A resume does not restore what Guild applied.
      this.options = codexOptions();
    } else {
      this.options = Object.freeze([]);
    }
    this.session = Object.freeze({
      adapterEpoch: this.adapterEpoch,
      sessionId,
      establishedBy,
      ...(this.engine === "claude" || this.engine === "codex" ? { configOptions: this.options } : {}),
      ...(this.engine === "codex" ? { modelCatalog: CODEX_START_CATALOG } : {}),
    });
    return this.session;
  }

  async prompt(session: AcpV1AdapterSession, text: string): Promise<RuntimePromptTerminalPayload> {
    this.prompts.push(text);
    this.world.onPrompt?.(text);
    this.note(`prompt:${text}`);
    const turnModel = sessionSelectionOf(this.options).modelId;
    if (turnModel !== undefined) {
      const byModel = transcriptModels.get(this.spec) ?? new Map<string, string>();
      byModel.set(session.sessionId, turnModel);
      transcriptModels.set(this.spec, byModel);
    }
    this.promptSequence += 1;
    const identity = { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId, promptSequence: this.promptSequence };
    await this.sink.commitPromptAccepted({ identity, write: writeReceipt() });
    if (this.spec.authRequiredOnPrompt === true && text === "login-expired") {
      throw new AcpV1AdapterError("auth_required");
    }
    if (text === "hold") {
      await this.sink.commitUpdate({
        identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
        ingestMode: "live",
        promptSequence: this.promptSequence,
        update: {
          type: "turn",
          payload: { type: "agent_thought_chunk", sessionId: session.sessionId, text: "thinking", received: received() },
        },
      });
      // A release that arrives before the turn started waiting is not lost.
      await new Promise<void>((resolve) => {
        if (this.releaseRequested) resolve();
        else this.held = resolve;
      });
      this.releaseRequested = false;
    }
    await this.sink.commitUpdate({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
      ingestMode: "live",
      promptSequence: this.promptSequence,
      update: {
        type: "turn",
        payload: { type: "agent_text_chunk", sessionId: session.sessionId, text: `reply:${text}`, received: received() },
      },
    });
    const terminal: RuntimePromptTerminalPayload = Object.freeze({
      type: "prompt_terminal",
      sessionId: session.sessionId,
      stopReason: "end_turn",
      classification: "completed",
      received: received(),
    });
    await this.sink.commitPromptTerminal({ identity, terminal });
    return terminal;
  }

  release(): void {
    this.releaseRequested = true;
    this.held?.();
    this.held = undefined;
  }

  async cancel(): Promise<JsonRpcWriteReceipt> {
    throw new Error("cancel is not used here");
  }

  async probeLiveness(): Promise<boolean> {
    return this.state === "ready";
  }

  /** The values of the session's model option: what this process really lists. */
  modelValues(): string[] {
    const option = this.options.find((candidate) => candidate.id === "model");
    if (option === undefined || option.type !== "select") return [];
    return option.choices.form === "flat"
      ? option.choices.options.map((choice) => choice.value)
      : option.choices.groups.flatMap((group) => group.options.map((choice) => choice.value));
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.note("close");
    this.state = "faulted";
    this.release();
    if (this.session !== undefined) {
      await this.sink.commitTransportInterrupted({
        identity: { adapterEpoch: this.adapterEpoch, sessionId: this.session.sessionId },
        reason: "explicit_close",
      });
    }
    this.state = "closed";
  }

  async emitTransportInterrupted(): Promise<void> {
    if (this.session === undefined) throw new Error("no session");
    this.state = "faulted";
    await this.sink.commitTransportInterrupted({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.session.sessionId },
      reason: "process_fault",
    });
  }

  emitAuthStatus(status: { readonly kind: string; readonly label?: string; readonly plan?: string }): void {
    this.sink.observeEngineSignal?.({ type: "auth_status", engine: this.engine === "codex" ? "codex" : "claude", status });
  }

  async emitContextUsage(used: number, size: number): Promise<void> {
    if (this.session === undefined) throw new Error("no session");
    await this.sink.commitUpdate({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.session.sessionId },
      ingestMode: "live",
      update: {
        type: "session_context",
        payload: {
          type: "session_context",
          sessionId: this.session.sessionId,
          received: received(),
          context: { kind: "usage", scope: "session_context_window_and_cost", used, size },
        },
      },
    });
  }
}

function optionOffersValue(option: RuntimeConfigOption, value: string): boolean {
  if (option.type !== "select") return false;
  return (option.choices.form === "flat" ? option.choices.options : option.choices.groups.flatMap((group) => group.options))
    .some((choice) => choice.value === value);
}

/** The model of the last turn per session, per spec: what a resumed session reads back (`restoreTranscriptModel`). */
const transcriptModels = new WeakMap<EngineSpec, Map<string, string>>();
/** Remaining lapsed resumes per spec, shared by every adapter the factory builds from it. */
const lapsedResumes = new WeakMap<EngineSpec, number>();
/** The error codes the next resumes of a spec fail with, in order (consumed one per resume). */
const resumeFailureCodes = new WeakMap<EngineSpec, AcpV1AdapterError["code"][]>();

function claudeOptions(
  models: readonly string[],
  previous: readonly RuntimeConfigOption[],
  vagueDefault = false,
  defaultDescription = "Opus 5.5",
): readonly RuntimeConfigOption[] {
  const current = (id: string, fallback: string): string => {
    const option = previous.find((candidate) => candidate.id === id);
    return option?.type === "select" ? option.currentValue : fallback;
  };
  const flat = (values: readonly string[]) => ({
    form: "flat" as const,
    // The adapter's Default row says which model it stands for, like the real adapter does.
    options: values.map((value) => ({ value, name: value, ...(value === "default" && !vagueDefault ? { description: defaultDescription } : {}) })),
  });
  return Object.freeze([
    {
      id: "mode", name: "Mode", category: "mode", type: "select", currentValue: current("mode", "default"),
      choices: flat(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]),
    },
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: current("model", "default"),
      choices: flat(models),
    },
    {
      id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: current("effort", "medium"),
      choices: flat(["low", "medium", "high"]),
    },
  ]) as readonly RuntimeConfigOption[];
}

/** What a Codex session lists when it starts: the user's own configuration, as the real adapter reports it. */
const CODEX_MODELS = [
  { id: "gpt-6.1-sol", name: "6.1 Sol", description: "Latest workhorse model for coding and everyday work.", efforts: ["low", "medium", "high", "ultra"] },
  { id: "gpt-6-luna", name: "6 Luna", description: "Fast and affordable model for easier tasks.", efforts: ["low", "medium"] },
] as const;

function codexOptions(
  previous: readonly RuntimeConfigOption[] = [],
  current: { readonly mode?: string; readonly model?: string; readonly effort?: string } = {},
): readonly RuntimeConfigOption[] {
  const value = (id: string, fallback: string): string => {
    const option = previous.find((candidate) => candidate.id === id);
    return option?.type === "select" ? option.currentValue : fallback;
  };
  const flat = (values: ReadonlyArray<{ value: string; name: string; description?: string }>) => ({ form: "flat" as const, options: values });
  // Like the real adapter, the effort option lists the efforts of the selected model only.
  const model = current.model ?? value("model", "gpt-6.1-sol");
  const offeredEfforts: readonly string[] = (CODEX_MODELS.find((candidate) => candidate.id === model) ?? CODEX_MODELS[0]).efforts;
  const wantedEffort = current.effort ?? value("reasoning_effort", "high");
  return Object.freeze([
    {
      id: "mode", name: "Mode", category: "mode", type: "select", currentValue: current.mode ?? value("mode", "agent"),
      choices: flat([
        { value: "read-only", name: "Read-only" },
        { value: "workspace-write", name: "Workspace access" },
        { value: "agent", name: "Auto review" },
        { value: "agent-full-access", name: "Full access" },
      ]),
    },
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: model,
      choices: flat(CODEX_MODELS.map((model) => ({ value: model.id, name: model.name, description: model.description }))),
    },
    {
      id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
      currentValue: offeredEfforts.includes(wantedEffort) ? wantedEffort : offeredEfforts.includes("medium") ? "medium" : offeredEfforts[0]!,
      choices: flat(offeredEfforts.map((effort) => ({ value: effort, name: effort }))),
    },
  ]) as readonly RuntimeConfigOption[];
}

/** The efforts of every model, listed once when a Codex session starts (the adapter's legacy `models` list). */
const CODEX_START_CATALOG = freezeModelCatalog("codex", {
  engine: "codex",
  runtimeDefaultModelId: "gpt-6.1-sol",
  models: CODEX_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    group: "codex",
    reasoningEfforts: model.efforts.map((id) => ({ id, label: id, isDefault: id === "high" })),
    contextWindows: [],
  })),
});

/** The automatic recovery after an interruption has failed this many times, as its diagnostic record says. */
async function recoveryFailures(h: Harness, count: number): Promise<void> {
  await eventually(async () => {
    const log = await readFile(join(h.root, "diagnostics", "runtime.jsonl"), "utf8").catch(() => "");
    return log.split("\n").filter((line) => line.includes("\"category\":\"recovery\"") && line.includes("\"event\":\"failed\"")).length >= count;
  });
}

async function runningTurn(h: Harness): Promise<TaskViewProjection> {
  return eventuallyValue(async () => {
    const view = (await h.service.bootstrap()).activeTask;
    return view?.task.activeRunState === "running" ? view : undefined;
  });
}

async function waitForCompleted(
  service: ReturnType<typeof createLiveDesktopService>,
  expectedAssistantCount: number,
): Promise<DesktopBootstrapProjection> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const projection = await service.bootstrap();
    const assistants = projection.activeTask?.timeline.filter((item) => item.kind === "assistant").length ?? 0;
    if (projection.activeTask?.task.activeRunState === "completed" && assistants === expectedAssistantCount) {
      return projection;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("the run did not complete");
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition not reached");
}

async function eventuallyValue<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("value not reached");
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

describe("which model answered each turn [PC-CONV-001, PC-MODEL-001]", () => {
  const labels = async (h: Awaited<ReturnType<typeof harness>>, taskId: TaskId): Promise<Array<[string, string | undefined]>> => {
    const view = await h.service.openTask(taskId);
    const byRun = new Map((view.runModels ?? []).map((entry) => [entry.runId, entry.label]));
    const runs = [...new Set(view.timeline.filter((item) => item.kind === "user").map((item) => item.runId!))];
    return runs.map((runId, index) => [`turn ${index + 1}`, byRun.get(runId)]);
  };

  it("names the model each Run started on, the routed model's own name, and keeps it across a restart", async () => {
    const router = new FakeRouterHost([DEEPSEEK, LOCAL_MODEL]);
    let store!: GuildPersistence;
    const h = await harness({ modelRouterHost: router }, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    // The label is written before the prompt reaches the engine, so a turn that dies at once still has its model.
    const labelsAtPrompt: number[] = [];
    h.world.onPrompt = () => { labelsAtPrompt.push(store.listRunModelLabels(taskId).length); };

    // The Default row stands for the model the adapter says (here its description), so that is the name.
    await h.send(taskId, "first");
    await h.completed();
    await h.idle();
    assert.deepEqual(await labels(h, taskId), [["turn 1", "Opus 5.5"]]);

    // A pinned Claude model is named as the picker names it; the selection of that turn, not the next one.
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "sonnet", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "second");
    await h.completed(2);
    await h.idle();
    assert.deepEqual(await labels(h, taskId), [["turn 1", "Opus 5.5"], ["turn 2", "sonnet"]]);

    // A routed model is named by the model's own name; its source's label is only the picker's description of it.
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "third");
    await h.completed(3);
    await h.idle();
    const expected: Array<[string, string | undefined]> = [["turn 1", "Opus 5.5"], ["turn 2", "sonnet"], ["turn 3", "DeepSeek V4 Flash"]];
    assert.deepEqual(await labels(h, taskId), expected);
    assert.deepEqual(labelsAtPrompt, [1, 2, 3], "each turn's label existed when its prompt went out");

    // The record is persistent data, not session state: it is there after quitting and starting again.
    await h.restart({ modelRouterHost: router });
    assert.deepEqual(await labels(h, taskId), expected);
  });

  it("leaves a Run unlabeled when the Default row does not say which model it stands for, and never blocks the turn", async () => {
    const h = await harness({}, { claude: { vagueDefault: true } });
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
    await h.send(taskId, "first");
    await h.completed();
    await h.idle();
    assert.deepEqual(h.world.adapters[0]!.prompts, ["first"], "the turn went out without a label");
    assert.deepEqual(await labels(h, taskId), [["turn 1", undefined]]);
    // A pinned model is named again, and the older Run stays as it was.
    await h.service.setTaskRuntimeSettings({ taskId, model: "haiku", reasoningEffort: null, contextWindow: null });
    await h.send(taskId, "second");
    await h.completed(2);
    assert.deepEqual(await labels(h, taskId), [["turn 1", undefined], ["turn 2", "haiku"]]);
  });
});

describe("Codex engine orchestration [PC-ENG-003]", () => {
  const codexSettings = async (h: Harness) => (await h.service.bootstrap()).runtimeSettings.engines?.codex;
  const sessionLog = (h: Harness, index = 0) => h.world.adapters[index]!.log;

  it("creates Codex tasks, fixes the engine at the first turn and keeps it across a restart [PC-ENG-003]", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    assert.equal(task.task.engine, "codex");
    // Before the first turn the picker's choice is still the engine.
    assert.equal((await h.service.setTaskEngine(task.task.taskId, "grok")).task.engine, "grok");
    assert.equal((await h.service.setTaskEngine(task.task.taskId, "codex")).task.engine, "codex");

    await h.send(task.task.taskId, "hello");
    await h.completed();
    const sidebar = (await h.service.bootstrap()).workspaces[0]!.tasks;
    assert.equal(sidebar.find((entry) => entry.taskId === task.task.taskId)?.engine, "codex");
    await assert.rejects(h.service.setTaskEngine(task.task.taskId, "claude"), /task_engine_locked/u);
    await assert.rejects(h.service.setTaskEngine(task.task.taskId, "grok"), /task_engine_locked/u);

    await h.restart();
    assert.equal((await h.service.openTask(task.task.taskId)).task.engine, "codex");
    // The restarted turn resumes the same session on a fresh Codex process.
    await h.send(task.task.taskId, "again");
    await h.completed(2);
    assert.deepEqual(h.world.adapters[0]!.startCalls.map((call) => call.kind), ["resume"]);
    assert.equal(h.world.inputs[0]!.engine, "codex");
  });

  it("starts the Codex process without per-spawn environment, router or authentication [PC-ENG-003, PC-OV-001]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router, claudeCaptureOff: true }, { codex: { advertiseAuthMethod: true } });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    // The OpenViking switches of the Codex plugin come from the engine profile's fixed environment, not from here.
    assert.equal(h.world.inputs[0]!.extraEnvironment, undefined);
    assert.equal(h.world.adapters[0]!.authenticateCalls, 0, "Guild never authenticates for Codex");
    assert.equal(router.calls, 0, "no model router for Codex");
    assert.equal(h.world.adapters[0]!.extensionCalls, 0, "no _x.ai request is ever sent to Codex");
    assert.equal(h.world.adapters[0]!.billingCalls, 0);
  });

  it("applies the permission mode, then model and effort, before the first prompt, and again after a resume [PC-ENG-003]", async () => {
    const h = await harness();
    // Nothing is known about Codex's models until a session reported them, so only the mode can be chosen first.
    await assert.rejects(h.service.setEngineSettings("codex", "gpt-6-luna", "low", "read-only"), /runtime_settings_change_unavailable/u);
    await h.service.setEngineSettings("codex", null, null, "read-only");
    const first = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(first.task.taskId, "one");
    await h.completed();
    await h.idle();
    assert.deepEqual(sessionLog(h).slice(0, 3), ["new", "mode=read-only", "prompt:one"], "no model is pinned: Codex keeps its own pick");

    // The first session listed the models, so a model and one of its efforts can be chosen.
    const saved = await h.service.setEngineSettings("codex", "gpt-6-luna", "low", "workspace-write");
    assert.deepEqual(
      [saved.runtimeSettings.engines?.codex?.model, saved.runtimeSettings.engines?.codex?.reasoningEffort, saved.runtimeSettings.engines?.codex?.permissionMode],
      ["gpt-6-luna", "low", "workspace-write"],
    );
    const second = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(second.task.taskId, "two");
    await h.completed();
    await h.idle();
    const adapter = h.world.adapters.at(-1)!;
    assert.deepEqual(adapter.log.slice(0, 5), ["new", "mode=workspace-write", "config:model=gpt-6-luna", "config:effort=low".replace("effort", "reasoning_effort"), "prompt:two"],
      "permission mode first, then model and effort, then the turn");

    // A resumed Codex session comes back on Codex's own configuration; Guild applies all three before the turn.
    await adapter.emitTransportInterrupted();
    await eventually(() => h.world.adapters.length >= 3 && h.world.adapters.at(-1)!.session !== undefined);
    await h.send(second.task.taskId, "three");
    await h.completed(2);
    const resumed = h.world.adapters.at(-1)!;
    assert.equal(resumed.startCalls[0]!.kind, "resume");
    const afterResume = resumed.log.slice(resumed.log.indexOf("resume"));
    assert.deepEqual(afterResume.slice(0, 4), ["resume", "mode=workspace-write", "config:model=gpt-6-luna", "config:reasoning_effort=low"]);
    assert.equal(afterResume.at(-1), "prompt:three");
    assert.equal((await h.service.bootstrap()).activeTask?.sessionModes?.currentModeId, "workspace-write");
  });

  it("starts a new session in the Guild default mode, never looser, and stops the start when the mode is refused [PC-ENG-003]", async () => {
    const h = await harness();
    assert.equal((await codexSettings(h))?.permissionMode, "workspace-write", "Guild's default");
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    // The fake session starts in Auto review; the default is stricter, so it is applied.
    assert.deepEqual(sessionLog(h).slice(0, 2), ["new", "mode=workspace-write"]);

    const refusing = await harness({}, { codex: { refuseMode: true } });
    const other = await refusing.service.createTask(refusing.workspaceId, undefined, "codex");
    await assert.rejects(refusing.send(other.task.taskId, "x"), /runtime_start_session_permission_mode/u);
    assert.equal(refusing.world.adapters[0]!.state, "closed", "the half-started process is closed");
    assert.deepEqual(refusing.world.adapters[0]!.prompts, []);
  });

  it("stores defaults only from the engine's own list and only Codex's own permission modes [PC-ENG-003, PC-SET-002]", async () => {
    const h = await harness();
    const before = await codexSettings(h);
    assert.deepEqual(before?.availablePermissionModes, ["read-only", "workspace-write", "agent", "agent-full-access"]);
    assert.equal(before?.model, null);
    assert.equal(before?.status, undefined, "nothing is known about the install yet");

    await assert.rejects(h.service.setEngineSettings("codex", null, null, "bypassPermissions"), /runtime_settings_change_unavailable/u);
    await assert.rejects(h.service.setEngineSettings("codex", null, "high", "workspace-write"), /runtime_settings_change_unavailable/u);
    await assert.rejects(h.service.setEngineSettings("claude" as never, null, null, "default"), /runtime_settings_change_unavailable/u);
    await assert.rejects(h.service.setEngineSettings("codex", "bad model!", null, "workspace-write"), /runtime_settings_change_unavailable/u);

    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    await h.idle();
    const ready = await codexSettings(h);
    assert.equal(ready?.status, "ready");
    assert.equal(ready?.version, "0.160.1");
    // A model its session did not list, or an effort that model does not offer, cannot be stored.
    await assert.rejects(h.service.setEngineSettings("codex", "gpt-9", null, "workspace-write"), /runtime_settings_change_unavailable/u);
    await assert.rejects(h.service.setEngineSettings("codex", "gpt-6-luna", "ultra", "workspace-write"), /runtime_settings_change_unavailable/u);
    const ok = await h.service.setEngineSettings("codex", "gpt-6.1-sol", "ultra", "agent");
    assert.equal(ok.runtimeSettings.engines?.codex?.reasoningEffort, "ultra");
    // The Claude and Grok defaults are untouched.
    assert.equal(ok.runtimeSettings.claude?.permissionMode, "default");
    // The same values again change nothing.
    assert.equal((await h.service.setEngineSettings("codex", "gpt-6.1-sol", "ultra", "agent")).runtimeSettings.engines?.codex?.permissionMode, "agent");
  });

  it("fills the Codex list from the session start with every model's efforts, keeps it out of the other lists and caches it [PC-MODEL-001, PC-ENG-003]", async () => {
    const h = await harness();
    const empty = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!;
    assert.deepEqual(empty.codex.models, []);
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    await h.idle();
    const catalogs = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!;
    assert.deepEqual(catalogs.codex.models.map((model) => model.id), ["gpt-6.1-sol", "gpt-6-luna"]);
    assert.deepEqual(catalogs.codex.models.map((model) => model.group), ["codex", "codex"]);
    assert.deepEqual(catalogs.codex.models[0]!.reasoningEfforts.map((effort) => effort.id), ["low", "medium", "high", "ultra"]);
    assert.deepEqual(catalogs.codex.models[1]!.reasoningEfforts.map((effort) => effort.id), ["low", "medium"]);
    assert.equal(catalogs.codex.runtimeDefaultModelId, "gpt-6.1-sol");
    // Codex's models never reach the Claude or Grok lists, and the reverse.
    assert.equal(catalogs.claude.models.some((model) => model.id.startsWith("gpt-")), false);
    assert.equal(catalogs.grok.models.some((model) => model.id.startsWith("gpt-")), false);

    // The list is cached for the next launch, so the picker has choices before a process runs.
    await h.restart();
    const after = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!;
    assert.deepEqual(after.codex.models.map((model) => model.id), ["gpt-6.1-sol", "gpt-6-luna"]);
    const opened = await h.service.openTask(task.task.taskId);
    assert.equal(opened.modelSelection.modelId, "gpt-6.1-sol");
    assert.equal(opened.modelSelection.source, "runtime");
  });

  it("stores a task's own model and effort, applies them between turns, and refuses what Codex did not list [PC-MODEL-001]", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    const taskId = task.task.taskId;
    await h.send(taskId, "one");
    await h.completed();
    await h.idle();
    const adapter = h.world.adapters[0]!;

    const saved = await h.service.setTaskRuntimeSettings({ taskId, model: "gpt-6-luna", reasoningEffort: "low", contextWindow: null });
    assert.equal(saved.status, "applied");
    assert.equal(saved.task.modelSelection.source, "task");
    assert.deepEqual([saved.task.modelSelection.modelId, saved.task.modelSelection.reasoningEffort], ["gpt-6-luna", "low"]);
    assert.ok(adapter.log.includes("config:model=gpt-6-luna"));

    // Not listed, an effort the model does not offer, a context window: refused, nothing stored.
    for (const request of [
      { model: "gpt-9", reasoningEffort: null, contextWindow: null },
      { model: "gpt-6-luna", reasoningEffort: "ultra", contextWindow: null },
      { model: "gpt-6-luna", reasoningEffort: null, contextWindow: 100_000 },
    ]) {
      const refused = await h.service.setTaskRuntimeSettings({ taskId, ...request });
      assert.equal(refused.status, "refused");
      assert.equal(refused.status === "refused" ? refused.reason : "", "unsupported_value");
    }
    assert.equal((await h.service.openTask(taskId)).modelSelection.modelId, "gpt-6-luna");

    // Clearing the override pins nothing: the live session keeps the model it runs and says so (the same rule as
    // Grok's), and a session that starts afterwards runs on Codex's own pick.
    const cleared = await h.service.setTaskRuntimeSettings({ taskId, model: null, reasoningEffort: null, contextWindow: null });
    assert.equal(cleared.status, "applied");
    assert.equal(cleared.task.modelSelection.source, "runtime");
    assert.equal(cleared.task.modelSelection.modelId, "gpt-6-luna", "what the session really runs");
    await h.restart();
    const resumed = await h.service.openTask(taskId);
    assert.equal(resumed.modelSelection.source, "runtime");
    assert.equal(resumed.modelSelection.modelId, "gpt-6.1-sol");
    await h.send(taskId, "two");
    await h.completed(2);
    const adapterAfter = h.world.adapters[0]!;
    assert.equal(adapterAfter.log.some((entry) => entry.startsWith("config:model=")), false, "nothing is pinned, so nothing is applied");
  });

  it("refuses the turn by name when the session cannot take the selected model, and keeps the session [PC-MODEL-001]", async () => {
    const h = await harness({}, { codex: { refuseModel: "gpt-6-luna" } });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    const taskId = task.task.taskId;
    await h.send(taskId, "one");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "gpt-6-luna", reasoningEffort: null, contextWindow: null })).status, "refused");
    assert.equal((await h.service.openTask(taskId)).modelSelection.source, "runtime", "nothing was stored");
  });

  it("names each Codex turn by the model it started on and keeps the label across a restart [PC-CONV-001]", async () => {
    let store!: GuildPersistence;
    const h = await harness({}, {}, (path) => {
      store = openGuildPersistence({ path });
      return store;
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    const taskId = task.task.taskId;
    const labelsAtPrompt: number[] = [];
    h.world.onPrompt = () => { labelsAtPrompt.push(store.listRunModelLabels(taskId).length); };
    await h.send(taskId, "first");
    await h.completed();
    await h.idle();
    assert.equal((await h.service.setTaskRuntimeSettings({ taskId, model: "gpt-6-luna", reasoningEffort: null, contextWindow: null })).status, "applied");
    await h.send(taskId, "second");
    await h.completed(2);
    await h.idle();
    const read = async () => {
      const view = await h.service.openTask(taskId);
      const runs = [...new Set(view.timeline.filter((item) => item.kind === "user").map((item) => item.runId!))];
      const byRun = new Map((view.runModels ?? []).map((entry) => [entry.runId, entry.label] as const));
      return runs.map((runId) => byRun.get(runId));
    };
    assert.deepEqual(await read(), ["6.1 Sol", "6 Luna"]);
    assert.deepEqual(labelsAtPrompt, [1, 2], "each turn's label existed when its prompt went out");
    await h.restart();
    assert.deepEqual(await read(), ["6.1 Sol", "6 Luna"]);
  });

  it("names the login state instead of failing blind, never authenticates and keeps the task usable [PC-ENG-003]", async () => {
    const h = await harness({}, { codex: { advertiseAuthMethod: true, authRequiredOnNewSession: true } });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await assert.rejects(h.send(task.task.taskId, "hi"), /^Error: engine_login_required$/u);
    assert.equal(h.world.adapters[0]!.authenticateCalls, 0);
    const reduced = await h.service.openTask(task.task.taskId);
    assert.equal(reduced.engineStatus?.loginRequired, true);
    assert.equal(reduced.canSend, true);
    assert.equal((await codexSettings(h))?.status, "not_logged_in");
    assert.equal(toDesktopIpcFailure(new Error("engine_login_required")).message, "engine_login_required", "the code survives the IPC allowlist");

    // The engine's own account notice clears it, and a later "none" brings it back.
    const loggedIn = await harness();
    const second = await loggedIn.service.createTask(loggedIn.workspaceId, undefined, "codex");
    await loggedIn.send(second.task.taskId, "x");
    await loggedIn.completed();
    const adapter = loggedIn.world.adapters[0]!;
    adapter.emitAuthStatus({ kind: "none" });
    await eventually(async () => (await loggedIn.service.bootstrap()).activeTask?.engineStatus?.loginRequired === true);
    adapter.emitAuthStatus({ kind: "account", label: "ChatGPT Plus" });
    await eventually(async () => (await loggedIn.service.bootstrap()).activeTask?.engineStatus?.accountLabel === "ChatGPT Plus");
    assert.equal((await codexSettings(loggedIn))?.accountLabel, "ChatGPT Plus");
    // An API key or any other kind has no plan: no label at all, the interface says Codex manages it.
    adapter.emitAuthStatus({ kind: "api_key", label: "sk-...secret" });
    await eventually(async () => (await loggedIn.service.bootstrap()).activeTask?.engineStatus?.accountLabel === undefined);
    assert.equal((await codexSettings(loggedIn))?.accountLabel, undefined);

    // A login that expires mid-session surfaces as the same named state in the timeline, with Codex's login command.
    const expiring = await harness({}, { codex: { authRequiredOnPrompt: true } });
    const third = await expiring.service.createTask(expiring.workspaceId, undefined, "codex");
    await expiring.send(third.task.taskId, "login-expired");
    await eventually(async () => {
      const view = (await expiring.service.bootstrap()).activeTask;
      return view?.timeline.some((item) => item.kind === "error" && item.text.includes("`codex login`")) === true;
    });
    assert.equal((await expiring.service.bootstrap()).activeTask?.engineStatus?.loginRequired, true);
  });

  it("keeps the Codex session when a lapsed login or a lost process makes the resume fail, and resumes it on the next send [PC-ENG-003]", async () => {
    const spec: EngineSpec = {};
    lapsedResumes.set(spec, 1);
    const h = await harness({}, { codex: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "first");
    await h.completed();
    await h.world.adapters[0]!.emitTransportInterrupted();
    await eventually(async () => (await h.service.bootstrap()).activeTask?.engineStatus?.loginRequired === true);
    const lapsed = (await h.service.bootstrap()).activeTask!;
    assert.equal(lapsed.sessionRecovery, "available", "the session is not declared lost");
    await h.send(task.task.taskId, "second");
    await h.completed(2);
    const resumes = h.world.adapters.flatMap((adapter) => adapter.startCalls).filter((call) => call.kind === "resume");
    assert.equal(new Set(resumes.map((call) => call.sessionId)).size, 1, "the same session each time");
    assert.equal((await h.service.bootstrap()).activeTask!.timeline.some((item) => item.kind === "notice"), false);

    // Only the adapter's own 'no such session' declares it lost; a timeout or a lost process does not.
    const timed: EngineSpec = {};
    resumeFailureCodes.set(timed, ["request_timeout"]);
    const t = await harness({}, { codex: timed });
    const second = await t.service.createTask(t.workspaceId, undefined, "codex");
    await t.send(second.task.taskId, "first");
    await t.completed();
    await t.world.adapters[0]!.emitTransportInterrupted();
    await recoveryFailures(t, 1);
    assert.equal((await t.service.bootstrap()).activeTask!.sessionRecovery, "available");
    await t.send(second.task.taskId, "again");
    await t.completed(2);
    assert.equal(t.world.adapters.at(-1)!.prompts.at(-1), "again");
  });

  it("declares a Codex session lost only when the adapter answers that it has no such rollout [PC-ENG-003]", async () => {
    const spec: EngineSpec = {};
    resumeFailureCodes.set(spec, ["session_not_found"]);
    const h = await harness({}, { codex: spec });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    const taskId = task.task.taskId;
    await h.send(taskId, "first");
    await h.completed();
    await h.world.adapters[0]!.emitTransportInterrupted();
    await eventually(async () => (await h.service.bootstrap()).activeTask?.sessionRecovery === "replacement_required");
    assert.deepEqual(h.world.adapters.flatMap((adapter) => adapter.startCalls).map((call) => call.kind), ["new", "resume"]);
    await assert.rejects(h.send(taskId, "second"), /session_replacement_requires_user_authorization/u);

    // Any other failure of the resume is not an answer about the session: it stays and is retried.
    const other: EngineSpec = {};
    resumeFailureCodes.set(other, ["operation_failed", "operation_failed"]);
    const o = await harness({}, { codex: other });
    const kept = await o.service.createTask(o.workspaceId, undefined, "codex");
    await o.send(kept.task.taskId, "first");
    await o.completed();
    await o.service.createTask(o.workspaceId, undefined, "codex");
    await o.world.adapters[0]!.emitTransportInterrupted();
    await recoveryFailures(o, 1);
    const failed = await o.send(kept.task.taskId, "second").then(() => undefined, (cause: unknown) => cause);
    assert.match(String(failed), /runtime_start_session_resume/u);
    assert.equal((await o.service.openTask(kept.task.taskId)).sessionRecovery, "available");
    await o.send(kept.task.taskId, "third");
    await o.completed(2);
    assert.equal(o.world.adapters.at(-1)!.prompts.at(-1), "third");
  });

  it("reports the install state from the probe and the session: ready with the version, not found, integrity, unavailable [PC-ENG-003]", async () => {
    const ready = await harness({ addonEngineProbes: { codex: async () => ({ version: "0.160.1" }) } });
    const readySettings = await eventuallyValue(async () => {
      const codex = await codexSettings(ready);
      return codex?.status === "ready" ? codex : undefined;
    });
    assert.equal(readySettings.version, "0.160.1");
    assert.equal(readySettings.accountLabel, undefined, "no login seen yet");

    const missing = await harness({ addonEngineProbes: { codex: async () => { throw new CodexLocatorError("adapter_missing"); } } });
    await eventually(async () => (await codexSettings(missing))?.status === "not_found");
    const broken = await harness({ addonEngineProbes: { codex: async () => { throw new Error("EACCES"); } } });
    await eventually(async () => (await codexSettings(broken))?.status === "unavailable");
    for (const component of ["node", "adapter", "core"] as const) {
      const changed = await harness({ addonEngineProbes: { codex: async () => { throw new CodexEngineIntegrityError(component); } } });
      await eventually(async () => (await codexSettings(changed))?.status === "integrity_changed");
    }

    // Without a probe the status is learned from the engine: a missing piece at start, a session that runs.
    const failing = await harness({
      runtimeFactory: async (input) => {
        if (input.engine === "codex") throw new CodexLocatorError("adapter_missing");
        throw new Error("unexpected");
      },
    });
    assert.equal((await codexSettings(failing))?.status, undefined, "nothing known yet");
    const failingTask = await failing.service.createTask(failing.workspaceId, undefined, "codex");
    await assert.rejects(failing.send(failingTask.task.taskId, "x"), /runtime_start_runtime_factory/u);
    assert.equal((await codexSettings(failing))?.status, "not_found");
  });

  it("refuses a Codex start whose pinned files changed, names the reduced state and the IPC code, then recovers [PC-ENG-003]", async () => {
    const world = newWorld();
    const base = engineFactory(world, {});
    let refuse = true;
    const h = await harness({
      runtimeFactory: async (input) => {
        const created = await base(input);
        if (input.engine !== "codex" || !refuse) return created;
        (created.adapter as EngineFake).start = async () => { throw new AcpV1AdapterError("operation_failed"); };
        return { ...created, refusedForIntegrity: () => true };
      },
    });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    const refused = await h.send(task.task.taskId, "x").then(() => undefined, (cause: unknown) => cause);
    assert.match(String(refused), /^Error: engine_integrity_changed$/u);
    assert.equal(toDesktopIpcFailure(refused).message, "engine_integrity_changed");
    assert.equal((await codexSettings(h))?.status, "integrity_changed");
    assert.equal(world.adapters[0]!.prompts.length, 0, "nothing was run");
    // Claude's state is its own.
    assert.equal((await h.service.bootstrap()).runtimeSettings.claude?.status, undefined);

    refuse = false;
    await h.send(task.task.taskId, "again");
    await h.completed();
    assert.equal((await codexSettings(h))?.status, "ready");
  });

  it("names a Codex start that got no answer at initialize, and keeps the session [PC-ENG-003]", async () => {
    const h = await harness({}, { codex: { initializeFailure: "request_timeout" } });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await assert.rejects(h.send(task.task.taskId, "x"), /^Error: engine_start_timeout$/u);
    assert.equal(toDesktopIpcFailure(new Error("engine_start_timeout")).message, "engine_start_timeout");
  });

  it("hands the browser MCP server only when Codex advertised HTTP MCP, on a new session and on a resume [PC-BROWSER-002]", async () => {
    const withMcp = await harness({ browserMcp: new FakeBrowserMcp() }, { codex: { mcpHttp: true } });
    const task = await withMcp.service.createTask(withMcp.workspaceId, undefined, "codex");
    await withMcp.send(task.task.taskId, "x");
    await withMcp.completed();
    const server = { type: "http", name: "guild-browser", url: BROWSER_URL, headers: [] };
    assert.deepEqual(withMcp.world.adapters[0]!.startCalls[0]!.options, { mcpServers: [server] }, "nothing but the browser server");
    await withMcp.world.adapters[0]!.emitTransportInterrupted();
    await eventually(() => withMcp.world.adapters.length === 2 && withMcp.world.adapters[1]!.session !== undefined);
    assert.equal(withMcp.world.adapters[1]!.startCalls[0]!.kind, "resume");
    assert.deepEqual(withMcp.world.adapters[1]!.startCalls[0]!.options?.mcpServers, [server]);

    const without = await harness({ browserMcp: new FakeBrowserMcp() }, { codex: { mcpHttp: false } });
    const plain = await without.service.createTask(without.workspaceId, undefined, "codex");
    await without.send(plain.task.taskId, "z");
    await without.completed();
    assert.equal(without.world.adapters[0]!.startCalls[0]!.options, undefined);
  });

  it("maps Steer to the Codex steering request, and sends what it did not inject as an ordinary message [docs/21 4.5]", async () => {
    const injected = await harness();
    const task = await injected.service.createTask(injected.workspaceId, undefined, "codex");
    await injected.send(task.task.taskId, "hold");
    await runningTurn(injected);
    assert.deepEqual((await injected.service.bootstrap()).activeTask?.steer, { available: true });
    const steered = await injected.service.steerMessage(task.task.taskId, "also this");
    assert.equal(steered.status, "steered");
    assert.deepEqual(injected.world.adapters[0]!.steers, ["also this"]);
    assert.equal(injected.world.adapters[0]!.extensionCalls, 0);
    injected.world.adapters[0]!.release();
    await injected.completed();

    // The adapter started a new turn instead (the turn had ended): the text goes out once, as an ordinary message.
    const missed = await harness({}, { codex: { steerResult: { status: "ok", outcome: "promptRequired" } } });
    const missedTask = await missed.service.createTask(missed.workspaceId, undefined, "codex");
    await missed.send(missedTask.task.taskId, "hold");
    await runningTurn(missed);
    const fallback = await missed.service.steerMessage(missedTask.task.taskId, "late idea");
    assert.equal(fallback.status, "queued");
    assert.equal(fallback.status === "queued" ? fallback.reason : "", "turn_not_running");
    missed.world.adapters[0]!.release();
    await eventually(() => missed.world.adapters[0]!.prompts.includes("late idea"));
    assert.equal(missed.world.adapters[0]!.prompts.filter((text) => text === "late idea").length, 1, "exactly once");

    const unsupported = await harness({}, { codex: { steerResult: { status: "unsupported", reason: "not_found" } } });
    const unsupportedTask = await unsupported.service.createTask(unsupported.workspaceId, undefined, "codex");
    await unsupported.send(unsupportedTask.task.taskId, "hold");
    await runningTurn(unsupported);
    const refused = await unsupported.service.steerMessage(unsupportedTask.task.taskId, "nope");
    assert.equal(refused.status, "queued");
    const explanation = (await unsupported.service.openTask(unsupportedTask.task.taskId)).timeline.find((item) => item.kind === "notice");
    assert.ok(explanation?.kind === "notice" && explanation.text.includes("Codex") && !explanation.text.includes("Grok"),
      "the fallback notice names the engine the task runs on");
  });

  it("offers no conversation rewind to Codex and sends it no _x.ai request [docs/21 4.5]", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    const view = await h.service.openTask(task.task.taskId);
    const runId = view.timeline.find((item) => item.runId !== undefined)!.runId!;
    assert.deepEqual(await h.service.previewRewind(task.task.taskId, runId), { status: "refused", reason: "conversation_rewind_unsupported" });
    assert.deepEqual(
      await h.service.executeRewind({ taskId: task.task.taskId, runId, scope: "conversation_and_files" }),
      { status: "refused", reason: "conversation_rewind_unsupported" },
    );
    assert.equal(h.world.adapters[0]!.extensionCalls, 0);
  });

  it("forks a Codex task into a Codex task and keeps the Grok version label out of Codex sessions [PC-ENG-003]", async () => {
    const h = await harness();
    const grok = await h.service.createTask(h.workspaceId);
    await h.send(grok.task.taskId, "g");
    await h.completed();
    const grokVersion = (await h.service.bootstrap()).runtimeVersion;
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    assert.equal((await h.service.bootstrap()).runtimeVersion, grokVersion, "Codex's version is not the Grok label");
    const branch = await h.service.forkTask(task.task.taskId);
    assert.equal(branch.task.engine, "codex");
  });

  it("shows Codex's permission mode as the session mode and keeps the generic option channel closed to it [PC-SET-002]", async () => {
    const h = await harness();
    await h.service.setEngineSettings("codex", null, null, "read-only");
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    await h.idle();
    const view = (await h.service.bootstrap()).activeTask!;
    assert.equal(view.sessionModes?.currentModeId, "read-only");
    assert.deepEqual(view.sessionModes?.availableModes.map((mode) => mode.id), ["read-only", "workspace-write", "agent", "agent-full-access"]);
    // A later default reaches the idle session at its next turn.
    await h.service.setEngineSettings("codex", null, null, "agent");
    await h.send(task.task.taskId, "y");
    await h.completed(2);
    assert.equal((await h.service.bootstrap()).activeTask?.sessionModes?.currentModeId, "agent");
    await assert.rejects(h.service.setSessionConfigOption(task.task.taskId, "mode", "agent-full-access"));
  });

  it("shows the plan label from an account login only, and context use like Claude's card [PC-FALLBACK-001]", async () => {
    const h = await harness();
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    const adapter = h.world.adapters[0]!;
    assert.equal((await h.service.openTask(task.task.taskId)).engineStatus, undefined, "nothing reported yet");
    adapter.emitAuthStatus({ kind: "account", label: "ChatGPT Pro", plan: "pro" });
    await adapter.emitContextUsage(31_000, 400_000);
    const view = await eventuallyValue(async () => {
      const current = (await h.service.bootstrap()).activeTask;
      return current?.engineStatus?.accountLabel === "ChatGPT Pro" ? current : undefined;
    });
    assert.deepEqual(view.engineStatus, { accountLabel: "ChatGPT Pro" });
    assert.deepEqual(view.contextWindow, { status: "available", used: 31_000, size: 400_000 });
    // The label is the engine's alone: a Claude task shows nothing of it, a Grok task has no status at all.
    const claude = await h.service.createTask(h.workspaceId, undefined, "claude");
    assert.equal(claude.engineStatus, undefined);
    assert.equal((await h.service.createTask(h.workspaceId, undefined, "grok")).engineStatus, undefined);
  });

  it("asks no engine but Grok for official usage, with a Codex task live [PC-FALLBACK-001]", async () => {
    const fetched: string[] = [];
    const usageFetcher = async (): Promise<AcpV1OfficialBillingSnapshot> => {
      fetched.push("dedicated");
      return { creditUsagePercent: 12 };
    };
    const h = await harness({ usageFetcher });
    const task = await h.service.createTask(h.workspaceId, undefined, "codex");
    await h.send(task.task.taskId, "x");
    await h.completed();
    await h.service.refreshUsage();
    assert.deepEqual(fetched, ["dedicated"], "nothing to borrow: the dedicated Grok probe answers");
    assert.equal(h.world.adapters[0]!.billingCalls, 0);
  });
});
