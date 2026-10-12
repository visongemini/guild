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
import { ClaudeLocatorError } from "./claude-locator.js";
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
  sourceId: "deepseek", sourceLabel: "DeepSeek", contextWindow: 128_000,
};
const LOCAL_MODEL: RoutedModelInfo = {
  id: "local-27b-model", label: "Local 27B", group: "local",
  sourceId: "llama", sourceLabel: "Local llama.cpp",
};

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

  it("projects Claude's own models with the router's Online and Local ones and tells the router the native ids [PC-MODEL-001]", async () => {
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
    assert.deepEqual(catalogs.grok.models, [], "the Grok list is not touched by a Claude session");
    assert.deepEqual(router.noted, [[...NATIVE_MODELS]], "the router learns Claude's ids, not its own");

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

  it("switches a native session to the router between turns and keeps the task routed [PC-ROUTE-002, docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK, LOCAL_MODEL]);
    const h = await harness({ modelRouterHost: router });
    const markedAtSpawn: boolean[] = [];
    h.world.onSpawn = async () => {
      markedAtSpawn.push((await h.service.bootstrap()).activeTask?.engineStatus?.routed === true);
    };
    const markedAtModel: boolean[] = [];
    h.world.onConfigOption = async (_label, configId) => {
      if (configId === "model") markedAtModel.push((await h.service.bootstrap()).activeTask?.engineStatus?.routed === true);
    };
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    await h.send(task.task.taskId, "native turn");
    await h.completed();
    await h.idle();
    assert.equal(h.world.inputs[0]!.extraEnvironment, undefined, "a Claude session starts native");
    assert.equal(h.world.adapters[0]!.startCalls[0]!.options?.claudeCodeOptions, undefined);
    assert.equal((await h.service.openTask(task.task.taskId)).engineStatus?.routed, undefined);

    const switched = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(switched.status, "applied");
    assert.equal(switched.task.engineStatus?.routed, true);

    // The sequence: router up, native process closed, routed process, resume, then the model.
    const order = ["router.ensureStarted", "claude-1.close", "spawn:claude:routed", "claude-2.resume", "claude-2.config:model=deepseek-v4-flash"]
      .map((entry) => h.world.log.indexOf(entry));
    assert.ok(order.every((index) => index >= 0), `every step happened: ${order.join()}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "in that order");
    assert.deepEqual(markedAtSpawn.slice(-1), [false], "no marker while the routed process is only starting");
    assert.deepEqual(markedAtModel, [false], "nor while it is taking the model: the marker follows the applied selection");
    assert.equal(h.world.adapters.length, 2);
    const routedEnvironment = {
      ANTHROPIC_BASE_URL: ROUTER_URL,
      ENABLE_TOOL_SEARCH: "true",
      OPENVIKING_AUTO_CAPTURE: "false",
    };
    assert.deepEqual(h.world.inputs[1]!.extraEnvironment, routedEnvironment);
    const resume = h.world.adapters[1]!.startCalls[0]!;
    assert.equal(resume.kind, "resume");
    assert.equal(resume.sessionId, "claude-session", "the same session continues");
    assert.deepEqual(resume.options?.claudeCodeOptions, {
      settings: { modelPicker: { options: [
        { model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        { model: "local-27b-model", label: "Local 27B" },
      ] } },
    });

    await h.send(task.task.taskId, "routed turn");
    await h.completed(2);
    await h.idle();
    assert.deepEqual(h.world.adapters[1]!.prompts, ["routed turn"]);
    // The routed session's picker models never become Claude's own.
    const claudeModels = (await h.service.bootstrap()).runtimeSettings.modelCatalogs!.claude.models;
    assert.deepEqual(claudeModels.filter((model) => model.group === "claude").map((model) => model.id), [...NATIVE_MODELS]);
    assert.deepEqual(router.noted.at(-1), [...NATIVE_MODELS]);

    // Switching among models of a routed session is a plain config option, with no restart.
    const back = await h.service.setTaskRuntimeSettings({
      taskId: task.task.taskId, model: "opus", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(back.status, "applied");
    assert.equal(h.world.adapters.length, 2);
    assert.equal(h.world.adapters[1]!.log.at(-1), "config:model=opus");

    // A crash recovery starts the task routed again.
    await h.world.adapters[1]!.emitTransportInterrupted();
    await eventually(() => h.world.adapters.length === 3 && h.world.adapters[2]!.session !== undefined);
    assert.deepEqual(h.world.inputs[2]!.extraEnvironment, routedEnvironment);
    assert.equal(h.world.adapters[2]!.startCalls[0]!.kind, "resume");

    // And so does a new Guild process.
    const restartedWorld = await h.restart();
    await h.service.openTask(task.task.taskId);
    await h.send(task.task.taskId, "after restart");
    await h.completed(3);
    const restartedInput = restartedWorld.inputs.find((input) => input.engine === "claude");
    assert.deepEqual(restartedInput?.extraEnvironment, routedEnvironment);
    assert.equal(restartedWorld.adapters.find((adapter) => adapter.engine === "claude")?.startCalls[0]?.options
      ?.claudeCodeOptions !== undefined, true);

    // The router URL carries the token and is never logged.
    await h.restart();
    const diagnostics = await readFile(join(h.root, "diagnostics", "runtime.jsonl"), "utf8");
    assert.ok(diagnostics.includes("task_routed"), "the switch itself is logged");
    assert.equal(diagnostics.includes("43210"), false);
    assert.equal(diagnostics.includes("0123456789abcdef"), false);
  });

  it("starts a new task whose first model is routed through the router from its first process [docs/20 3.3]", async () => {
    const router = new FakeRouterHost([DEEPSEEK]);
    const h = await harness({ modelRouterHost: router });
    const markedAtModel: boolean[] = [];
    h.world.onConfigOption = async (_label, configId) => {
      if (configId === "model") markedAtModel.push((await h.service.bootstrap()).activeTask?.engineStatus?.routed === true);
    };
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
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
    assert.equal((await h.service.openTask(task.task.taskId)).engineStatus?.routed, true);
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
    assert.equal(refused.task.engineStatus?.routed, undefined);

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
    const h = await harness({ modelRouterHost: router });
    const markedAtModel: boolean[] = [];
    h.world.onConfigOption = async (_label, configId) => {
      if (configId === "model") markedAtModel.push((await h.service.bootstrap()).activeTask?.engineStatus?.routed === true);
    };
    const task = await h.service.createTask(h.workspaceId, undefined, "claude");
    const taskId = task.task.taskId;
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
    assert.equal((await h.service.bootstrap()).activeTask?.engineStatus?.routed, undefined, "the task is not marked yet");

    gate.open();
    assert.equal((await switching).status, "applied");
    await Promise.all([first, second]);
    await h.completed(3);
    await h.idle();
    assert.deepEqual(h.world.adapters[0]!.prompts, ["native"]);
    assert.deepEqual([...h.world.adapters[1]!.prompts].sort(), ["first", "second"]);
    assert.equal(h.world.adapters.length, 2, "one switch, however many callers joined it");
    assert.deepEqual(markedAtModel, [false], "the marker follows the applied model");
    assert.equal((await h.service.openTask(taskId)).engineStatus?.routed, true);
    const turnLog = h.world.adapters[1]!.log;
    assert.ok(
      turnLog.indexOf("config:model=deepseek-v4-flash") < turnLog.findIndex((entry) => entry.startsWith("prompt:")),
      "the model is applied before the first turn of the routed process",
    );
  });

  it("restarts a task marked routed that still has a native process at the next idle point, whatever Claude model it selects [docs/20 3.3]", async () => {
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
    assert.equal(h.world.adapters.length, 1, "opus is a native model: no restart");

    // A marker with no routed process behind it, as an earlier build could leave after a failed switch.
    store.markTaskRouted({ taskId });
    assert.equal((await h.service.openTask(taskId)).engineStatus?.routed, true);
    await h.send(taskId, "after");
    await h.completed(2);
    assert.equal(h.world.adapters.length, 2);
    assert.equal(h.world.adapters[0]!.state, "closed");
    assert.deepEqual(h.world.inputs[1]!.extraEnvironment, {
      ANTHROPIC_BASE_URL: ROUTER_URL, ENABLE_TOOL_SEARCH: "true", OPENVIKING_AUTO_CAPTURE: "false",
    });
    assert.deepEqual(h.world.adapters[0]!.prompts, ["native"]);
    assert.deepEqual(h.world.adapters[1]!.prompts, ["after"]);
    assert.equal(h.world.adapters[1]!.startCalls[0]!.kind, "resume");
    assert.ok(h.world.adapters[1]!.log.includes("config:model=opus"), "the chosen Claude model is applied on the routed process");
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
    assert.equal(refused.task.engineStatus?.routed, undefined, "and the task is not marked");
    assert.equal(refused.task.modelSelection.source, "runtime", "the previous choice is back");
    assert.equal(h.world.adapters.length, 2);
    assert.equal(h.world.adapters[1]!.state, "closed", "the half-started routed process is closed");

    // Native again for the next turn: the marker was never written.
    await h.send(taskId, "again");
    await h.completed(2);
    assert.equal(h.world.adapters.length, 3);
    assert.equal(h.world.inputs[2]!.extraEnvironment, undefined);
    assert.deepEqual(h.world.adapters[2]!.prompts, ["again"]);
    assert.equal((await h.service.openTask(taskId)).engineStatus?.routed, undefined);

    // A task whose first model is routed surfaces the named code from its first send.
    const fresh = await h.service.createTask(h.workspaceId, undefined, "claude");
    const saved = await h.service.setTaskRuntimeSettings({
      taskId: fresh.task.taskId, model: "deepseek-v4-flash", reasoningEffort: null, contextWindow: null,
    });
    assert.equal(saved.status, "saved");
    await assert.rejects(h.send(fresh.task.taskId, "hi"), /^Error: model_selection_failed$/u);
    assert.equal((await h.service.openTask(fresh.task.taskId)).engineStatus?.routed, undefined);
    assert.deepEqual(h.world.adapters.at(-1)!.prompts, []);
    assert.equal(h.world.adapters.at(-1)!.state, "closed");
  });

  it("gives the session/load fallback the routed picker and the browser server a resume gets [docs/20 3.3]", async () => {
    const spec: EngineSpec = { mcpHttp: true, loadSession: true };
    failingResumes.set(spec, 1);
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
    assert.deepEqual(calls.map((call) => call.kind), ["resume", "load"], "the resume failed and the load took over");
    const server = { type: "http", name: "guild-browser", url: BROWSER_URL, headers: [] };
    assert.deepEqual(calls[1]!.options?.mcpServers, [server]);
    assert.deepEqual(calls[1]!.options?.claudeCodeOptions, {
      settings: { modelPicker: { options: [{ model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }] } },
    });
    assert.deepEqual(calls[1]!.options, calls[0]!.options, "the same start options as the resume");
    assert.deepEqual(h.world.inputs[1]!.extraEnvironment?.["ANTHROPIC_BASE_URL"], ROUTER_URL);
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
    assert.deepEqual(Object.keys(projection.runtimeSettings.modelCatalogs ?? {}).sort(), ["claude", "grok"]);
    assert.deepEqual(
      projection.runtimeSettings.modelCatalogs!.claude.models.map((model) => model.group),
      ["claude", "claude", "claude", "claude", "online", "local"],
    );
    assert.equal(projection.runtimeSettings.claude?.permissionMode, "default");
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
  /** `initialize` advertises `loadSession`; with `failingResumes` the fallback is exercised. */
  readonly loadSession?: boolean;
};

type World = {
  readonly log: string[];
  readonly adapters: EngineFake[];
  readonly inputs: Parameters<RuntimeFactory>[0][];
  onSpawn: ((input: Parameters<RuntimeFactory>[0]) => Promise<void>) | undefined;
  /** Called after a config option was applied on any adapter of the world. */
  onConfigOption: ((adapterLabel: string, configId: string, value: string | boolean) => Promise<void>) | undefined;
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
  const overrides: Partial<LiveDesktopServiceOptions> = openStore === undefined
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
  return { log: [], adapters: [], inputs: [], onSpawn: undefined, onConfigOption: undefined };
}

function engineFactory(world: World, specs: Partial<Record<GuildEngine, EngineSpec>>): RuntimeFactory {
  const counts: Record<GuildEngine, number> = { grok: 0, claude: 0 };
  return async (input) => {
    world.inputs.push(input);
    await world.onSpawn?.(input);
    counts[input.engine] += 1;
    world.log.push(`spawn:${input.engine}:${input.extraEnvironment === undefined ? "native" : "routed"}`);
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
      runtimeVersion: input.engine === "claude" ? "Claude Code 2.1.291" : "Fake Grok 1.0",
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
  readonly noted: string[][] = [];
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
  noteAnthropicModels(ids: readonly string[]): void { this.noted.push([...ids]); }
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
    this.state = "ready";
    return Object.freeze({
      protocolVersion: 1,
      agentCapabilities: Object.freeze({
        loadSession: this.spec.loadSession === true,
        resumeSession: true,
        prompt: Object.freeze({ image: false, audio: false, embeddedContext: false }),
      }),
      authMethods: Object.freeze(this.spec.advertiseAuthMethod === true
        ? [{ id: "claude-login", name: "Log in with Claude", type: "terminal" as const }] as never
        : []),
      ...(this.spec.mcpHttp === true ? { mcpCapabilities: { http: true, sse: false } } : {}),
      ...(this.engine === "claude" ? { steering: { supported: this.spec.steering ?? true } } : {}),
    });
  }

  async authenticate(): Promise<void> {
    this.authenticateCalls += 1;
    if (this.engine === "claude") throw new AcpV1AdapterError("unsupported_for_engine");
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
    if (this.engine !== "claude" || !this.features.steer) {
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
    this.options = Object.freeze(this.options.map((option) =>
      option.id === configId ? Object.freeze({ ...option, currentValue: value }) as RuntimeConfigOption : option));
    await this.world.onConfigOption?.(this.label, configId, value);
    return this.options;
  }

  async setPermissionMode(_session: AcpV1AdapterSession, mode: string): Promise<readonly RuntimeConfigOption[]> {
    if (this.engine !== "claude") throw new AcpV1AdapterError("unsupported_for_engine");
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
    if (lapsedResumes.get(this.spec) !== undefined && lapsedResumes.get(this.spec)! > 0) {
      lapsedResumes.set(this.spec, lapsedResumes.get(this.spec)! - 1);
      throw new AcpV1AdapterError("auth_required");
    }
    if (failingResumes.get(this.spec) !== undefined && failingResumes.get(this.spec)! > 0) {
      failingResumes.set(this.spec, failingResumes.get(this.spec)! - 1);
      throw new AcpV1AdapterError("operation_failed");
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
      this.options = claudeOptions([...NATIVE_MODELS, ...picker], this.options);
    } else {
      this.options = Object.freeze([]);
    }
    this.session = Object.freeze({
      adapterEpoch: this.adapterEpoch,
      sessionId,
      establishedBy,
      ...(this.engine === "claude" ? { configOptions: this.options } : {}),
    });
    return this.session;
  }

  async prompt(session: AcpV1AdapterSession, text: string): Promise<RuntimePromptTerminalPayload> {
    this.prompts.push(text);
    this.note(`prompt:${text}`);
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
    this.sink.observeEngineSignal?.({ type: "auth_status", engine: "claude", status });
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

/** Remaining lapsed resumes per spec, shared by every adapter the factory builds from it. */
const lapsedResumes = new WeakMap<EngineSpec, number>();
/** Remaining resumes that fail with a plain operation failure, so the load fallback is tried. */
const failingResumes = new WeakMap<EngineSpec, number>();

function claudeOptions(models: readonly string[], previous: readonly RuntimeConfigOption[]): readonly RuntimeConfigOption[] {
  const current = (id: string, fallback: string): string => {
    const option = previous.find((candidate) => candidate.id === id);
    return option?.type === "select" ? option.currentValue : fallback;
  };
  const flat = (values: readonly string[]) => ({
    form: "flat" as const,
    options: values.map((value) => ({ value, name: value })),
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
