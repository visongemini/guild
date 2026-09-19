import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import type {
  RuntimePromptTerminalPayload,
  RuntimeCommand,
  RuntimeConfigOption,
  RuntimePlanPayload,
  RuntimeTextChunkPayload,
  SendMessageResponse,
} from "@guild/contracts";
import {
  GUILD_GROK_MODELS,
  GUILD_GROK_PERMISSION_MODES,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parseRunId,
  parseSessionAttemptId,
  parseSessionId,
  type Result,
} from "@guild/contracts";
import { openGuildPersistence } from "@guild/persistence";
import {
  AcpV1AdapterError,
  ACP_V1_CODEC_LIMITS,
  type AcpV1AdapterSession,
  type AcpV1AdapterSink,
  type AcpV1DecodedUpdate,
  type AcpV1InitializeResult,
  type AcpV1PreparedPermissionResponse,
  type JsonRpcInboundResponseWriteReceipt,
  type JsonRpcWriteReceipt,
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

describe("live desktop service", () => {

  for (const transition of ["create", "open", "restart"] as const) {
    it(`preserves a first-message draft across ${transition} [PC-DATA-001]`, async () => {
      const root = await mkdtemp(join(tmpdir(), "guild-first-draft-"));
      const workspace = join(root, "Workspace");
      await mkdir(workspace);
      const options = {
        appVersion: "2.0.34-test",
        databasePath: join(root, "guild.sqlite3"),
        stagingRoot: join(root, "staging"),
        chooseWorkspace: async () => workspace,
        runtimeFactory: fakeRuntimeFactory(),
      };
      let service = createLiveDesktopService(options);
      services.push(service);
      const initial = await service.chooseWorkspace();
      const workspaceId = initial.workspaces[0]!.workspaceId;
      const other = await service.createTask(workspaceId);
      await service.updateTask({ taskId: other.task.taskId, action: "rename", title: "Existing task" });
      const draftTask = await service.createTask(workspaceId);
      await service.setDraft(draftTask.task.taskId, "Important instructions, not sent yet");
      if (transition === "create") await service.createTask(workspaceId);
      else if (transition === "open") await service.openTask(other.task.taskId);
      else {
        await service.close();
        services.splice(services.indexOf(service), 1);
        service = createLiveDesktopService(options);
        services.push(service);
      }
      const restored = await service.openTask(draftTask.task.taskId);
      assert.equal(restored.draft, "Important instructions, not sent yet");
      assert.equal(restored.timeline.length, 0);
      const projection = await service.bootstrap();
      assert.ok(projection.workspaces.flatMap((workspace) => workspace.tasks)
        .some((task) => task.taskId === draftTask.task.taskId));
    });
  }
  for (const mode of ["standard", "continuous"] as const) {
    it(`retains a drafted ${mode} first send when runtime startup fails [PC-DATA-001]`, async () => {
      const root = await mkdtemp(join(tmpdir(), "guild-drafted-start-failure-"));
      const workspace = join(root, "Workspace");
      await mkdir(workspace);
      const options = {
        appVersion: "2.0.34-test",
        databasePath: join(root, "guild.sqlite3"),
        stagingRoot: join(root, "staging"),
        chooseWorkspace: async () => workspace,
        runtimeFactory: fakeRuntimeFactory([{ startFailure: "runtime unavailable" }]),
      };
      const service = createLiveDesktopService(options);
      services.push(service);
      const initial = await service.chooseWorkspace();
      const task = await service.createTask(initial.workspaces[0]!.workspaceId);
      const objective = "Retain this first objective";
      await service.setDraft(task.task.taskId, objective);
      await assert.rejects(service.sendMessage(task.task.taskId, objective, [], mode),
        mode === "continuous" ? /continuous_task_failed_to_start/u : /runtime_start_initialize/u);
      const failed = await service.openTask(task.task.taskId);
      assert.equal(failed.task.title, objective, "a saved draft must not suppress the first title");
      // Even a user-chosen default title must not turn a durable objective into an empty task.
      await service.updateTask({ taskId: task.task.taskId, action: "rename", title: "New task" });
      await service.close();
      services.splice(services.indexOf(service), 1);
      const reopened = createLiveDesktopService(options);
      services.push(reopened);
      const restored = await reopened.openTask(task.task.taskId);
      if (mode === "continuous") {
        assert.equal(restored.continuousTask?.objective, objective);
        assert.equal(restored.continuousTask?.status, "blocked");
      } else {
        assert.equal(restored.draft, objective);
      }
    });
  }

  it("uses a concise fallback title, then adopts one official semantic title without overwriting a manual rename [D-050]", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-short-title-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    let adapter: FakeAdapter | undefined;
    const service = createLiveDesktopService({
      appVersion: "2.1.3-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (created) => { adapter = created; }),
    });
    services.push(service);
    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    const prompt = "请你帮我把 Guild 的深色模式模型选择修好，然后增加自动短标题功能。";

    await service.sendMessage(task.task.taskId, prompt);
    await waitForCompleted(service);
    const fallback = (await service.bootstrap()).activeTask?.task.title;
    assert.equal(fallback, "把 Guild 的深色模式模型…");

    await adapter!.emitSessionTitle("任务：修复 Guild 深色模型选择与自动标题");
    assert.equal((await service.bootstrap()).activeTask?.task.title, "修复 Guild 深色模型选择…");

    await service.updateTask({ taskId: task.task.taskId, action: "rename", title: "我的固定名称" });
    await adapter!.emitSessionTitle("另一个自动标题");
    assert.equal((await service.bootstrap()).activeTask?.task.title, "我的固定名称");
  });

  it("coalesces a stream burst while preserving partial display, event order and terminal text [D-049]", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-stream-burst-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    let adapter: FakeAdapter | undefined;
    const service = createLiveDesktopService({
      appVersion: "2.1.2-test", databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"), chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (created) => { adapter = created; }),
    });
    services.push(service);
    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    const observed: string[] = [];
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    const unsubscribe = service.subscribe((projection) => {
      const current = projection.activeTask;
      const answer = current?.timeline.find((entry) => entry.kind === "assistant");
      if (answer?.kind === "assistant") observed.push(answer.text);
      if (current?.task.activeRunState === "completed") finish();
    });
    const timeout = setTimeout(() => finish(), 15_000);
    try {
      await service.sendMessage(task.task.taskId, "stream-burst");
      await completed;
      const final = await service.bootstrap();
      assert.equal(final.activeTask?.task.activeRunState, "completed");
      const expected = Array.from({ length: 512 }, (_, index) => String(index) + ",").join("");
      const answer = final.activeTask?.timeline.find((entry) => entry.kind === "assistant");
      assert.equal(answer?.kind === "assistant" ? answer.text : "", expected);
      assert.ok(observed.some((value) => value.length > 0 && value.length < expected.length),
        "a pending burst must still yield to publish partial output");
      assert.ok(observed.length < 128, "UI should batch chunks rather than publish each one");
      assert.ok(observed.every((value, index) =>
        expected.startsWith(value) && (index === 0 || value.startsWith(observed[index - 1]!))));
      assert.equal(adapter?.streamBurstYielded, true, "stream draining must not starve the event loop");
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
  });

  it("runs a Guild-owned continuous task through work and an independent audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-continuous-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace, { recursive: true });
    let adapter: FakeAdapter | undefined;
    const service = createLiveDesktopService({
      appVersion: "2.0.31-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        promptResponses: Object.freeze([
          "Implemented and tested the release slice.\nGUILD_CONTINUOUS_SUMMARY: Release slice implemented and tested\nGUILD_CONTINUOUS_REMAINING: Independent completion audit\nGUILD_CONTINUOUS_VERDICT: CONTINUE",
          "The workspace evidence satisfies the original objective.\nGUILD_CONTINUOUS_SUMMARY: Full objective verified\nGUILD_CONTINUOUS_REMAINING: NONE\nGUILD_CONTINUOUS_VERDICT: COMPLETE",
        ]),
      }], (created) => {
        adapter = created;
      }),
    });
    services.push(service);
    const selected = await service.chooseWorkspace();
    const workspaceId = selected.workspaces[0]!.workspaceId;
    const task = await service.createTask(workspaceId);
    const objective = "Build the complete release and verify it";
    const started = await service.sendMessage(task.task.taskId, objective, [], "continuous");
    assert.equal(started.status, "started");

    const deadline = Date.now() + 3_000;
    let completed: Awaited<ReturnType<typeof service.bootstrap>> | undefined;
    while (Date.now() < deadline) {
      const projection = await service.bootstrap();
      if (projection.activeTask?.continuousTask?.status === "completed") {
        completed = projection;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(completed, "continuous task did not complete its audit");
    assert.equal(completed.activeTask?.continuousTask?.cycle, 1);
    assert.equal(completed.activeTask?.continuousTask?.summary, "Full objective verified");
    const visibleUser = completed.activeTask?.timeline.find((item) => item.kind === "user");
    assert.equal(visibleUser?.kind, "user");
    if (visibleUser?.kind !== "user") assert.fail("continuous objective was not visible");
    assert.equal(visibleUser.text, objective);
    assert.equal(adapter?.prompts.length, 2);
    assert.match(adapter?.prompts[0]?.text ?? "", /执行阶段/u);
    assert.match(adapter?.prompts[1]?.text ?? "", /审计阶段/u);
    assert.doesNotMatch(adapter?.prompts[0]?.text ?? "", /^\/goal\b/mu);
  });

  it("does not accept a work-phase completion claim without a valid audit verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-continuous-audit-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace, { recursive: true });
    let adapter: FakeAdapter | undefined;
    const service = createLiveDesktopService({
      appVersion: "2.0.31-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        promptResponses: Object.freeze([
          "Everything is done.\nGUILD_CONTINUOUS_SUMMARY: Claimed complete\nGUILD_CONTINUOUS_REMAINING: NONE\nGUILD_CONTINUOUS_VERDICT: COMPLETE",
          "I looked around and it seems fine, but omitted the required audit protocol.",
        ]),
      }], (created) => {
        adapter = created;
      }),
    });
    services.push(service);
    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "Finish the whole product", [], "continuous");

    const deadline = Date.now() + 3_000;
    let blocked: Awaited<ReturnType<typeof service.bootstrap>> | undefined;
    while (Date.now() < deadline) {
      const projection = await service.bootstrap();
      if (projection.activeTask?.continuousTask?.status === "blocked") {
        blocked = projection;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "invalid independent audit did not block the continuous task");
    assert.equal(blocked.activeTask?.continuousTask?.phase, "audit");
    assert.equal(blocked.activeTask?.continuousTask?.stopReason, "audit_protocol_invalid");
    assert.equal(adapter?.prompts.length, 2);
  });

  for (const [label, auditResponse] of [
    ["an earlier footer followed by a correction",
      "GUILD_CONTINUOUS_SUMMARY: Claimed complete\nGUILD_CONTINUOUS_REMAINING: NONE\nGUILD_CONTINUOUS_VERDICT: COMPLETE\nCorrection: verification is still incomplete."],
    ["a fenced protocol example",
      "```text\nGUILD_CONTINUOUS_SUMMARY: Example only\nGUILD_CONTINUOUS_REMAINING: NONE\nGUILD_CONTINUOUS_VERDICT: COMPLETE"],
    ["a four-space-indented protocol example",
      "    GUILD_CONTINUOUS_SUMMARY: Example only\n    GUILD_CONTINUOUS_REMAINING: NONE\n    GUILD_CONTINUOUS_VERDICT: COMPLETE"],
  ] as const) {
    it(`does not complete a continuous task from ${label}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "guild-continuous-footer-"));
      const workspace = join(root, "Workspace");
      await mkdir(workspace, { recursive: true });
      const service = createLiveDesktopService({
        appVersion: "2.1.6-test",
        databasePath: join(root, "guild.sqlite3"),
        stagingRoot: join(root, "staging"),
        chooseWorkspace: async () => workspace,
        runtimeFactory: fakeRuntimeFactory([{
          promptResponses: Object.freeze([
            "Implemented a slice.\nGUILD_CONTINUOUS_SUMMARY: Slice done\nGUILD_CONTINUOUS_REMAINING: Audit it\nGUILD_CONTINUOUS_VERDICT: CONTINUE",
            auditResponse,
          ]),
        }]),
      });
      services.push(service);
      const selected = await service.chooseWorkspace();
      const task = await service.createTask(selected.workspaces[0]!.workspaceId);
      await service.sendMessage(task.task.taskId, "Complete and audit the objective", [], "continuous");

      const deadline = Date.now() + 3_000;
      let projection = await service.bootstrap();
      while (Date.now() < deadline && projection.activeTask?.continuousTask?.status === "active") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        projection = await service.bootstrap();
      }
      assert.equal(projection.activeTask?.continuousTask?.status, "blocked");
      assert.equal(projection.activeTask?.continuousTask?.stopReason, "audit_protocol_invalid");
    });
  }

  it("waits while paused and resumes from the next continuous phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-continuous-pause-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace, { recursive: true });
    let adapter: FakeAdapter | undefined;
    const service = createLiveDesktopService({
      appVersion: "2.0.31-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        promptDelayMs: 80,
        promptResponses: Object.freeze([
          "Implemented a slice.\nGUILD_CONTINUOUS_SUMMARY: Slice done\nGUILD_CONTINUOUS_REMAINING: Audit it\nGUILD_CONTINUOUS_VERDICT: CONTINUE",
          "Verified.\nGUILD_CONTINUOUS_SUMMARY: Objective verified\nGUILD_CONTINUOUS_REMAINING: NONE\nGUILD_CONTINUOUS_VERDICT: COMPLETE",
        ]),
      }], (created) => {
        adapter = created;
      }),
    });
    services.push(service);
    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "Finish and audit the product", [], "continuous");

    await service.setContinuousTask(task.task.taskId, "pause");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const paused = await service.bootstrap();
    assert.equal(paused.activeTask?.continuousTask?.status, "paused");
    assert.equal(paused.activeTask?.continuousTask?.phase, "audit");
    assert.equal(adapter?.prompts.length, 1);

    await service.setContinuousTask(task.task.taskId, "resume");
    const deadline = Date.now() + 3_000;
    let completed: Awaited<ReturnType<typeof service.bootstrap>> | undefined;
    while (Date.now() < deadline) {
      const projection = await service.bootstrap();
      if (projection.activeTask?.continuousTask?.status === "completed") {
        completed = projection;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(completed, "resumed continuous task did not complete its audit");
    assert.equal(adapter?.prompts.length, 2);
  });

  it("pauses an active continuous task after a desktop restart instead of replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-continuous-restart-"));
    const workspace = join(root, "Workspace");
    const databasePath = join(root, "guild.sqlite3");
    await mkdir(workspace, { recursive: true });
    const initial = createLiveDesktopService({
      appVersion: "2.0.31-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        promptResponses: Object.freeze([
          "Need user input.\nGUILD_CONTINUOUS_SUMMARY: Inspected current state\nGUILD_CONTINUOUS_REMAINING: User decision\nGUILD_CONTINUOUS_VERDICT: BLOCKED",
        ]),
      }]),
    });
    services.push(initial);
    const selected = await initial.chooseWorkspace();
    const task = await initial.createTask(selected.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "Complete the product", [], "continuous");
    const blockedDeadline = Date.now() + 3_000;
    while (Date.now() < blockedDeadline) {
      if ((await initial.bootstrap()).activeTask?.continuousTask?.status === "blocked") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const store = openGuildPersistence({ path: databasePath });
    const mission = store.loadContinuousTask(task.task.taskId);
    assert.equal(mission?.status, "blocked");
    store.updateContinuousTask({
      taskId: task.task.taskId,
      expectedRevision: mission!.revision,
      status: "active",
      stopReason: null,
    });
    store.close();

    let adapterCreated = false;
    const reopened = createLiveDesktopService({
      appVersion: "2.0.31-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], () => {
        adapterCreated = true;
      }),
    });
    services.push(reopened);
    const projection = await reopened.bootstrap();
    assert.equal(projection.activeTask?.continuousTask?.status, "paused");
    assert.equal(projection.activeTask?.continuousTask?.stopReason, "desktop_restarted");
    assert.equal(adapterCreated, false);
  });

  it("fetches official usage only on demand and delegates a validated external URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-"));
    const opened: string[] = [];
    let fetches = 0;
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
      usageFetcher: async () => {
        fetches += 1;
        return Object.freeze({
          creditUsagePercent: 4,
          periodType: "USAGE_PERIOD_TYPE_WEEKLY",
          periodEndIso: "2026-09-01T01:00:29.066410+00:00",
        });
      },
      openExternal: async (url) => {
        opened.push(url);
      },
    });
    services.push(service);

    assert.deepEqual((await service.bootstrap()).usage, {
      status: "unavailable",
      reason: "not_reported_by_runtime",
    });
    const [refreshed] = await Promise.all([
      service.refreshUsage(),
      service.refreshUsage(),
    ]);
    assert.equal(fetches, 1);
    assert.equal(refreshed.usage.status, "available");
    if (refreshed.usage.status === "available") {
      assert.equal(refreshed.usage.usedLabel, "已使用 4%");
      assert.equal(refreshed.usage.resetsAtIso, "2026-09-01T01:00:29.066410+00:00");
    }
    await service.refreshUsage();
    assert.equal(fetches, 1);
    await service.openExternal("https://grok.com/?_s=usage");
    await service.openExternal("http://127.0.0.1:4176/");
    assert.deepEqual(opened, ["https://grok.com/?_s=usage", "http://127.0.0.1:4176/"]);
    await assert.rejects(service.openExternal("http://example.com"));
  });

  it("does not hold the command queue while the native workspace dialog is open", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-workspace-dialog-"));
    let markChooserStarted!: () => void;
    const chooserStarted = new Promise<void>((resolve) => {
      markChooserStarted = resolve;
    });
    let releaseChooser!: () => void;
    const chooserGate = new Promise<void>((resolve) => {
      releaseChooser = resolve;
    });
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => {
        markChooserStarted();
        await chooserGate;
        return undefined;
      },
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const choosing = service.chooseWorkspace();
    await chooserStarted;
    const localized = await service.setLocale("en-US");
    assert.equal(localized.locale, "en-US");
    releaseChooser();
    assert.equal((await choosing).locale, "en-US");
  });

  it("attaches only revalidated regular files from the task workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-attachments-"));
    const workspace = join(root, "Workspace");
    const outside = join(root, "outside.txt");
    const inside = join(workspace, "docs", "README.md");
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(inside, "workspace context", "utf8");
    await writeFile(outside, "outside", "utf8");
    let selection: readonly string[] | undefined = [inside];
    let adapter: FakeAdapter | undefined;
    const service = createLiveDesktopService({
      appVersion: "2.0.23-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      choosePromptFiles: async () => selection,
      runtimeFactory: fakeRuntimeFactory([], (created) => {
        adapter = created;
      }),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const chosen = await service.choosePromptFiles(task.task.taskId);
    assert.deepEqual(chosen, {
      status: "selected",
      attachments: [{
        relativePath: "docs/README.md",
        name: "README.md",
        size: 17,
        mimeType: "text/markdown",
      }],
    });
    if (chosen.status !== "selected") assert.fail("attachment picker cancelled");
    await service.sendMessage(task.task.taskId, "Review the attachment", chosen.attachments);
    await waitForRunState(service, "completed");
    assert.equal(adapter?.prompts.length, 1);
    assert.deepEqual(adapter?.prompts[0]?.resources, [{
      name: "README.md",
      uri: pathToFileURL(await realpath(inside)).href,
      mimeType: "text/markdown",
      size: 17,
    }]);

    selection = [outside];
    await assert.rejects(
      service.choosePromptFiles(task.task.taskId),
      /prompt_attachment_outside_workspace/,
    );
    await rm(inside);
    await assert.rejects(
      service.sendMessage(task.task.taskId, "Review the vanished attachment", chosen.attachments),
    );
  });

  it("re-adds a removed project as an empty container without reviving its tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-readd-")), workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({ appVersion: "2.1.0-test", databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"), chooseWorkspace: async () => workspace, runtimeFactory: fakeRuntimeFactory() });
    services.push(service);
    const selected = await service.chooseWorkspace();
    const id = selected.workspaces[0]!.workspaceId;
    const task = await service.createTask(id);
    await service.setDraft(task.task.taskId, "A saved draft");
    await service.updateWorkspace(id, "delete");
    const readded = await service.chooseWorkspace();
    assert.equal(readded.workspaces.find((item) => item.workspaceId === id)?.tasks.length, 0);
    await assert.rejects(service.openTask(task.task.taskId));
    assert.ok((await service.createTask(id)).canSend);
  });

  it("opens a persisted search hit beyond the first history page and retains the target draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-search-anchor-")), workspace = join(root, "Workspace");
    await mkdir(workspace);
    const options = { appVersion: "2.1.0-test", databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"), chooseWorkspace: async () => workspace, runtimeFactory: fakeRuntimeFactory() };
    const setup = createLiveDesktopService(options);
    const selected = await setup.chooseWorkspace();
    const task = await setup.createTask(selected.workspaces[0]!.workspaceId);
    await setup.setDraft(task.task.taskId, "Preserve this draft");
    await setup.close();
    const store = openGuildPersistence({ path: options.databasePath });
    for (let index = 1; index <= 610; index++) store.createConversationEntry({
      taskId: task.task.taskId, entryId: "message-" + index, kind: "assistant", status: "complete",
      text: index === 8 ? "anchor needle" : "later message " + index, metadata: {},
    });
    store.close();
    const service = createLiveDesktopService(options); services.push(service);
    const search = await service.searchConversations("anchor needle");
    assert.equal(search.results[0]?.sequence, 8);
    const opened = await service.openTask(task.task.taskId, search.results[0]!.sequence);
    assert.ok(opened.timeline.some((item) => item.sequence === 8));
    assert.equal(opened.draft, "Preserve this draft");
    assert.ok((await service.openTask(task.task.taskId)).timeline.some((item) => item.sequence === 8));
    await assert.rejects(service.openTask(task.task.taskId, 999999), /search_message_unavailable/);
  });

  it("creates a consistent local backup without changing the live database", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-backup-"));
    const workspace = join(root, "Workspace");
    const mediaRoot = join(root, "media");
    const diagnosticsRoot = join(root, "diagnostics");
    const destination = join(root, "Guild-backup.guild-backup");
    await mkdir(workspace);
    await mkdir(mediaRoot);
    await mkdir(diagnosticsRoot);
    await writeFile(join(mediaRoot, "11111111-1111-4111-8111-111111111111.png"), "media", "utf8");
    await writeFile(join(diagnosticsRoot, "incident.json"), "{}", "utf8");
    const service = createLiveDesktopService({
      appVersion: "2.0.23-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      mediaRoot,
      diagnosticsRoot,
      chooseWorkspace: async () => workspace,
      chooseUserDataBackupPath: async () => destination,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);
    await service.chooseWorkspace();

    assert.deepEqual(await service.backupUserData(), { status: "saved", path: destination });
    assert.equal((await readFile(join(destination, "guild.sqlite3"))).subarray(0, 16).toString(), "SQLite format 3\u0000");
    assert.equal(await readFile(join(destination, "media", "11111111-1111-4111-8111-111111111111.png"), "utf8"), "media");
    assert.equal(await readFile(join(destination, "diagnostics", "incident.json"), "utf8"), "{}");
    const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest["format"], "guild-local-backup-v2");
    assert.equal((await service.bootstrap()).workspaces.length, 1);
  });

  for (const operation of ["backup", "restore"] as const) {
    it("drains a completed live session before " + operation + " without rejecting its close notification", async () => {
      const root = await mkdtemp(join(tmpdir(), "guild-maintenance-session-"));
      const workspace = join(root, "Workspace"), destination = join(root, "backup");
      await mkdir(workspace);
      let staged: string | undefined;
      const service = createLiveDesktopService({
        appVersion: "2.1.0-test", databasePath: join(root, "guild.sqlite3"),
        stagingRoot: join(root, "staging"), chooseWorkspace: async () => workspace,
        chooseUserDataBackupPath: async () => destination,
        chooseUserDataRestorePath: async () => destination,
        requestRestoreRestart: (path) => { staged = path; },
        runtimeFactory: fakeRuntimeFactory(),
      });
      services.push(service);
      const selected = await service.chooseWorkspace();
      const task = await service.createTask(selected.workspaces[0]!.workspaceId);
      if (operation === "restore") await service.backupUserData();
      await service.sendMessage(task.task.taskId, "First completed turn");
      await waitForCompleted(service);
      const idleDeadline = Date.now() + 3_000;
      while (!(await service.bootstrap()).runtimeSettings.canChange && Date.now() < idleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal((await service.bootstrap()).runtimeSettings.canChange, true);
      if (operation === "backup") {
        assert.equal((await service.backupUserData()).status, "saved");
        await service.sendMessage(task.task.taskId, "Continue after the backup");
        const continued = await waitForCompleted(service, 2);
        assert.equal(continued.activeTask?.task.taskId, task.task.taskId);
      } else {
        assert.equal((await service.restoreUserData()).status, "restarting");
        assert.ok(staged?.startsWith(join(root, "restore-")));
      }
    });
  }

  it("binds official management to the selected workspace and blocks it during a run", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-management-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const invocations: Array<{ action: string; workingDirectory: string }> = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
      managementRunner: async ({ request, workingDirectory }) => {
        invocations.push({ action: request.action, workingDirectory });
        return Object.freeze({
          action: request.action,
          commandLabel: "grok --version",
          completedAtIso: "2026-08-30T00:00:00.000Z",
          durationMs: 1,
          output: "grok test",
          status: "completed" as const,
        });
      },
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    const running = await waitForRunState(service, "running");
    const runningSummary = running.workspaces
      .flatMap((candidate) => candidate.tasks)
      .find((candidate) => candidate.taskId === task.task.taskId);
    assert.equal(runningSummary?.activeActivity, "working");

    await assert.rejects(
      service.runGrokManagement({ action: "version", taskId: task.task.taskId }),
      /grok_management_change_unavailable/,
    );
    await assert.rejects(
      service.runGrokManagement({
        action: "plugin_enable",
        taskId: task.task.taskId,
        parameters: { name: "example-plugin" },
      }),
      /grok_management_change_unavailable/,
    );

    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancelled");
    const version = await service.runGrokManagement({
      action: "version",
      taskId: task.task.taskId,
    });
    assert.equal(version.status, "completed");
    assert.deepEqual(invocations, [{
      action: "version",
      workingDirectory: await realpath(workspace),
    }]);
  });

  it("refuses official management when no task workspace is selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-management-no-workspace-"));
    let invoked = false;
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
      managementRunner: async () => {
        invoked = true;
        throw new Error("must_not_run");
      },
    });
    services.push(service);

    await assert.rejects(
      service.runGrokManagement({ action: "version" }),
      /grok_management_workspace_required/u,
    );
    assert.equal(invoked, false);
  });

  it("admits only one official management operation at a time", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-management-lock-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
      managementRunner: async ({ request, onOutput }) => {
        onOutput?.("Visit https://example.test/device and enter ABCD-EFGH");
        markStarted();
        await gate;
        return Object.freeze({
          action: request.action,
          commandLabel: "grok --version",
          completedAtIso: "2026-08-30T00:00:00.000Z",
          durationMs: 1,
          output: "grok test",
          status: "completed" as const,
        });
      },
    });
    services.push(service);

    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    const first = service.runGrokManagement({ action: "version", taskId: task.task.taskId });
    await started;
    const inProgress = await service.bootstrap();
    assert.deepEqual(inProgress.grokManagementProgress, {
      action: "version",
      commandLabel: "grok version",
      startedAtIso: inProgress.grokManagementProgress?.startedAtIso,
      output: "Visit https://example.test/device and enter ABCD-EFGH",
    });
    await assert.rejects(
      service.runGrokManagement({ action: "models", taskId: task.task.taskId }),
      /grok_management_operation_active/,
    );
    await assert.rejects(
      service.sendMessage(task.task.taskId, "must not overlap management"),
      /grok_management_operation_active/,
    );
    release();
    assert.equal((await first).status, "completed");
    assert.equal((await service.bootstrap()).grokManagementProgress, undefined);
  });

  it("does not start management while a message is still opening its Grok session", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-management-send-race-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    let managementInvoked = false;
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ startDelayMs: 150 }]),
      managementRunner: async () => {
        managementInvoked = true;
        throw new Error("must_not_run");
      },
    });
    services.push(service);

    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    const sending = service.sendMessage(task.task.taskId, "hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      service.runGrokManagement({ action: "version", taskId: task.task.taskId }),
      /grok_management_change_unavailable/u,
    );
    assert.equal(managementInvoked, false);
    await sending;
    await waitForCompleted(service);
  });

  it("aborts and joins an owned management operation before closing persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-management-close-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let observedAbort = false;
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
      managementRunner: async ({ request, signal }) => await new Promise((resolve) => {
        markStarted();
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve(Object.freeze({
            action: request.action,
            commandLabel: "grok --version",
            completedAtIso: "2026-08-30T00:00:00.000Z",
            durationMs: 1,
            output: "cancelled",
            status: "failed" as const,
          }));
        }, { once: true });
      }),
    });
    services.push(service);

    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    const running = service.runGrokManagement({ action: "version", taskId: task.task.taskId });
    await started;
    await service.close();
    services.splice(services.indexOf(service), 1);
    assert.equal(observedAbort, true);
    assert.equal((await running).status, "failed");
  });

  it("persists official Grok runtime settings and applies them to the real session selectors", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-runtime-settings-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const adapters: FakeAdapter[] = [];
    const factoryInputs: Parameters<RuntimeFactory>[0][] = [];
    const runtimeFactory = fakeRuntimeFactory(
      [],
      (adapter) => adapters.push(adapter),
      (input) => factoryInputs.push(input),
    );
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(service);

    assert.deepEqual((await service.bootstrap()).runtimeSettings, {
      model: "grok-4.6",
      reasoningEffort: "xhigh",
      permissionMode: "default",
      availableModels: GUILD_GROK_MODELS,
      availablePermissionModes: GUILD_GROK_PERMISSION_MODES,
      startup: {
        webSearchEnabled: true,
        planEnabled: true,
        subagentsEnabled: true,
        maxTurns: null,
      },
      canChange: true,
    });
    const configured = await service.setRuntimeSettings(
      "grok-4.5",
      "medium",
      "bypassPermissions",
      {
        webSearchEnabled: false,
        planEnabled: true,
        subagentsEnabled: false,
        maxTurns: 256,
      },
    );
    assert.deepEqual(configured.runtimeSettings, {
      model: "grok-4.5",
      reasoningEffort: "medium",
      permissionMode: "bypassPermissions",
      availableModels: GUILD_GROK_MODELS,
      availablePermissionModes: GUILD_GROK_PERMISSION_MODES,
      startup: {
        webSearchEnabled: false,
        planEnabled: true,
        subagentsEnabled: false,
        maxTurns: 256,
      },
      canChange: true,
    });
    const withWorkspace = await service.chooseWorkspace();
    const task = await service.createTask(withWorkspace.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "settings-check");
    await waitForCompleted(service);

    assert.deepEqual(factoryInputs.map((input) => input.runtimeSettings), [{
      model: "grok-4.5",
      reasoningEffort: "medium",
      permissionMode: "bypassPermissions",
      startup: {
        webSearchEnabled: false,
        planEnabled: true,
        subagentsEnabled: false,
        maxTurns: 256,
      },
    }]);
    assert.deepEqual(adapters[0]?.selectedModels, ["grok-4.5"]);
    assert.deepEqual(adapters[0]?.selectedModes, [{
      model: "grok-4.5",
      reasoningEffort: "medium",
    }]);

    const adapterStateBeforeNoOp = adapters[0]?.state;
    const unchanged = await service.setRuntimeSettings(
      "grok-4.5",
      "medium",
      "bypassPermissions",
      {
        webSearchEnabled: false,
        planEnabled: true,
        subagentsEnabled: false,
        maxTurns: 256,
      },
    );
    assert.equal(unchanged.runtimeSettings.permissionMode, "bypassPermissions");
    assert.equal(adapters[0]?.state, adapterStateBeforeNoOp);

    const running = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    assert.equal((await service.bootstrap()).runtimeSettings.canChange, false);
    await assert.rejects(
      service.setRuntimeSettings("grok-4.6", "high", "default", {
        webSearchEnabled: true,
        planEnabled: true,
        subagentsEnabled: true,
        maxTurns: null,
      }),
      /runtime_settings_change_unavailable/,
    );
    await service.cancelRun(task.task.taskId, startedRunId(running));
    await waitForRunState(service, "cancelled");

    await service.close();
    services.splice(services.indexOf(service), 1);
    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(reopened);
    assert.deepEqual((await reopened.bootstrap()).runtimeSettings, {
      model: "grok-4.5",
      reasoningEffort: "medium",
      permissionMode: "bypassPermissions",
      availableModels: GUILD_GROK_MODELS,
      availablePermissionModes: GUILD_GROK_PERMISSION_MODES,
      startup: {
        webSearchEnabled: false,
        planEnabled: true,
        subagentsEnabled: false,
        maxTurns: 256,
      },
      canChange: true,
    });
  });

  it("branches, exports, searches, and opens only task-owned local resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-artifacts-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "note.txt"), "workspace note", "utf8");
    const exports: Array<{ readonly filename: string; readonly contents: string }> = [];
    const terminals: string[] = [];
    const files: string[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
      saveTaskExport: async ({ suggestedFilename, contents }) => {
        exports.push({ filename: suggestedFilename, contents });
        return "saved";
      },
      openWorkspaceTerminal: async (path) => { terminals.push(path); },
      openTaskFile: async (path) => { files.push(path); },
    });
    services.push(service);

    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "LOCAL-TRANSCRIPT-NEEDLE");
    await waitForCompleted(service);
    const firstTurn = await service.openTask(task.task.taskId);
    const firstUserSequence = firstTurn.timeline.find(
      (item) => item.kind === "user",
    )?.sequence;
    assert.equal(typeof firstUserSequence, "number");

    const search = await service.searchConversations("transcript-needle");
    assert.equal(search.results[0]?.taskId, task.task.taskId);
    assert.equal(search.results[0]?.sequence, firstUserSequence);
    assert.match(search.results[0]?.snippet ?? "", /LOCAL-TRANSCRIPT-NEEDLE/iu);
    assert.deepEqual(await service.exportTask(task.task.taskId, "markdown"), { status: "saved" });
    assert.match(exports[0]?.filename ?? "", /\.md$/u);
    assert.match(exports[0]?.contents ?? "", /LOCAL-TRANSCRIPT-NEEDLE/u);

    await service.openTaskResource(task.task.taskId, "terminal");
    await service.openTaskResource(task.task.taskId, "file", join(workspace, "note.txt"));
    assert.deepEqual(terminals, [await realpath(workspace)]);
    assert.deepEqual(files, [await realpath(join(workspace, "note.txt"))]);
    await assert.rejects(
      service.openTaskResource(task.task.taskId, "file", join(root, "outside.txt")),
    );

    const branch = await service.forkTask(task.task.taskId, firstUserSequence);
    assert.notEqual(branch.task.taskId, task.task.taskId);
    assert.equal(branch.timeline.some((item) => item.kind === "user" && item.text === "LOCAL-TRANSCRIPT-NEEDLE"), true);
    assert.equal(branch.timeline.some((item) => item.kind === "assistant"), false);
    assert.equal(branch.timeline.some((item) => item.kind === "notice"), true);
  });

  it("applies ACP-reported session config options and rejects invented values", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-config-options-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const configOptions = Object.freeze([
      Object.freeze({ id: "web-search", name: "Web search", type: "boolean" as const, currentValue: true }),
      Object.freeze({
        id: "style",
        name: "Style",
        type: "select" as const,
        currentValue: "concise",
        choices: Object.freeze({
          form: "flat" as const,
          options: Object.freeze([
            Object.freeze({ value: "concise", name: "Concise" }),
            Object.freeze({ value: "detailed", name: "Detailed" }),
          ]),
        }),
      }),
    ]);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ configOptions }], (adapter) => adapters.push(adapter)),
    });
    services.push(service);
    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    const connected = await service.loadSlashCommands(task.task.taskId);
    assert.deepEqual(connected.sessionConfigOptions, configOptions);

    const updated = await service.setSessionConfigOption(task.task.taskId, "web-search", false);
    assert.equal(updated.sessionConfigOptions[0]?.currentValue, false);
    assert.deepEqual(adapters[0]?.selectedConfigOptions, [{ configId: "web-search", value: false }]);
    await assert.rejects(
      service.setSessionConfigOption(task.task.taskId, "style", "invented"),
      /session_config_value_unavailable/u,
    );
  });

  it("runs two turns and resumes the exact task after a clean desktop restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const runtimeFactory = fakeRuntimeFactory();

    const first = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(first);

    const withWorkspace = await first.chooseWorkspace();
    assert.equal(withWorkspace.workspaces.length, 1);
    const task = await first.createTask(withWorkspace.workspaces[0]!.workspaceId);

    await first.sendMessage(task.task.taskId, "first");
    const firstCompleted = await waitForCompleted(first);
    assert.equal(firstCompleted.workspaces[0]?.tasks[0]?.title, "first");
    assert.deepEqual(
      firstCompleted.activeTask?.timeline
        .filter((item) => item.kind === "assistant")
        .map((item) => item.kind === "assistant" ? item.text : ""),
      ["reply:first"],
    );

    await first.sendMessage(task.task.taskId, "second");
    const secondCompleted = await waitForCompleted(first, 2);
    assert.deepEqual(
      secondCompleted.activeTask?.timeline
        .filter((item) => item.kind === "assistant")
        .map((item) => item.kind === "assistant" ? item.text : ""),
      ["reply:first", "reply:second"],
    );

    await first.setDraft(task.task.taskId, "unsent draft");
    assert.equal((await first.bootstrap()).activeTask?.draft, "unsent draft");

    await first.close();
    services.splice(services.indexOf(first), 1);
    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-2"),
      chooseWorkspace: async () => undefined,
      runtimeFactory,
    });
    services.push(reopened);
    const restored = await reopened.bootstrap();
    assert.equal(restored.activeTask?.timeline.length, 4);
    assert.equal(restored.activeTask?.draft, "unsent draft");

    await reopened.sendMessage(task.task.taskId, "unsent draft");
    const thirdCompleted = await waitForCompleted(reopened, 3);
    assert.equal(thirdCompleted.activeTask?.draft, "");
    assert.deepEqual(
      thirdCompleted.activeTask?.timeline
        .filter((item) => item.kind === "assistant")
        .map((item) => item.kind === "assistant" ? item.text : ""),
      ["reply:first", "reply:second", "reply:unsent draft"],
    );
  });

  it("starts the next turn when the previous prompt hangs after terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-prompt-hang-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
      promptSettleMs: 40,
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "hold-after-terminal");
    const firstCompleted = await waitForCompleted(service);
    assert.equal(
      firstCompleted.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:hold-after-terminal",
      ),
      true,
    );

    const started = Date.now();
    const second = await service.sendMessage(task.task.taskId, "after-hung-prompt");
    assert.equal(second.status, "started");
    assert.ok(Date.now() - started < 1_000, "second send stayed blocked on the hung prompt");
    const completed = await waitForCompleted(service, 2);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-hung-prompt",
      ),
      true,
    );
  });

  it("persists nickname, copied avatar, and general settings across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-profile-"));
    const workspace = join(root, "Workspace");
    const mediaRoot = join(root, "media");
    await mkdir(workspace);
    const source = join(root, "11111111-1111-4111-8111-111111111111.png");
    await writeFile(source, Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    ));
    const opened: string[] = [];
    const first = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      mediaRoot,
      chooseWorkspace: async () => workspace,
      chooseAvatarFile: async () => source,
      openUserData: async () => {
        opened.push(root);
      },
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    assert.equal(bootstrapped.profile.nickname, "BDV");
    assert.equal(bootstrapped.profile.avatarGrantUrl, undefined);
    assert.equal(bootstrapped.generalSettings.restoreLastTask, true);
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const chosen = await first.chooseAvatar();
    assert.equal(chosen.status, "selected");
    if (chosen.status !== "selected") throw new Error("avatar not selected");
    await writeFile(source, "deleted-original");
    const saved = await first.saveProfile(" 小云 ", { previewToken: chosen.previewToken });
    assert.equal(saved.profile.nickname, "小云");
    assert.match(saved.profile.avatarGrantUrl ?? "", /^guild-media:\/\/media\/.+\.png$/u);
    const general = await first.setGeneralSettings(false, "last", false, false);
    assert.equal(general.generalSettings.restoreLastTask, false);
    assert.equal(general.generalSettings.newTaskWorkspaceMode, "last");
    assert.equal(general.browserSyncEnabled, false);
    assert.equal(general.generalSettings.taskNotificationsEnabled, false);
    assert.equal(general.generalSettings.lastWorkspaceId, bootstrapped.workspaces[0]?.workspaceId);
    await first.openUserData();
    assert.deepEqual(opened, [root]);
    await first.close();
    services.splice(services.indexOf(first), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging-2"),
      mediaRoot,
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(reopened);
    const restored = await reopened.bootstrap();
    assert.equal(restored.profile.nickname, "小云");
    assert.equal(restored.profile.avatarGrantUrl, saved.profile.avatarGrantUrl);
    assert.equal(restored.generalSettings.restoreLastTask, false);
    assert.equal(restored.generalSettings.newTaskWorkspaceMode, "last");
    assert.equal(restored.generalSettings.taskNotificationsEnabled, false);
    assert.equal(restored.activeTask, undefined);
    const reset = await reopened.saveProfile("BDV", "reset");
    assert.equal(reset.profile.avatarGrantUrl, undefined);
    await assert.rejects(reopened.saveProfile("\nnope", "keep"));
    const tooLarge = join(root, "huge.png");
    await writeFile(tooLarge, Buffer.alloc(5 * 1024 * 1024 + 12, 0x89));
    const oversized = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild-2.sqlite3"),
      stagingRoot: join(root, "staging-3"),
      mediaRoot: join(root, "media-2"),
      chooseWorkspace: async () => undefined,
      chooseAvatarFile: async () => tooLarge,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(oversized);
    assert.deepEqual(await oversized.chooseAvatar(), {
      status: "rejected",
      reason: "too_large",
    });
    const fakeImage = join(root, "fake.png");
    await writeFile(fakeImage, "png-extension-but-not-an-image");
    const disguised = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild-3.sqlite3"),
      stagingRoot: join(root, "staging-4"),
      mediaRoot: join(root, "media-3"),
      chooseWorkspace: async () => undefined,
      chooseAvatarFile: async () => fakeImage,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(disguised);
    assert.deepEqual(await disguised.chooseAvatar(), {
      status: "rejected",
      reason: "unsupported_type",
    });
    void task;
  });

  it("reconciles an orphaned persisted run before the first bootstrap", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-orphaned-startup-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const setup = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-setup"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(setup);
    const bootstrapped = await setup.chooseWorkspace();
    const task = await setup.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await setup.close();
    services.splice(services.indexOf(setup), 1);

    const store = openGuildPersistence({ path: databasePath });
    const attemptId = testMust(parseSessionAttemptId("orphaned-attempt"));
    const sessionId = testMust(parseSessionId("orphaned-session"));
    const adapterEpoch = testMust(parseAdapterEpoch(1));
    const runId = testMust(parseRunId("orphaned-run"));
    const started = store.applySessionBinding({
      taskId: task.task.taskId,
      event: {
        type: "start_session",
        attemptId,
        idempotencyKey: testKey("orphaned-session-start"),
      },
    });
    assert.equal(started.ok, true, started.ok ? "" : started.reason);
    const established = store.applySessionBinding({
      taskId: task.task.taskId,
      event: {
        type: "session_new_succeeded",
        sessionId,
        adapterEpoch,
        attemptId,
        idempotencyKey: testKey("orphaned-session-established"),
      },
    });
    assert.equal(established.ok, true, established.ok ? "" : established.reason);
    store.createRun({ taskId: task.task.taskId, runId });
    const dispatched = store.applyRun({
      taskId: task.task.taskId,
      runId,
      event: {
        type: "scheduler_dispatch",
        sessionId,
        adapterEpoch,
        idempotencyKey: testKey("orphaned-run-dispatch"),
      },
    });
    assert.equal(dispatched.ok, true, dispatched.ok ? "" : dispatched.reason);
    store.commitAdapterEpoch({
      taskId: task.task.taskId,
      sessionId,
      adapterEpoch,
      expectedRevision: 0,
      status: "alive",
    });
    const accepted = store.commitPromptAccepted({
      taskId: task.task.taskId,
      runId,
      sessionId,
      adapterEpoch,
      promptSequence: 1,
      idempotencyKey: testKey("orphaned-prompt-accepted"),
    });
    assert.equal(accepted.run.state, "running");
    store.close();

    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory([{ sessionId: "orphaned-session" }]),
    });
    services.push(reopened);
    const recovered = await reopened.bootstrap();
    assert.equal(recovered.activeTask?.task.activeRunState, "interrupted");
    assert.equal(recovered.activeTask?.canSend, true);

    await reopened.sendMessage(task.task.taskId, "after-orphaned-restart");
    const completed = await waitForCompleted(reopened);
    assert.equal(completed.activeTask?.task.activeRunState, "completed");
  });

  it("keeps unrelated task navigation responsive during cold runtime startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-cold-start-navigation-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ startDelayMs: 150 }]),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const first = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.setDraft(first.task.taskId, "cold-start");
    let sendResolved = false;
    const sending = service.sendMessage(first.task.taskId, "cold-start").then((result) => {
      sendResolved = true;
      return result;
    });

    await service.setDraft(first.task.taskId, "follow-up draft");
    const second = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const opened = await service.openTask(second.task.taskId);
    assert.equal(opened.task.taskId, second.task.taskId);
    assert.equal(sendResolved, false);
    await sending;
    assert.equal((await service.bootstrap()).activeTask?.task.taskId, second.task.taskId);

    await service.openTask(first.task.taskId);
    const completed = await waitForCompleted(service);
    assert.equal(completed.activeTask?.draft, "follow-up draft");
  });

  it("revalidates a session that drops after cold start before dispatching the send", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-send-session-race-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(
        [{ sessionId: "stale-session" }, { sessionId: "stale-session" }],
        (adapter) => adapters.push(adapter),
      ),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    let interrupted = false;
    const unsubscribe = service.subscribe((projection) => {
      if (
        interrupted ||
        adapters.length !== 1 ||
        projection.activeTask?.task.taskId !== task.task.taskId ||
        projection.activeTask.task.activeRunState !== undefined
      ) return;
      interrupted = true;
      void adapters[0]!.close();
    });

    const sent = await service.sendMessage(task.task.taskId, "survive-session-race");
    unsubscribe();
    assert.equal(sent.status, "started");
    assert.equal(adapters.length, 2);
    const completed = await waitForCompleted(service);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:survive-session-race",
      ),
      true,
    );
  });

  it("defers an immediate follow-up until the prior adapter prompt fully settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-terminal-gap-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    let followUp: Promise<SendMessageResponse> | undefined;
    const unsubscribe = service.subscribe((projection) => {
      if (
        followUp !== undefined ||
        projection.activeTask?.task.activeRunState !== "completed" ||
        !projection.activeTask.timeline.some(
          (item) => item.kind === "assistant" && item.text === "reply:first-terminal-gap",
        )
      ) return;
      followUp = service.sendMessage(task.task.taskId, "second-terminal-gap");
    });

    await service.sendMessage(task.task.taskId, "first-terminal-gap");
    const deadline = Date.now() + 1_000;
    while (followUp === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.notEqual(followUp, undefined);
    assert.equal((await followUp!).status, "started");
    unsubscribe();
    const completed = await waitForCompleted(service, 2);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:second-terminal-gap",
      ),
      true,
    );
  });

  it("keeps navigation responsive while a queued turn reconnects in the background", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-queued-reconnect-navigation-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const first = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-first"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId: "queued-navigation-session" }]),
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    const otherTask = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(otherTask.task.taskId, "other-navigation-target");
    await waitForCompleted(first);
    const runningTask = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(runningTask.task.taskId, "wait-for-cancel");
    await waitForRunState(first, "running");
    await first.sendMessage(runningTask.task.taskId, "queued-after-reconnect");
    await first.close();
    services.splice(services.indexOf(first), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory([
        { sessionId: "queued-navigation-session", startDelayMs: 250 },
      ]),
    });
    services.push(reopened);
    await reopened.bootstrap();

    const openedAt = Date.now();
    const opened = await reopened.openTask(otherTask.task.taskId);
    const openElapsedMs = Date.now() - openedAt;
    assert.equal(opened.task.taskId, otherTask.task.taskId);
    assert.ok(openElapsedMs < 150, `queued reconnect blocked navigation for ${openElapsedMs}ms`);

    await reopened.openTask(runningTask.task.taskId);
    const completed = await waitForCompleted(reopened);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:queued-after-reconnect",
      ),
      true,
    );
  });

  it("reaps an in-flight cold runtime start without waiting for its full deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-cold-start-close-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(
        [{ startDelayMs: 10_000 }],
        (adapter) => adapters.push(adapter),
      ),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sending = service.sendMessage(task.task.taskId, "cold-start-close");
    void sending.catch(() => undefined);
    const deadline = Date.now() + 1_000;
    while (adapters.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(adapters.length, 1);

    const closeStartedAt = Date.now();
    await service.close();
    const closeElapsedMs = Date.now() - closeStartedAt;
    services.splice(services.indexOf(service), 1);
    await assert.rejects(sending);
    assert.equal(adapters[0]?.state, "closed");
    assert.ok(closeElapsedMs < 1_000, `cold close took ${closeElapsedMs}ms`);
  });

  it("fences a runtime factory that finishes after the app has resumed", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-resume-factory-race-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      markFactoryStarted = resolve;
    });
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    let firstFactory = true;
    const innerFactory = fakeRuntimeFactory([
      { sessionId: "pre-resume-session" },
      { sessionId: "post-resume-session" },
    ]);
    const runtimeFactory: RuntimeFactory = async (input) => {
      if (firstFactory) {
        firstFactory = false;
        markFactoryStarted();
        await factoryGate;
      }
      return innerFactory(input);
    };
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const staleSend = service.sendMessage(task.task.taskId, "pre-resume-send");
    void staleSend.catch(() => undefined);
    await factoryStarted;
    await service.handleLifecycleEvent("resume");
    releaseFactory();
    await assert.rejects(staleSend, /runtime_start_invalidated_by_resume/);

    await service.sendMessage(task.task.taskId, "post-resume-send");
    const completed = await waitForCompleted(service);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:post-resume-send",
      ),
      true,
    );
  });

  it("keeps a new task retryable when runtime initialization fails before session/new", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-initialize-retry-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(
        [
          { startFailure: "settings unavailable" },
          { sessionId: "retry-session" },
        ],
        (adapter) => adapters.push(adapter),
      ),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await assert.rejects(
      service.sendMessage(task.task.taskId, "first attempt"),
      /runtime_start_initialize:settings unavailable/,
    );

    const retryable = await service.bootstrap();
    assert.equal(retryable.activeTask?.sessionRecovery, "available");
    assert.equal(retryable.activeTask?.canSend, true);
    assert.equal(adapters[0]?.newSessionCalls, 0);

    await service.sendMessage(task.task.taskId, "retry after initialize failure");
    const completed = await waitForCompleted(service);
    assert.equal(completed.activeTask?.task.activeRunState, "completed");
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:retry after initialize failure",
      ),
      true,
    );
  });

  it("refuses to start the official process when the workspace folder is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-missing-folder-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const factoryCalls: string[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId: "restored-folder" }], undefined, () => {
        factoryCalls.push("created");
      }),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await rm(workspace, { recursive: true, force: true });
    await assert.rejects(
      service.sendMessage(task.task.taskId, "folder is gone"),
      /workspace_folder_missing/,
    );
    assert.deepEqual(factoryCalls, []);

    await mkdir(workspace);
    await service.sendMessage(task.task.taskId, "folder is back");
    const completed = await waitForCompleted(service);
    assert.equal(factoryCalls.length, 1);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:folder is back",
      ),
      true,
    );
  });

  it("keeps a retained session retryable when runtime setup fails before session/resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-restore-start-failure-"));
    const workspace = join(root, "Workspace");
    const databasePath = join(root, "guild.sqlite3");
    await mkdir(workspace);

    const first = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-first"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId: "retained-session" }]),
    });
    services.push(first);
    const bootstrapped = await first.chooseWorkspace();
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(task.task.taskId, "before restart");
    await waitForCompleted(first);
    await first.close();
    services.splice(services.indexOf(first), 1);

    const adapters: FakeAdapter[] = [];
    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(
        [
          { sessionId: "retained-session", startFailure: "runtime temporarily unavailable" },
          { sessionId: "retained-session" },
        ],
        (adapter) => adapters.push(adapter),
      ),
    });
    services.push(reopened);

    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "retry retained session"),
      /runtime_start_initialize:runtime temporarily unavailable/,
    );
    const retryable = await reopened.bootstrap();
    assert.equal(retryable.activeTask?.sessionRecovery, "available");
    assert.equal(retryable.activeTask?.canSend, true);

    await reopened.sendMessage(task.task.taskId, "retry retained session");
    const completed = await waitForCompleted(reopened, 2);
    assert.equal(completed.activeTask?.task.activeRunState, "completed");
    assert.equal(adapters[0]?.adapterEpoch, 2);
    assert.equal(adapters[1]?.adapterEpoch, 3);
  });

  it("interrupts a silent Grok prompt within a bound and keeps the task retryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-silence-watchdog-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
      promptSilenceMs: 25,
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "silent");
    const interrupted = await waitForRunState(service, "interrupted");
    assert.equal(
      interrupted.activeTask?.timeline.some((item) => item.kind === "error"),
      true,
    );

    await service.sendMessage(task.task.taskId, "after silence");
    const completed = await waitForCompleted(service);
    assert.equal(completed.activeTask?.task.activeRunState, "completed");
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after silence",
      ),
      true,
    );
    assert.equal(adapters.length, 2);
  });

  it("does not terminate a silent official Grok goal unless a watchdog is explicitly configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-production-silence-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.23-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "silent");
    await waitForRunState(service, "running");
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal((await service.bootstrap()).activeTask?.task.activeRunState, "running");
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancelled");
  });

  it("publishes replacement consent immediately when session/new becomes uncertain", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-session-new-failure-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(
        [{ newSessionFailure: "session response lost" }],
        (adapter) => adapters.push(adapter),
      ),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    let latestProjection = await service.bootstrap();
    const unsubscribe = service.subscribe((projection) => {
      latestProjection = projection;
    });
    await assert.rejects(
      service.sendMessage(task.task.taskId, "uncertain session"),
      /runtime_start_session_new:session response lost/,
    );
    unsubscribe();

    assert.equal(adapters[0]?.newSessionCalls, 1);
    assert.equal(latestProjection.activeTask?.sessionRecovery, "replacement_required");
    assert.equal(latestProjection.activeTask?.canSend, false);
  });

  it("aborts an in-flight official usage refresh during close", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-usage-close-"));
    let aborted = false;
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
      usageFetcher: async (signal) => new Promise((_, reject) => {
        const abort = () => {
          aborted = true;
          reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    });
    services.push(service);

    const refreshing = service.refreshUsage();
    void refreshing.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.close();
    services.splice(services.indexOf(service), 1);
    await assert.rejects(refreshing);
    assert.equal(aborted, true);
  });

  it("keeps one completed projection when a tool sends sparse follow-up updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-tools-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "tool");
    const completed = await waitForCompleted(service);
    const tools = completed.activeTask?.timeline.filter((item) => item.kind === "tool") ?? [];
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.kind, "tool");
    if (tools[0]?.kind !== "tool") assert.fail("missing tool projection");
    assert.equal(tools[0].title, "Read package");
    assert.equal(tools[0].toolStatus, "completed");
    assert.equal(tools[0].content.length, 1);
    assert.equal(tools[0].content[0]?.type, "text");
    if (tools[0].content[0]?.type !== "text") assert.fail("missing tool text content");
    assert.equal(tools[0].content[0].text, "package.json");
  });

  it("keeps sidebar and timeline activity aligned to the latest overlapping tool update", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-overlapping-tools-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "overlapping-tools-wait");
    let projection = await service.bootstrap();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const summary = projection.workspaces
        .flatMap((workspaceProjection) => workspaceProjection.tasks)
        .find((candidate) => candidate.taskId === task.task.taskId);
      if (summary?.activeActivity === "reading") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      projection = await service.bootstrap();
    }
    const summary = projection.workspaces
      .flatMap((workspaceProjection) => workspaceProjection.tasks)
      .find((candidate) => candidate.taskId === task.task.taskId);
    assert.equal(summary?.activeActivity, "reading");
    const activeTools = projection.activeTask?.timeline.filter(
      (item) => item.kind === "tool" && (item.toolStatus === "pending" || item.toolStatus === "in_progress"),
    ) ?? [];
    const latestActiveTool = activeTools.at(-1);
    assert.equal(latestActiveTool?.kind, "tool");
    if (latestActiveTool?.kind !== "tool") assert.fail("missing active tool");
    assert.equal(latestActiveTool.toolKind, "read");

    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancelled");
  });

  it("projects worker activity for /goal without persisting child-authored text", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-auxiliary-goal-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.23-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "/goal auxiliary");
    let projection = await service.bootstrap();
    for (
      let attempt = 0;
      attempt < 50 && (
        projection.activeTask?.auxiliaryActivity?.activity !== "searching" ||
        !projection.activeTask.auxiliaryActivity.toolKinds.includes("search")
      );
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      projection = await service.bootstrap();
    }
    assert.deepEqual(projection.activeTask?.auxiliaryActivity, {
      activity: "searching",
      startedAtMs: projection.activeTask?.auxiliaryActivity?.startedAtMs,
      workerCount: 1,
      toolKinds: ["search"],
    });
    assert.equal(
      projection.activeTask?.timeline.some(
        (item) => (item.kind === "assistant" || item.kind === "thought") && item.text.includes("worker-private"),
      ),
      false,
    );

    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancelled");
  });

  it("keeps an active concrete tool ahead of a later plan refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-overlapping-plan-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "overlapping-plan-wait");
    let projection = await service.bootstrap();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const summary = projection.workspaces
        .flatMap((workspaceProjection) => workspaceProjection.tasks)
        .find((candidate) => candidate.taskId === task.task.taskId);
      const hasPlan = projection.activeTask?.timeline.some(
        (item) => item.kind === "tool" && item.toolCallId?.startsWith("plan:"),
      ) === true;
      if (summary?.activeActivity === "reading" && hasPlan) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      projection = await service.bootstrap();
    }
    const summary = projection.workspaces
      .flatMap((workspaceProjection) => workspaceProjection.tasks)
      .find((candidate) => candidate.taskId === task.task.taskId);
    assert.equal(summary?.activeActivity, "reading");
    const activeTools = projection.activeTask?.timeline.filter(
      (item) => item.kind === "tool" && (item.toolStatus === "pending" || item.toolStatus === "in_progress"),
    ) ?? [];
    assert.equal(activeTools.some((item) => item.kind === "tool" && item.toolKind === "read"), true);
    assert.equal(activeTools.some((item) => item.kind === "tool" && item.toolCallId?.startsWith("plan:")), true);

    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancelled");
  });

  it("keeps official plan steps available inside the tool disclosure", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-plan-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "plan");
    const completed = await waitForCompleted(service);
    const plan = completed.activeTask?.timeline.find(
      (item) => item.kind === "tool" && item.title === "计划",
    );
    assert.equal(plan?.kind === "tool" ? plan.runtimeReplayKind : undefined, "plan");
    if (plan?.kind !== "tool") assert.fail("missing plan projection");
    assert.equal(plan.content.length, 1);
    assert.equal(plan.content[0]?.type, "text");
    if (plan.content[0]?.type !== "text") assert.fail("missing plan text content");
    assert.equal(plan.content[0].text, "Inspect\nFix\nVerify");
  });

  it("persists a legal large ACP plan without overflowing conversation metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-large-plan-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "large-plan");
    const completed = await waitForCompleted(service);
    const plan = completed.activeTask?.timeline.find(
      (item) => item.kind === "tool" && item.runtimeReplayKind === "plan",
    );
    assert.equal(plan?.kind, "tool");
    if (plan?.kind === "tool") {
      assert.equal(plan.content[0]?.type, "text");
      assert.equal(plan.content[0]?.type === "text" ? plan.content[0].text.length : 0, 40_001);
    }
  });

  it("persists bounded runtime media behind an opaque Guild media grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-media-"));
    const workspace = join(root, "Workspace");
    const mediaRoot = join(root, "media");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      mediaRoot,
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "media");
    const completed = await waitForCompleted(service);
    const media = completed.activeTask?.timeline.find((item) => item.kind === "media");
    if (media?.kind !== "media") assert.fail("missing media projection");
    assert.equal(media.mediaType, "image");
    assert.equal(media.mimeType, "image/png");
    const grant = new URL(media.grantUrl);
    assert.equal(grant.protocol, "guild-media:");
    assert.equal(grant.hostname, "media");
    const bytes = await readFile(join(mediaRoot, grant.pathname.slice(1)));
    assert.equal(bytes.toString("base64"), TEST_PNG_BASE64);
  });

  it("materializes tool-returned and workspace-located images as opaque View Image grants [D-051]", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-tool-media-"));
    const workspace = join(root, "Workspace");
    const mediaRoot = join(root, "media");
    await mkdir(workspace);
    const locatedImage = join(workspace, "viewed.png");
    await writeFile(locatedImage, Buffer.from(TEST_PNG_BASE64, "base64"));
    const service = createLiveDesktopService({
      appVersion: "2.1.4-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      mediaRoot,
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const first = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(first.task.taskId, "tool-image");
    const returned = await waitForCompleted(service);
    const returnedTool = returned.activeTask?.timeline.find((item) => item.kind === "tool");
    if (returnedTool?.kind !== "tool") assert.fail("missing returned-image tool");
    const returnedMedia = returnedTool.content.find((item) => item.type === "media");
    if (returnedMedia?.type !== "media") assert.fail("missing returned-image grant");
    assert.equal(returnedMedia.alt, "preview.png");
    assert.match(returnedMedia.grantUrl, /^guild-media:\/\/media\/[0-9a-f-]+\.png$/u);
    assert.equal(
      (await readFile(join(mediaRoot, new URL(returnedMedia.grantUrl).pathname.slice(1)))).toString("base64"),
      TEST_PNG_BASE64,
    );

    const second = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(second.task.taskId, `tool-location-image:${locatedImage}`);
    const located = await waitForCompleted(service);
    const locatedTool = located.activeTask?.timeline.find((item) => item.kind === "tool");
    if (locatedTool?.kind !== "tool") assert.fail("missing located-image tool");
    const locatedMedia = locatedTool.content.find((item) => item.type === "media");
    if (locatedMedia?.type !== "media") assert.fail("missing located-image grant");
    assert.equal(locatedMedia.alt, "viewed.png");
    assert.equal(locatedMedia.grantUrl.includes(workspace), false);

    const outsideImage = join(root, "outside.png");
    await writeFile(outsideImage, Buffer.from(TEST_PNG_BASE64, "base64"));
    const third = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(third.task.taskId, `tool-location-image:${outsideImage}`);
    const rejected = await waitForCompleted(service);
    const rejectedTool = rejected.activeTask?.timeline.find((item) => item.kind === "tool");
    if (rejectedTool?.kind !== "tool") assert.fail("missing outside-workspace tool");
    assert.equal(rejectedTool.content.some((item) => item.type === "media"), false);
  });

  it("projects only official ACP context-window usage and never estimates it", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-context-window-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    assert.deepEqual(task.contextWindow, { status: "unavailable" });

    await service.sendMessage(task.task.taskId, "context-usage");
    const completed = await waitForCompleted(service);
    assert.deepEqual(completed.activeTask?.contextWindow, {
      status: "available",
      used: 81_920,
      size: 262_144,
    });
  });

  it("loads native slash commands on explicit demand without sending a prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-slash-commands-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    let runtimeStarts = 0;
    const service = createLiveDesktopService({
      appVersion: "2.0.2-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(
        [{ availableCommands: [
          { name: "context", description: "Show context" },
          { name: "plan", description: "Create a plan", inputHint: "topic" },
        ] }],
        (adapter) => {
          adapters.push(adapter);
          runtimeStarts += 1;
        },
      ),
    });
    services.push(service);

    const selected = await service.chooseWorkspace();
    const task = await service.createTask(selected.workspaces[0]!.workspaceId);
    assert.deepEqual(task.availableCommands, []);
    assert.equal(runtimeStarts, 0);

    const loaded = await service.loadSlashCommands(task.task.taskId);
    assert.deepEqual(loaded.availableCommands, [
      { name: "context", description: "Show context" },
      { name: "plan", description: "Create a plan", inputHint: "topic" },
    ]);
    assert.deepEqual(loaded.timeline, []);
    assert.equal(runtimeStarts, 1);
    assert.equal(adapters[0]?.newSessionCalls, 1);

    await service.loadSlashCommands(task.task.taskId);
    assert.equal(runtimeStarts, 1);
    assert.equal(adapters[0]?.newSessionCalls, 1);
  });

  it("pages earlier history into a long active task without truncating the live tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-history-pages-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const setup = createLiveDesktopService({
      appVersion: "2.0.2-test",
      databasePath,
      stagingRoot: join(root, "staging-setup"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(setup);
    const bootstrapped = await setup.chooseWorkspace();
    const task = await setup.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await setup.close();
    services.splice(services.indexOf(setup), 1);

    const store = openGuildPersistence({ path: databasePath });
    for (let index = 1; index <= 650; index += 1) {
      store.createConversationEntry({
        taskId: task.task.taskId,
        entryId: `history-${String(index).padStart(4, "0")}`,
        kind: "tool",
        text: `tool-update-${index}`,
        metadata: {
          toolCallId: `call-${Math.ceil(index / 5)}`,
          title: `tool-${Math.ceil(index / 5)}`,
          toolKind: "read",
          toolStatus: "completed",
          content: [],
        },
        status: "complete",
      });
    }
    store.close();

    const service = createLiveDesktopService({
      appVersion: "2.0.2-test",
      databasePath,
      stagingRoot: join(root, "staging-reopen"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);
    const initial = (await service.bootstrap()).activeTask;
    assert.equal(initial?.timeline.length, 100);
    assert.equal(initial?.timeline[0]?.kind === "tool" ? initial.timeline[0].toolCallId : "", "call-31");
    assert.equal(initial?.hasEarlierTimeline, true);

    const expanded = await service.loadEarlierTimeline(task.task.taskId);
    assert.equal(expanded.timeline.length, 130);
    assert.equal(expanded.timeline[0]?.kind === "tool" ? expanded.timeline[0].toolCallId : "", "call-1");
    const last = expanded.timeline.at(-1);
    assert.equal(last?.kind === "tool" ? last.toolCallId : "", "call-130");
    assert.equal(expanded.hasEarlierTimeline, false);

    // A fresh renderer has no retained timeline cache. Bootstrap and opening a
    // previously evicted task must restore every page already requested.
    const reloaded = (await service.bootstrap()).activeTask!;
    assert.equal(reloaded.timeline.length, 130);
    assert.equal(reloaded.hasEarlierTimeline, false);
    const reopened = await service.openTask(task.task.taskId);
    assert.equal(reopened.timeline.length, 130);
    const exhausted = await service.loadEarlierTimeline(task.task.taskId);
    assert.equal(exhausted.timeline.length, 130);
    let pushedLength = 0;
    const unsubscribe = service.subscribe((projection) => {
      pushedLength = projection.activeTask?.timeline.length ?? 0;
    });
    await service.setLocale("en-US");
    unsubscribe();
    assert.equal(pushedLength, 100, "streaming projections must stay bounded");

    await service.sendMessage(task.task.taskId, "continue-after-history-load");
    const continued = await waitForCompleted(service);
    assert.equal((continued.activeTask?.timeline.length ?? 500) < 200, true);
    assert.equal(continued.activeTask?.hasEarlierTimeline, false);
  });

  it("projects exact official Grok context occupancy when ACP omits the window size", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-context-tokens-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "context-used-only");
    const completed = await waitForCompleted(service);
    assert.deepEqual(completed.activeTask?.contextWindow, {
      status: "used_only",
      used: 25_523,
    });
  });

  it("combines official Grok model capacity with terminal token occupancy", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-grok-context-capacity-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ contextWindowSize: 500_000 }]),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "context-used-only");
    const completed = await waitForCompleted(service);
    assert.deepEqual(completed.activeTask?.contextWindow, {
      status: "available",
      used: 25_523,
      size: 500_000,
    });

    await service.close();
    services.splice(services.indexOf(service), 1);
    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(reopened);
    assert.deepEqual((await reopened.bootstrap()).activeTask?.contextWindow, {
      status: "available",
      used: 25_523,
      size: 500_000,
    });
  });

  it("publishes terminal token occupancy when it arrives during an in-flight projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-context-publish-race-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ contextWindowSize: 500_000 }]),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    let latest = await service.bootstrap();
    const unsubscribe = service.subscribe((projection) => {
      latest = projection;
    });
    await service.sendMessage(task.task.taskId, "context-publish-race");
    await waitForCompleted(service);
    await new Promise((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    assert.deepEqual(latest.activeTask?.contextWindow, {
      status: "available",
      used: 25_523,
      size: 500_000,
    });
  });

  it("keeps a standard ACP window size when exact prompt metadata updates used tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-context-combined-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "context-usage-and-terminal");
    const completed = await waitForCompleted(service);
    assert.deepEqual(completed.activeTask?.contextWindow, {
      status: "available",
      used: 25_523,
      size: 262_144,
    });
  });

  it("projects a stale streaming thought as completed after its Run is terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-stale-thought-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const service = createLiveDesktopService({
      appVersion: "2.0.33-test",
      databasePath,
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "finish-before-stale-thought");
    await waitForCompleted(service);
    await service.close();
    services.splice(services.indexOf(service), 1);

    const persisted = openGuildPersistence({ path: databasePath });
    persisted.createConversationEntry({
      taskId: task.task.taskId,
      runId: startedRunId(sent),
      entryId: "stale-streaming-thought",
      kind: "thought",
      text: "completed work must not keep counting",
      metadata: { startedAtMs: 1 },
      status: "streaming",
    });
    persisted.close();

    const reopened = createLiveDesktopService({
      appVersion: "2.0.33-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(reopened);
    await reopened.bootstrap();
    const projection = await reopened.openTask(task.task.taskId);
    const thought = projection.timeline.find(
      (item) => item.entryId === "stale-streaming-thought",
    );
    assert.equal(thought?.kind, "thought");
    assert.equal(thought?.status, "completed");
  });

  it("cancels an active turn and leaves the task ready for another message", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-cancel-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    const cancelled = await waitForRunState(service, "cancelled");
    assert.equal(cancelled.activeTask?.canSend, true);
    const thought = cancelled.activeTask?.timeline.find((item) => item.kind === "thought");
    assert.equal(thought?.status, "cancelled");
  });

  it("does not hold unrelated commands behind a slow cancellation write", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-cancel-command-lock-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    let releaseCancel!: () => void;
    adapters[0]!.cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const cancelling = service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancel_requested");
    await Promise.race([
      service.setDraft(task.task.taskId, "draft while cancelling"),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("draft command blocked behind cancellation")),
        150,
      )),
    ]);
    releaseCancel();
    await cancelling;
    await waitForRunState(service, "cancelled");
  });

  it("falls back to closing the runtime when the cancellation write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-cancel-write-failure-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
      cancelGraceMs: 15,
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    adapters[0]!.cancelFailure = new Error("fake cancellation write failed");
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    const cancelled = await waitForRunState(service, "cancelled");
    assert.equal(cancelled.activeTask?.canSend, true);
  });

  it("keeps the runtime healthy when natural completion wins the cancel-sent race", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-cancel-terminal-race-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "terminal-before-cancel-sent");
    await waitForRunState(service, "running");
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "completed");
    assert.equal(adapters[0]!.cancelSinkFailures, 0);
    assert.equal(adapters[0]!.state, "ready");

    await service.sendMessage(task.task.taskId, "after-cancel-terminal-race");
    const completed = await waitForCompleted(service);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-cancel-terminal-race",
      ),
      true,
    );
    assert.equal(adapters.length, 1);
  });

  it("preempts the active Run and dispatches the selected queued turn before older follow-ups", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-queue-preempt-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    await service.sendMessage(task.task.taskId, "older-follow-up");
    const selected = await service.sendMessage(task.task.taskId, "take-over-now");
    assert.equal(selected.status, "queued");
    if (selected.status !== "queued") assert.fail("preempt fixture was not queued");

    let releaseCancel!: () => void;
    adapters[0]!.cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const preempting = service.preemptQueuedTurn(task.task.taskId, selected.queueId);
    const requested = await waitForRunState(service, "cancel_requested");
    assert.deepEqual(
      requested.activeTask?.queuedTurns.map((queued) => queued.text),
      ["take-over-now", "older-follow-up"],
    );
    releaseCancel();
    await preempting;

    const completed = await waitForCompleted(service, 2);
    assert.deepEqual(
      adapters[0]!.prompts.map((prompt) => prompt.text),
      ["wait-for-cancel", "take-over-now", "older-follow-up"],
    );
    assert.equal(completed.activeTask?.queuedTurns.length, 0);
    assert.equal(
      completed.activeTask?.timeline.some((item) => item.status === "cancelled"),
      true,
    );
  });

  it("persists a queued follow-up across restart and dispatches it only after the active Run terminates", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-queue-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const runtimeFactory = fakeRuntimeFactory();
    const first = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(first, "running");
    const queued = await first.sendMessage(task.task.taskId, "queued-after-restart");
    assert.equal(queued.status, "queued");
    const beforeRestart = await first.bootstrap();
    assert.deepEqual(
      beforeRestart.activeTask?.queuedTurns.map((turn) => turn.text),
      ["queued-after-restart"],
    );
    assert.equal(
      beforeRestart.activeTask?.timeline.some(
        (item) => item.kind === "user" && item.text === "queued-after-restart",
      ),
      false,
    );

    await first.close();
    services.splice(services.indexOf(first), 1);
    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory,
    });
    services.push(reopened);
    const restored = await reopened.bootstrap();
    assert.equal(restored.activeTask?.queuedTurns.length, 1);
    const completed = await waitForCompleted(reopened);
    assert.equal(completed.activeTask?.queuedTurns.length, 0);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:queued-after-restart",
      ),
      true,
    );
  });

  it("keeps a new send behind older persisted queued turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-queue-fifo-restart-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const first = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-first"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(first, "running");
    assert.equal((await first.sendMessage(task.task.taskId, "older-queued-turn")).status, "queued");
    await first.close();
    services.splice(services.indexOf(first), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(reopened);

    const newer = await reopened.sendMessage(task.task.taskId, "newer-send");
    assert.equal(newer.status, "queued");
    const completed = await waitForCompleted(reopened, 2);
    assert.deepEqual(
      completed.activeTask?.timeline
        .flatMap((item) => item.kind === "assistant" ? [item.text] : []),
      ["reply:older-queued-turn", "reply:newer-send"],
    );
  });

  it("forces a stuck runtime closed after the cancel grace period and can resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-forced-cancel-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
      cancelGraceMs: 15,
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "ignore-cancel");
    await waitForRunState(service, "running");
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    const cancelled = await waitForRunState(service, "cancelled");
    assert.equal(cancelled.activeTask?.canSend, true);

    await service.sendMessage(task.task.taskId, "after-forced-cancel");
    const resumed = await waitForCompleted(service);
    assert.equal(
      resumed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-forced-cancel",
      ),
      true,
    );
  });

  it("recovers from wake by fencing the old runtime and reopening the exact task", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-wake-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "ignore-cancel");
    await waitForRunState(service, "running");
    await service.handleLifecycleEvent("suspend");
    assert.equal((await service.bootstrap()).activeTask?.task.activeRunState, "running");
    await service.handleLifecycleEvent("resume");
    const recovered = await waitForRunState(service, "interrupted");
    assert.equal(recovered.activeTask?.canSend, true);
    const diagnostics = await waitForText(
      join(root, "diagnostics", "runtime.jsonl"),
      "os_resume",
    );
    assert.match(
      diagnostics,
      /"category":"recovery","event":"os_suspend","reason":"system_power_event"[\s\S]*"category":"recovery","event":"os_resume","reason":"system_power_event"/u,
    );

    await service.sendMessage(task.task.taskId, "after-wake");
    const resumed = await waitForCompleted(service);
    assert.equal(
      resumed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-wake",
      ),
      true,
    );
  });

  it("keeps the main-owned runtime live across a renderer reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-renderer-reload-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    await service.handleLifecycleEvent("renderer_reload");
    const preserved = await service.bootstrap();
    assert.equal(preserved.activeTask?.task.activeRunState, "running");
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    const cancelled = await waitForRunState(service, "cancelled");
    assert.equal(cancelled.activeTask?.canSend, true);

    await service.sendMessage(task.task.taskId, "after-renderer-reload");
    const resumed = await waitForCompleted(service);
    assert.equal(
      resumed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-renderer-reload",
      ),
      true,
    );
  });

  it("terminalizes an accepted Run when prompt rejection wins the transport-interruption race", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-transport-race-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "reject-after-accept");
    const interrupted = await waitForRunState(service, "interrupted");
    assert.equal(interrupted.activeTask?.canSend, true);
    assert.equal(
      interrupted.activeTask?.timeline.some(
        (item) => item.kind === "thought" && item.status === "interrupted",
      ),
      true,
    );

    await service.sendMessage(task.task.taskId, "after-transport-race");
    const resumed = await waitForCompleted(service);
    assert.equal(
      resumed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-transport-race",
      ),
      true,
    );
  });

  it("does not label a written prompt safe to resend when acceptance persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-acceptance-sink-failure-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "acceptance-sink-failure");
    const interrupted = await waitForRunState(service, "interrupted");
    const error = interrupted.activeTask?.timeline.find(
      (item) => item.kind === "error" && item.text.includes("本地接收记录"),
    );
    assert.equal(error?.kind, "error");
    assert.equal(error?.kind === "error" && error.text.includes("不会自动重发"), true);
    assert.equal(error?.kind === "error" && error.text.includes("可以重新发送"), false);
  });

  it("terminalizes a malformed prompt response without leaking state into the next turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-prompt-rejection-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "protocol-rejection-after-thought");
    const failed = await waitForRunState(service, "failed");
    assert.equal(
      failed.activeTask?.timeline.some(
        (item) => item.kind === "error" && item.text.includes("Grok"),
      ),
      true,
    );
    assert.equal(
      failed.activeTask?.timeline.some(
        (item) => item.kind === "thought" && item.status === "failed",
      ),
      true,
    );

    await service.sendMessage(task.task.taskId, "after-protocol-rejection");
    const completed = await waitForCompleted(service);
    const thoughts = completed.activeTask?.timeline.filter(
      (item) => item.kind === "thought",
    ) ?? [];
    assert.deepEqual(
      thoughts.map((item) => ({ status: item.status, text: item.text })),
      [
        {
          status: "failed",
          text: "reasoning before malformed prompt response",
        },
        {
          status: "completed",
          text: "fresh reasoning after recovery",
        },
      ],
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-protocol-rejection",
      ),
      true,
    );
  });

  it("durably rejects a permission that arrives after cancellation without faulting the adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-safe-cancel-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "late-permission-after-cancel");
    await waitForRunState(service, "running");
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    const cancelled = await waitForRunState(service, "cancelled");
    assert.deepEqual(adapters[0]?.safeCancelDecisions, [
      { type: "selected", optionId: "reject-once" },
    ]);
    assert.equal(cancelled.activeTask?.timeline.some((item) => item.kind === "permission"), false);

    await service.sendMessage(task.task.taskId, "after-safe-cancel");
    await waitForCompleted(service);
  });

  it("lets transport interruption settle a permission waiter without reviving the Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-permission-transport-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "permission-transport-loss");
    const interrupted = await waitForRunState(service, "interrupted");
    assert.equal(interrupted.activeTask?.timeline.some((item) => item.kind === "permission"), false);
    assert.equal(interrupted.activeTask?.canSend, true);
    const recovered = await waitForRuntimeRecovery(service, "restored");
    assert.equal(recovered.runtimeDiagnostics?.recentIncidents[0]?.exitCode, 9);
    assert.equal(recovered.runtimeDiagnostics?.recentIncidents[0]?.hasStderr, true);
    const recoveryNotice = recovered.activeTask?.timeline.find(
      (item) => item.kind === "notice" && item.noticeType === "session_restored",
    );
    const transportError = recovered.activeTask?.timeline.find(
      (item) => item.kind === "error" && item.incidentId !== undefined,
    );
    assert.notEqual(recoveryNotice, undefined);
    assert.equal(
      recoveryNotice?.kind === "notice" ? recoveryNotice.incidentId : undefined,
      recovered.runtimeDiagnostics?.recentIncidents[0]?.incidentId,
    );
    assert.equal(
      transportError?.kind === "error" ? transportError.incidentId : undefined,
      recoveryNotice?.kind === "notice" ? recoveryNotice.incidentId : undefined,
    );
    const diagnostics = await waitForText(join(root, "diagnostics", "runtime.jsonl"));
    assert.match(diagnostics, /"event":"interrupted"/u);
    assert.match(diagnostics, /"exitCode":9/u);
    assert.match(diagnostics, /"event":"restored"/u);
    assert.doesNotMatch(diagnostics, /permission-transport-loss/u);

    await service.sendMessage(task.task.taskId, "after-permission-transport-loss");
    await waitForCompleted(service);
    await service.close();

    const restarted = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(restarted);
    const afterRestart = await restarted.bootstrap();
    assert.equal(afterRestart.runtimeDiagnostics?.recentIncidents[0]?.incidentId, recovered.runtimeDiagnostics?.recentIncidents[0]?.incidentId);
    assert.equal(afterRestart.runtimeDiagnostics?.recentIncidents[0]?.recovery, "restored");
    assert.equal(
      afterRestart.runtimeDiagnostics?.recentIncidents[0]?.taskTitle,
      recovered.runtimeDiagnostics?.recentIncidents[0]?.taskTitle,
    );
  });

  it("keeps a failed original-session recovery visible until the user authorizes replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-recovery-failed-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const sessionId = "session-visible-recovery-failure";
    const service = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([
        { sessionId },
        { sessionId, resumeFails: true },
      ]),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "permission-transport-loss");
    await waitForRunState(service, "interrupted");
    const failed = await waitForRuntimeRecovery(service, "failed");

    assert.equal(failed.activeTask?.sessionRecovery, "replacement_required");
    assert.equal(failed.activeTask?.canSend, false);
    assert.equal(failed.activeTask?.recentResult?.state, "interrupted");
    assert.equal(
      failed.activeTask?.timeline.some(
        (item) => item.kind === "notice" && item.noticeType === "session_restored",
      ),
      false,
    );
    assert.equal(
      failed.activeTask?.timeline.some(
        (item) => item.status === "interrupted",
      ),
      true,
    );
  });

  it("falls back to advertised session load and reconciles replay without duplicating history", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-recovery-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-recovery";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "seed-load-turn");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{ user: "seed-load-turn", assistant: "reply:seed-load-turn" }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "after-load-recovery");
    const completed = await waitForCompleted(reopened, 2);

    assert.equal(completed.activeTask?.sessionRecovery, "available");
    assert.equal(completed.activeTask?.canSend, true);
    assert.equal(
      completed.activeTask?.timeline.filter(
        (item) => item.kind === "user" && item.text === "seed-load-turn",
      ).length,
      1,
    );
    assert.equal(
      completed.activeTask?.timeline.filter(
        (item) => item.kind === "assistant" && item.text === "reply:seed-load-turn",
      ).length,
      1,
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-load-recovery",
      ),
      true,
    );
    assert.match(
      await waitForText(join(root, "diagnostics", "runtime.jsonl"), "load_committed"),
      /"event":"load_committed"/u,
    );
  });

  it("reconciles only the currently bound replacement session after S1 is replaced by S2", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-current-binding-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId: "session-s1" }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "s1-only");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const replacementAdapters: FakeAdapter[] = [];
    const replacement = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-replacement"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([
        { sessionId: "session-s1", resumeFails: true },
        { sessionId: "session-s2" },
      ], (adapter) => replacementAdapters.push(adapter)),
    });
    services.push(replacement);
    await replacement.bootstrap();
    await assert.rejects(
      replacement.sendMessage(task.task.taskId, "trigger replacement"),
      /session_replacement_requires_user_authorization/u,
    );
    await replacement.authorizeSessionReplacement(task.task.taskId);
    await replacement.sendMessage(task.task.taskId, "继续");
    await waitForCompleted(replacement, 2);
    await replacement.sendMessage(task.task.taskId, "s2-second");
    await waitForCompleted(replacement, 3);
    const recoveryCapsule = replacementAdapters.at(-1)?.prompts[0]?.text;
    assert.ok(recoveryCapsule?.startsWith("[Guild replacement-session recovery context]\n"));
    await replacement.close();
    services.splice(services.indexOf(replacement), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId: "session-s2",
        resumeFails: true,
        loadSession: true,
        replayTurns: [
          { user: recoveryCapsule!, assistant: `reply:${recoveryCapsule!}` },
          { user: "s2-second", assistant: "reply:s2-second" },
        ],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "after-s2-load");
    const completed = await waitForCompleted(reopened, 4);
    assert.equal(completed.activeTask?.sessionRecovery, "available");
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-s2-load",
      ),
      true,
    );
  });

  it("accepts a load replay when the official process echoes the user turn live", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-user-echo-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-user-echo";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "user-echo");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{ user: "user-echo", assistant: "reply:user-echo" }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "after-user-echo-load");
    assert.equal((await waitForCompleted(reopened, 2)).activeTask?.sessionRecovery, "available");
  });

  it("backtracks across an omitted interrupted duplicate before a completed retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-optional-duplicate-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-optional-duplicate";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([
        { sessionId, interruptAfterAssistant: true },
        { sessionId },
      ]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "same-turn");
    await waitForRunState(initial, "interrupted");
    await waitForRuntimeRecovery(initial, "restored");
    await initial.sendMessage(task.task.taskId, "same-turn");
    await waitForCompleted(initial, 2);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{ user: "same-turn", assistant: "reply:same-turn" }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "after-optional-duplicate-load");
    assert.equal((await waitForCompleted(reopened, 3)).activeTask?.sessionRecovery, "available");
  });

  it("fails closed when load omits an accepted replacement recovery capsule", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-missing-capsule-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const setup = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-setup"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId: "session-capsule-s1" }]),
    });
    services.push(setup);
    const bootstrapped = await setup.chooseWorkspace();
    const task = await setup.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await setup.sendMessage(task.task.taskId, "seed-before-capsule");
    await waitForCompleted(setup);
    await setup.close();
    services.splice(services.indexOf(setup), 1);

    const replacement = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-replacement"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([
        { sessionId: "session-capsule-s1", resumeFails: true },
        { sessionId: "session-capsule-s2" },
      ]),
    });
    services.push(replacement);
    await replacement.bootstrap();
    await assert.rejects(
      replacement.sendMessage(task.task.taskId, "trigger replacement"),
      /session_replacement_requires_user_authorization/u,
    );
    await replacement.authorizeSessionReplacement(task.task.taskId);
    await replacement.sendMessage(task.task.taskId, "interrupt-capsule-after-accept");
    await waitForRunState(replacement, "interrupted");
    await replacement.close();
    services.splice(services.indexOf(replacement), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId: "session-capsule-s2",
        resumeFails: true,
        loadSession: true,
        replayTurns: [],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-skip-capsule"),
      /session_replacement_requires_user_authorization/u,
    );
    assert.equal((await reopened.bootstrap()).activeTask?.sessionRecovery, "replacement_required");
  });

  it("fails closed when loaded history conflicts with the durable task transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-conflict-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-conflict";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "durable-task-a");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{ user: "different-task-b", assistant: "reply:different-task-b" }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-send-after-conflict"),
      /session_replacement_requires_user_authorization/u,
    );
    const failed = await reopened.bootstrap();
    assert.equal(failed.activeTask?.sessionRecovery, "replacement_required");
    assert.equal(failed.activeTask?.canSend, false);
    assert.equal(
      failed.activeTask?.timeline.some(
        (item) => "text" in item && item.text.includes("different-task-b"),
      ),
      false,
    );
  });

  it("fails closed when user chunks without message IDs have an ambiguous turn boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-user-boundary-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-user-boundary";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "ab");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{ user: "ab", userChunks: ["a", "b"], assistant: "reply:ab" }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-ambiguous-user-boundary"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("does not let an empty first user chunk bypass boundary ambiguity", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-empty-user-boundary-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-empty-user-boundary";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "ab");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{ user: "ab", userChunks: ["", "ab"], assistant: "reply:ab" }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-empty-user-boundary"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("rejects a different task recovery capsule even when its visible user turn and reply match", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-capsule-conflict-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-capsule-conflict";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "继续");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const wrongTaskCapsule = [
      "[Guild replacement-session recovery context]",
      "Guild task ID: task-from-another-conversation",
      "Task title: another task",
      "Workspace root: /tmp/another-workspace",
      "[End Guild replacement-session recovery context]",
      "",
      "[Current user message]",
      "继续",
    ].join("\n");
    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: wrongTaskCapsule,
          thought: "waiting",
          assistant: "reply:继续",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-enter-wrong-capsule"),
      /session_replacement_requires_user_authorization/u,
    );
    assert.equal((await reopened.bootstrap()).activeTask?.sessionRecovery, "replacement_required");
  });

  it("rejects a replay that omits durable tool evidence from a completed turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-tool-conflict-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-tool-conflict";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "tool");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{ user: "tool", thought: "waiting", assistant: "reply:tool" }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-incomplete-replay"),
      /session_replacement_requires_user_authorization/u,
    );
    assert.equal((await reopened.bootstrap()).activeTask?.sessionRecovery, "replacement_required");
  });

  it("rejects a replay with the same tool snapshots in a different authored order", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-tool-order-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-tool-order";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "tool");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "tool",
          thought: "waiting",
          assistant: "reply:tool",
          toolOrder: "after_assistant",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-reordered-replay"),
      /session_replacement_requires_user_authorization/u,
    );
    assert.equal((await reopened.bootstrap()).activeTask?.sessionRecovery, "replacement_required");
  });

  it("fails closed when ACP tool evidence was intentionally reduced for safe display", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-lossy-tool-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-lossy-tool";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "lossy-tool");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "lossy-tool",
          toolCallId: "lossy-tool",
          toolOrder: "before_assistant",
          toolReplayProofUnavailable: true,
          assistant: "reply:lossy-tool",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-lossy-tool-proof"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("treats an agent-owned plan-prefixed tool call ID as an opaque tool identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-opaque-tool-id-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-opaque-tool-id";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "opaque-plan-tool");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "opaque-plan-tool",
          toolCallId: "plan:external",
          toolOrder: "before_assistant",
          assistant: "reply:opaque-plan-tool",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "after-opaque-tool-load");
    const completed = await waitForCompleted(reopened, 2);
    assert.equal(completed.activeTask?.sessionRecovery, "available");
    const opaqueTool = completed.activeTask?.timeline.find(
      (item) => item.kind === "tool" && item.toolCallId === testToolIdentityKey("plan:external"),
    );
    assert.equal(opaqueTool?.kind === "tool" ? opaqueTool.runtimeReplayKind : undefined, "tool");
  });

  it("persists and reconciles a long legal opaque tool call ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-long-tool-id-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-long-tool-id";
    const toolCallId = "x".repeat(508);
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "long-tool-id");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "long-tool-id",
          toolCallId,
          toolOrder: "before_assistant",
          assistant: "reply:long-tool-id",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "after-long-tool-load");
    const completed = await waitForCompleted(reopened, 2);
    assert.equal(completed.activeTask?.sessionRecovery, "available");
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "tool" && item.toolCallId?.startsWith("tool-id-sha256:"),
      ),
      true,
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "tool" && item.toolCallId === toolCallId,
      ),
      false,
    );
  });

  it("keeps a raw synthetic-looking ID distinct from the long ID whose legacy key it copies", async () => {
    await assertToolIdentityCollisionRejected("synthetic");
  });

  it("rejects a replay that collapses multiple exact plan entries into one", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-plan-boundary-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-plan-boundary";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "plan");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "plan",
          plan: [{
            content: "Inspect\nFix\nVerify",
            priority: "medium",
            status: "pending",
          }],
          assistant: "reply:plan",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-collapsed-plan"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("rejects plan replay entries with changed priority or per-item status", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-plan-fields-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-plan-fields";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "plan");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "plan",
          plan: [
            { content: "Inspect", priority: "low", status: "completed" },
            { content: "Fix", priority: "high", status: "pending" },
            { content: "Verify", priority: "medium", status: "pending" },
          ],
          assistant: "reply:plan",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-changed-plan-fields"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("fails closed when a completed prompt used attachment resources that load cannot prove", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-attachment-proof-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const attachmentPath = join(workspace, "brief.txt");
    await writeFile(attachmentPath, "attachment identity", "utf8");
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-attachment-proof";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "review attachment", [{
      relativePath: "brief.txt",
      name: "brief.txt",
      size: 19,
      mimeType: "text/plain",
    }]);
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "review attachment",
          thought: "waiting",
          assistant: "reply:review attachment",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-unproved-resource"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("rejects replay media with the same metadata but different bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-media-digest-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-media-digest";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      mediaRoot: join(root, "media"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "media");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      mediaRoot: join(root, "media"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "media",
          thought: "waiting",
          media: {
            base64Data: Buffer.from("different png bytes", "utf8").toString("base64"),
            messageId: "media-1",
          },
          assistant: "reply:media",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-different-media"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("accepts identical media bytes when the replayed message ID changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-media-message-id-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-media-message-id";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      mediaRoot: join(root, "media"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "media");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      mediaRoot: join(root, "media"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "media",
          media: { base64Data: TEST_PNG_BASE64, messageId: "media-reloaded" },
          assistant: "reply:media",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "after-media-load");
    assert.equal((await waitForCompleted(reopened, 2)).activeTask?.sessionRecovery, "available");
  });

  it("rejects identical media bytes replayed under the wrong authored role", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-media-role-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-media-role";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      mediaRoot: join(root, "media"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "media");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      mediaRoot: join(root, "media"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        replayTurns: [{
          user: "media",
          media: {
            base64Data: TEST_PNG_BASE64,
            messageId: "media-1",
            discriminator: "user_message_chunk",
          },
          assistant: "reply:media",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "must-not-accept-wrong-media-role"),
      /session_replacement_requires_user_authorization/u,
    );
  });

  it("acknowledges replay abort after transport interruption terminalizes the live barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-load-abort-ack-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const sessionId = "session-load-abort-ack";
    const initial = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-initial"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
    });
    services.push(initial);
    const bootstrapped = await initial.chooseWorkspace();
    const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await initial.sendMessage(task.task.taskId, "seed-abort-ack");
    await waitForCompleted(initial);
    await initial.close();
    services.splice(services.indexOf(initial), 1);

    const reopened = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([{
        sessionId,
        resumeFails: true,
        loadSession: true,
        interruptDuringLoad: true,
        replayTurns: [{
          user: "seed-abort-ack",
          thought: "waiting",
          assistant: "reply:seed-abort-ack",
        }],
      }]),
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "trigger-load-transport-race"),
      /session_replacement_requires_user_authorization/u,
    );
    assert.match(
      await waitForText(join(root, "diagnostics", "runtime.jsonl"), "load_abort_acknowledged"),
      /"event":"load_abort_acknowledged"/u,
    );
  });

  it("records an intentional runtime close as lifecycle cleanup instead of a transport incident", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-explicit-close-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.23-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "clean-close");
    await waitForCompleted(service);
    const deadline = Date.now() + 3_000;
    while (true) {
      try {
        await service.updateTask({ taskId: task.task.taskId, action: "archive" });
        break;
      } catch (cause: unknown) {
        if (!(cause instanceof Error) || !cause.message.includes("task_run_active") || Date.now() >= deadline) {
          throw cause;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    const diagnostics = await waitForText(join(root, "diagnostics", "runtime.jsonl"), "closed");
    assert.match(diagnostics, /"category":"runtime","event":"closed"/u);
    assert.match(diagnostics, /"reason":"explicit_close"/u);
    assert.doesNotMatch(
      diagnostics,
      /"category":"transport","event":"interrupted"[^\n]*"reason":"explicit_close"/u,
    );
  });

  it("keeps an idle transport recovery in diagnostics without inventing an interrupted instruction", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-idle-recovery-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.28-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "complete-before-idle-loss");
    await waitForCompleted(service);
    await adapters[0]!.emitTransportInterrupted();
    const recovered = await waitForRuntimeRecovery(service, "restored");

    assert.equal(recovered.activeTask?.recentResult?.state, "completed");
    assert.equal(
      recovered.activeTask?.timeline.some(
        (item) => item.kind === "notice" && item.noticeType === "session_restored",
      ),
      false,
    );
    const diagnostics = await waitForText(join(root, "diagnostics", "runtime.jsonl"));
    assert.match(diagnostics, /"event":"interrupted"/u);
    assert.match(diagnostics, /"event":"restored"/u);
  });

  it("settles a permission whose transport signal was already aborted before the sink subscribed", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-permission-pre-aborted-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "permission-pre-aborted-transport-loss");
    const interrupted = await waitForRunState(service, "interrupted");
    assert.equal(interrupted.activeTask?.timeline.some((item) => item.kind === "permission"), false);
    assert.equal(interrupted.activeTask?.canSend, true);

    await service.sendMessage(task.task.taskId, "after-pre-aborted-permission");
    await waitForCompleted(service);
  });

  it("returns one durable safe rejection when cancellation aborts an in-flight permission", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-permission-cancel-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "permission-before-cancel");
    await waitForPermission(service);
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    const cancelled = await waitForRunState(service, "cancelled");
    assert.deepEqual(adapters[0]?.safeCancelDecisions, [
      { type: "selected", optionId: "reject-once" },
    ]);
    assert.equal(cancelled.activeTask?.timeline.some((item) => item.kind === "permission"), false);
    assert.equal(cancelled.activeTask?.canSend, true);
  });

  it("ignores a delayed transport interruption from a replaced adapter epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-stale-interruption-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "first-epoch");
    await waitForCompleted(service);
    adapters[0]!.faultWithoutInterrupt();

    const second = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    await adapters[0]!.emitAgentText("stale-old-epoch");
    await adapters[0]!.emitPromptTerminal();
    const afterStaleTerminal = await service.bootstrap();
    assert.equal(afterStaleTerminal.activeTask?.task.activeRunState, "running");
    assert.equal(
      afterStaleTerminal.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text.includes("stale-old-epoch"),
      ),
      false,
    );
    await adapters[0]!.emitContextUsage(999, 1_000);
    assert.deepEqual((await service.bootstrap()).activeTask?.contextWindow, { status: "unavailable" });
    await adapters[0]!.emitTransportInterrupted();
    assert.equal((await service.bootstrap()).activeTask?.task.activeRunState, "running");

    await service.cancelRun(task.task.taskId, startedRunId(second));
    await waitForRunState(service, "cancelled");
    await service.sendMessage(task.task.taskId, "after-stale-interruption");
    await waitForCompleted(service, 2);
    assert.equal(adapters.length, 2);
  });

  it("fences a faulted adapter before replacing an in-flight Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-active-epoch-replacement-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const adapters: FakeAdapter[] = [];
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory([], (adapter) => adapters.push(adapter)),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    adapters[0]!.faultWithoutInterrupt();

    await service.sendMessage(task.task.taskId, "after-active-epoch-replacement");
    const completed = await waitForCompleted(service);
    assert.equal(adapters.length, 2);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "error" && item.status === "interrupted",
      ),
      true,
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "assistant" && item.text === "reply:after-active-epoch-replacement",
      ),
      true,
    );
  });

  it("preserves but does not dispatch queued messages bound to a replaced session", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-queue-replacement-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    await mkdir(join(workspace, "games/table-sling/src"), { recursive: true });
    await mkdir(join(workspace, "games/face-brawl/src"), { recursive: true });
    await writeFile(join(workspace, "games/table-sling/src/main.ts"), "table sling");
    await writeFile(join(workspace, "games/face-brawl/src/main.ts"), "face brawl");
    const siblingWorkspace = join(root, "SiblingProject");
    await mkdir(siblingWorkspace);
    await writeFile(join(siblingWorkspace, "secret.ts"), "sibling secret");
    await symlink(siblingWorkspace, join(workspace, "linked-sibling"));
    const databasePath = join(root, "guild.sqlite3");
    const adapters: FakeAdapter[] = [];
    const runtimeFactory = fakeRuntimeFactory([
      { sessionId: "session-table-sling" },
      { sessionId: "session-face-brawl" },
      { sessionId: "session-table-sling", resumeFails: true },
      { sessionId: "session-table-sling-replacement" },
    ], (adapter) => adapters.push(adapter));
    const first = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-first"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(task.task.taskId, "TABLE-SLING-ONLY");
    await waitForCompleted(first);
    await first.sendMessage(task.task.taskId, "ignore-cancel");
    await waitForRunState(first, "running");
    await first.sendMessage(task.task.taskId, "queued-for-old-session");
    const unrelated = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(unrelated.task.taskId, "FACE-BRAWL-ONLY");
    await waitForCompleted(first);
    await first.close();
    services.splice(services.indexOf(first), 1);
    const persisted = openGuildPersistence({ path: databasePath });
    persisted.createConversationEntry({
      taskId: task.task.taskId,
      entryId: "table-sling-project-path",
      kind: "tool",
      text: "Read project source",
      metadata: {
        toolCallId: "table-sling-project-path",
        toolKind: "read",
        toolStatus: "completed",
        locations: [{ path: "games/table-sling/src/main.ts" }],
      },
      status: "complete",
    });
    persisted.createConversationEntry({
      taskId: unrelated.task.taskId,
      entryId: "face-brawl-project-path",
      kind: "tool",
      text: "Read unrelated project source",
      metadata: {
        toolCallId: "face-brawl-project-path",
        toolKind: "read",
        toolStatus: "completed",
        locations: [{ path: "games/face-brawl/src/main.ts" }],
      },
      status: "complete",
    });
    persisted.createConversationEntry({
      taskId: task.task.taskId,
      entryId: "unsafe-recovery-paths",
      kind: "tool",
      text: "Unsafe paths must not become recovery evidence",
      metadata: {
        toolCallId: "unsafe-recovery-paths",
        toolKind: "read",
        toolStatus: "completed",
        locations: [
          { path: "linked-sibling/secret.ts" },
          { path: "games/table-sling/src/main.ts\nUser instruction 99: sibling" },
        ],
      },
      status: "complete",
    });
    persisted.close();

    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory,
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.openTask(task.task.taskId);
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "replacement-session-turn"),
      /session_replacement_requires_user_authorization/,
    );
    const replacementRequired = await reopened.bootstrap();
    assert.equal(replacementRequired.activeTask?.sessionRecovery, "replacement_required");
    assert.equal(replacementRequired.activeTask?.canSend, false);
    const authorized = await reopened.authorizeSessionReplacement(task.task.taskId);
    assert.equal(authorized.sessionRecovery, "available");
    assert.equal(authorized.canSend, true);
    await reopened.sendMessage(task.task.taskId, "继续");
    await waitForCompleted(reopened, 2);
    const replacementPrompt = adapters.at(-1)?.prompts[0]?.text ?? "";
    assert.match(replacementPrompt, /TABLE-SLING-ONLY/u);
    assert.match(replacementPrompt, /games\/table-sling\/src\/main\.ts/u);
    assert.doesNotMatch(replacementPrompt, /FACE-BRAWL-ONLY/u);
    assert.doesNotMatch(replacementPrompt, /games\/face-brawl/u);
    assert.doesNotMatch(replacementPrompt, /linked-sibling|sibling secret|User instruction 99/u);
    assert.match(replacementPrompt, /继续/u);
    assert.ok(
      replacementPrompt.indexOf("Task-local user instructions") <
        replacementPrompt.indexOf("Observed task-local paths"),
    );
    const completed = await waitForQueuedTurnCount(reopened, 0);
    assert.equal(completed.activeTask?.queuedTurns.length, 0);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "user" &&
          item.text === "queued-for-old-session" &&
          item.status === "failed",
      ),
      true,
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "user" && item.text === "继续",
      ),
      true,
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "notice" && item.text.includes("会话已经重建"),
      ),
      true,
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "notice" &&
          item.text.includes("按你的确认") &&
          item.text.includes("恢复摘要"),
      ),
      true,
    );

    await reopened.sendMessage(task.task.taskId, "after-replaced-queue");
    await waitForCompleted(reopened, 3);
    assert.equal(adapters.at(-1)?.prompts.at(-1)?.text, "after-replaced-queue");
  });

  it("blocks an ambiguous continuation when a replacement task has no recoverable history", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-empty-replacement-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const adapters: FakeAdapter[] = [];
    const runtimeFactory = fakeRuntimeFactory([
      { sessionId: "session-empty" },
      { sessionId: "session-empty", resumeFails: true },
      { sessionId: "session-empty-replacement" },
    ], (adapter) => adapters.push(adapter));
    const first = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-first"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.loadSlashCommands(task.task.taskId);
    await first.close();
    services.splice(services.indexOf(first), 1);
    const persisted = openGuildPersistence({ path: databasePath });
    persisted.createConversationEntry({
      taskId: task.task.taskId,
      entryId: "empty-replacement-test-notice",
      kind: "notice",
      text: "Session initialized without a user prompt.",
      status: "complete",
    });
    persisted.close();

    const reopened = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory,
    });
    services.push(reopened);
    await reopened.bootstrap();
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "继续"),
      /session_replacement_requires_user_authorization/,
    );
    await reopened.authorizeSessionReplacement(task.task.taskId);
    await assert.rejects(
      reopened.sendMessage(task.task.taskId, "继续"),
      /session_recovery_context_required/,
    );
    assert.equal(adapters.at(-1)?.prompts.length, 0);
    assert.equal(
      (await reopened.bootstrap()).activeTask?.timeline.some(
        (item) => item.kind === "user" && item.text === "继续",
      ),
      false,
    );
    await assert.rejects(
      reopened.sendMessage(
        task.task.taskId,
        "x".repeat(ACP_V1_CODEC_LIMITS.maxStringLength),
      ),
      /message_too_long/u,
    );
    assert.equal(adapters.at(-1)?.prompts.length, 0);

    await reopened.sendMessage(task.task.taskId, "Build a calculator in this workspace.");
    await waitForCompleted(reopened);
    assert.match(adapters.at(-1)?.prompts[0]?.text ?? "", /Build a calculator/u);
  });

  it("keeps recovery armed when replacement setup fails after the new session is committed", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-replacement-setup-failure-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const adapters: FakeAdapter[] = [];
    const runtimeFactory = fakeRuntimeFactory([
      { sessionId: "session-setup-original" },
      { sessionId: "session-setup-original", resumeFails: true },
      {
        sessionId: "session-setup-replacement",
        setModelFailure: "fake replacement model failure",
      },
      { sessionId: "session-setup-replacement" },
    ], (adapter) => adapters.push(adapter));
    const first = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-first"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(task.task.taskId, "SETUP-FAILURE-TABLE-SLING-ONLY");
    await waitForCompleted(first);
    await first.close();
    services.splice(services.indexOf(first), 1);

    const replacementAttempt = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-replacement"),
      chooseWorkspace: async () => undefined,
      runtimeFactory,
    });
    services.push(replacementAttempt);
    await replacementAttempt.bootstrap();
    await assert.rejects(
      replacementAttempt.sendMessage(task.task.taskId, "trigger replacement"),
      /session_replacement_requires_user_authorization/u,
    );
    await assert.rejects(
      replacementAttempt.authorizeSessionReplacement(task.task.taskId),
      /runtime_start_session_set_model:fake replacement model failure/u,
    );
    await replacementAttempt.close();
    services.splice(services.indexOf(replacementAttempt), 1);

    const recovered = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-recovered"),
      chooseWorkspace: async () => undefined,
      runtimeFactory,
    });
    services.push(recovered);
    await recovered.bootstrap();
    await recovered.sendMessage(task.task.taskId, "继续");
    await waitForCompleted(recovered, 2);
    const prompt = adapters.at(-1)?.prompts[0]?.text ?? "";
    assert.match(prompt, /SETUP-FAILURE-TABLE-SLING-ONLY/u);
    assert.match(prompt, /继续/u);

    await recovered.sendMessage(task.task.taskId, "after durable handoff");
    await waitForCompleted(recovered, 3);
    assert.equal(adapters.at(-1)?.prompts.at(-1)?.text, "after durable handoff");
  });

  it("continues queued dispatch after rejecting an ambiguous recovery turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-recovery-queue-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const setup = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-setup"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(setup);

    const bootstrapped = await setup.chooseWorkspace();
    const task = await setup.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await setup.close();
    services.splice(services.indexOf(setup), 1);

    const persisted = openGuildPersistence({ path: databasePath });
    const attemptId = testMust(parseSessionAttemptId("recovery-queue-attempt"));
    const sessionId = testMust(parseSessionId("session-queue-replacement"));
    const adapterEpoch = testMust(parseAdapterEpoch(1));
    const orphanedRunId = testMust(parseRunId("recovery-queue-orphaned-run"));
    const ambiguousRunId = testMust(parseRunId("recovery-queue-ambiguous-run"));
    const oversizedRunId = testMust(parseRunId("recovery-queue-oversized-run"));
    const explicitRunId = testMust(parseRunId("recovery-queue-explicit-run"));
    assert.equal(persisted.applySessionBinding({
      taskId: task.task.taskId,
      event: {
        type: "start_session",
        attemptId,
        idempotencyKey: testKey("recovery-queue-start"),
      },
    }).ok, true);
    assert.equal(persisted.applySessionBinding({
      taskId: task.task.taskId,
      event: {
        type: "session_new_succeeded",
        sessionId,
        adapterEpoch,
        attemptId,
        idempotencyKey: testKey("recovery-queue-established"),
      },
    }).ok, true);
    persisted.commitAdapterEpoch({
      taskId: task.task.taskId,
      sessionId,
      adapterEpoch,
      expectedRevision: 0,
      status: "alive",
    });
    persisted.createConversationEntry({
      taskId: task.task.taskId,
      entryId: "recovery-queue-authorized",
      kind: "notice",
      text: "Guild replacement-session recovery authorized.",
      metadata: {
        hidden: true,
        replacementRecoveryAuthorized: true,
        recoveryHandoffRequired: true,
      },
      status: "complete",
    });
    persisted.createRun({ taskId: task.task.taskId, runId: orphanedRunId });
    assert.equal(persisted.applyRun({
      taskId: task.task.taskId,
      runId: orphanedRunId,
      event: {
        type: "scheduler_dispatch",
        sessionId,
        adapterEpoch,
        idempotencyKey: testKey("recovery-queue-orphaned-dispatch"),
      },
    }).ok, true);
    persisted.enqueueQueuedTurn({
      taskId: task.task.taskId,
      queueId: "recovery-queue-ambiguous",
      intendedSessionId: sessionId,
      reservedRunId: ambiguousRunId,
      entryId: "recovery-queue-ambiguous-entry",
      text: "继续",
    });
    persisted.enqueueQueuedTurn({
      taskId: task.task.taskId,
      queueId: "recovery-queue-oversized",
      intendedSessionId: sessionId,
      reservedRunId: oversizedRunId,
      entryId: "recovery-queue-oversized-entry",
      text: "x".repeat(ACP_V1_CODEC_LIMITS.maxStringLength),
    });
    persisted.enqueueQueuedTurn({
      taskId: task.task.taskId,
      queueId: "recovery-queue-explicit",
      intendedSessionId: sessionId,
      reservedRunId: explicitRunId,
      entryId: "recovery-queue-explicit-entry",
      text: "explicit queued recovery turn",
    });
    persisted.close();

    const adapters: FakeAdapter[] = [];

    const reopened = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory: fakeRuntimeFactory(
        [{ sessionId: "session-queue-replacement" }],
        (adapter) => adapters.push(adapter),
      ),
    });
    services.push(reopened);
    await reopened.bootstrap();

    const completed = await waitForCompleted(reopened);
    assert.equal(completed.activeTask?.queuedTurns.length, 0);
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) => item.kind === "user" && item.text === "继续" && item.status === "failed",
      ),
      true,
    );
    assert.equal(
      completed.activeTask?.timeline.some(
        (item) =>
          item.kind === "user" &&
          item.text.length === ACP_V1_CODEC_LIMITS.maxStringLength &&
          item.status === "failed",
      ),
      true,
    );
    const replacementPrompts = adapters.at(-1)?.prompts ?? [];
    assert.equal(replacementPrompts.length, 1);
    assert.match(replacementPrompts[0]?.text ?? "", /explicit queued recovery turn/u);
  });

  it("repairs a pre-2.0.27 replacement session with one task-local handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-legacy-replacement-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const databasePath = join(root, "guild.sqlite3");
    const adapters: FakeAdapter[] = [];
    const runtimeFactory = fakeRuntimeFactory([
      { sessionId: "session-legacy-replacement" },
      { sessionId: "session-legacy-replacement" },
    ], (adapter) => adapters.push(adapter));
    const first = createLiveDesktopService({
      appVersion: "2.0.26-test",
      databasePath,
      stagingRoot: join(root, "staging-first"),
      chooseWorkspace: async () => workspace,
      runtimeFactory,
    });
    services.push(first);

    const bootstrapped = await first.chooseWorkspace();
    const task = await first.createTask(bootstrapped.workspaces[0]!.workspaceId);
    await first.sendMessage(task.task.taskId, "LEGACY-TABLE-SLING-ONLY");
    await waitForCompleted(first);
    await first.close();
    services.splice(services.indexOf(first), 1);
    const persisted = openGuildPersistence({ path: databasePath });
    persisted.createConversationEntry({
      taskId: task.task.taskId,
      entryId: "legacy-session-replaced",
      kind: "notice",
      text: "A replacement session was created by the earlier release.",
      metadata: { sessionReplaced: true, userAuthorized: true },
      status: "complete",
    });
    persisted.close();

    const reopened = createLiveDesktopService({
      appVersion: "2.0.27-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => undefined,
      runtimeFactory,
    });
    services.push(reopened);
    await reopened.bootstrap();
    await reopened.sendMessage(task.task.taskId, "继续");
    await waitForCompleted(reopened, 2);
    assert.match(adapters.at(-1)?.prompts[0]?.text ?? "", /LEGACY-TABLE-SLING-ONLY/u);

    await reopened.sendMessage(task.task.taskId, "after-legacy-handoff");
    await waitForCompleted(reopened, 3);
    assert.equal(adapters.at(-1)?.prompts.at(-1)?.text, "after-legacy-handoff");
  });

  it("hides archived tasks and rejects archiving while a run is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-archive-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    const pinned = await service.updateTask({ taskId: task.task.taskId, action: "pin" });
    assert.equal(pinned.workspaces[0]?.tasks[0]?.pinned, true);
    const renamed = await service.updateTask({
      taskId: task.task.taskId,
      action: "rename",
      title: "Pinned running task",
    });
    assert.equal(renamed.workspaces[0]?.tasks[0]?.title, "Pinned running task");
    await assert.rejects(() => service.updateTask({ taskId: task.task.taskId, action: "archive" }), /task_run_active/);
    await service.cancelRun(task.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancelled");

    const archived = await service.updateTask({ taskId: task.task.taskId, action: "archive" });
    assert.equal(archived.workspaces[0]?.tasks[0]?.archived, true);
    assert.equal(archived.activeTask, undefined);

    const restored = await service.updateTask({ taskId: task.task.taskId, action: "restore" });
    assert.equal(restored.workspaces[0]?.tasks[0]?.archived, false);
    const reopened = await service.openTask(task.task.taskId);
    assert.equal(reopened.task.taskId, task.task.taskId);

    const archivedWorkspace = await service.updateWorkspace(
      bootstrapped.workspaces[0]!.workspaceId,
      "archive",
    );
    assert.equal(archivedWorkspace.workspaces[0]?.archived, true);
    const restoredWorkspace = await service.updateWorkspace(
      bootstrapped.workspaces[0]!.workspaceId,
      "restore",
    );
    assert.equal(restoredWorkspace.workspaces[0]?.archived, false);
  });

  it("keeps unsent new tasks provisional and discards them on navigation or restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-provisional-task-"));
    const workspace = join(root, "Workspace");
    const databasePath = join(root, "guild.sqlite3");
    await mkdir(workspace);
    const firstService = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(firstService);

    const selected = await firstService.chooseWorkspace();
    const workspaceId = selected.workspaces[0]!.workspaceId;
    const abandoned = await firstService.createTask(workspaceId);
    assert.equal((await firstService.bootstrap()).workspaces[0]?.tasks.length, 0);

    const committed = await firstService.createTask(workspaceId);
    await assert.rejects(firstService.openTask(abandoned.task.taskId), /task_not_active|task_deleted/u);
    await firstService.sendMessage(committed.task.taskId, "kept task");
    const completed = await waitForCompleted(firstService);
    assert.equal(completed.workspaces[0]?.tasks.length, 1);
    assert.equal(completed.workspaces[0]?.tasks[0]?.title, "kept task");

    const restartAbandoned = await firstService.createTask(workspaceId);
    assert.equal((await firstService.bootstrap()).workspaces[0]?.tasks.length, 1);
    await firstService.close();

    const reopened = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath,
      stagingRoot: join(root, "staging-reopened"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(reopened);
    const restarted = await reopened.bootstrap();
    assert.equal(restarted.workspaces[0]?.tasks.length, 1);
    assert.equal(restarted.activeTask?.task.title, "kept task");
    await assert.rejects(reopened.openTask(restartAbandoned.task.taskId), /task_not_active|task_deleted/u);
  });

  it("projects live state and queued work for a running non-active sidebar task", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-sidebar-state-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const first = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(first.task.taskId, "wait-for-cancel");
    await waitForRunState(service, "running");
    await service.sendMessage(first.task.taskId, "queued-while-backgrounded");
    await service.sendMessage(first.task.taskId, "promote-this-follow-up");
    await service.createTask(bootstrapped.workspaces[0]!.workspaceId);

    const projection = await service.bootstrap();
    const firstSummary = projection.workspaces[0]?.tasks.find(
      (task) => task.taskId === first.task.taskId,
    );
    assert.equal(projection.activeTask?.task.taskId === first.task.taskId, false);
    assert.equal(firstSummary?.activeRunState, "running");
    assert.equal(firstSummary?.queuedTurnCount, 2);

    const reopenedFirst = await service.openTask(first.task.taskId);
    await service.prioritizeQueuedTurn(first.task.taskId, reopenedFirst.queuedTurns[1]!.queueId);
    const prioritized = await service.bootstrap();
    assert.deepEqual(
      prioritized.activeTask?.queuedTurns.map((queued) => queued.text),
      ["promote-this-follow-up", "queued-while-backgrounded"],
    );
    for (const queued of prioritized.activeTask?.queuedTurns ?? []) {
      await service.cancelQueuedTurn(first.task.taskId, queued.queueId);
    }
    await service.cancelRun(first.task.taskId, startedRunId(sent));
    await waitForRunState(service, "cancelled");
  });

  it("round-trips an explicit permission decision before the turn completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-permission-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "permission");
    const pending = await waitForPermission(service);
    assert.equal(pending.title, "Allow test read?");
    await service.decidePermission({
      taskId: task.task.taskId,
      runId: startedRunId(sent),
      permissionId: pending.permissionId,
      decision: { type: "selected", optionId: "allow-once" },
    });
    const completed = await waitForCompleted(service);
    assert.equal(completed.activeTask?.timeline.some((item) => item.kind === "permission"), false);
    assert.equal(completed.activeTask?.canSend, true);
  });

  it("pauses the prompt-silence bound while a permission waits for the user", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-live-service-permission-silence-"));
    const workspace = join(root, "Workspace");
    await mkdir(workspace);
    const service = createLiveDesktopService({
      appVersion: "2.0.0-test",
      databasePath: join(root, "guild.sqlite3"),
      stagingRoot: join(root, "staging"),
      chooseWorkspace: async () => workspace,
      runtimeFactory: fakeRuntimeFactory(),
      promptSilenceMs: 25,
    });
    services.push(service);

    const bootstrapped = await service.chooseWorkspace();
    const task = await service.createTask(bootstrapped.workspaces[0]!.workspaceId);
    const sent = await service.sendMessage(task.task.taskId, "permission");
    const pending = await waitForPermission(service);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const stillWaiting = await service.bootstrap();
    assert.equal(stillWaiting.activeTask?.task.activeRunState, "awaiting_permission");
    assert.equal(
      stillWaiting.activeTask?.timeline.some(
        (item) => item.kind === "permission" && item.permissionId === pending.permissionId,
      ),
      true,
    );

    await service.decidePermission({
      taskId: task.task.taskId,
      runId: startedRunId(sent),
      permissionId: pending.permissionId,
      decision: { type: "selected", optionId: "allow-once" },
    });
    const completed = await waitForCompleted(service);
    assert.equal(completed.activeTask?.task.activeRunState, "completed");
  });
});

async function waitForCompleted(
  service: ReturnType<typeof createLiveDesktopService>,
  expectedAssistantCount = 1,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const projection = await service.bootstrap();
    const assistantCount = projection.activeTask?.timeline
      .filter((item) => item.kind === "assistant").length ?? 0;
    if (
      projection.activeTask?.task.activeRunState === "completed" &&
      assistantCount === expectedAssistantCount
    ) {
      return projection;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("desktop run did not complete");
}

async function waitForRunState(
  service: ReturnType<typeof createLiveDesktopService>,
  expected: string,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const projection = await service.bootstrap();
    if (projection.activeTask?.task.activeRunState === expected) return projection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`desktop run did not reach ${expected}`);
}

async function waitForPermission(service: ReturnType<typeof createLiveDesktopService>) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const projection = await service.bootstrap();
    const permission = projection.activeTask?.timeline.find((item) => item.kind === "permission");
    if (permission?.kind === "permission") return permission;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("desktop permission did not appear");
}

async function waitForQueuedTurnCount(
  service: ReturnType<typeof createLiveDesktopService>,
  expected: number,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const projection = await service.bootstrap();
    if (projection.activeTask?.queuedTurns.length === expected) return projection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`desktop queue did not reach ${expected}`);
}

async function waitForRuntimeRecovery(
  service: ReturnType<typeof createLiveDesktopService>,
  expected: "restoring" | "restored" | "failed",
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const projection = await service.bootstrap();
    if (projection.runtimeDiagnostics?.recentIncidents[0]?.recovery === expected) return projection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`runtime recovery did not reach ${expected}`);
}

async function waitForText(path: string, expectedEvent = "restored"): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const contents = await readFile(path, "utf8").catch(() => undefined);
    if (contents !== undefined && contents.includes(`"event":"${expectedEvent}"`)) return contents;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("runtime diagnostic log was not flushed");
}

async function assertToolIdentityCollisionRejected(
  collisionCase: "synthetic",
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `guild-live-service-tool-id-${collisionCase}-`));
  const workspace = join(root, "Workspace");
  await mkdir(workspace);
  const databasePath = join(root, "guild.sqlite3");
  const sessionId = `session-tool-id-${collisionCase}`;
  const prompt = `tool-id-${collisionCase}-collision`;
  const initial = createLiveDesktopService({
    appVersion: "2.0.28-test",
    databasePath,
    stagingRoot: join(root, "staging-initial"),
    chooseWorkspace: async () => workspace,
    runtimeFactory: fakeRuntimeFactory([{ sessionId }]),
  });
  services.push(initial);
  const bootstrapped = await initial.chooseWorkspace();
  const task = await initial.createTask(bootstrapped.workspaces[0]!.workspaceId);
  await initial.sendMessage(task.task.taskId, prompt);
  await waitForCompleted(initial);
  await initial.close();
  services.splice(services.indexOf(initial), 1);

  const reopened = createLiveDesktopService({
    appVersion: "2.0.28-test",
    databasePath,
    stagingRoot: join(root, "staging-reopened"),
    chooseWorkspace: async () => workspace,
    runtimeFactory: fakeRuntimeFactory([{
      sessionId,
      resumeFails: true,
      loadSession: true,
      replayTurns: [{
        user: prompt,
        assistant: `reply:${prompt}`,
        toolOrder: "before_assistant",
        toolIdentityCollisionCase: collisionCase,
        collisionFirstContent: "remote-first",
      }],
    }]),
  });
  services.push(reopened);
  await reopened.bootstrap();
  await assert.rejects(
    reopened.sendMessage(task.task.taskId, `must-reject-${collisionCase}-tool-id-collision`),
    /session_replacement_requires_user_authorization/u,
  );
}

function collisionToolSpecs(
  _collisionCase: "synthetic",
  firstContent: string,
): readonly Readonly<{ id: string; content: string }>[] {
  const longId = "legacy-collision-source-".repeat(20).slice(0, 508);
  const legacyDigest = createHash("sha256").update(longId, "utf8").digest("hex");
  return Object.freeze([
    Object.freeze({ id: longId, content: firstContent }),
    Object.freeze({ id: `tool-sha256:${legacyDigest}`, content: "shared-second" }),
  ]);
}

function testToolIdentityKey(toolCallId: string): string {
  const canonical = JSON.stringify({ kind: "guild-tool-call-id-v1", value: toolCallId });
  return `tool-id-sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function startedRunId(response: SendMessageResponse) {
  assert.equal(response.status, "started");
  if (response.status !== "started") assert.fail("message was unexpectedly queued");
  return response.runId;
}

type FakeRuntimeSpec = {
  readonly contextWindowSize?: number;
  readonly sessionId?: string;
  readonly newSessionFailure?: string;
  readonly resumeFails?: boolean;
  readonly loadSession?: boolean;
  readonly loadFails?: boolean;
  readonly interruptDuringLoad?: boolean;
  readonly interruptAfterAssistant?: boolean;
  readonly replayTurns?: readonly Readonly<{
    user: string;
    userChunks?: readonly string[];
    assistant?: string;
    thought?: string;
    toolOrder?: "before_assistant" | "after_assistant";
    toolCallId?: string;
    toolReplayProofUnavailable?: boolean;
    toolIdentityCollisionCase?: "synthetic";
    collisionFirstContent?: string;
    plan?: RuntimePlanPayload["entries"];
    media?: Readonly<{
      base64Data: string;
      messageId?: string;
      discriminator?: "agent_message_chunk" | "user_message_chunk";
    }>;
  }>[];
  readonly startDelayMs?: number;
  readonly startFailure?: string;
  readonly setModelFailure?: string;
  readonly availableCommands?: readonly RuntimeCommand[];
  readonly configOptions?: readonly RuntimeConfigOption[];
  readonly promptResponses?: readonly string[];
  readonly promptDelayMs?: number;
};

function fakeRuntimeFactory(
  specs: readonly FakeRuntimeSpec[] = [],
  onCreate?: (adapter: FakeAdapter) => void,
  onFactoryInput?: (input: Parameters<RuntimeFactory>[0]) => void,
): RuntimeFactory {
  let created = 0;
  return async (input) => {
    onFactoryInput?.(input);
    const { adapterEpoch, sink } = input;
    const spec = specs[created] ?? specs.at(-1) ?? {};
    created += 1;
    const adapter = new FakeAdapter(
      adapterEpoch,
      spec.sessionId ?? "fake-session",
      sink,
      spec.resumeFails ?? false,
      spec.loadSession ?? false,
      spec.loadFails ?? false,
      spec.interruptDuringLoad ?? false,
      spec.interruptAfterAssistant ?? false,
      spec.replayTurns ?? Object.freeze([]),
      spec.startDelayMs ?? 0,
      spec.startFailure,
      spec.newSessionFailure,
      spec.setModelFailure,
      spec.contextWindowSize,
      spec.availableCommands,
      spec.configOptions,
      spec.promptResponses,
      spec.promptDelayMs ?? 0,
    );
    onCreate?.(adapter);
    return {
      runtimeVersion: "Fake Grok 1.0",
      adapter,
    };
  };
}

class FakeAdapter implements RuntimeAdapterPort {
  state = "created";
  newSessionCalls = 0;
  readonly selectedModels: string[] = [];
  readonly selectedModes: Array<{
    readonly model: string;
    readonly reasoningEffort: string;
  }> = [];
  readonly selectedConfigOptions: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  readonly prompts: Array<{
    readonly text: string;
    readonly resources: readonly {
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
      readonly size?: number;
    }[];
  }> = [];
  streamBurstYielded = false;
  cancelGate: Promise<void> | undefined;
  cancelFailure: Error | undefined;
  cancelSinkFailures = 0;
  readonly safeCancelDecisions: Array<{ readonly type: "cancelled" } | { readonly type: "selected"; readonly optionId: string }> = [];
  private promptSequence = 0;
  private startDelayReject: ((cause: unknown) => void) | undefined;
  private startDelayTimer: ReturnType<typeof setTimeout> | undefined;
  private session: AcpV1AdapterSession | undefined;
  private lastPromptError: unknown;
  private pendingPermission: {
    readonly controller: AbortController;
    readonly preparation: Promise<AcpV1PreparedPermissionResponse>;
    readonly request: ReturnType<typeof permissionRequest>;
  } | undefined;
  private pendingCancellation: {
    readonly identity: {
      readonly adapterEpoch: number;
      readonly sessionId: string;
      readonly promptSequence: number;
    };
    readonly ignoreTerminal: boolean;
    readonly latePermission: boolean;
    readonly terminalBeforeCancelSent: boolean;
    readonly reject: (cause: unknown) => void;
    readonly resolve: (terminal: RuntimePromptTerminalPayload) => void;
  } | undefined;

  constructor(
    readonly adapterEpoch: number,
    private readonly sessionId: string,
    private readonly sink: AcpV1AdapterSink,
    private readonly resumeFails: boolean,
    private readonly loadSessionAdvertised: boolean,
    private readonly loadFails: boolean,
    private readonly interruptDuringLoad: boolean,
    private readonly interruptAfterAssistant: boolean,
    private readonly replayTurns: readonly Readonly<{
      user: string;
      userChunks?: readonly string[];
      assistant?: string;
      thought?: string;
      toolOrder?: "before_assistant" | "after_assistant";
      toolCallId?: string;
      toolReplayProofUnavailable?: boolean;
      toolIdentityCollisionCase?: "synthetic";
      collisionFirstContent?: string;
      plan?: RuntimePlanPayload["entries"];
      media?: Readonly<{
        base64Data: string;
        messageId?: string;
        discriminator?: "agent_message_chunk" | "user_message_chunk";
      }>;
    }>[],
    private readonly startDelayMs: number,
    private readonly startFailure: string | undefined,
    private readonly newSessionFailure: string | undefined,
    private readonly setModelFailure: string | undefined,
    private readonly contextWindowSize: number | undefined,
    private readonly availableCommands: readonly RuntimeCommand[] | undefined,
    private configOptions: readonly RuntimeConfigOption[] | undefined,
    private readonly promptResponses: readonly string[] | undefined,
    private readonly promptDelayMs: number,
  ) {}

  async start(): Promise<AcpV1InitializeResult> {
    if (this.startDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        this.startDelayReject = reject;
        this.startDelayTimer = setTimeout(() => {
          this.startDelayReject = undefined;
          this.startDelayTimer = undefined;
          resolve();
        }, this.startDelayMs);
      });
    }
    if (this.state === "closed") throw new Error("fake adapter closed");
    if (this.startFailure !== undefined) throw new Error(this.startFailure);
    this.state = "ready";
    return Object.freeze({
      protocolVersion: 1,
      agentCapabilities: Object.freeze({
        loadSession: this.loadSessionAdvertised,
        resumeSession: true,
        prompt: Object.freeze({ image: false, audio: false, embeddedContext: false }),
      }),
      authMethods: Object.freeze([]),
      agentInfo: Object.freeze({ name: "Fake Grok", version: "1.0" }),
    });
  }

  async authenticate(): Promise<void> {}

  async officialBilling() {
    return Object.freeze({ creditUsagePercent: 0 });
  }

  async setModel(_session: AcpV1AdapterSession, model: "grok-4.6" | "grok-4.5"): Promise<void> {
    this.selectedModels.push(model);
    if (this.setModelFailure !== undefined) throw new Error(this.setModelFailure);
  }

  async setMode(
    _session: AcpV1AdapterSession,
    model: "grok-4.6" | "grok-4.5",
    reasoningEffort: "xhigh" | "high" | "medium" | "low",
  ): Promise<void> {
    this.selectedModes.push({ model, reasoningEffort });
  }

  async setConfigOption(
    _session: AcpV1AdapterSession,
    configId: string,
    value: string | boolean,
  ): Promise<readonly RuntimeConfigOption[]> {
    this.selectedConfigOptions.push({ configId, value });
    this.configOptions = Object.freeze((this.configOptions ?? []).map((option) =>
      option.id !== configId ? option : Object.freeze({ ...option, currentValue: value }) as RuntimeConfigOption));
    return this.configOptions;
  }

  async newSession(): Promise<AcpV1AdapterSession> {
    this.newSessionCalls += 1;
    if (this.newSessionFailure !== undefined) throw new Error(this.newSessionFailure);
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "new",
      state: {},
    });
    await this.announceCommands();
    return this.makeSession("new");
  }

  async resumeSession(): Promise<AcpV1AdapterSession> {
    if (this.resumeFails) throw new Error("fake resume failed");
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "resume",
      state: {},
    });
    await this.announceCommands();
    return this.makeSession("resume");
  }

  private async announceCommands(): Promise<void> {
    if (this.availableCommands === undefined) return;
    await this.sink.commitUpdate({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      ingestMode: "live",
      update: {
        type: "session_context",
        payload: {
          type: "session_context",
          sessionId: this.sessionId,
          received: received(),
          context: {
            kind: "commands",
            commands: this.availableCommands,
          },
        },
      },
    });
  }

  async loadSession(): Promise<AcpV1AdapterSession> {
    if (!this.loadSessionAdvertised) throw new Error("not supported");
    if (this.loadFails) throw new Error("fake load failed");
    const identity = { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId };
    const barrier = await this.sink.beginReplayBarrier({ identity });
    try {
      for (const turn of this.replayTurns) {
        const updates: AcpV1DecodedUpdate[] = (turn.userChunks ?? [turn.user]).map((text) => ({
          type: "turn" as const,
          payload: {
            type: "user_text_chunk" as const,
            sessionId: this.sessionId,
            text,
            received: received(),
          },
        }));
        if (turn.thought !== undefined) {
          updates.push({
            type: "turn",
            payload: {
              type: "agent_thought_chunk",
              sessionId: this.sessionId,
              text: turn.thought,
              received: received(),
            },
          });
        }
        const replayToolSpecs = turn.toolIdentityCollisionCase === undefined
          ? [{ id: turn.toolCallId ?? "tool-1", content: "package.json" }]
          : collisionToolSpecs(
              turn.toolIdentityCollisionCase,
              turn.collisionFirstContent ?? "remote-first",
            );
        const toolUpdates: AcpV1DecodedUpdate[] = replayToolSpecs.flatMap(({ id, content }) => [
          {
            type: "turn" as const,
            payload: {
              type: "tool_call_create" as const,
              sessionId: this.sessionId,
              toolCallId: id,
              title: "Read package",
              kind: "read" as const,
              status: "in_progress" as const,
              ...(turn.toolReplayProofUnavailable === true
                ? { replayProofUnavailable: true }
                : {}),
              received: received(),
            },
          },
          {
            type: "turn" as const,
            payload: {
              type: "tool_call_update" as const,
              sessionId: this.sessionId,
              toolCallId: id,
              status: "completed" as const,
              received: received(),
            },
          },
          {
            type: "turn" as const,
            payload: {
              type: "tool_call_update" as const,
              sessionId: this.sessionId,
              toolCallId: id,
              content: [{ type: "text" as const, text: content }],
              received: received(),
            },
          },
        ]);
        if (turn.toolOrder === "before_assistant") updates.push(...toolUpdates);
        if (turn.plan !== undefined) {
          updates.push({
            type: "turn",
            payload: {
              type: "plan",
              sessionId: this.sessionId,
              entries: turn.plan,
              received: received(),
            },
          });
        }
        if (turn.media !== undefined) {
          updates.push({
            type: "media_content",
            sessionId: this.sessionId,
            discriminator: turn.media.discriminator ?? "agent_message_chunk",
            mediaType: "image",
            mimeType: "image/png",
            base64Data: turn.media.base64Data,
            ...(turn.media.messageId === undefined ? {} : { messageId: turn.media.messageId }),
          });
        }
        if (turn.assistant !== undefined) {
          updates.push({
            type: "turn",
            payload: {
              type: "agent_text_chunk",
              sessionId: this.sessionId,
              text: turn.assistant,
              received: received(),
            },
          });
        }
        if (turn.toolOrder === "after_assistant") updates.push(...toolUpdates);
        for (const update of updates) {
          await this.sink.commitUpdate({ identity, ingestMode: "replay", update });
        }
      }
      if (this.interruptDuringLoad) {
        this.state = "faulted";
        await this.sink.commitTransportInterrupted({
          identity,
          reason: "process_fault",
          diagnostic: {
            exitCode: 9,
            signal: null,
            stderrTail: Object.freeze([]),
            stderrCapturedBytes: 0,
            stderrDroppedBytes: 0,
          },
        });
        throw new Error("fake transport interruption during load");
      }
      await this.sink.commitReplayBarrier({ identity, barrier, state: {} });
      return this.makeSession("load");
    } catch (cause: unknown) {
      await this.sink.abortReplayBarrier({ identity, barrier });
      throw cause;
    }
  }

  async prompt(
    session: AcpV1AdapterSession,
    text: string,
    resources: readonly {
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
      readonly size?: number;
    }[] = [],
  ): Promise<RuntimePromptTerminalPayload> {
    this.prompts.push(Object.freeze({ text, resources: Object.freeze([...resources]) }));
    this.promptSequence += 1;
    const promptSequence = this.promptSequence;
    const identity = {
      adapterEpoch: this.adapterEpoch,
      sessionId: session.sessionId,
      promptSequence,
    };
    if (text === "acceptance-sink-failure") {
      this.state = "faulted";
      const transportError = new AcpV1AdapterError("sink_commit_failed");
      setTimeout(() => {
        void this.sink.commitTransportInterrupted({
          identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
          activePromptSequence: promptSequence,
          reason: "process_fault",
          diagnostic: {
            faultCode: "sink_commit_failed",
            faultStage: "prompt_acceptance",
            stderrTail: Object.freeze([]),
            stderrCapturedBytes: 0,
            stderrDroppedBytes: 0,
          },
        });
      }, 0);
      throw transportError;
    }
    await this.sink.commitPromptAccepted({ identity, write: writeReceipt() });
    if (this.promptDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.promptDelayMs));
    }
    if (this.interruptAfterAssistant) {
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "agent_text_chunk",
            sessionId: session.sessionId,
            text: `reply:${text}`,
            received: received(),
          },
        },
      });
      this.state = "faulted";
      setTimeout(() => {
        void this.sink.commitTransportInterrupted({
          identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
          activePromptSequence: promptSequence,
          reason: "stdout_eof",
        });
      }, 0);
      throw new AcpV1AdapterError("transport_lost");
    }
    if (text.includes("[Current user message]\ninterrupt-capsule-after-accept")) {
      this.state = "faulted";
      const transportError = new Error("fake replacement capsule transport loss");
      setTimeout(() => {
        void this.sink.commitTransportInterrupted({
          identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
          activePromptSequence: promptSequence,
          reason: "stdout_eof",
        });
      }, 0);
      throw transportError;
    }
    if (
      text === "wait-for-cancel" ||
      text === "ignore-cancel" ||
      text === "late-permission-after-cancel" ||
      text === "permission-before-cancel" ||
      text === "terminal-before-cancel-sent" ||
      text === "overlapping-tools-wait" ||
      text === "overlapping-plan-wait" ||
      text === "/goal auxiliary" ||
      text === "silent"
    ) {
      let resolvePrompt!: (terminal: RuntimePromptTerminalPayload) => void;
      let rejectPrompt!: (cause: unknown) => void;
      const pendingPrompt = new Promise<RuntimePromptTerminalPayload>((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
      });
      void pendingPrompt.catch(() => undefined);
      const pending = {
        identity,
        ignoreTerminal: text === "ignore-cancel",
        latePermission: text === "late-permission-after-cancel",
        terminalBeforeCancelSent: text === "terminal-before-cancel-sent",
        reject: rejectPrompt,
        resolve: resolvePrompt,
      };
      this.pendingCancellation = pending;
      if (text === "permission-before-cancel") {
        const controller = new AbortController();
        const request = permissionRequest(session.sessionId, 74, "Allow cancellation test read?");
        const preparation = this.sink.preparePermissionResponse({
          identity,
          request,
          signal: controller.signal,
        });
        void preparation.catch(() => undefined);
        this.pendingPermission = { controller, preparation, request };
      }
      try {
        if (text === "/goal auxiliary") {
          await this.sink.commitAuxiliaryUpdate({
            identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
            auxiliarySessionId: "worker-session-1",
            update: {
              type: "turn",
              payload: {
                type: "agent_text_chunk",
                sessionId: "worker-session-1",
                text: "worker-private authored text",
                received: received(),
              },
            },
          });
          await this.sink.commitAuxiliaryUpdate({
            identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
            auxiliarySessionId: "worker-session-1",
            update: {
              type: "turn",
              payload: {
                type: "tool_call_create",
                sessionId: "worker-session-1",
                toolCallId: "worker-search",
                title: "Search project",
                kind: "search",
                status: "in_progress",
                received: received(),
              },
            },
          });
        } else if (text === "overlapping-tools-wait") {
          for (const payload of [
            {
              type: "tool_call_create" as const,
              sessionId: session.sessionId,
              toolCallId: "tool-read",
              title: "Read source",
              kind: "read" as const,
              status: "in_progress" as const,
              received: received(),
            },
            {
              type: "tool_call_create" as const,
              sessionId: session.sessionId,
              toolCallId: "tool-edit",
              title: "Edit source",
              kind: "edit" as const,
              status: "in_progress" as const,
              received: received(),
            },
            {
              type: "tool_call_update" as const,
              sessionId: session.sessionId,
              toolCallId: "tool-read",
              status: "in_progress" as const,
              received: received(),
            },
          ]) {
            await this.sink.commitUpdate({
              identity,
              ingestMode: "live",
              promptSequence,
              update: { type: "turn", payload },
            });
          }
        } else if (text === "overlapping-plan-wait") {
          await this.sink.commitUpdate({
            identity,
            ingestMode: "live",
            promptSequence,
            update: {
              type: "turn",
              payload: {
                type: "tool_call_create",
                sessionId: session.sessionId,
                toolCallId: "tool-read-before-plan",
                title: "Read before plan",
                kind: "read",
                status: "in_progress",
                received: received(),
              },
            },
          });
          await this.sink.commitUpdate({
            identity,
            ingestMode: "live",
            promptSequence,
            update: {
              type: "turn",
              payload: {
                type: "plan",
                sessionId: session.sessionId,
                entries: [
                  { content: "Inspect", priority: "high", status: "completed" },
                  { content: "Fix", priority: "high", status: "in_progress" },
                ],
                received: received(),
              },
            },
          });
        } else if (text !== "silent") {
          await this.sink.commitUpdate({
            identity,
            ingestMode: "live",
            promptSequence,
            update: {
              type: "turn",
              payload: {
                type: "agent_thought_chunk",
                sessionId: session.sessionId,
                text: "waiting",
                received: received(),
              },
            },
          });
        }
      } catch (cause: unknown) {
        this.lastPromptError = cause;
        if (this.pendingCancellation === pending) this.pendingCancellation = undefined;
        rejectPrompt(cause);
      }
      return pendingPrompt;
    }
    if (text === "reject-after-accept") {
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "agent_thought_chunk",
            sessionId: session.sessionId,
            text: "transport race",
            received: received(),
          },
        },
      });
      this.state = "faulted";
      setTimeout(() => {
        void this.sink.commitTransportInterrupted({
          identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
          activePromptSequence: promptSequence,
          reason: "stdout_eof",
        });
      }, 0);
      throw new Error("fake prompt transport rejection");
    }
    if (text === "permission-transport-loss") {
      const controller = new AbortController();
      const request = permissionRequest(session.sessionId, 73, "Allow transport test read?");
      const preparing = this.sink.preparePermissionResponse({ identity, request, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const transportError = new Error("fake permission transport loss");
      controller.abort(transportError);
      await preparing.catch(() => undefined);
      this.state = "faulted";
      setTimeout(() => {
        void this.sink.commitTransportInterrupted({
          identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
          activePromptSequence: promptSequence,
          reason: "process_fault",
          diagnostic: {
            processId: 4242,
            exitCode: 9,
            signal: null,
            stderrTail: Object.freeze(["redacted fake stderr"]),
            stderrCapturedBytes: 20,
            stderrDroppedBytes: 0,
          },
        });
      }, 0);
      throw transportError;
    }
    if (text === "permission-pre-aborted-transport-loss") {
      const controller = new AbortController();
      const transportError = new Error("fake pre-aborted permission transport loss");
      controller.abort(transportError);
      const request = permissionRequest(session.sessionId, 75, "Allow pre-aborted transport read?");
      await this.sink.preparePermissionResponse({
        identity,
        request,
        signal: controller.signal,
      }).catch(() => undefined);
      this.state = "faulted";
      setTimeout(() => {
        void this.sink.commitTransportInterrupted({
          identity: { adapterEpoch: this.adapterEpoch, sessionId: session.sessionId },
          activePromptSequence: promptSequence,
          reason: "process_fault",
        });
      }, 0);
      throw transportError;
    }
    if (text === "permission") {
      const request = Object.freeze({
        type: "permission_request" as const,
        sessionId: session.sessionId,
        received: received(),
        callbackRequestId: 71,
        toolCallId: "tool-permission-1",
        title: "Allow test read?",
        options: Object.freeze([
          Object.freeze({ optionId: "allow-once", name: "Allow once", kind: "allow_once" as const }),
          Object.freeze({ optionId: "reject-once", name: "Reject once", kind: "reject_once" as const }),
        ]),
      });
      const prepared = await this.sink.preparePermissionResponse({
        identity,
        request,
        signal: new AbortController().signal,
      });
      await this.sink.commitPermissionResponseFlushed({
        identity,
        request,
        decision: prepared.decision,
        delivery: prepared.delivery,
        write: inboundWriteReceipt(71),
      });
    }
    if (text === "tool" || text === "opaque-plan-tool" || text === "long-tool-id" || text === "lossy-tool") {
      const toolCallId = text === "opaque-plan-tool"
        ? "plan:external"
        : text === "long-tool-id"
          ? "x".repeat(508)
          : text === "lossy-tool"
            ? "lossy-tool"
          : "tool-1";
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "tool_call_create",
            sessionId: session.sessionId,
            toolCallId,
            title: "Read package",
            kind: "read",
            status: "in_progress",
            ...(text === "lossy-tool" ? { replayProofUnavailable: true } : {}),
            received: received(),
          },
        },
      });
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "tool_call_update",
            sessionId: session.sessionId,
            toolCallId,
            status: "completed",
            received: received(),
          },
        },
      });
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "tool_call_update",
            sessionId: session.sessionId,
            toolCallId,
            content: [{ type: "text", text: "package.json" }],
            received: received(),
          },
        },
      });
    }
    if (text === "tool-id-synthetic-collision") {
      for (const { id, content } of collisionToolSpecs("synthetic", "local-first")) {
        for (const payload of [
          {
            type: "tool_call_create" as const,
            sessionId: session.sessionId,
            toolCallId: id,
            title: "Read package",
            kind: "read" as const,
            status: "in_progress" as const,
            received: received(),
          },
          {
            type: "tool_call_update" as const,
            sessionId: session.sessionId,
            toolCallId: id,
            status: "completed" as const,
            received: received(),
          },
          {
            type: "tool_call_update" as const,
            sessionId: session.sessionId,
            toolCallId: id,
            content: [{ type: "text" as const, text: content }],
            received: received(),
          },
        ]) {
          await this.sink.commitUpdate({
            identity,
            ingestMode: "live",
            promptSequence,
            update: { type: "turn", payload },
          });
        }
      }
    }
    if (text === "tool-image") {
      const toolCallId = "tool-image";
      for (const payload of [
        {
          type: "tool_call_create" as const,
          sessionId: session.sessionId,
          toolCallId,
          title: "View image",
          kind: "read" as const,
          status: "in_progress" as const,
          received: received(),
        },
        {
          type: "tool_call_update" as const,
          sessionId: session.sessionId,
          toolCallId,
          status: "completed" as const,
          content: [{
            type: "media" as const,
            mediaType: "image" as const,
            mimeType: "image/png" as const,
            base64Data: TEST_PNG_BASE64,
            uri: "file:///tmp/preview.png",
          }],
          received: received(),
        },
      ]) {
        await this.sink.commitUpdate({
          identity,
          ingestMode: "live",
          promptSequence,
          update: { type: "turn", payload },
        });
      }
    }
    if (text.startsWith("tool-location-image:")) {
      const path = text.slice("tool-location-image:".length);
      const toolCallId = "tool-location-image";
      for (const payload of [
        {
          type: "tool_call_create" as const,
          sessionId: session.sessionId,
          toolCallId,
          title: "View image",
          kind: "read" as const,
          status: "in_progress" as const,
          locations: [{ path }],
          received: received(),
        },
        {
          type: "tool_call_update" as const,
          sessionId: session.sessionId,
          toolCallId,
          status: "completed" as const,
          received: received(),
        },
      ]) {
        await this.sink.commitUpdate({
          identity,
          ingestMode: "live",
          promptSequence,
          update: { type: "turn", payload },
        });
      }
    }
    if (text === "plan" || text === "large-plan") {
      const entries: RuntimePlanPayload["entries"] = text === "large-plan"
        ? [
            { content: "A".repeat(20_000), priority: "high", status: "in_progress" },
            { content: "B".repeat(20_000), priority: "low", status: "pending" },
          ]
        : [
            { content: "Inspect", priority: "high", status: "completed" },
            { content: "Fix", priority: "high", status: "in_progress" },
            { content: "Verify", priority: "medium", status: "pending" },
          ];
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "plan",
            sessionId: session.sessionId,
            entries,
            received: received(),
          },
        },
      });
    }
    if (text === "media") {
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "media_content",
          sessionId: session.sessionId,
          discriminator: "agent_message_chunk",
          mediaType: "image",
          mimeType: "image/png",
          base64Data: TEST_PNG_BASE64,
          messageId: "media-1",
        },
      });
    }
    if (text === "user-echo") {
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "user_text_chunk",
            sessionId: session.sessionId,
            text,
            messageId: `user-${promptSequence}`,
            received: received(),
          },
        },
      });
    }
    if (text === "context-usage" || text === "context-usage-and-terminal") {
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "session_context",
          payload: {
            type: "session_context",
            sessionId: session.sessionId,
            received: received(),
            context: {
              kind: "usage",
              scope: "session_context_window_and_cost",
              used: 81_920,
              size: 262_144,
            },
          },
        },
      });
    }
    if (text === "protocol-rejection-after-thought") {
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "agent_thought_chunk",
            sessionId: session.sessionId,
            text: "reasoning before malformed prompt response",
            received: received(),
          },
        },
      });
      throw new Error("official runtime prompt response could not be decoded");
    }
    if (text === "after-protocol-rejection") {
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: {
          type: "turn",
          payload: {
            type: "agent_thought_chunk",
            sessionId: session.sessionId,
            text: "fresh reasoning after recovery",
            received: received(),
          },
        },
      });
    }
    if (text === "context-publish-race") {
      const payload: RuntimeTextChunkPayload = Object.freeze({
        type: "agent_text_chunk",
        sessionId: session.sessionId,
        messageId: `message-${promptSequence}`,
        text: "reply:context-publish-race",
        received: received(),
      });
      const terminal: RuntimePromptTerminalPayload = Object.freeze({
        type: "prompt_terminal",
        sessionId: session.sessionId,
        stopReason: "end_turn",
        classification: "completed",
        contextTokensUsed: 25_523,
        received: received(),
      });
      await Promise.all([
        this.sink.commitUpdate({
          identity,
          ingestMode: "live",
          promptSequence,
          update: { type: "turn", payload },
        }),
        this.sink.commitPromptTerminal({ identity, terminal }),
      ]);
      return terminal;
    }
    if (text === "stream-burst") setImmediate(() => { this.streamBurstYielded = true; });
    const responseChunks = text === "stream-burst"
      ? Array.from({ length: 512 }, (_, index) => String(index) + ",")
      : [this.promptResponses?.[promptSequence - 1] ?? `reply:${text}`];
    for (const chunk of responseChunks) {
      const payload: RuntimeTextChunkPayload = Object.freeze({
        type: "agent_text_chunk",
        sessionId: session.sessionId,
        messageId: `message-${promptSequence}`,
        text: chunk,
        received: received(),
      });
      await this.sink.commitUpdate({
        identity,
        ingestMode: "live",
        promptSequence,
        update: { type: "turn", payload },
      });
    }
    const terminal: RuntimePromptTerminalPayload = Object.freeze({
      type: "prompt_terminal",
      sessionId: session.sessionId,
      stopReason: "end_turn",
      classification: "completed",
      received: received(),
      ...(text === "context-used-only" || text === "context-usage-and-terminal"
        ? { contextTokensUsed: 25_523 }
        : {}),
    });
    await this.sink.commitPromptTerminal({ identity, terminal });
    if (text === "hold-after-terminal") {
      return new Promise(() => undefined);
    }
    return terminal;
  }

  async cancel(): Promise<JsonRpcWriteReceipt> {
    await this.cancelGate;
    if (this.cancelFailure !== undefined) throw this.cancelFailure;
    let pending = this.pendingCancellation;
    for (let attempt = 0; pending === undefined && attempt < 100; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      pending = this.pendingCancellation;
    }
    if (pending === undefined) {
      const detail = this.lastPromptError instanceof Error ? this.lastPromptError.message : "none";
      throw new Error(`no active cancellable fixture prompt:${detail}`);
    }
    const write = writeReceipt();
    if (pending.terminalBeforeCancelSent) {
      const terminal: RuntimePromptTerminalPayload = Object.freeze({
        type: "prompt_terminal",
        sessionId: pending.identity.sessionId,
        stopReason: "end_turn",
        classification: "completed",
        received: received(),
      });
      await this.sink.commitPromptTerminal({ identity: pending.identity, terminal });
      this.pendingCancellation = undefined;
      pending.resolve(terminal);
      try {
        await this.sink.commitCancelSent({ identity: pending.identity, write });
      } catch (cause: unknown) {
        this.cancelSinkFailures += 1;
        throw cause;
      }
      return write;
    }
    const pendingPermission = this.pendingPermission;
    if (pendingPermission !== undefined) {
      const abortReason = new Error("fake permission preparation abandoned by cancel");
      pendingPermission.controller.abort(abortReason);
      const prepared = await pendingPermission.preparation;
      this.safeCancelDecisions.push(prepared.decision);
      await this.sink.commitPermissionResponseFlushed({
        identity: pending.identity,
        request: pendingPermission.request,
        decision: prepared.decision,
        delivery: prepared.delivery,
        write: inboundWriteReceipt(pendingPermission.request.callbackRequestId),
      });
      this.pendingPermission = undefined;
    }
    await this.sink.commitCancelSent({ identity: pending.identity, write });
    if (pending.ignoreTerminal) return write;
    if (pending.latePermission) {
      const request = permissionRequest(pending.identity.sessionId, 72, "Allow late test read?");
      const prepared = await this.sink.preparePermissionResponse({
        identity: pending.identity,
        request,
        signal: new AbortController().signal,
      });
      this.safeCancelDecisions.push(prepared.decision);
      await this.sink.commitPermissionResponseFlushed({
        identity: pending.identity,
        request,
        decision: prepared.decision,
        delivery: prepared.delivery,
        write: inboundWriteReceipt(72),
      });
    }
    const terminal: RuntimePromptTerminalPayload = Object.freeze({
      type: "prompt_terminal",
      sessionId: pending.identity.sessionId,
      stopReason: "cancelled",
      classification: "cancelled",
      received: received(),
    });
    await this.sink.commitPromptTerminal({ identity: pending.identity, terminal });
    this.pendingCancellation = undefined;
    pending.resolve(terminal);
    return write;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "faulted";
    if (this.startDelayTimer !== undefined) clearTimeout(this.startDelayTimer);
    this.startDelayTimer = undefined;
    const rejectStart = this.startDelayReject;
    this.startDelayReject = undefined;
    rejectStart?.(new Error("fake adapter closed"));
    const pending = this.pendingCancellation;
    this.pendingPermission?.controller.abort(new Error("fake adapter closed"));
    this.pendingPermission = undefined;
    if (pending !== undefined) {
      this.pendingCancellation = undefined;
      pending.reject(new Error("fake adapter closed"));
      await Promise.resolve();
    }
    if (this.session !== undefined) {
      await this.sink.commitTransportInterrupted({
        identity: {
          adapterEpoch: this.adapterEpoch,
          sessionId: this.session.sessionId,
        },
        reason: "explicit_close",
      });
    }
    this.state = "closed";
  }

  faultWithoutInterrupt(): void {
    this.state = "faulted";
  }

  async emitTransportInterrupted(): Promise<void> {
    if (this.session === undefined) throw new Error("fake session missing");
    await this.sink.commitTransportInterrupted({
      identity: {
        adapterEpoch: this.adapterEpoch,
        sessionId: this.session.sessionId,
      },
      reason: "process_fault",
    });
  }

  async emitContextUsage(used: number, size: number): Promise<void> {
    if (this.session === undefined) throw new Error("fake session missing");
    await this.sink.commitUpdate({
      identity: {
        adapterEpoch: this.adapterEpoch,
        sessionId: this.session.sessionId,
      },
      ingestMode: "live",
      update: {
        type: "session_context",
        payload: {
          type: "session_context",
          sessionId: this.session.sessionId,
          received: received(),
          context: {
            kind: "usage",
            scope: "session_context_window_and_cost",
            used,
            size,
          },
        },
      },
    });
  }

  async emitSessionTitle(title: string): Promise<void> {
    if (this.session === undefined) throw new Error("fake session missing");
    await this.sink.commitUpdate({
      identity: {
        adapterEpoch: this.adapterEpoch,
        sessionId: this.session.sessionId,
      },
      ingestMode: "live",
      update: {
        type: "session_context",
        payload: {
          type: "session_context",
          sessionId: this.session.sessionId,
          received: received(),
          context: { kind: "info", title },
        },
      },
    });
  }

  async emitAgentText(text: string): Promise<void> {
    if (this.session === undefined) throw new Error("fake session missing");
    await this.sink.commitUpdate({
      identity: {
        adapterEpoch: this.adapterEpoch,
        sessionId: this.session.sessionId,
      },
      ingestMode: "live",
      promptSequence: this.promptSequence,
      update: {
        type: "turn",
        payload: {
          type: "agent_text_chunk",
          sessionId: this.session.sessionId,
          messageId: `stale-message-${this.promptSequence}`,
          text,
          received: received(),
        },
      },
    });
  }

  async emitPromptTerminal(): Promise<void> {
    if (this.session === undefined) throw new Error("fake session missing");
    await this.sink.commitPromptTerminal({
      identity: {
        adapterEpoch: this.adapterEpoch,
        sessionId: this.session.sessionId,
        promptSequence: this.promptSequence,
      },
      terminal: {
        type: "prompt_terminal",
        sessionId: this.session.sessionId,
        stopReason: "end_turn",
        classification: "completed",
        received: received(),
      },
    });
  }

  private makeSession(establishedBy: "new" | "resume" | "load"): AcpV1AdapterSession {
    const session = Object.freeze({
      adapterEpoch: this.adapterEpoch,
      sessionId: this.sessionId,
      establishedBy,
      ...(this.contextWindowSize === undefined ? {} : { contextWindowSize: this.contextWindowSize }),
      ...(this.configOptions === undefined ? {} : { configOptions: this.configOptions }),
    });
    this.session = session;
    return session;
  }
}

function permissionRequest(sessionId: string, callbackRequestId: number, title: string) {
  return Object.freeze({
    type: "permission_request" as const,
    sessionId,
    received: received(),
    callbackRequestId,
    toolCallId: `tool-permission-${callbackRequestId}`,
    title,
    options: Object.freeze([
      Object.freeze({ optionId: "allow-once", name: "Allow once", kind: "allow_once" as const }),
      Object.freeze({ optionId: "reject-once", name: "Reject once", kind: "reject_once" as const }),
    ]),
  });
}

function received() {
  return Object.freeze({
    wallClockIso: new Date().toISOString(),
    monotonicMs: performance.now(),
  });
}

const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9ZQAAAABJRU5ErkJggg==";

let testKeySequence = 0;

function testKey(label: string) {
  testKeySequence += 1;
  return testMust(parseIdempotencyKey(`${label}-${testKeySequence}`));
}

function testMust<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(result.reason);
  return result.value;
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

function inboundWriteReceipt(requestId: number): JsonRpcInboundResponseWriteReceipt {
  return Object.freeze({
    type: "inbound_response_write_completed",
    method: "session/request_permission",
    requestId,
    bytes: 1,
    evidence: "local_writer_completion",
    remoteAcceptance: "not_evidenced",
  });
}
