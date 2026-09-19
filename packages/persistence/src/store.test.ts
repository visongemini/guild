import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import {
  createRuntimeTurnEvent,
  freezeRuntimePayload,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parsePermissionDeliveryAttemptId,
  parsePermissionOutboxCommandId,
  parseRunId,
  parseSessionAttemptId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  type PermissionIdentity,
  type Result,
  type RuntimePermissionRequestPayload,
} from "@guild/contracts";
import {
  openGuildPersistence,
  PersistenceError,
  type GuildPersistence,
} from "./index.js";
import * as packageRoot from "./index.js";

function must<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

function temporaryDatabase(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "guild-persistence-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return join(directory, "guild.sqlite3");
}

const taskId = must(parseTaskId("task-1"));
const runId = must(parseRunId("run-1"));
const sessionId = must(parseSessionId("session-1"));
const windowId = must(parseWindowId("window-1"));
const epoch = must(parseAdapterEpoch(1));
const workspaceId = "workspace-1";

let sequence = 0;
function key(label: string) {
  sequence += 1;
  return must(parseIdempotencyKey(`${label}-${sequence}`));
}

function identity(toolLabel: string): PermissionIdentity {
  return Object.freeze({
    taskId,
    runId,
    sessionId,
    toolCallId: must(parseToolCallId(`tool-${toolLabel}`)),
    adapterEpoch: epoch,
    windowId,
  });
}

function request(
  exactIdentity: PermissionIdentity,
  callbackRequestId: string,
): RuntimePermissionRequestPayload {
  const payload = freezeRuntimePayload({
    type: "permission_request",
    sessionId: exactIdentity.sessionId,
    received: {
      wallClockIso: "2026-08-27T12:00:00.000Z",
      monotonicMs: 100,
    },
    callbackRequestId,
    toolCallId: exactIdentity.toolCallId,
    title: "Write file?",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
    ],
  });
  if (payload.type !== "permission_request") assert.fail("wrong payload");
  return payload;
}

function register(
  store: GuildPersistence,
  exactIdentity: PermissionIdentity,
  callbackRequestId: string,
): void {
  const result = store.registerPermission({
    identity: exactIdentity,
    request: request(exactIdentity, callbackRequestId),
    idempotencyKey: key(`register-${callbackRequestId}`),
    runIdempotencyKey: key(`run-register-${callbackRequestId}`),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  assert.equal(result.duplicate, false);
  assert.equal(result.record.registrationMode, "pending");
  assert.equal(result.record.state, "pending");
  assert.equal(result.record.outbox, undefined);
}

function baseStore(path: string): GuildPersistence {
  const store = openGuildPersistence({ path });
  store.createTask({ taskId, owningWindowId: windowId });
  store.createRun({ taskId, runId });
  return store;
}

function conversationStore(path: string): GuildPersistence {
  const store = openGuildPersistence({ path });
  store.createWorkspace({
    workspaceId,
    canonicalPath: "/tmp/guild-workspace-1",
    displayName: "Guild Workspace",
  });
  store.createConversationTask({
    taskId,
    workspaceId,
    title: "Conversation task",
    owningWindowId: windowId,
  });
  return store;
}

function liveReadyStore(
  path: string,
  durableNotices: NonNullable<
    Parameters<GuildPersistence["commitPromptAccepted"]>[0]["durableNotices"]
  > = [],
): GuildPersistence {
  const store = conversationStore(path);
  const attemptId = must(parseSessionAttemptId("attempt-live-1"));
  const started = store.applySessionBinding({
    taskId,
    event: {
      type: "start_session",
      attemptId,
      idempotencyKey: key("live-session-start"),
    },
  });
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  const established = store.applySessionBinding({
    taskId,
    event: {
      type: "session_new_succeeded",
      sessionId,
      adapterEpoch: epoch,
      attemptId,
      idempotencyKey: key("live-session-established"),
    },
  });
  assert.equal(established.ok, true, established.ok ? "" : established.reason);
  store.createRun({ taskId, runId });
  const dispatched = store.applyRun({
    taskId,
    runId,
    event: {
      type: "scheduler_dispatch",
      sessionId,
      adapterEpoch: epoch,
      idempotencyKey: key("live-run-dispatch"),
    },
  });
  assert.equal(dispatched.ok, true, dispatched.ok ? "" : dispatched.reason);
  store.commitAdapterEpoch({
    taskId,
    sessionId,
    adapterEpoch: epoch,
    expectedRevision: 0,
    status: "alive",
  });
  const accepted = store.commitPromptAccepted({
    taskId,
    runId,
    sessionId,
    adapterEpoch: epoch,
    promptSequence: 1,
    idempotencyKey: key("live-prompt-accepted"),
    durableNotices,
  });
  assert.equal(accepted.run.state, "running");
  return store;
}

function permissionReadyStore(path: string): GuildPersistence {
  const store = baseStore(path);
  const dispatched = store.applyRun({
    taskId,
    runId,
    event: {
      type: "scheduler_dispatch",
      sessionId,
      adapterEpoch: epoch,
      idempotencyKey: key("permission-ready-dispatch"),
    },
  });
  assert.equal(dispatched.ok, true, dispatched.ok ? "" : dispatched.reason);
  const accepted = store.applyRun({
    taskId,
    runId,
    event: {
      type: "prompt_accepted",
      sessionId,
      adapterEpoch: epoch,
      idempotencyKey: key("permission-ready-prompt"),
    },
  });
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.reason);
  assert.equal(accepted.run.state, "running");
  return store;
}

function cancelRequestedStore(path: string): GuildPersistence {
  const store = permissionReadyStore(path);
  const cancelled = store.applyRun({
    taskId,
    runId,
    event: {
      type: "user_cancel",
      idempotencyKey: key("request-cancel"),
    },
  });
  assert.equal(cancelled.ok, true, cancelled.ok ? "" : cancelled.reason);
  assert.equal(cancelled.run.state, "cancel_requested");
  return store;
}

function leaveDeadWriterLease(path: string): void {
  const crashed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      String.raw`
        const { acquireDatabaseLease } = await import(
          process.env.GUILD_LEASE_MODULE_URL
        );
        acquireDatabaseLease(process.env.GUILD_LEASE_DATABASE_PATH);
        process.kill(process.pid, "SIGKILL");
      `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GUILD_LEASE_DATABASE_PATH: path,
        GUILD_LEASE_MODULE_URL: new URL("./lease.js", import.meta.url).href,
      },
      timeout: 5_000,
    },
  );
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
}

describe("main-only SQLite persistence", () => {
  it("exports only the narrow package root and no SQLite, SQL, codec, or transaction surface", () => {
    assert.deepEqual(Object.keys(packageRoot).sort(), [
      "PersistenceError",
      "SCHEMA_VERSION",
      "openGuildPersistence",
    ]);
    for (const forbidden of [
      "DatabaseSync",
      "SQL",
      "codec",
      "transaction",
      "encodePermission",
    ]) {
      assert.equal(Object.hasOwn(packageRoot, forbidden), false);
    }
    const publicDeclarations = ["index.d.ts", "store.d.ts"]
      .map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
      .join("\n");
    assert.doesNotMatch(
      publicDeclarations,
      /DatabaseSync|node:sqlite|encodePermission|\btransaction\b/u,
    );
    const storeImplementation = readFileSync(
      new URL("store.js", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      storeImplementation,
      /node:sqlite|new DatabaseSync|openSync|readFileSync|copyFileSync/u,
    );
  });

  it("rejects an Electron renderer before creating a database file", (t) => {
    const path = temporaryDatabase(t);
    const prior = Object.getOwnPropertyDescriptor(process, "type");
    try {
      Object.defineProperty(process, "type", {
        configurable: true,
        value: "renderer",
      });
      assert.throws(
        () => openGuildPersistence({ path }),
        (error: unknown) =>
          error instanceof PersistenceError &&
          error.code === "storage_configuration_failed",
      );
      assert.equal(existsSync(path), false);
    } finally {
      if (prior === undefined) {
        Reflect.deleteProperty(process, "type");
      } else {
        Object.defineProperty(process, "type", prior);
      }
    }
  });

  it("rejects a worker thread before it can touch the process-wide guard", async (t) => {
    const path = temporaryDatabase(t);
    const worker = new Worker(
      String.raw`
        const { parentPort, workerData } = require("node:worker_threads");
        import(workerData.moduleUrl).then(({ openGuildPersistence }) => {
          try {
            openGuildPersistence({ path: workerData.databasePath });
            parentPort.postMessage({ opened: true });
          } catch (error) {
            parentPort.postMessage({
              opened: false,
              code: error && typeof error === "object" ? error.code : undefined,
            });
          }
        }).catch((error) => parentPort.postMessage({
          opened: false,
          importError: String(error),
        }));
      `,
      {
        eval: true,
        workerData: {
          databasePath: path,
          moduleUrl: new URL("./index.js", import.meta.url).href,
        },
      },
    );
    t.after(() => worker.terminate());
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      },
    );
    assert.deepEqual(result, {
      opened: false,
      code: "storage_configuration_failed",
    });
    assert.equal(existsSync(path), false);
    assert.equal(
      existsSync(`${path}.guild-writer-guard.sqlite3`),
      false,
    );
  });

  it("creates a WAL database whose application tables are STRICT at schema v14", (t) => {
    const path = temporaryDatabase(t);
    const store = baseStore(path);
    store.close();
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
    assert.equal(raw.prepare("PRAGMA user_version").get()?.["user_version"], 14);
    const strictByTable = new Map(
      raw
        .prepare("PRAGMA table_list")
        .all()
        .filter((row) => row["schema"] === "main" && row["name"] !== "sqlite_schema")
        .map((row) => [row["name"], row["strict"]]),
    );
    for (const table of [
      "schema_migrations",
      "guild_meta",
      "tasks",
      "session_bindings",
      "runs",
      "permission_requests",
      "permission_outbox",
      "committed_envelopes",
      "workspaces",
      "task_metadata",
      "adapter_epochs",
      "prompt_correlations",
      "conversation_entries",
      "queued_turns",
      "drafts",
      "app_settings",
      "session_context_windows",
      "continuous_tasks",
    ]) {
      assert.equal(strictByTable.get(table), 1, `${table} must be STRICT`);
    }
    raw.close();
  });

  it("uses the system-derived locale only for a brand-new database", (t) => {
    const path = temporaryDatabase(t);
    const first = openGuildPersistence({ path, initialLocale: "en-US" });
    assert.equal(first.loadAppSettings().locale, "en-US");
    first.close();

    const reopened = openGuildPersistence({ path, initialLocale: "zh-CN" });
    assert.equal(reopened.loadAppSettings().locale, "en-US");
    reopened.close();
  });

  it("atomically creates workspace-owned conversations and keeps the parent binding immutable", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    const duplicate = store.createConversationTask({
      taskId,
      workspaceId,
      title: "Conversation task",
      owningWindowId: windowId,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.sessionBinding.state, "unbound");

    store.createWorkspace({
      workspaceId: "workspace-2",
      canonicalPath: "/tmp/guild-workspace-2",
      displayName: "Second Workspace",
    });
    assert.throws(
      () => store.bindTaskToWorkspace({
        taskId,
        workspaceId: "workspace-2",
        title: "Conversation task",
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_already_exists",
    );
    assert.equal(store.listTasks({ workspaceId }).length, 1);
    assert.equal(store.listTasks({ workspaceId: "workspace-2" }).length, 0);
    assert.equal(
      store.listWorkspaces().find((workspace) => workspace.workspaceId === workspaceId)?.taskCount,
      1,
    );

    const archived = store.archiveTask({
      taskId,
      expectedRevision: duplicate.metadata.revision,
    });
    assert.equal(archived.disposition, "archived");
    assert.equal(store.listTasks({ workspaceId }).length, 0);
    assert.deepEqual(
      store.listTasks({ workspaceId, includeArchived: true }).map((task) => task.taskId),
      [taskId],
    );
    assert.throws(
      () => store.archiveTask({ taskId, expectedRevision: 1 }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );

    const restoredTask = store.unarchiveTask({
      taskId,
      expectedRevision: archived.revision,
    });
    assert.equal(restoredTask.disposition, "active");
    assert.equal(store.listTasks({ workspaceId }).length, 1);

    const workspace = store.loadWorkspace(workspaceId);
    const archivedWorkspace = store.archiveWorkspace({
      workspaceId,
      expectedRevision: workspace.revision,
    });
    assert.equal(store.listWorkspaces().some((item) => item.workspaceId === workspaceId), false);
    const restoredWorkspace = store.restoreWorkspace({
      workspaceId,
      expectedRevision: archivedWorkspace.revision,
    });
    assert.equal(restoredWorkspace.disposition, "active");
    const deletedWorkspace = store.deleteWorkspace({
      workspaceId,
      expectedRevision: restoredWorkspace.revision,
    });
    assert.equal(deletedWorkspace.disposition, "deleted");
    assert.equal(store.listWorkspaces().some((item) => item.workspaceId === workspaceId), false);
    assert.equal(
      store.listWorkspaces({ includeDeleted: true }).some((item) => item.workspaceId === workspaceId),
      true,
    );
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadTaskMetadata(taskId).workspaceId, workspaceId);
    assert.equal(reopened.loadWorkspace(workspaceId).disposition, "deleted");
    reopened.close();
  });

  it("renames only active tasks with compare-and-swap revision protection", (t) => {
    const store = conversationStore(temporaryDatabase(t));
    const original = store.loadTaskMetadata(taskId);
    const renamed = store.renameTask({
      taskId,
      expectedRevision: original.revision,
      title: "First real prompt",
    });
    assert.equal(renamed.title, "First real prompt");
    assert.equal(renamed.revision, original.revision + 1);

    const duplicate = store.renameTask({
      taskId,
      expectedRevision: renamed.revision,
      title: "First real prompt",
    });
    assert.equal(duplicate.revision, renamed.revision);

    assert.throws(
      () => store.renameTask({
        taskId,
        expectedRevision: original.revision,
        title: "Stale title",
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );

    const archived = store.archiveTask({
      taskId,
      expectedRevision: renamed.revision,
    });
    assert.throws(
      () => store.renameTask({
        taskId,
        expectedRevision: archived.revision,
        title: "Archived title",
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "domain_operation_rejected",
    );
    store.close();
  });

  it("persists pinned task ordering and protects updates with revisions", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    const original = store.loadTaskMetadata(taskId);
    assert.equal(original.pinned, false);
    const newerTaskId = must(parseTaskId("task-newer"));
    store.createConversationTask({
      taskId: newerTaskId,
      workspaceId,
      title: "Newer unpinned task",
    });
    const pinned = store.setTaskPinned({
      taskId,
      expectedRevision: original.revision,
      pinned: true,
    });
    assert.equal(pinned.pinned, true);
    assert.deepEqual(store.listTasks({ workspaceId }).map((task) => task.taskId), [taskId, newerTaskId]);
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadTaskMetadata(taskId).pinned, true);
    assert.throws(
      () => reopened.setTaskPinned({ taskId, expectedRevision: original.revision, pinned: false }),
      (error: unknown) => error instanceof PersistenceError && error.code === "persistence_cas_conflict",
    );
    reopened.close();
  });

  it("keeps sidebar task order stable while background output streams", async (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    const backgroundTaskId = must(parseTaskId("task-background"));
    store.createConversationTask({
      taskId: backgroundTaskId,
      workspaceId,
      title: "Background task",
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 4));
    store.createConversationEntry({
      taskId,
      entryId: "entry-user-order-anchor",
      kind: "user",
      text: "Start this task after the background task.",
      status: "complete",
    });
    assert.deepEqual(store.listTasks({ workspaceId }).map((task) => task.taskId), [taskId, backgroundTaskId]);

    await new Promise<void>((resolve) => setTimeout(resolve, 4));
    const assistant = store.createConversationEntry({
      taskId: backgroundTaskId,
      entryId: "entry-background-stream",
      kind: "assistant",
      text: "Streaming",
      status: "streaming",
    }).record;
    const appended = store.appendConversationEntryText({
      taskId: backgroundTaskId,
      entryId: assistant.entryId,
      expectedRevision: assistant.revision,
      text: " output",
    });
    store.finalizeConversationEntry({
      taskId: backgroundTaskId,
      entryId: assistant.entryId,
      expectedRevision: appended.revision,
      status: "complete",
    });
    assert.deepEqual(store.listTasks({ workspaceId }).map((task) => task.taskId), [taskId, backgroundTaskId]);

    store.saveDraft({
      taskId: backgroundTaskId,
      expectedRevision: 0,
      text: "A draft is not a newly started turn.",
    });
    assert.deepEqual(store.listTasks({ workspaceId }).map((task) => task.taskId), [taskId, backgroundTaskId]);

    await new Promise<void>((resolve) => setTimeout(resolve, 4));
    store.createConversationEntry({
      taskId: backgroundTaskId,
      entryId: "entry-user-new-order",
      kind: "user",
      text: "Now explicitly continue this task.",
      status: "complete",
    });
    assert.deepEqual(store.listTasks({ workspaceId }).map((task) => task.taskId), [backgroundTaskId, taskId]);
    store.close();
  });

  it("persists idempotent ordered entries, bounded streaming, drafts, and bilingual settings", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    const created = store.createConversationEntry({
      taskId,
      entryId: "entry-user-1",
      kind: "user",
      text: "你好",
      metadata: { z: true, a: { nested: 1 } },
      status: "complete",
    });
    assert.equal(created.duplicate, false);
    assert.equal(created.record.sequence, 1);
    const duplicate = store.createConversationEntry({
      taskId,
      entryId: "entry-user-1",
      kind: "user",
      text: "你好",
      metadata: { a: { nested: 1 }, z: true },
      status: "complete",
    });
    assert.equal(duplicate.duplicate, true);
    assert.throws(
      () => store.createConversationEntry({
        taskId,
        entryId: "entry-user-1",
        kind: "assistant",
        text: "conflict",
        status: "complete",
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_already_exists",
    );

    const streaming = store.createConversationEntry({
      taskId,
      entryId: "entry-assistant-1",
      kind: "assistant",
      text: "Hel",
      status: "streaming",
    }).record;
    const appended = store.appendConversationEntryText({
      taskId,
      entryId: streaming.entryId,
      expectedRevision: streaming.revision,
      text: "lo",
    });
    assert.equal(appended.text, "Hello");
    assert.throws(
      () => store.appendConversationEntryText({
        taskId,
        entryId: streaming.entryId,
        expectedRevision: streaming.revision,
        text: "!",
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    const terminal = store.finalizeConversationEntry({
      taskId,
      entryId: streaming.entryId,
      expectedRevision: appended.revision,
      status: "complete",
    });
    assert.equal(terminal.status, "complete");
    assert.deepEqual(
      store.listConversationEntries({ taskId, afterSequence: 1, limit: 1 })
        .map((entry) => entry.entryId),
      ["entry-assistant-1"],
    );

    const draft1 = store.saveDraft({ taskId, expectedRevision: 0, text: "draft" });
    const draft2 = store.saveDraft({
      taskId,
      expectedRevision: draft1.revision,
      text: "draft two",
    });
    assert.equal(draft2.text, "draft two");
    const settings1 = store.loadAppSettings();
    assert.deepEqual(
      {
        locale: settings1.locale,
        sidebarWidth: settings1.sidebarWidth,
        browserSyncEnabled: settings1.browserSyncEnabled,
        grokModel: settings1.grokModel,
        reasoningEffort: settings1.reasoningEffort,
        permissionMode: settings1.permissionMode,
        startup: settings1.startup,
        nickname: settings1.nickname,
        restoreLastTask: settings1.restoreLastTask,
        newTaskWorkspaceMode: settings1.newTaskWorkspaceMode,
        taskNotificationsEnabled: settings1.taskNotificationsEnabled,
      },
      {
        locale: "zh-CN",
        sidebarWidth: 280,
        browserSyncEnabled: false,
        grokModel: "grok-4.6",
        reasoningEffort: "xhigh",
        permissionMode: "default",
        startup: {
          webSearchEnabled: true,
          planEnabled: true,
          subagentsEnabled: true,
          maxTurns: null,
        },
        nickname: "BDV",
        restoreLastTask: true,
        newTaskWorkspaceMode: "ask",
        taskNotificationsEnabled: true,
      },
    );
    assert.equal(settings1.avatarFilename, undefined);
    const settings2 = store.updateAppSettings({
      expectedRevision: settings1.revision,
      locale: "en-US",
      sidebarWidth: 360,
      browserSyncEnabled: true,
      grokModel: "grok-4.5",
      reasoningEffort: "high",
      permissionMode: "bypassPermissions",
      startup: {
        webSearchEnabled: false,
        planEnabled: true,
        subagentsEnabled: false,
        maxTurns: 256,
      },
      nickname: " 小云 ",
      restoreLastTask: false,
      newTaskWorkspaceMode: "last",
      taskNotificationsEnabled: false,
    });
    assert.equal(settings2.locale, "en-US");
    assert.equal(settings2.sidebarWidth, 360);
    assert.equal(settings2.browserSyncEnabled, true);
    assert.equal(settings2.grokModel, "grok-4.5");
    assert.equal(settings2.reasoningEffort, "high");
    assert.equal(settings2.permissionMode, "bypassPermissions");
    assert.deepEqual(settings2.startup, {
      webSearchEnabled: false,
      planEnabled: true,
      subagentsEnabled: false,
      maxTurns: 256,
    });
    assert.equal(settings2.nickname, "小云");
    assert.equal(settings2.restoreLastTask, false);
    assert.equal(settings2.newTaskWorkspaceMode, "last");
    assert.equal(settings2.taskNotificationsEnabled, false);
    assert.throws(
      () => store.updateAppSettings({
        expectedRevision: settings2.revision,
        nickname: "\nnope",
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "domain_operation_rejected",
    );
    assert.throws(
      () => store.updateAppSettings({
        expectedRevision: settings2.revision,
        grokModel: "grok-4.5",
        reasoningEffort: "xhigh",
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "domain_operation_rejected",
    );
    assert.throws(
      () => store.updateAppSettings({
        expectedRevision: settings2.revision,
        permissionMode: "allow-all" as never,
      }),
      (error: unknown) =>
        error instanceof TypeError ||
        (error instanceof PersistenceError && error.code === "domain_operation_rejected"),
    );
    const withAvatar = store.updateAppSettings({
      expectedRevision: settings2.revision,
      avatarFilename: "a1b2c3d4-e5f6-4890-abcd-ef1234567890.png",
    });
    assert.equal(withAvatar.avatarFilename, "a1b2c3d4-e5f6-4890-abcd-ef1234567890.png");
    const clearedAvatar = store.updateAppSettings({
      expectedRevision: withAvatar.revision,
      avatarFilename: null,
    });
    assert.equal(clearedAvatar.avatarFilename, undefined);
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadConversationEntry(taskId, terminal.entryId).text, "Hello");
    assert.equal(reopened.loadDraft(taskId)?.text, "draft two");
    assert.deepEqual(
      {
        locale: reopened.loadAppSettings().locale,
        grokModel: reopened.loadAppSettings().grokModel,
        reasoningEffort: reopened.loadAppSettings().reasoningEffort,
        permissionMode: reopened.loadAppSettings().permissionMode,
        startup: reopened.loadAppSettings().startup,
      },
      {
        locale: "en-US",
        grokModel: "grok-4.5",
        reasoningEffort: "high",
        permissionMode: "bypassPermissions",
        startup: {
          webSearchEnabled: false,
          planEnabled: true,
          subagentsEnabled: false,
          maxTurns: 256,
        },
      },
    );
    reopened.clearDraft({ taskId, expectedRevision: draft2.revision });
    assert.equal(reopened.loadDraft(taskId), undefined);
    reopened.close();
  });

  it("returns the newest bounded conversation page in chronological order", (t) => {
    const store = conversationStore(temporaryDatabase(t));
    for (let index = 1; index <= 505; index += 1) {
      store.createConversationEntry({
        taskId,
        entryId: `entry-recent-${String(index).padStart(3, "0")}`,
        kind: "assistant",
        text: `message-${index}`,
        status: "complete",
      });
    }

    const recent = store.listRecentConversationEntries({ taskId, limit: 500 });
    assert.equal(store.countConversationEntries(taskId), 505);
    assert.equal(recent.length, 500);
    assert.equal(recent[0]?.text, "message-6");
    assert.equal(recent.at(-1)?.text, "message-505");
    assert.deepEqual(
      store.listConversationEntries({ taskId, limit: 2 }).map((entry) => entry.text),
      ["message-1", "message-2"],
    );
    assert.deepEqual(
      store.listConversationEntriesBefore({
        taskId,
        beforeSequence: recent[0]!.sequence,
        limit: 500,
      }).map((entry) => entry.text),
      ["message-1", "message-2", "message-3", "message-4", "message-5"],
    );
    assert.throws(() => store.listConversationEntriesBefore({
      taskId,
      beforeSequence: 0,
    }));
    store.close();
  });

  it("commits prompt acceptance, replay proof, and recovery handoff in one transaction", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path, [
      {
        entryId: "prompt-proof-run-1",
        text: "Guild outbound prompt replay proof.",
        metadata: {
          hidden: true,
          outboundPromptProof: true,
          outboundPromptProofVersion: 2,
          outboundPromptSha256: "a".repeat(64),
        },
      },
      {
        entryId: "recovery-handoff-run-1",
        text: "Guild replacement-session recovery context established.",
        metadata: {
          hidden: true,
          replacementHandoffEstablished: true,
          sourceNoticeEntryId: "replacement-notice-1",
        },
      },
    ]);

    assert.equal(store.loadPromptCorrelation(taskId, runId).status, "accepted");
    const notices = store.listConversationEntries({ taskId, limit: 10 });
    assert.deepEqual(notices.map((entry) => entry.entryId), [
      "prompt-proof-run-1",
      "recovery-handoff-run-1",
    ]);
    assert.deepEqual(notices.map((entry) => entry.runId), [runId, runId]);
    store.close();
  });

  it("atomically admits live events with prompt correlation and finalizes the timeline and Run", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    const received = {
      wallClockIso: "2026-08-27T12:00:00.000Z",
      monotonicMs: 100,
    } as const;
    const first = must(createRuntimeTurnEvent({
      taskId,
      runId,
      adapterEpoch: epoch,
      ingestMode: "live",
      receiveSequence: 1,
      idempotencyKey: key("live-entry-first"),
      payload: {
        type: "agent_text_chunk",
        sessionId,
        received,
        messageId: "message-1",
        text: "Hel",
      },
    }));
    const firstCommit = store.commitLiveRuntimeEvent({
      event: first,
      mutation: {
        type: "create",
        entryId: "live-assistant-1",
        kind: "assistant",
        text: "Hel",
        status: "streaming",
      },
    });
    assert.equal(firstCommit.ok, true);
    assert.equal(firstCommit.record?.revision, 1);

    const second = must(createRuntimeTurnEvent({
      taskId,
      runId,
      adapterEpoch: epoch,
      ingestMode: "live",
      receiveSequence: 2,
      idempotencyKey: key("live-entry-second"),
      payload: {
        type: "agent_text_chunk",
        sessionId,
        received: { ...received, monotonicMs: 101 },
        messageId: "message-1",
        text: "lo",
      },
    }));
    const secondCommit = store.commitLiveRuntimeEvent({
      event: second,
      mutation: {
        type: "append_text",
        entryId: "live-assistant-1",
        expectedRevision: 1,
        text: "lo",
      },
    });
    assert.equal(secondCommit.ok, true);
    assert.equal(secondCommit.record?.text, "Hello");
    const duplicate = store.commitLiveRuntimeEvent({
      event: second,
      mutation: {
        type: "append_text",
        entryId: "live-assistant-1",
        expectedRevision: 1,
        text: "lo",
      },
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record?.text, "Hello");

    const outOfOrder = must(createRuntimeTurnEvent({
      taskId,
      runId,
      adapterEpoch: epoch,
      ingestMode: "live",
      receiveSequence: 4,
      idempotencyKey: key("live-out-of-order"),
      payload: {
        type: "agent_text_chunk",
        sessionId,
        received: { ...received, monotonicMs: 102 },
        messageId: "message-1",
        text: "!",
      },
    }));
    const rejected = store.commitLiveRuntimeEvent({
      event: outOfOrder,
      mutation: {
        type: "append_text",
        entryId: "live-assistant-1",
        expectedRevision: 2,
        text: "!",
      },
    });
    assert.deepEqual(rejected, {
      ok: false,
      reason: "out_of_order_receive_sequence",
    });
    assert.equal(store.loadConversationEntry(taskId, "live-assistant-1").text, "Hello");

    const terminal = must(createRuntimeTurnEvent({
      taskId,
      runId,
      adapterEpoch: epoch,
      ingestMode: "live",
      receiveSequence: 3,
      idempotencyKey: key("live-terminal"),
      payload: {
        type: "prompt_terminal",
        sessionId,
        received: { ...received, monotonicMs: 103 },
        stopReason: "end_turn",
        classification: "completed",
      },
    }));
    const terminalFinalizationKey = key("live-terminal-finalized");
    assert.throws(
      () => store.commitLiveRuntimeEvent({
        event: terminal,
        mutation: {
          type: "finalize",
          entryId: "live-assistant-1",
          expectedRevision: 1,
          status: "complete",
        },
        terminalFinalizationIdempotencyKey: terminalFinalizationKey,
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    assert.equal(store.loadRun(taskId, runId).state, "running");
    assert.equal(store.loadPromptCorrelation(taskId, runId).status, "accepted");
    const terminalCommit = store.commitLiveRuntimeEvent({
      event: terminal,
      mutation: {
        type: "finalize",
        entryId: "live-assistant-1",
        expectedRevision: 2,
        status: "complete",
      },
      terminalFinalizationIdempotencyKey: terminalFinalizationKey,
    });
    assert.equal(terminalCommit.ok, true);
    assert.equal(terminalCommit.run.state, "completed");
    assert.equal(terminalCommit.record?.status, "complete");
    assert.equal(store.loadPromptCorrelation(taskId, runId).status, "terminal");
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadRun(taskId, runId).state, "completed");
    assert.equal(reopened.loadConversationEntry(taskId, "live-assistant-1").text, "Hello");
    assert.equal(reopened.verifyIntegrity().schemaVersion, 14);
    reopened.close();
  });

  it("retains old-event deduplication, collision and sequence checks after a long stream [D-049]", (t) => {
    const path = temporaryDatabase(t);
    let store = liveReadyStore(path);
    const eventAt = (index: number, text = "x", idempotencyKey = key("long-stream")) =>
      must(createRuntimeTurnEvent({
        taskId, runId, adapterEpoch: epoch, ingestMode: "live",
        receiveSequence: index, idempotencyKey,
        payload: {
          type: "agent_text_chunk", sessionId, text,
          received: { wallClockIso: "2026-09-13T00:00:00.000Z", monotonicMs: index },
        },
      }));
    const first = eventAt(1);
    for (let index = 1; index <= 256; index += 1) {
      const result = store.commitLiveRuntimeEvent({
        event: index === 1 ? first : eventAt(index),
        mutation: index === 1
          ? { type: "create", entryId: "long-stream", kind: "assistant", text: "x", status: "streaming" }
          : { type: "append_text", entryId: "long-stream", expectedRevision: index - 1, text: "x" },
      });
      assert.equal(result.ok, true);
    }
    store.close();
    store = openGuildPersistence({ path });
    const mutation = {
      type: "append_text", entryId: "long-stream", expectedRevision: 256, text: "x",
    } as const;
    const duplicate = store.commitLiveRuntimeEvent({ event: first, mutation });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record?.text, "x".repeat(256));
    assert.deepEqual(store.commitLiveRuntimeEvent({
      event: eventAt(257, "different", first.envelope.idempotencyKey), mutation,
    }), { ok: false, reason: "idempotency_collision" });
    assert.deepEqual(store.commitLiveRuntimeEvent({
      event: eventAt(256), mutation,
    }), { ok: false, reason: "stale_receive_sequence" });
    assert.deepEqual(store.commitLiveRuntimeEvent({
      event: eventAt(258), mutation,
    }), { ok: false, reason: "out_of_order_receive_sequence" });
    const next = store.commitLiveRuntimeEvent({ event: eventAt(257), mutation });
    assert.equal(next.ok, true);
    assert.equal(next.record?.text, "x".repeat(257));
    assert.equal(store.verifyIntegrity().schemaVersion, 14);
    store.close();
  });

  it("forward-migrates an intact schema-v1 database without rebinding legacy tasks", (t) => {
    const path = temporaryDatabase(t);
    const legacy = baseStore(path);
    legacy.close();

    const raw = new DatabaseSync(path);
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE continuous_tasks;
      DROP TABLE queued_turns;
      DROP TABLE session_context_windows;
      DROP TABLE drafts;
      DROP TABLE conversation_entries;
      DROP TABLE prompt_correlations;
      DROP TABLE adapter_epochs;
      DROP TABLE task_metadata;
      DROP TABLE workspaces;
      DROP TABLE app_settings;
      DROP TABLE committed_envelopes;
      CREATE TABLE committed_envelopes (
        task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) > 0),
        fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
        adapter_epoch INTEGER NOT NULL CHECK(adapter_epoch >= 1),
        ingest_mode TEXT NOT NULL CHECK(ingest_mode IN ('live', 'replay')),
        receive_sequence INTEGER NOT NULL CHECK(receive_sequence >= 1),
        event_json TEXT NOT NULL CHECK(length(event_json) > 0),
        event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64),
        committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms >= 0),
        PRIMARY KEY(task_id, idempotency_key),
        UNIQUE(task_id, adapter_epoch, receive_sequence)
      ) STRICT;
      DELETE FROM schema_migrations WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14);
      CREATE TABLE guild_meta_v1 (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
        last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
      ) STRICT;
      INSERT INTO guild_meta_v1(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
      SELECT singleton, 1, clean_shutdown, last_integrity_at_ms FROM guild_meta;
      DROP TABLE guild_meta;
      ALTER TABLE guild_meta_v1 RENAME TO guild_meta;
      PRAGMA user_version = 1;
    `);
    raw.close();

    const migrated = openGuildPersistence({ path });
    assert.equal(migrated.verifyIntegrity().schemaVersion, 14);
    assert.equal(migrated.loadRun(taskId, runId).state, "queued");
    assert.throws(
      () => migrated.loadTaskMetadata(taskId),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "aggregate_not_found",
    );
    migrated.createWorkspace({
      workspaceId,
      canonicalPath: "/tmp/guild-workspace-legacy",
      displayName: "Legacy Workspace",
    });
    assert.equal(
      migrated.bindTaskToWorkspace({
        taskId,
        workspaceId,
        title: "Legacy task",
      }).workspaceId,
      workspaceId,
    );
    migrated.close();
  });

  it("refuses to replace a nonterminal current Run and rotates only after terminal proof", (t) => {
    const path = temporaryDatabase(t);
    const store = baseStore(path);
    const secondRunId = must(parseRunId("run-2"));
    assert.throws(
      () => store.createRun({ taskId, runId: secondRunId }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_already_exists",
    );
    assert.equal(store.restoreTask(taskId).currentRun?.runId, runId);

    const terminal = store.applyRun({
      taskId,
      runId,
      event: {
        type: "user_cancel",
        idempotencyKey: key("terminal-before-rotation"),
      },
    });
    assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.reason);
    assert.equal(terminal.run.state, "cancelled");
    const second = store.createRun({ taskId, runId: secondRunId });
    assert.equal(second.state, "queued");
    assert.equal(store.restoreTask(taskId).currentRun?.runId, secondRunId);
    assert.equal(store.loadRun(taskId, runId).state, "cancelled");
    assert.throws(
      () => store.createRun({ taskId, runId }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_already_exists",
    );
    assert.equal(store.restoreTask(taskId).currentRun?.runId, secondRunId);
    store.close();
  });

  it("durably queues follow-ups and atomically dispatches them in FIFO order", (t) => {
    const path = temporaryDatabase(t);
    const firstQueuedRunId = must(parseRunId("run-queued-1"));
    const secondQueuedRunId = must(parseRunId("run-queued-2"));
    let store = liveReadyStore(path);
    const first = store.enqueueQueuedTurn({
      taskId,
      queueId: "queue-1",
      intendedSessionId: sessionId,
      reservedRunId: firstQueuedRunId,
      entryId: "user-queued-1",
      text: "first follow-up",
    });
    const second = store.enqueueQueuedTurn({
      taskId,
      queueId: "queue-2",
      intendedSessionId: sessionId,
      reservedRunId: secondQueuedRunId,
      entryId: "user-queued-2",
      text: "second follow-up",
    });
    assert.equal(first.text, "first follow-up");
    assert.equal(second.text, "second follow-up");
    assert.equal(second.createdAtMs > first.createdAtMs, true);
    assert.deepEqual(
      store.listQueuedTurns(taskId).map((queued) => queued.queueId),
      ["queue-1", "queue-2"],
    );
    store.close();

    store = openGuildPersistence({ path });
    assert.deepEqual(
      store.listQueuedTurns(taskId).map((queued) => queued.text),
      ["first follow-up", "second follow-up"],
    );
    const interrupted = store.applyRun({
      taskId,
      runId,
      event: { type: "application_quit", idempotencyKey: key("queue-active-terminal") },
    });
    assert.equal(interrupted.ok, true, interrupted.ok ? "" : interrupted.reason);
    assert.equal(interrupted.run.state, "interrupted");

    const dispatched = store.dispatchQueuedTurn({
      taskId,
      queueId: "queue-1",
      sessionId,
      adapterEpoch: epoch,
      idempotencyKey: key("queue-first-dispatch"),
    });
    assert.equal(dispatched.run.state, "starting");
    assert.equal(dispatched.entry.runId, firstQueuedRunId);
    assert.equal(dispatched.entry.text, "first follow-up");
    assert.deepEqual(
      store.listQueuedTurns(taskId).map((queued) => queued.queueId),
      ["queue-2"],
    );
    assert.throws(
      () => store.dispatchQueuedTurn({
        taskId,
        queueId: "queue-2",
        sessionId,
        adapterEpoch: epoch,
        idempotencyKey: key("queue-second-too-early"),
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "domain_operation_rejected",
    );

    const failed = store.applyRun({
      taskId,
      runId: firstQueuedRunId,
      event: { type: "launch_failure", idempotencyKey: key("queue-first-terminal") },
    });
    assert.equal(failed.ok, true, failed.ok ? "" : failed.reason);
    assert.equal(failed.run.state, "failed");
    const secondDispatch = store.dispatchQueuedTurn({
      taskId,
      queueId: "queue-2",
      sessionId,
      adapterEpoch: epoch,
      idempotencyKey: key("queue-second-dispatch"),
    });
    assert.equal(secondDispatch.run.runId, secondQueuedRunId);
    assert.equal(store.listQueuedTurns(taskId).length, 0);
    assert.equal(store.verifyIntegrity().schemaVersion, 14);
    store.close();
  });

  it("persists explicit queued-turn priority without interrupting the active Run", (t) => {
    const path = temporaryDatabase(t);
    let store = liveReadyStore(path);
    for (const index of [1, 2, 3]) {
      store.enqueueQueuedTurn({
        taskId,
        queueId: `priority-queue-${index}`,
        intendedSessionId: sessionId,
        reservedRunId: must(parseRunId(`priority-run-${index}`)),
        entryId: `priority-entry-${index}`,
        text: `follow-up ${index}`,
      });
    }
    store.prioritizeQueuedTurn({ taskId, queueId: "priority-queue-3" });
    assert.deepEqual(
      store.listQueuedTurns(taskId).map((queued) => queued.queueId),
      ["priority-queue-3", "priority-queue-1", "priority-queue-2"],
    );
    assert.equal(store.loadRun(taskId, runId).state, "running");
    store.prioritizeQueuedTurn({ taskId, queueId: "priority-queue-2" });
    assert.deepEqual(
      store.listQueuedTurns(taskId).map((queued) => queued.queueId),
      ["priority-queue-2", "priority-queue-3", "priority-queue-1"],
    );
    store.close();

    store = openGuildPersistence({ path });
    assert.deepEqual(
      store.listQueuedTurns(taskId).map((queued) => queued.queueId),
      ["priority-queue-2", "priority-queue-3", "priority-queue-1"],
    );
    assert.equal(store.loadRun(taskId, runId).state, "running");
    store.close();
  });

  it("persists continuous-task objective and compare-and-swap phase transitions", (t) => {
    const path = temporaryDatabase(t);
    let store = conversationStore(path);
    const started = store.startContinuousTask({
      taskId,
      objective: "Build and verify the complete release",
    });
    assert.equal(started.status, "active");
    assert.equal(started.phase, "work");
    assert.equal(started.cycle, 1);
    store.createRun({ taskId, runId });
    const audited = store.updateContinuousTask({
      taskId,
      expectedRevision: started.revision,
      phase: "audit",
      lastRunId: runId,
      summary: "Implemented the first slice",
      remaining: "Release verification",
    });
    assert.equal(audited.phase, "audit");
    assert.equal(audited.lastRunId, runId);
    assert.throws(() => store.updateContinuousTask({
      taskId,
      expectedRevision: started.revision,
      status: "paused",
    }), (error: unknown) => error instanceof PersistenceError && error.code === "persistence_cas_conflict");
    store.close();

    store = openGuildPersistence({ path });
    assert.deepEqual(store.loadContinuousTask(taskId), audited);
    const paused = store.updateContinuousTask({
      taskId,
      expectedRevision: audited.revision,
      status: "paused",
      stopReason: "desktop_restarted",
    });
    assert.equal(paused.status, "paused");
    assert.equal(paused.stopReason, "desktop_restarted");
    store.close();
  });

  it("cancels a queued follow-up without creating its reserved Run", (t) => {
    const path = temporaryDatabase(t);
    const reservedRunId = must(parseRunId("run-cancelled-queue"));
    const store = liveReadyStore(path);
    store.enqueueQueuedTurn({
      taskId,
      queueId: "queue-cancel",
      intendedSessionId: sessionId,
      reservedRunId,
      entryId: "user-cancelled-queue",
      text: "do not send",
    });
    store.cancelQueuedTurn({ taskId, queueId: "queue-cancel" });
    assert.equal(store.listQueuedTurns(taskId).length, 0);
    assert.throws(
      () => store.loadRun(taskId, reservedRunId),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "aggregate_not_found",
    );
    store.close();
  });

  it("canonically restores Run and SessionBinding after a clean reopen", (t) => {
    const path = temporaryDatabase(t);
    let store = baseStore(path);
    const runResult = store.applyRun({
      taskId,
      runId,
      event: {
        type: "scheduler_dispatch",
        sessionId,
        adapterEpoch: epoch,
        idempotencyKey: key("dispatch"),
      },
    });
    assert.equal(runResult.ok, true);
    assert.equal(runResult.run.state, "starting");

    store.createSessionBinding(taskId);
    const attemptId = must(parseSessionAttemptId("create-1"));
    const began = store.applySessionBinding({
      taskId,
      event: {
        type: "start_session",
        attemptId,
        idempotencyKey: key("start-session"),
      },
    });
    assert.equal(began.ok, true);
    const healthy = store.applySessionBinding({
      taskId,
      event: {
        type: "session_new_succeeded",
        sessionId,
        adapterEpoch: epoch,
        attemptId,
        idempotencyKey: key("session-new"),
      },
    });
    assert.equal(healthy.ok, true);
    assert.equal(healthy.binding.state, "healthy");
    store.close();

    store = openGuildPersistence({ path });
    assert.equal(store.recoveredAfterUncleanShutdown, false);
    const restored = store.restoreTask(taskId);
    assert.equal(restored.task.owningWindowId, windowId);
    assert.equal(restored.currentRun?.state, "starting");
    assert.equal(restored.sessionBinding?.state, "healthy");
    assert.equal(restored.permissions.length, 0);
    store.close();
  });

  it("durably restores rejected Run and SessionBinding audit entries", (t) => {
    const path = temporaryDatabase(t);
    let store = baseStore(path);
    const rejectedRun = store.applyRun({
      taskId,
      runId,
      event: {
        type: "prompt_accepted",
        sessionId,
        adapterEpoch: epoch,
        idempotencyKey: key("illegal-prompt-accept"),
      },
    });
    assert.equal(rejectedRun.ok, false);
    assert.equal(rejectedRun.run.applied.length, 1);

    store.createSessionBinding(taskId);
    const rejectedBinding = store.applySessionBinding({
      taskId,
      event: {
        type: "creation_failed",
        attemptId: must(parseSessionAttemptId("never-started")),
        idempotencyKey: key("illegal-creation-failure"),
      },
    });
    assert.equal(rejectedBinding.ok, false);
    assert.equal(rejectedBinding.binding.applied.length, 1);
    store.close();

    store = openGuildPersistence({ path });
    assert.equal(store.loadRun(taskId, runId).applied.length, 1);
    assert.equal(store.loadSessionBinding(taskId).applied.length, 1);
    store.close();
  });

  it("detects an unclean marker and runs the reopen integrity path", (t) => {
    const path = temporaryDatabase(t);
    const first = baseStore(path);
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE guild_meta SET clean_shutdown = 0 WHERE singleton = 1").run();
    raw.close();

    const recovered = openGuildPersistence({ path });
    assert.equal(recovered.recoveredAfterUncleanShutdown, true);
    const report = recovered.verifyIntegrity();
    assert.equal(report.recoveredAfterUncleanShutdown, true);
    recovered.close();
  });

  it("treats a reaped writer lease as unclean even when SQLite was already marked clean", (t) => {
    const path = temporaryDatabase(t);
    const first = baseStore(path);
    first.close();

    const raw = new DatabaseSync(path);
    const marker = raw
      .prepare("SELECT clean_shutdown FROM guild_meta WHERE singleton = 1")
      .get();
    assert.equal(marker?.["clean_shutdown"], 1);
    raw.close();

    leaveDeadWriterLease(path);

    const recovered = openGuildPersistence({ path });
    assert.equal(recovered.recoveredAfterUncleanShutdown, true);
    recovered.close();

    const cleanSuccessor = openGuildPersistence({ path });
    assert.equal(cleanSuccessor.recoveredAfterUncleanShutdown, false);
    cleanSuccessor.close();
  });

  it("preserves stale-owner recovery evidence when the first recovery open fails", (t) => {
    const path = temporaryDatabase(t);
    const first = baseStore(path);
    first.close();

    const raw = new DatabaseSync(path);
    const storedRun = raw
      .prepare("SELECT snapshot_sha256 FROM runs WHERE task_id = ? AND run_id = ?")
      .get(taskId, runId);
    const originalSha = storedRun?.["snapshot_sha256"];
    if (typeof originalSha !== "string") assert.fail("missing original SHA-256");
    raw
      .prepare("UPDATE runs SET snapshot_sha256 = ? WHERE task_id = ? AND run_id = ?")
      .run("0".repeat(64), taskId, runId);
    raw.close();
    leaveDeadWriterLease(path);

    assert.throws(
      () => openGuildPersistence({ path }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_integrity_failed",
    );

    const repair = new DatabaseSync(path);
    repair
      .prepare("UPDATE runs SET snapshot_sha256 = ? WHERE task_id = ? AND run_id = ?")
      .run(originalSha, taskId, runId);
    repair.close();

    const recovered = openGuildPersistence({ path });
    assert.equal(recovered.recoveredAfterUncleanShutdown, true);
    recovered.close();
  });

  it("admits exactly one authoritative store for a canonical database path", (t) => {
    const path = temporaryDatabase(t);
    const first = baseStore(path);
    assert.throws(
      () => openGuildPersistence({ path }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "database_lease_held",
    );
    assert.equal(first.restoreTask(taskId).currentRun?.runId, runId);
    first.close();

    const successor = openGuildPersistence({ path });
    assert.equal(successor.recoveredAfterUncleanShutdown, false);
    assert.equal(successor.restoreTask(taskId).currentRun?.runId, runId);
    successor.close();
  });

  it("closes its own SQLite connections when owner metadata no longer matches", (t) => {
    const path = temporaryDatabase(t);
    const store = baseStore(path);
    const canonicalPath = realpathSync.native(path);
    const ownerPath = `${canonicalPath}.guild-writer-lease/owner.json`;
    const changedOwner = JSON.parse(
      readFileSync(ownerPath, "utf8"),
    ) as Record<string, unknown>;
    changedOwner["ownerToken"] = "00000000-0000-4000-8000-000000000001";
    writeFileSync(ownerPath, `${JSON.stringify(changedOwner)}\n`, "utf8");

    assert.throws(
      () => store.close(),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "storage_configuration_failed",
    );
    // The failed close reports the metadata fault but does not strand either
    // SQLite connection until process exit. A successor can reap the evidence.
    const recovered = openGuildPersistence({ path });
    assert.equal(recovered.recoveredAfterUncleanShutdown, true);
    recovered.close();
  });

  it("releases the writer lease when SQLite open fails", (t) => {
    const path = temporaryDatabase(t);
    writeFileSync(path, "not a sqlite database", "utf8");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => openGuildPersistence({ path }),
        (error: unknown) =>
          error instanceof PersistenceError &&
          error.code !== "database_lease_held",
      );
    }
  });

  it("releases the writer lease and preserves recovery evidence when clean shutdown persistence fails", (t) => {
    const path = temporaryDatabase(t);
    const seeded = baseStore(path);
    seeded.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TRIGGER fail_clean_shutdown_marker
      BEFORE UPDATE OF clean_shutdown ON guild_meta
      WHEN NEW.clean_shutdown = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced_clean_shutdown_failure');
      END;
    `);
    raw.close();

    const store = openGuildPersistence({ path });

    assert.throws(
      () => store.close(),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "schema_integrity_failed",
    );

    const repair = new DatabaseSync(path);
    repair.exec("DROP TRIGGER fail_clean_shutdown_marker");
    repair.close();

    const recovered = openGuildPersistence({ path });
    assert.equal(recovered.recoveredAfterUncleanShutdown, true);
    recovered.close();
  });

  it("rejects a stored aggregate whose SHA-256 was tampered", (t) => {
    const path = temporaryDatabase(t);
    const store = baseStore(path);
    store.close();
    const raw = new DatabaseSync(path);
    raw
      .prepare("UPDATE runs SET snapshot_sha256 = ? WHERE task_id = ? AND run_id = ?")
      .run("0".repeat(64), taskId, runId);
    raw.close();

    assert.throws(
      () => openGuildPersistence({ path }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_integrity_failed",
    );
  });

  it("atomically admits an ordinary pending permission into its Run and deduplicates both ledgers", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("atomic-register");
    const registrationKey = key("atomic-register");
    const runRegistrationKey = key("atomic-run-register");
    const input = {
      identity: exactIdentity,
      request: request(exactIdentity, "callback-atomic-register"),
      idempotencyKey: registrationKey,
      runIdempotencyKey: runRegistrationKey,
    };
    const before = store.loadRun(taskId, runId).applied.length;
    const first = store.registerPermission(input);
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    assert.equal(first.duplicate, false);
    assert.equal(first.record.registrationMode, "pending");
    assert.equal(first.record.state, "pending");
    assert.equal(first.record.outbox, undefined);
    const admitted = store.loadRun(taskId, runId);
    assert.equal(admitted.state, "awaiting_permission");
    assert.deepEqual(admitted.unresolvedPermissionIdentities, [exactIdentity]);
    assert.equal(admitted.applied.length, before + 1);

    const duplicate = store.registerPermission(input);
    assert.equal(duplicate.ok, true, duplicate.ok ? "" : duplicate.reason);
    assert.equal(duplicate.duplicate, true);
    assert.equal(store.loadRun(taskId, runId).applied.length, before + 1);
    assert.equal(store.restoreTask(taskId).permissions.length, 1);
    store.close();
  });

  it("rolls back an ordinary Run admission when the permission insert aborts", (t) => {
    const path = temporaryDatabase(t);
    let store = permissionReadyStore(path);
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TRIGGER test_abort_pending_permission_insert
      BEFORE INSERT ON permission_requests
      WHEN NEW.decision_commit_json IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'test_abort_pending_permission_insert');
      END;
    `);
    raw.close();

    store = openGuildPersistence({ path });
    const exactIdentity = identity("ordinary-rollback");
    const runLedgerBeforeFailure = store.loadRun(taskId, runId).applied.length;
    assert.throws(
      () =>
        store.registerPermission({
          identity: exactIdentity,
          request: request(exactIdentity, "callback-ordinary-rollback"),
          idempotencyKey: key("ordinary-rollback-register"),
          runIdempotencyKey: key("ordinary-rollback-run"),
        }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    assert.equal(
      store.loadRun(taskId, runId).applied.length,
      runLedgerBeforeFailure,
    );
    assert.throws(
      () => store.loadPermission(exactIdentity),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_not_found",
    );
    store.close();
  });

  it("keeps ordinary registration pending and rejects safe-cancel knobs on that API", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("ordinary-only");
    const before = store.loadRun(taskId, runId).applied.length;
    const result = store.registerPermission({
      identity: exactIdentity,
      request: request(exactIdentity, "callback-ordinary-only"),
      idempotencyKey: key("ordinary-only-register"),
      runIdempotencyKey: key("ordinary-only-run"),
      mode: "run_cancel_requested",
      transportCanReceive: true,
      commandId: must(parsePermissionOutboxCommandId("forbidden-command")),
    } as never);
    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? undefined : result.reason,
      "invalid_pending_permission_registration",
    );
    assert.equal(store.loadRun(taskId, runId).applied.length, before);
    assert.throws(
      () => store.loadPermission(exactIdentity),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_not_found",
    );
    store.close();
  });

  it("routes running permissions only to pending registration and cancel-time permissions only to safe claim", (t) => {
    const runningPath = temporaryDatabase(t);
    const runningStore = permissionReadyStore(runningPath);
    const runningIdentity = identity("safe-on-running");
    const runningLedger = runningStore.loadRun(taskId, runId).applied.length;
    const wrongSafePath = runningStore.registerSafeCancelPermissionAndClaim({
      identity: runningIdentity,
      request: request(runningIdentity, "callback-safe-on-running"),
      idempotencyKey: key("safe-on-running-register"),
      runIdempotencyKey: key("safe-on-running-run"),
      commandId: must(parsePermissionOutboxCommandId("safe-on-running-command")),
      deliveryAttemptId: must(
        parsePermissionDeliveryAttemptId("safe-on-running-attempt"),
      ),
    });
    assert.equal(wrongSafePath.ok, false);
    assert.equal(
      wrongSafePath.ok ? undefined : wrongSafePath.reason,
      "run_not_cancel_requested",
    );
    assert.equal(runningStore.loadRun(taskId, runId).applied.length, runningLedger);
    assert.throws(() => runningStore.loadPermission(runningIdentity));
    runningStore.close();

    const cancelPath = temporaryDatabase(t);
    const cancelStore = cancelRequestedStore(cancelPath);
    const cancelIdentity = identity("ordinary-on-cancel");
    const cancelLedger = cancelStore.loadRun(taskId, runId).applied.length;
    const wrongPendingPath = cancelStore.registerPermission({
      identity: cancelIdentity,
      request: request(cancelIdentity, "callback-ordinary-on-cancel"),
      idempotencyKey: key("ordinary-on-cancel-register"),
      runIdempotencyKey: key("ordinary-on-cancel-run"),
    });
    assert.equal(wrongPendingPath.ok, false);
    assert.equal(
      wrongPendingPath.ok ? undefined : wrongPendingPath.reason,
      "run_requires_safe_cancel_registration",
    );
    assert.equal(cancelStore.loadRun(taskId, runId).applied.length, cancelLedger);
    assert.throws(() => cancelStore.loadPermission(cancelIdentity));
    cancelStore.close();
  });

  it("atomically terminalizes a Run and orphans every still-pending permission", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const firstIdentity = identity("terminal-pending-a");
    const secondIdentity = identity("terminal-pending-b");
    register(store, firstIdentity, "callback-terminal-pending-a");
    register(store, secondIdentity, "callback-terminal-pending-b");

    const terminal = store.applyRun({
      taskId,
      runId,
      event: {
        type: "protocol_terminal_error",
        idempotencyKey: key("terminalize-pending-run"),
      },
    });
    assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.reason);
    assert.equal(terminal.run.state, "failed");
    assert.deepEqual(terminal.run.unresolvedPermissionIdentities, []);
    for (const exactIdentity of [firstIdentity, secondIdentity]) {
      const permission = store.loadPermission(exactIdentity);
      assert.equal(permission.state, "orphaned");
      assert.equal(permission.orphanCause, "run_terminalized");
      assert.equal(permission.decisionCommit?.cause, "orphan");
      assert.equal(permission.outbox, undefined);
      const staleDecision = store.decidePermissionAndClaim({
        identity: exactIdentity,
        callbackRequestId: permission.request.callbackRequestId,
        outcome: { outcome: "selected", optionId: "allow-once" },
        commandId: must(
          parsePermissionOutboxCommandId(
            `stale-command-${exactIdentity.toolCallId}`,
          ),
        ),
        deliveryAttemptId: must(
          parsePermissionDeliveryAttemptId(
            `stale-attempt-${exactIdentity.toolCallId}`,
          ),
        ),
      });
      assert.equal(staleDecision.ok, false);
      assert.equal(staleDecision.ok ? undefined : staleDecision.reason, "not_pending");
    }
    store.close();
  });

  it("marks an in-flight Permission delivery uncertain in the same Run terminal transaction", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("terminal-in-flight");
    register(store, exactIdentity, "callback-terminal-in-flight");
    const commandId = must(
      parsePermissionOutboxCommandId("terminal-in-flight-command"),
    );
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("terminal-in-flight-attempt"),
    );
    const decision = store.decidePermissionAndClaim({
      identity: exactIdentity,
      callbackRequestId: "callback-terminal-in-flight",
      outcome: { outcome: "selected", optionId: "reject-once" },
      commandId,
      deliveryAttemptId,
    });
    assert.equal(decision.ok, true, decision.ok ? "" : decision.reason);
    const version = decision.writeClaim?.version;
    if (version === undefined) assert.fail("missing version");

    const terminal = store.applyRun({
      taskId,
      runId,
      event: {
        type: "ownership_lost_before_completion",
        idempotencyKey: key("terminalize-in-flight-run"),
      },
    });
    assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.reason);
    assert.equal(terminal.run.state, "interrupted");
    const uncertain = store.loadPermission(exactIdentity);
    assert.equal(uncertain.state, "delivery_uncertain");
    assert.equal(uncertain.outbox?.lifecycle, "delivery_uncertain");

    const lateAck = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "pending",
      runResolutionIdempotencyKey: key("terminal-in-flight-late-ack"),
    });
    assert.equal(lateAck.ok, true, lateAck.ok ? "" : lateAck.reason);
    assert.equal(lateAck.record.state, "selected_rejection");
    assert.equal(store.loadRun(taskId, runId).state, "interrupted");
    store.close();
  });

  it("rolls back Run terminalization when coupled Permission closure cannot persist", (t) => {
    const path = temporaryDatabase(t);
    let store = permissionReadyStore(path);
    const exactIdentity = identity("terminal-rollback");
    register(store, exactIdentity, "callback-terminal-rollback");
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TRIGGER fail_terminal_permission_persistence
      BEFORE UPDATE OF snapshot_json ON permission_requests
      BEGIN
        SELECT RAISE(ABORT, 'forced_terminal_permission_failure');
      END;
    `);
    raw.close();
    store = openGuildPersistence({ path });

    assert.throws(
      () =>
        store.applyRun({
          taskId,
          runId,
          event: {
            type: "protocol_terminal_error",
            idempotencyKey: key("terminal-rollback-run"),
          },
        }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    assert.equal(store.loadRun(taskId, runId).state, "awaiting_permission");
    assert.equal(store.loadPermission(exactIdentity).state, "pending");
    store.close();
  });

  it("rejects direct public Run permission events that would bypass coupled persistence", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("direct-run-permission");
    assert.throws(
      () =>
        store.applyRun({
          taskId,
          runId,
          event: {
            type: "permission_admitted",
            identity: exactIdentity,
            idempotencyKey: key("direct-run-permission"),
          },
        }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "domain_operation_rejected",
    );
    assert.equal(store.loadRun(taskId, runId).state, "running");
    store.close();
  });

  it("atomically expires a pending Permission without a transport write and releases its Run", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("deadline-no-transport");
    register(store, exactIdentity, "callback-deadline-no-transport");
    const input = {
      type: "deadline_passed" as const,
      identity: exactIdentity,
      runResolutionIdempotencyKey: key("deadline-no-transport-run"),
      transportCanReceive: false as const,
    };
    const settled = store.settlePermissionAutomaticallyAndMaybeClaim(input);
    assert.equal(settled.ok, true, settled.ok ? "" : settled.reason);
    assert.equal(settled.duplicate, false);
    assert.equal(settled.record.state, "expired");
    assert.equal(settled.record.decisionCommit?.cause, "deadline");
    assert.equal(settled.record.outbox, undefined);
    assert.equal(settled.writeClaim, undefined);
    assert.equal(store.loadRun(taskId, runId).state, "running");
    assert.deepEqual(
      store.loadRun(taskId, runId).unresolvedPermissionIdentities,
      [],
    );

    const duplicate = store.settlePermissionAutomaticallyAndMaybeClaim(input);
    assert.equal(duplicate.ok, true, duplicate.ok ? "" : duplicate.reason);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.writeClaim, undefined);
    store.close();
  });

  it("atomically orphans a window-bound Permission, claims one safe response, and ACKs without re-resolving its Run", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("window-close");
    register(store, exactIdentity, "callback-window-close");
    const commandId = must(
      parsePermissionOutboxCommandId("window-close-command"),
    );
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("window-close-attempt"),
    );
    const settled = store.settlePermissionAutomaticallyAndMaybeClaim({
      type: "orphan",
      cause: "window_closed",
      identity: exactIdentity,
      runResolutionIdempotencyKey: key("window-close-run"),
      transportCanReceive: true,
      commandId,
      deliveryAttemptId,
    });
    assert.equal(settled.ok, true, settled.ok ? "" : settled.reason);
    assert.equal(settled.record.state, "orphaned");
    assert.equal(settled.record.outbox?.lifecycle, "in_flight");
    assert.equal(settled.writeClaim?.commandId, commandId);
    assert.equal(store.loadRun(taskId, runId).state, "running");
    const version = settled.writeClaim?.version;
    if (version === undefined) assert.fail("missing version");

    const acknowledged = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "pending",
      runResolutionIdempotencyKey: key("window-close-ack-run-proof"),
    });
    assert.equal(
      acknowledged.ok,
      true,
      acknowledged.ok ? "" : acknowledged.reason,
    );
    assert.equal(acknowledged.record.state, "orphaned");
    assert.equal(acknowledged.record.outbox?.lifecycle, "completed");
    assert.equal(store.loadRun(taskId, runId).state, "running");
    store.close();
  });

  it("marks an already released automatic response uncertain when its Run later terminates", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("window-close-terminal");
    register(store, exactIdentity, "callback-window-close-terminal");
    const commandId = must(
      parsePermissionOutboxCommandId("window-close-terminal-command"),
    );
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("window-close-terminal-attempt"),
    );
    const settled = store.settlePermissionAutomaticallyAndMaybeClaim({
      type: "orphan",
      cause: "window_closed",
      identity: exactIdentity,
      runResolutionIdempotencyKey: key("window-close-terminal-run"),
      transportCanReceive: true,
      commandId,
      deliveryAttemptId,
    });
    assert.equal(settled.ok, true, settled.ok ? "" : settled.reason);
    assert.equal(settled.record.state, "orphaned");
    assert.equal(settled.record.outbox?.lifecycle, "in_flight");
    assert.deepEqual(
      store.loadRun(taskId, runId).unresolvedPermissionIdentities,
      [],
    );
    const version = settled.writeClaim?.version;
    if (version === undefined) assert.fail("missing version");

    const terminal = store.applyRun({
      taskId,
      runId,
      event: {
        type: "ownership_lost_before_completion",
        idempotencyKey: key("window-close-terminal-ownership-loss"),
      },
    });
    assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.reason);
    assert.equal(terminal.run.state, "interrupted");
    const uncertain = store.loadPermission(exactIdentity);
    assert.equal(uncertain.state, "delivery_uncertain");
    assert.equal(uncertain.outbox?.lifecycle, "delivery_uncertain");

    const lateAck = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "pending",
      runResolutionIdempotencyKey: key("window-close-terminal-late-ack"),
    });
    assert.equal(lateAck.ok, true, lateAck.ok ? "" : lateAck.reason);
    assert.equal(lateAck.record.state, "orphaned");
    assert.equal(lateAck.record.outbox?.lifecycle, "completed");
    assert.equal(store.loadRun(taskId, runId).state, "interrupted");
    store.close();
  });

  it("rolls back Run terminalization when an already released in-flight response cannot be persisted", (t) => {
    const path = temporaryDatabase(t);
    let store = permissionReadyStore(path);
    const exactIdentity = identity("automatic-terminal-rollback");
    register(store, exactIdentity, "callback-automatic-terminal-rollback");
    const settled = store.settlePermissionAutomaticallyAndMaybeClaim({
      type: "orphan",
      cause: "window_closed",
      identity: exactIdentity,
      runResolutionIdempotencyKey: key("automatic-terminal-rollback-run"),
      transportCanReceive: true,
      commandId: must(
        parsePermissionOutboxCommandId("automatic-terminal-rollback-command"),
      ),
      deliveryAttemptId: must(
        parsePermissionDeliveryAttemptId("automatic-terminal-rollback-attempt"),
      ),
    });
    assert.equal(settled.ok, true, settled.ok ? "" : settled.reason);

    store.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TRIGGER fail_automatic_terminal_permission_persistence
      BEFORE UPDATE OF snapshot_json ON permission_requests
      BEGIN
        SELECT RAISE(ABORT, 'forced_automatic_terminal_permission_failure');
      END;
    `);
    raw.close();
    store = openGuildPersistence({ path });

    assert.throws(
      () =>
        store.applyRun({
          taskId,
          runId,
          event: {
            type: "ownership_lost_before_completion",
            idempotencyKey: key("automatic-terminal-rollback-ownership-loss"),
          },
        }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    assert.equal(store.loadRun(taskId, runId).state, "running");
    const unchanged = store.loadPermission(exactIdentity);
    assert.equal(unchanged.state, "orphaned");
    assert.equal(unchanged.outbox?.lifecycle, "in_flight");
    store.close();
  });

  it("settles a pre-existing Permission after cancel intent without undoing cancellation", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("cancel-existing-permission");
    register(store, exactIdentity, "callback-cancel-existing-permission");
    const cancel = store.applyRun({
      taskId,
      runId,
      event: {
        type: "user_cancel",
        idempotencyKey: key("cancel-existing-permission-run"),
      },
    });
    assert.equal(cancel.ok, true, cancel.ok ? "" : cancel.reason);
    assert.equal(cancel.run.state, "cancel_requested");
    const commandId = must(
      parsePermissionOutboxCommandId("cancel-existing-command"),
    );
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("cancel-existing-attempt"),
    );
    const settled = store.settlePermissionAutomaticallyAndMaybeClaim({
      type: "orphan",
      cause: "run_cancel_requested",
      identity: exactIdentity,
      runResolutionIdempotencyKey: key("cancel-existing-resolution"),
      transportCanReceive: true,
      commandId,
      deliveryAttemptId,
    });
    assert.equal(settled.ok, true, settled.ok ? "" : settled.reason);
    assert.equal(settled.record.state, "orphaned");
    assert.equal(settled.writeClaim?.commandId, commandId);
    assert.equal(store.loadRun(taskId, runId).state, "cancel_requested");
    assert.deepEqual(
      store.loadRun(taskId, runId).unresolvedPermissionIdentities,
      [exactIdentity],
    );

    const terminal = store.applyRun({
      taskId,
      runId,
      event: {
        type: "runtime_confirms_cancellation",
        idempotencyKey: key("cancel-existing-terminal"),
      },
    });
    assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.reason);
    assert.equal(terminal.run.state, "cancelled");
    assert.deepEqual(terminal.run.unresolvedPermissionIdentities, []);
    assert.equal(store.loadPermission(exactIdentity).state, "delivery_uncertain");
    assert.equal(
      store.loadPermission(exactIdentity).outbox?.lifecycle,
      "delivery_uncertain",
    );
    store.close();
  });

  it("atomically registers and claims one safe-cancel response, then deduplicates the exact retry", (t) => {
    const path = temporaryDatabase(t);
    const store = cancelRequestedStore(path);
    const exactIdentity = identity("safe-cancel");
    const commandId = must(parsePermissionOutboxCommandId("safe-command"));
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("safe-attempt"),
    );
    const input = {
      identity: exactIdentity,
      request: request(exactIdentity, "callback-safe-cancel"),
      idempotencyKey: key("safe-register"),
      runIdempotencyKey: key("safe-run-register"),
      commandId,
      deliveryAttemptId,
    };
    const first = store.registerSafeCancelPermissionAndClaim(input);
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    assert.equal(first.duplicate, false);
    assert.equal(first.record.registrationMode, "run_cancel_requested");
    assert.equal(first.record.state, "orphaned");
    assert.equal(first.record.outbox?.lifecycle, "in_flight");
    assert.equal(first.writeClaim?.commandId, commandId);
    assert.deepEqual(
      store.loadRun(taskId, runId).unresolvedPermissionIdentities,
      [],
    );

    const duplicate = store.registerSafeCancelPermissionAndClaim(input);
    assert.equal(duplicate.ok, true, duplicate.ok ? "" : duplicate.reason);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.writeClaim, undefined);
    assert.equal(duplicate.record.outbox?.deliveryAttemptId, deliveryAttemptId);

    const terminal = store.applyRun({
      taskId,
      runId,
      event: {
        type: "runtime_confirms_cancellation",
        idempotencyKey: key("safe-cancel-terminal"),
      },
    });
    assert.equal(terminal.ok, true, terminal.ok ? "" : terminal.reason);
    assert.equal(terminal.run.state, "cancelled");
    const uncertain = store.loadPermission(exactIdentity);
    assert.equal(uncertain.state, "delivery_uncertain");
    assert.equal(uncertain.outbox?.lifecycle, "delivery_uncertain");

    const version = first.writeClaim?.version;
    if (version === undefined) assert.fail("missing version");
    const lateAck = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "run_cancel_requested",
    });
    assert.equal(lateAck.ok, true, lateAck.ok ? "" : lateAck.reason);
    assert.equal(lateAck.record.state, "orphaned");
    assert.equal(lateAck.record.outbox?.lifecycle, "completed");
    assert.equal(store.loadRun(taskId, runId).state, "cancelled");
    store.close();
  });

  it("rolls back both the Run ledger and safe-cancel registration when outbox insertion fails", (t) => {
    const path = temporaryDatabase(t);
    const store = cancelRequestedStore(path);
    const firstIdentity = identity("safe-rollback-a");
    const secondIdentity = identity("safe-rollback-b");
    const sharedCommand = must(
      parsePermissionOutboxCommandId("safe-shared-command"),
    );
    const first = store.registerSafeCancelPermissionAndClaim({
      identity: firstIdentity,
      request: request(firstIdentity, "callback-safe-rollback-a"),
      idempotencyKey: key("safe-rollback-a-register"),
      runIdempotencyKey: key("safe-rollback-a-run"),
      commandId: sharedCommand,
      deliveryAttemptId: must(
        parsePermissionDeliveryAttemptId("safe-rollback-a-attempt"),
      ),
    });
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    const runLedgerBeforeFailure = store.loadRun(taskId, runId).applied.length;

    assert.throws(
      () =>
        store.registerSafeCancelPermissionAndClaim({
          identity: secondIdentity,
          request: request(secondIdentity, "callback-safe-rollback-b"),
          idempotencyKey: key("safe-rollback-b-register"),
          runIdempotencyKey: key("safe-rollback-b-run"),
          commandId: sharedCommand,
          deliveryAttemptId: must(
            parsePermissionDeliveryAttemptId("safe-rollback-b-attempt"),
          ),
        }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    assert.equal(
      store.loadRun(taskId, runId).applied.length,
      runLedgerBeforeFailure,
    );
    assert.throws(
      () => store.loadPermission(secondIdentity),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_not_found",
    );
    store.close();
  });

  it("uses exact ACK CAS and leaves an in-flight response unchanged on a wrong ACK", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("ack");
    register(store, exactIdentity, "callback-ack");
    const commandId = must(parsePermissionOutboxCommandId("command-ack"));
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("delivery-ack"),
    );
    const decision = store.decidePermissionAndClaim({
      identity: exactIdentity,
      callbackRequestId: "callback-ack",
      outcome: { outcome: "selected", optionId: "allow-once" },
      commandId,
      deliveryAttemptId,
    });
    assert.equal(decision.ok, true, decision.ok ? "" : decision.reason);
    assert.equal(decision.record.outbox?.lifecycle, "in_flight");
    const version = decision.writeClaim?.version;
    assert.notEqual(version, undefined);
    if (version === undefined) assert.fail("missing version");
    const runResolutionIdempotencyKey = key("ack-run-resolution");

    const wrong = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId: must(
        parsePermissionDeliveryAttemptId("delivery-wrong"),
      ),
      registrationMode: "pending",
      runResolutionIdempotencyKey,
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.ok ? undefined : wrong.reason, "outbox_cas_mismatch");
    assert.equal(store.loadPermission(exactIdentity).outbox?.lifecycle, "in_flight");
    assert.equal(store.loadRun(taskId, runId).state, "awaiting_permission");

    const exact = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "pending",
      runResolutionIdempotencyKey,
    });
    assert.equal(exact.ok, true, exact.ok ? "" : exact.reason);
    assert.equal(exact.record.outbox?.lifecycle, "completed");
    assert.equal(store.loadRun(taskId, runId).state, "running");
    assert.deepEqual(
      store.loadRun(taskId, runId).unresolvedPermissionIdentities,
      [],
    );
    const duplicateAck = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "pending",
      runResolutionIdempotencyKey,
    });
    assert.equal(duplicateAck.ok, true);
    assert.equal(duplicateAck.ok && duplicateAck.duplicate, true);
    store.close();
  });

  it("accepts an exact late ACK after durable delivery uncertainty", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("late-ack");
    register(store, exactIdentity, "callback-late-ack");
    const commandId = must(parsePermissionOutboxCommandId("command-late-ack"));
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("delivery-late-ack"),
    );
    const decision = store.decidePermissionAndClaim({
      identity: exactIdentity,
      callbackRequestId: "callback-late-ack",
      outcome: { outcome: "cancelled" },
      commandId,
      deliveryAttemptId,
    });
    assert.equal(decision.ok, true, decision.ok ? "" : decision.reason);
    const version = decision.writeClaim?.version;
    if (version === undefined) assert.fail("missing version");

    const uncertain = store.markPermissionDeliveryUncertain({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      cause: "epoch_exited",
    });
    assert.equal(uncertain.ok, true, uncertain.ok ? "" : uncertain.reason);
    assert.equal(uncertain.record.state, "delivery_uncertain");
    assert.equal(uncertain.record.outbox?.lifecycle, "delivery_uncertain");

    const lateAck = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "pending",
      runResolutionIdempotencyKey: key("late-ack-run-resolution"),
    });
    assert.equal(lateAck.ok, true, lateAck.ok ? "" : lateAck.reason);
    assert.equal(lateAck.record.state, "cancelled");
    assert.equal(lateAck.record.outbox?.lifecycle, "completed");
    assert.equal(store.loadRun(taskId, runId).state, "running");
    assert.deepEqual(
      store.loadRun(taskId, runId).unresolvedPermissionIdentities,
      [],
    );
    store.close();
  });

  it("rolls back Permission, outbox, and Run together when ACK Run persistence fails", (t) => {
    const path = temporaryDatabase(t);
    let store = permissionReadyStore(path);
    const exactIdentity = identity("ack-rollback");
    register(store, exactIdentity, "callback-ack-rollback");
    const commandId = must(
      parsePermissionOutboxCommandId("command-ack-rollback"),
    );
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("delivery-ack-rollback"),
    );
    const decision = store.decidePermissionAndClaim({
      identity: exactIdentity,
      callbackRequestId: "callback-ack-rollback",
      outcome: { outcome: "selected", optionId: "allow-once" },
      commandId,
      deliveryAttemptId,
    });
    assert.equal(decision.ok, true, decision.ok ? "" : decision.reason);
    const version = decision.writeClaim?.version;
    if (version === undefined) assert.fail("missing version");

    store.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TRIGGER fail_ack_run_persistence
      BEFORE UPDATE OF snapshot_json ON runs
      BEGIN
        SELECT RAISE(ABORT, 'forced_ack_run_failure');
      END;
    `);
    raw.close();
    store = openGuildPersistence({ path });

    assert.throws(
      () =>
        store.acknowledgePermissionResponse({
          identity: exactIdentity,
          commandId,
          version,
          deliveryAttemptId,
          registrationMode: "pending",
          runResolutionIdempotencyKey: key("ack-rollback-run-resolution"),
        }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    assert.equal(store.loadPermission(exactIdentity).state, "resolving");
    assert.equal(
      store.loadPermission(exactIdentity).outbox?.lifecycle,
      "in_flight",
    );
    const run = store.loadRun(taskId, runId);
    assert.equal(run.state, "awaiting_permission");
    assert.deepEqual(run.unresolvedPermissionIdentities, [exactIdentity]);
    store.close();
  });

  it("ACKs a safe-cancel response without fabricating a Run permission resolution", (t) => {
    const path = temporaryDatabase(t);
    const store = cancelRequestedStore(path);
    const exactIdentity = identity("safe-ack");
    const commandId = must(parsePermissionOutboxCommandId("safe-ack-command"));
    const deliveryAttemptId = must(
      parsePermissionDeliveryAttemptId("safe-ack-attempt"),
    );
    const registered = store.registerSafeCancelPermissionAndClaim({
      identity: exactIdentity,
      request: request(exactIdentity, "callback-safe-ack"),
      idempotencyKey: key("safe-ack-register"),
      runIdempotencyKey: key("safe-ack-run-register"),
      commandId,
      deliveryAttemptId,
    });
    assert.equal(registered.ok, true, registered.ok ? "" : registered.reason);
    const version = registered.writeClaim?.version;
    if (version === undefined) assert.fail("missing version");

    const wrongMode = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "pending",
      runResolutionIdempotencyKey: key("safe-ack-wrong-mode"),
    });
    assert.equal(wrongMode.ok, false);
    assert.equal(
      wrongMode.ok ? undefined : wrongMode.reason,
      "registration_mode_mismatch",
    );

    const acknowledged = store.acknowledgePermissionResponse({
      identity: exactIdentity,
      commandId,
      version,
      deliveryAttemptId,
      registrationMode: "run_cancel_requested",
    });
    assert.equal(
      acknowledged.ok,
      true,
      acknowledged.ok ? "" : acknowledged.reason,
    );
    assert.equal(acknowledged.record.state, "orphaned");
    assert.equal(acknowledged.record.outbox?.lifecycle, "completed");
    const run = store.loadRun(taskId, runId);
    assert.equal(run.state, "cancel_requested");
    assert.deepEqual(run.unresolvedPermissionIdentities, []);
    store.close();
  });

  it("does not replace or claim a second command for a duplicate decision", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("duplicate");
    register(store, exactIdentity, "callback-duplicate");
    const firstCommand = must(parsePermissionOutboxCommandId("command-first"));
    const firstAttempt = must(parsePermissionDeliveryAttemptId("attempt-first"));
    const first = store.decidePermissionAndClaim({
      identity: exactIdentity,
      callbackRequestId: "callback-duplicate",
      outcome: { outcome: "selected", optionId: "reject-once" },
      commandId: firstCommand,
      deliveryAttemptId: firstAttempt,
    });
    assert.equal(first.ok, true, first.ok ? "" : first.reason);

    const duplicate = store.decidePermissionAndClaim({
      identity: exactIdentity,
      callbackRequestId: "callback-duplicate",
      outcome: { outcome: "selected", optionId: "reject-once" },
      commandId: must(parsePermissionOutboxCommandId("command-second")),
      deliveryAttemptId: must(parsePermissionDeliveryAttemptId("attempt-second")),
    });
    assert.equal(duplicate.ok, true, duplicate.ok ? "" : duplicate.reason);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.writeClaim, undefined);
    assert.equal(duplicate.record.decisionCommit?.commandId, firstCommand);
    assert.equal(duplicate.record.outbox?.deliveryAttemptId, firstAttempt);
    store.close();
  });

  it("rolls back decisionCommit when the same outbox command violates uniqueness", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const firstIdentity = identity("rollback-a");
    const secondIdentity = identity("rollback-b");
    register(store, firstIdentity, "callback-rollback-a");
    register(store, secondIdentity, "callback-rollback-b");
    const sharedCommand = must(parsePermissionOutboxCommandId("shared-command"));
    const first = store.decidePermissionAndClaim({
      identity: firstIdentity,
      callbackRequestId: "callback-rollback-a",
      outcome: { outcome: "cancelled" },
      commandId: sharedCommand,
      deliveryAttemptId: must(parsePermissionDeliveryAttemptId("attempt-a")),
    });
    assert.equal(first.ok, true, first.ok ? "" : first.reason);

    assert.throws(
      () =>
        store.decidePermissionAndClaim({
          identity: secondIdentity,
          callbackRequestId: "callback-rollback-b",
          outcome: { outcome: "cancelled" },
          commandId: sharedCommand,
          deliveryAttemptId: must(parsePermissionDeliveryAttemptId("attempt-b")),
        }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "persistence_cas_conflict",
    );
    const rolledBack = store.loadPermission(secondIdentity);
    assert.equal(rolledBack.state, "pending");
    assert.equal(rolledBack.decisionCommit, undefined);
    assert.equal(rolledBack.outbox, undefined);
    store.close();
  });

  it("enforces the database trigger that forbids decisionCommit rewrites", (t) => {
    const path = temporaryDatabase(t);
    const store = permissionReadyStore(path);
    const exactIdentity = identity("trigger");
    register(store, exactIdentity, "callback-trigger");
    const decision = store.decidePermissionAndClaim({
      identity: exactIdentity,
      callbackRequestId: "callback-trigger",
      outcome: { outcome: "cancelled" },
      commandId: must(parsePermissionOutboxCommandId("command-trigger")),
      deliveryAttemptId: must(
        parsePermissionDeliveryAttemptId("attempt-trigger"),
      ),
    });
    assert.equal(decision.ok, true, decision.ok ? "" : decision.reason);
    store.close();

    const raw = new DatabaseSync(path);
    assert.throws(
      () =>
        raw
          .prepare("UPDATE permission_requests SET decision_commit_json = '{}' WHERE task_id = ?")
          .run(taskId),
      /permission_decision_immutable/u,
    );
    raw.close();
  });
});
