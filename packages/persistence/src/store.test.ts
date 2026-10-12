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
  freezeGrokModelCatalog,
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
  type GrokModelCatalog,
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

/**
 * Takes a freshly created (schema v19) database back to what a v18 install looks like: none of the
 * Guild 3.0 tables, columns, triggers or migration row. The downgrade fixtures below run it first, so
 * their old-schema databases migrate forward through V19 again.
 */
const REMOVE_V19_SQL = `
  DROP TRIGGER IF EXISTS task_engine_is_fixed_after_first_run;
  DROP TRIGGER IF EXISTS task_routed_marker_is_sticky;
  DROP TRIGGER IF EXISTS task_runtime_model_follows_engine_on_insert;
  DROP TRIGGER IF EXISTS task_runtime_model_follows_engine_on_update;
  DROP TABLE IF EXISTS thinking_provenance;
  DROP TABLE IF EXISTS workspace_prefs;
  DROP TABLE IF EXISTS model_sources;
  ALTER TABLE task_metadata DROP COLUMN routed_at_ms;
  ALTER TABLE task_metadata DROP COLUMN engine;
  ALTER TABLE app_settings DROP COLUMN claude_model;
  ALTER TABLE app_settings DROP COLUMN claude_effort;
  ALTER TABLE app_settings DROP COLUMN claude_permission_mode;
  DELETE FROM schema_migrations WHERE version = 19;
`;

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

  it("creates a WAL database whose application tables are STRICT at the current schema", (t) => {
    const path = temporaryDatabase(t);
    const store = baseStore(path);
    store.close();
    const raw = new DatabaseSync(path);
    assert.equal(raw.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
    assert.equal(raw.prepare("PRAGMA user_version").get()?.["user_version"], 19);
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
      "task_context_usage",
      "task_runtime_settings",
      "runtime_model_catalog",
      "model_sources",
      "workspace_prefs",
      "thinking_provenance",
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
        grokModel: null,
        reasoningEffort: null,
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
        grokModel: "MiniMax-M3",
      }),
      (error: unknown) =>
        error instanceof TypeError ||
        (error instanceof PersistenceError && error.code === "domain_operation_rejected"),
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
    assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
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
    assert.equal(store.verifyIntegrity().schemaVersion, 19);
    store.close();
  });

  it("forward-migrates an intact schema-v1 database without rebinding legacy tasks", (t) => {
    const path = temporaryDatabase(t);
    const legacy = baseStore(path);
    legacy.close();

    const raw = new DatabaseSync(path);
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      ${REMOVE_V19_SQL}
      DROP TABLE task_worktrees;
      DROP TABLE run_checkpoints;
      DROP TABLE task_interjections;
      DROP TABLE runtime_model_catalog;
      DROP TABLE task_runtime_settings;
      DROP TABLE task_context_usage;
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
      DELETE FROM schema_migrations WHERE version IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18);
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
    assert.equal(migrated.verifyIntegrity().schemaVersion, 19);
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
    assert.equal(store.verifyIntegrity().schemaVersion, 19);
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

  it("rejects a stored aggregate whose SHA-256 was tampered when it is read or after an unclean shutdown", (t) => {
    const path = temporaryDatabase(t);
    const store = baseStore(path);
    store.close();
    const raw = new DatabaseSync(path);
    raw
      .prepare("UPDATE runs SET snapshot_sha256 = ? WHERE task_id = ? AND run_id = ?")
      .run("0".repeat(64), taskId, runId);
    raw.close();

    // WP3: a clean start validates lazily, so open succeeds and the first read of the aggregate
    // (or an explicit full verification) reports the tamper.
    const lazy = openGuildPersistence({ path });
    assert.equal(lazy.recoveredAfterUncleanShutdown, false);
    assert.throws(
      () => lazy.loadRun(taskId, runId),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_integrity_failed",
    );
    assert.throws(
      () => lazy.verifyIntegrity(),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "aggregate_integrity_failed",
    );
    lazy.close();

    // After an unclean shutdown the open itself verifies every aggregate.
    const marker = new DatabaseSync(path);
    marker.prepare("UPDATE guild_meta SET clean_shutdown = 0 WHERE singleton = 1").run();
    marker.close();
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
  describe("streaming write path (WP2) and startup/read path (WP3)", () => {
    const streamReceived = { wallClockIso: "2026-10-09T12:00:00.000Z", monotonicMs: 1 } as const;

    function textChunk(
      sequence: number,
      text: string,
      options: {
        readonly type?: "agent_text_chunk" | "agent_thought_chunk";
        readonly messageId?: string;
        readonly idempotencyKey?: ReturnType<typeof key>;
      } = {},
    ) {
      return must(createRuntimeTurnEvent({
        taskId,
        runId,
        adapterEpoch: epoch,
        ingestMode: "live",
        receiveSequence: sequence,
        idempotencyKey: options.idempotencyKey ?? key("stream-chunk"),
        payload: {
          type: options.type ?? "agent_text_chunk",
          sessionId,
          received: streamReceived,
          ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
          text,
        },
      }));
    }

    /** Creates an entry from its first chunk, then appends the rest the way the live service does. */
    function streamChunks(
      store: GuildPersistence,
      entryId: string,
      texts: readonly string[],
      firstSequence: number,
      options: { readonly type?: "agent_text_chunk" | "agent_thought_chunk"; readonly messageId?: string } = {},
    ) {
      const kind = options.type === "agent_thought_chunk" ? "thought" : "assistant";
      let sequence = firstSequence;
      const created = store.commitLiveRuntimeEvent({
        event: textChunk(sequence, texts[0]!, options),
        mutation: { type: "create", entryId, kind, text: texts[0]!, status: "streaming" },
      });
      assert.equal(created.ok, true, created.ok ? "" : created.reason);
      let record = created.record!;
      for (const text of texts.slice(1)) {
        sequence += 1;
        const appended = store.commitLiveRuntimeEvent({
          event: textChunk(sequence, text, options),
          mutation: { type: "append_text", entryId, expectedRevision: record.revision, text },
        });
        assert.equal(appended.ok, true, appended.ok ? "" : appended.reason);
        record = appended.record!;
      }
      return { record, lastSequence: sequence };
    }

    function terminalEvent(sequence: number, tokens?: number, forRun = runId) {
      return must(createRuntimeTurnEvent({
        taskId,
        runId: forRun,
        adapterEpoch: epoch,
        ingestMode: "live",
        receiveSequence: sequence,
        idempotencyKey: key("stream-terminal"),
        payload: {
          type: "prompt_terminal",
          sessionId,
          received: streamReceived,
          stopReason: "end_turn",
          classification: "completed",
          ...(tokens === undefined ? {} : { contextTokensUsed: tokens }),
        },
      }));
    }

    function rawRows<T extends Record<string, unknown>>(path: string, sql: string, ...parameters: string[]): T[] {
      const raw = new DatabaseSync(path);
      try {
        return raw.prepare(sql).all(...parameters) as T[];
      } finally {
        raw.close();
      }
    }

    it("coalesces a 2,000-chunk burst into one entry write and one envelope [WP2]", (t) => {
      const path = temporaryDatabase(t);
      const store = liveReadyStore(path);
      const texts = Array.from({ length: 2_000 }, (_, index) => ["a", "。", "ing", "x,"][index % 4]!);
      const { record, lastSequence } = streamChunks(store, "burst-entry", texts, 1);
      const expected = texts.join("");
      // Revision still counts chunks, so callers' compare-and-set tokens are unchanged.
      assert.equal(record.revision, 2_000);
      assert.equal(record.text, expected);
      // Every reader sees the pending tail before it is written.
      assert.equal(store.loadConversationEntry(taskId, "burst-entry").text, expected);
      assert.equal(store.loadConversationEntry(taskId, "burst-entry").revision, 2_000);
      assert.equal(store.listRecentConversationEntries({ taskId }).at(-1)?.text, expected);
      assert.equal(store.listConversationEntries({ taskId }).at(-1)?.text, expected);
      assert.equal(store.countConversationEntries(taskId), 1);
      store.close();

      const stored = rawRows<{ text_content: string; revision: number; status: string }>(
        path,
        "SELECT text_content, revision, status FROM conversation_entries WHERE entry_id = 'burst-entry'",
      );
      assert.equal(stored.length, 1);
      assert.equal(stored[0]!.text_content === expected, true);
      assert.equal(stored[0]!.revision, 2_000);
      assert.equal(stored[0]!.status, "streaming");
      const envelopes = rawRows<{ receive_sequence: number; event_json: string }>(
        path,
        "SELECT receive_sequence, event_json FROM committed_envelopes WHERE task_id = 'task-1' ORDER BY receive_sequence",
      );
      // One row for the create and ONE for the 1,999 appended chunks, ending at the last sequence.
      assert.deepEqual(envelopes.map((row) => row.receive_sequence), [1, lastSequence]);
      const merged = JSON.parse(envelopes[1]!.event_json) as { payload: { text: string } };
      assert.equal(merged.payload.text, texts.slice(1).join(""));

      const reopened = openGuildPersistence({ path });
      assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
      // Admission continues from the last covered sequence, so the stream resumes gaplessly.
      const next = reopened.commitLiveRuntimeEvent({
        event: textChunk(lastSequence + 1, "!"),
        mutation: { type: "append_text", entryId: "burst-entry", expectedRevision: 2_000, text: "!" },
      });
      assert.equal(next.ok, true, next.ok ? "" : next.reason);
      assert.equal(next.record?.text, `${expected}!`);
      reopened.close();
    });

    it("reports the pending revision in entry stamps while a stream window is open [WP4]", (t) => {
      const store = liveReadyStore(temporaryDatabase(t));
      const { record } = streamChunks(store, "stamp-entry", ["a", "b", "c", "d", "e"], 1);
      const stamp = store.listRecentConversationEntryStamps({ taskId }).at(-1);
      assert.equal(stamp?.entryId, "stamp-entry");
      // Projection caches key rows by these stamps; a stored revision behind the window would
      // keep serving text without the pending tail.
      assert.equal(stamp?.revision, record.revision);
      assert.equal(stamp?.revision, store.listRecentConversationEntries({ taskId }).at(-1)?.revision);
      store.close();
    });

    it("writes the open window before any other store call, in call order [WP2]", (t) => {
      const path = temporaryDatabase(t);
      const store = liveReadyStore(path);
      const { lastSequence } = streamChunks(store, "ordered-entry", ["a", "b", "c", "d"], 1);
      // A tool update is a boundary. Admission requires the last stored sequence to be 3, which
      // is only true if the pending window was written before this event was judged.
      const toolEvent = must(createRuntimeTurnEvent({
        taskId,
        runId,
        adapterEpoch: epoch,
        ingestMode: "live",
        receiveSequence: lastSequence + 1,
        idempotencyKey: key("tool-boundary"),
        payload: {
          type: "tool_call_create",
          sessionId,
          received: streamReceived,
          toolCallId: "tool-boundary",
          title: "Read",
        },
      }));
      const tool = store.commitLiveRuntimeEvent({
        event: toolEvent,
        mutation: {
          type: "create",
          entryId: "tool-entry",
          kind: "tool",
          text: "Read",
          status: "complete",
        },
      });
      assert.equal(tool.ok, true, tool.ok ? "" : tool.reason);
      store.close();

      const entries = rawRows<{ entry_id: string; sequence: number; text_content: string }>(
        path,
        "SELECT entry_id, sequence, text_content FROM conversation_entries ORDER BY sequence",
      );
      assert.deepEqual(entries.map((entry) => [entry.entry_id, entry.text_content]), [
        ["ordered-entry", "abcd"],
        ["tool-entry", "Read"],
      ]);
      const envelopes = rawRows<{ receive_sequence: number; committed_at_ms: number }>(
        path,
        "SELECT receive_sequence, committed_at_ms FROM committed_envelopes ORDER BY receive_sequence",
      );
      assert.deepEqual(envelopes.map((row) => row.receive_sequence), [1, 4, 5]);
      assert.equal(
        envelopes.every((row, index) => index === 0 || row.committed_at_ms >= envelopes[index - 1]!.committed_at_ms),
        true,
      );
    });

    it("judges unusual chunks against stored state without losing pending text [WP2]", (t) => {
      const path = temporaryDatabase(t);
      const store = liveReadyStore(path);
      const first = textChunk(1, "a", { messageId: "message-1" });
      assert.equal(store.commitLiveRuntimeEvent({
        event: first,
        mutation: { type: "create", entryId: "edge-entry", kind: "assistant", text: "a", status: "streaming" },
      }).ok, true);
      const second = textChunk(2, "b", { messageId: "message-1" });
      const append = (event: ReturnType<typeof textChunk>, expectedRevision: number, text: string) =>
        store.commitLiveRuntimeEvent({
          event,
          mutation: { type: "append_text", entryId: "edge-entry", expectedRevision, text },
        });
      const textAfter = (result: ReturnType<typeof append>) =>
        result.ok ? result.record?.text : result.reason;
      assert.equal(append(second, 1, "b").ok, true);
      const third = textChunk(3, "c", { messageId: "message-1" });
      assert.equal(textAfter(append(third, 2, "c")), "abc");

      // In-window duplicate and collision are answered from memory.
      const duplicate = append(third, 2, "c");
      assert.equal(duplicate.ok && duplicate.duplicate, true);
      assert.equal(duplicate.ok ? duplicate.record?.text : "", "abc");
      assert.deepEqual(
        append(textChunk(3, "different", { messageId: "message-1", idempotencyKey: third.envelope.idempotencyKey }), 3, "different"),
        { ok: false, reason: "idempotency_collision" },
      );

      // A gap and a stale revision are judged by the ordinary path, with the historical results.
      assert.deepEqual(append(textChunk(9, "z", { messageId: "message-1" }), 3, "z"), {
        ok: false,
        reason: "out_of_order_receive_sequence",
      });
      assert.throws(
        () => append(textChunk(4, "d", { messageId: "message-1" }), 1, "d"),
        (error: unknown) =>
          error instanceof PersistenceError && error.code === "persistence_cas_conflict",
      );
      // Nothing pending was lost by either rejection, and the stream continues.
      assert.equal(store.loadConversationEntry(taskId, "edge-entry").text, "abc");
      assert.equal(textAfter(append(textChunk(4, "d", { messageId: "message-1" }), 3, "d")), "abcd");

      // A different protocol message id ends the window; so does an entry of another kind.
      assert.equal(textAfter(append(textChunk(5, "e", { messageId: "message-2" }), 4, "e")), "abcde");
      const thought = store.commitLiveRuntimeEvent({
        event: textChunk(6, "t", { type: "agent_thought_chunk" }),
        mutation: { type: "create", entryId: "edge-thought", kind: "thought", text: "t", status: "streaming" },
      });
      assert.equal(thought.ok, true, thought.ok ? "" : thought.reason);
      assert.equal(store.loadConversationEntry(taskId, "edge-entry").text, "abcde");
      store.close();

      const envelopes = rawRows<{ receive_sequence: number; event_json: string }>(
        path,
        "SELECT receive_sequence, event_json FROM committed_envelopes ORDER BY receive_sequence",
      );
      // create(1), window b+c (2..3) written by the gap probe, window d (4) written by the
      // message-id change, window e (5) written by the thought entry, thought create (6).
      assert.deepEqual(envelopes.map((row) => row.receive_sequence), [1, 3, 4, 5, 6]);
      const merged = JSON.parse(envelopes[1]!.event_json) as { payload: { text: string; messageId: string } };
      assert.equal(merged.payload.text, "bc");
      assert.equal(merged.payload.messageId, "message-1");
      const single = JSON.parse(envelopes[2]!.event_json) as { payload: { text: string } };
      assert.equal(single.payload.text, "d");
    });

    it("never admits a chunk from state cached before another write changed it [WP2]", (t) => {
      const warm = (store: GuildPersistence) => {
        const { record, lastSequence } = streamChunks(store, "stale-entry", ["a", "b", "c"], 1);
        const next = (sequence: number, expectedRevision: number) => store.commitLiveRuntimeEvent({
          event: textChunk(sequence, "z"),
          mutation: { type: "append_text", entryId: "stale-entry", expectedRevision, text: "z" },
        });
        // The live context is warm here; the chunk is admitted.
        assert.equal(next(lastSequence + 1, record.revision).ok, true);
        return () => next(lastSequence + 2, record.revision + 1);
      };

      // Interrupting the Run is a write that is not a live event: the context must be dropped.
      const interruptedStore = liveReadyStore(temporaryDatabase(t));
      const lateChunk = warm(interruptedStore);
      const interrupted = interruptedStore.applyRun({
        taskId,
        runId,
        event: { type: "application_quit", idempotencyKey: key("stale-quit") },
      });
      assert.equal(interrupted.ok, true, interrupted.ok ? "" : interrupted.reason);
      assert.equal(lateChunk().ok, false);
      assert.equal(interruptedStore.loadConversationEntry(taskId, "stale-entry").text, "abcz");
      interruptedStore.close();

      // The same holds for an adapter epoch that exits after a warm admission.
      const exitedStore = liveReadyStore(temporaryDatabase(t));
      const lateAfterExit = warm(exitedStore);
      const current = exitedStore.loadCurrentAdapterEpoch(taskId)!;
      exitedStore.commitAdapterEpoch({
        taskId,
        sessionId,
        adapterEpoch: epoch,
        expectedRevision: current.revision,
        status: "exited",
      });
      assert.equal(lateAfterExit().ok, false);
      exitedStore.close();
    });

    it("limits the crash window to unwritten stream text; boundaries and terminals are durable [WP2]", (t) => {
      const spec = { taskId: "task-1", runId: "run-1", sessionId: "session-1" };
      const script = String.raw`
        const { openGuildPersistence } = await import(process.env.GUILD_CRASH_PERSISTENCE_URL);
        const { createRuntimeTurnEvent } = await import(process.env.GUILD_CRASH_CONTRACTS_URL);
        const spec = JSON.parse(process.env.GUILD_CRASH_SPEC);
        const store = openGuildPersistence({ path: process.env.GUILD_CRASH_DATABASE_PATH });
        let sequence = 0;
        const event = (payload) => {
          sequence += 1;
          const created = createRuntimeTurnEvent({
            taskId: spec.taskId, runId: spec.runId, adapterEpoch: 1, ingestMode: "live",
            receiveSequence: sequence, idempotencyKey: "crash-" + sequence + "-" + Math.random(),
            payload: { sessionId: spec.sessionId, received: { wallClockIso: "2026-10-09T12:00:00.000Z", monotonicMs: 1 }, ...payload },
          });
          if (!created.ok) throw new Error(created.reason);
          return created.value;
        };
        const chunk = (text) => event({ type: "agent_text_chunk", text });
        let record = store.commitLiveRuntimeEvent({
          event: chunk("A"),
          mutation: { type: "create", entryId: "crash-entry", kind: "assistant", text: "A", status: "streaming" },
        }).record;
        for (const text of ["B", "C", "D"]) {
          const result = store.commitLiveRuntimeEvent({
            event: chunk(text),
            mutation: { type: "append_text", entryId: "crash-entry", expectedRevision: record.revision, text },
          });
          if (!result.ok) throw new Error(result.reason);
          record = result.record;
        }
        if (spec.scenario === "timer") await new Promise((resolve) => setTimeout(resolve, 400));
        if (spec.scenario === "boundary") {
          store.applyRun({ taskId: spec.taskId, runId: spec.runId, event: { type: "user_cancel", idempotencyKey: "crash-cancel" } });
        }
        if (spec.scenario === "terminal") {
          const result = store.commitLiveRuntimeEvent({
            event: event({ type: "prompt_terminal", stopReason: "end_turn", classification: "completed", contextTokensUsed: 777 }),
            mutation: { type: "finalize", entryId: "crash-entry", expectedRevision: record.revision, status: "complete" },
            terminalFinalizationIdempotencyKey: "crash-terminal-finalized",
          });
          if (!result.ok) throw new Error(result.reason);
        }
        process.kill(process.pid, "SIGKILL");
      `;
      const crashed = (scenario: string) => {
        const path = temporaryDatabase(t);
        liveReadyStore(path).close();
        const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
          encoding: "utf8",
          env: {
            ...process.env,
            GUILD_CRASH_DATABASE_PATH: path,
            GUILD_CRASH_SPEC: JSON.stringify({ ...spec, scenario }),
            GUILD_CRASH_PERSISTENCE_URL: new URL("./index.js", import.meta.url).href,
            GUILD_CRASH_CONTRACTS_URL: import.meta.resolve("@guild/contracts"),
          },
          timeout: 20_000,
        });
        assert.equal(child.signal, "SIGKILL", child.stderr);
        const recovered = openGuildPersistence({ path });
        // The unclean open verified the whole database, so no row is torn.
        assert.equal(recovered.recoveredAfterUncleanShutdown, true);
        return recovered;
      };

      // No boundary: the entry exists (its create is written immediately), the window is gone.
      let recovered = crashed("pending");
      assert.equal(recovered.loadConversationEntry(taskId, "crash-entry").text, "A");
      assert.equal(recovered.loadConversationEntry(taskId, "crash-entry").revision, 1);
      assert.equal(recovered.loadRun(taskId, runId).state, "running");
      recovered.close();

      // The 100 ms timer writes the window without any other call.
      recovered = crashed("timer");
      assert.equal(recovered.loadConversationEntry(taskId, "crash-entry").text, "ABCD");
      assert.equal(recovered.loadConversationEntry(taskId, "crash-entry").revision, 4);
      recovered.close();

      // Any other store call is a boundary: the window is written before the cancel is.
      recovered = crashed("boundary");
      assert.equal(recovered.loadConversationEntry(taskId, "crash-entry").text, "ABCD");
      assert.equal(recovered.loadRun(taskId, runId).state, "cancel_requested");
      recovered.close();

      // A completed Run is never lost: terminal Run, correlation, final text and context tokens.
      recovered = crashed("terminal");
      assert.equal(recovered.loadRun(taskId, runId).state, "completed");
      assert.equal(recovered.loadPromptCorrelation(taskId, runId).status, "terminal");
      const entry = recovered.loadConversationEntry(taskId, "crash-entry");
      assert.equal(entry.text, "ABCD");
      assert.equal(entry.status, "complete");
      assert.equal(recovered.loadLatestContextTokensUsed(taskId), 777);
      recovered.close();
    });

    it("migrates a v14 database to the O(1) append guard without rewriting history [WP2]", (t) => {
      const path = temporaryDatabase(t);
      const seeded = conversationStore(path);
      seeded.createConversationEntry({
        taskId, entryId: "history-1", kind: "user", status: "complete", text: "Hello history", metadata: {},
      });
      const streaming = seeded.createConversationEntry({
        taskId, entryId: "history-2", kind: "assistant", status: "streaming", text: "Héllo ", metadata: {},
      });
      seeded.appendConversationEntryText({
        taskId, entryId: "history-2", expectedRevision: streaming.record.revision, text: "world",
      });
      seeded.close();

      const snapshot = () => JSON.stringify(rawRows(
        path,
        `SELECT task_id, entry_id, sequence, kind, text_content, metadata_json, metadata_sha256,
                initial_fingerprint, status, revision, created_at_ms, updated_at_ms
         FROM conversation_entries ORDER BY sequence`,
      ));
      const before = snapshot();

      const downgrade = new DatabaseSync(path);
      downgrade.exec(`
        DROP TRIGGER conversation_entry_is_append_only;
        CREATE TRIGGER conversation_entry_is_append_only
        BEFORE UPDATE ON conversation_entries
        WHEN NOT (
          NEW.task_id IS OLD.task_id AND NEW.entry_id IS OLD.entry_id
          AND NEW.sequence IS OLD.sequence AND NEW.kind IS OLD.kind
          AND NEW.run_id IS OLD.run_id AND NEW.metadata_json IS OLD.metadata_json
          AND NEW.metadata_sha256 IS OLD.metadata_sha256
          AND NEW.initial_fingerprint IS OLD.initial_fingerprint
          AND NEW.created_at_ms IS OLD.created_at_ms
          AND NEW.revision = OLD.revision + 1
          AND NEW.updated_at_ms >= OLD.updated_at_ms
          AND substr(NEW.text_content, 1, length(OLD.text_content)) = OLD.text_content
          AND (
            (OLD.status = 'streaming' AND NEW.status IN ('streaming', 'complete', 'failed'))
            OR (OLD.status IN ('complete', 'failed') AND NEW.status IS OLD.status)
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'conversation_entry_not_append_only');
        END;
        ${REMOVE_V19_SQL}
        DROP TABLE task_worktrees;
        DROP TABLE run_checkpoints;
        DROP TABLE task_interjections;
        DROP TABLE runtime_model_catalog;
        DROP TABLE task_runtime_settings;
        DROP TABLE task_context_usage;
        DELETE FROM schema_migrations WHERE version IN (15, 16, 17, 18);
        CREATE TABLE guild_meta_v14 (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          schema_version INTEGER NOT NULL CHECK(schema_version = 14),
          clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
          last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
        ) STRICT;
        INSERT INTO guild_meta_v14(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
        SELECT singleton, 14, clean_shutdown, last_integrity_at_ms FROM guild_meta;
        DROP TABLE guild_meta;
        ALTER TABLE guild_meta_v14 RENAME TO guild_meta;
        PRAGMA user_version = 14;
      `);
      // The v14 guard rejects a revision jump, which a coalesced flush needs.
      assert.throws(
        () => downgrade.exec(
          "UPDATE conversation_entries SET text_content = text_content || 'x', revision = revision + 3 WHERE entry_id = 'history-2'",
        ),
        /conversation_entry_not_append_only/u,
      );
      downgrade.close();

      const migrated = openGuildPersistence({ path });
      assert.equal(migrated.verifyIntegrity().schemaVersion, 19);
      migrated.close();
      assert.equal(snapshot(), before, "migration must not read-modify historical rows");

      const raw = new DatabaseSync(path);
      assert.equal(raw.prepare("PRAGMA user_version").get()?.["user_version"], 19);
      assert.match(
        String(raw.prepare("SELECT sql FROM sqlite_schema WHERE name = 'conversation_entry_is_append_only'").get()?.["sql"]),
        /octet_length/u,
      );

      const append = "UPDATE conversation_entries SET text_content = text_content || 'x', revision = revision + 3 WHERE entry_id = 'history-2'";
      raw.exec(append);
      const rejected = [
        "UPDATE conversation_entries SET text_content = 'short', revision = revision + 1 WHERE entry_id = 'history-2'",
        "UPDATE conversation_entries SET text_content = 'Jéllo worldxxxxxxxxxxxx', revision = revision + 1 WHERE entry_id = 'history-2'",
        "UPDATE conversation_entries SET text_content = text_content || 'y' WHERE entry_id = 'history-2'",
        "UPDATE conversation_entries SET revision = revision + 1, status = 'streaming' WHERE entry_id = 'history-1'",
        "UPDATE conversation_entries SET kind = 'notice', revision = revision + 1 WHERE entry_id = 'history-2'",
      ];
      for (const statement of rejected) {
        assert.throws(() => raw.exec(statement), /conversation_entry_not_append_only/u, statement);
      }
      assert.equal(
        raw.prepare("SELECT text_content FROM conversation_entries WHERE entry_id = 'history-2'").get()?.["text_content"],
        "Héllo worldx",
      );
      raw.close();
    });

    it("searches visible user and assistant text in SQL without decoding the history [WP3]", (t) => {
      const path = temporaryDatabase(t);
      const store = conversationStore(path);
      const second = must(parseTaskId("task-2"));
      store.createConversationTask({
        taskId: second, workspaceId, title: "Second task", owningWindowId: windowId,
      });
      const add = (task: typeof taskId, entryId: string, kind: "user" | "assistant" | "tool" | "thought", text: string, metadata = {}) =>
        store.createConversationEntry({ taskId: task, entryId, kind, status: "complete", text, metadata });
      add(taskId, "a-1", "user", "Find the Needle in 100%_done\\path");
      add(taskId, "a-2", "assistant", "plain reply");
      add(taskId, "a-hidden", "user", "needle hidden marker", { hidden: true });
      add(taskId, "a-tool", "tool", "needle in a tool title");
      add(taskId, "a-thought", "thought", "needle thought");
      for (const until = Date.now() + 3; Date.now() < until;) {
        // Conversation activity is ordered by millisecond timestamp.
      }
      add(second, "b-1", "assistant", "Another NEEDLE, newer activity");
      add(second, "b-cjk", "user", "数据库搜索 Éclair");
      const found = (query: string, limit?: number) =>
        store.searchConversationEntries({ query, ...(limit === undefined ? {} : { limit }) })
          .map((entry) => `${entry.taskId}:${entry.entryId}`);

      // ASCII is case-insensitive; hidden, tool and thought entries are never returned;
      // the conversation with the newest activity comes first.
      assert.deepEqual(found("needle"), ["task-2:b-1", "task-1:a-1"]);
      assert.deepEqual(found("  NeEdLe  ", 1), ["task-2:b-1"]);
      // LIKE metacharacters and the escape character are matched literally.
      assert.deepEqual(found("100%_done\\path"), ["task-1:a-1"]);
      assert.deepEqual(found("%"), ["task-1:a-1"]);
      assert.deepEqual(found("_"), ["task-1:a-1"]);
      assert.deepEqual(found("100_done"), []);
      // CJK has no case; cased non-ASCII letters keep full case-insensitive matching.
      assert.deepEqual(found("搜索"), ["task-2:b-cjk"]);
      assert.deepEqual(found("éclair"), ["task-2:b-cjk"]);
      assert.deepEqual(found("ÉCLAIR"), ["task-2:b-cjk"]);
      assert.deepEqual(found(""), []);
      assert.deepEqual(found("   "), []);
      assert.deepEqual(found("absent"), []);
      for (const bad of [{ query: "x".repeat(513) }, { query: "x", limit: 0 }, { query: "x", limit: 501 }]) {
        assert.throws(
          () => store.searchConversationEntries(bad),
          (error: unknown) =>
            error instanceof PersistenceError && error.code === "domain_operation_rejected",
        );
      }

      // Archived conversations are not searched; restoring them brings the matches back.
      const metadata = store.loadTaskMetadata(second);
      const archived = store.archiveTask({ taskId: second, expectedRevision: metadata.revision });
      assert.deepEqual(found("needle"), ["task-1:a-1"]);
      store.unarchiveTask({ taskId: second, expectedRevision: archived.revision });
      assert.deepEqual(found("needle"), ["task-2:b-1", "task-1:a-1"]);
      store.close();
    });

    it("searches stream text that has not been written yet [WP3]", (t) => {
      const store = liveReadyStore(temporaryDatabase(t));
      streamChunks(store, "pending-search", ["first ", "second ", "uniqueneedle"], 1);
      assert.deepEqual(
        store.searchConversationEntries({ query: "UNIQUENEEDLE" }).map((entry) => entry.text),
        ["first second uniqueneedle"],
      );
      store.close();
    });

    it("persists the latest context occupancy at turn end and recovers it for older databases [WP3]", (t) => {
      const path = temporaryDatabase(t);
      let store = liveReadyStore(path);
      assert.equal(store.loadLatestContextTokensUsed(taskId), undefined);
      const commitTerminal = (forRun: typeof runId, sequence: number, tokens?: number) => {
        const result = store.commitLiveRuntimeEvent({
          event: terminalEvent(sequence, tokens, forRun),
          mutation: {
            type: "create",
            entryId: `terminal-${forRun}`,
            kind: "notice",
            text: "",
            metadata: { hidden: true },
            status: "complete",
          },
          terminalFinalizationIdempotencyKey: key("terminal-finalized"),
        });
        assert.equal(result.ok, true, result.ok ? "" : result.reason);
      };
      commitTerminal(runId, 1, 4_321);
      assert.equal(store.loadLatestContextTokensUsed(taskId), 4_321);
      store.close();

      store = openGuildPersistence({ path });
      assert.equal(store.loadLatestContextTokensUsed(taskId), 4_321);
      store.close();

      // A database written before the value was persisted: the envelope is found through the
      // session's terminal Run by primary key.
      const stripped = new DatabaseSync(path);
      stripped.exec("DELETE FROM task_context_usage");
      stripped.close();
      store = openGuildPersistence({ path });
      assert.equal(store.loadLatestContextTokensUsed(taskId), 4_321);

      const turn = (nextRun: string, promptSequence: number, sequence: number, tokens?: number) => {
        const next = must(parseRunId(nextRun));
        store.createRun({ taskId, runId: next });
        const dispatched = store.applyRun({
          taskId,
          runId: next,
          event: { type: "scheduler_dispatch", sessionId, adapterEpoch: epoch, idempotencyKey: key("turn-dispatch") },
        });
        assert.equal(dispatched.ok, true, dispatched.ok ? "" : dispatched.reason);
        store.commitPromptAccepted({
          taskId, runId: next, sessionId, adapterEpoch: epoch, promptSequence,
          idempotencyKey: key("turn-accepted"),
        });
        commitTerminal(next, sequence, tokens);
      };
      // A turn without a usage report keeps the previous exact value; a later report replaces it.
      turn("run-2", 2, 2);
      assert.equal(store.loadLatestContextTokensUsed(taskId), 4_321);
      turn("run-3", 3, 3, 9_000);
      assert.equal(store.loadLatestContextTokensUsed(taskId), 9_000);
      store.close();

      const reopened = openGuildPersistence({ path });
      assert.equal(reopened.loadLatestContextTokensUsed(taskId), 9_000);
      assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
      reopened.close();
    });

    it("verifies history after an unclean shutdown but only lazily after a clean one [WP3]", (t) => {
      const path = temporaryDatabase(t);
      const seeded = liveReadyStore(path);
      streamChunks(seeded, "verify-entry", ["a", "b", "c"], 1);
      seeded.close();

      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE committed_envelopes SET event_sha256 = ? WHERE receive_sequence = 1").run("0".repeat(64));
      raw.close();

      // Clean start: the history is not scanned, so open succeeds and unrelated reads work.
      const lazy = openGuildPersistence({ path });
      assert.equal(lazy.recoveredAfterUncleanShutdown, false);
      assert.equal(lazy.loadConversationEntry(taskId, "verify-entry").text, "abc");
      assert.throws(
        () => lazy.verifyIntegrity(),
        (error: unknown) =>
          error instanceof PersistenceError && error.code === "aggregate_integrity_failed",
      );
      lazy.close();

      const marker = new DatabaseSync(path);
      marker.prepare("UPDATE guild_meta SET clean_shutdown = 0 WHERE singleton = 1").run();
      marker.close();
      assert.throws(
        () => openGuildPersistence({ path }),
        (error: unknown) =>
          error instanceof PersistenceError && error.code === "aggregate_integrity_failed",
      );
    });
  });

  describe("runtime model catalog and per-task settings [F1]", () => {
    const failure = (code: string) => (error: unknown) =>
      error instanceof PersistenceError && error.code === code;
    // updateAppSettings lets the contracts parser's TypeError through, like every other setting.
    const invalidValue = (error: unknown) =>
      error instanceof TypeError ||
      (error instanceof PersistenceError && error.code === "domain_operation_rejected");

    function withRaw<T>(path: string, operation: (raw: DatabaseSync) => T): T {
      const raw = new DatabaseSync(path);
      try {
        return operation(raw);
      } finally {
        raw.close();
      }
    }

    // Rebuilds a freshly created database the way a Guild 2.2 (schema v15) install looks: the
    // old closed model and effort CHECKs, none of the V16 tables, and the given settings pair.
    function downgradeToV15(path: string, model: string, effort: string): void {
      withRaw(path, (raw) => {
        raw.exec(`
          PRAGMA foreign_keys = OFF;
          ${REMOVE_V19_SQL}
          DROP TABLE task_worktrees;
          DROP TABLE run_checkpoints;
          DROP TABLE task_interjections;
          DROP TABLE runtime_model_catalog;
          DROP TABLE task_runtime_settings;
          DELETE FROM schema_migrations WHERE version IN (16, 17, 18);
          CREATE TABLE app_settings_v15 (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
            sidebar_width INTEGER NOT NULL CHECK(sidebar_width BETWEEN 220 AND 600),
            browser_sync_enabled INTEGER NOT NULL CHECK(browser_sync_enabled IN (0, 1)),
            revision INTEGER NOT NULL CHECK(revision >= 1),
            updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
            grok_model TEXT NOT NULL CHECK(grok_model IN ('grok-4.6', 'grok-4.5')),
            reasoning_effort TEXT NOT NULL CHECK(reasoning_effort IN ('xhigh', 'high', 'medium', 'low')),
            nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 1 AND 512),
            avatar_filename TEXT CHECK(avatar_filename IS NULL OR length(avatar_filename) BETWEEN 1 AND 80),
            restore_last_task INTEGER NOT NULL CHECK(restore_last_task IN (0, 1)),
            new_task_workspace_mode TEXT NOT NULL CHECK(new_task_workspace_mode IN ('ask', 'last')),
            last_active_task_id TEXT CHECK(last_active_task_id IS NULL OR length(last_active_task_id) BETWEEN 1 AND 512),
            last_workspace_id TEXT CHECK(last_workspace_id IS NULL OR length(last_workspace_id) BETWEEN 1 AND 512),
            permission_mode TEXT NOT NULL CHECK(permission_mode IN (
              'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan'
            )),
            web_search_enabled INTEGER NOT NULL CHECK(web_search_enabled IN (0, 1)),
            plan_enabled INTEGER NOT NULL CHECK(plan_enabled IN (0, 1)),
            subagents_enabled INTEGER NOT NULL CHECK(subagents_enabled IN (0, 1)),
            max_turns INTEGER CHECK(max_turns IS NULL OR max_turns BETWEEN 1 AND 10000),
            task_notifications_enabled INTEGER NOT NULL CHECK(task_notifications_enabled IN (0, 1))
          ) STRICT;
          CREATE TABLE guild_meta_v15 (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            schema_version INTEGER NOT NULL CHECK(schema_version = 15),
            clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
            last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
          ) STRICT;
          INSERT INTO guild_meta_v15(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
          SELECT singleton, 15, clean_shutdown, last_integrity_at_ms FROM guild_meta;
          DROP TABLE guild_meta;
          ALTER TABLE guild_meta_v15 RENAME TO guild_meta;
        `);
        // revision and updated_at_ms get recognisable values so the test can prove they are kept.
        raw.prepare(`
          INSERT INTO app_settings_v15(
            singleton, locale, sidebar_width, browser_sync_enabled, revision, updated_at_ms,
            grok_model, reasoning_effort, nickname, avatar_filename, restore_last_task,
            new_task_workspace_mode, last_active_task_id, last_workspace_id, permission_mode,
            web_search_enabled, plan_enabled, subagents_enabled, max_turns,
            task_notifications_enabled
          )
          SELECT singleton, locale, sidebar_width, browser_sync_enabled, 7, 1234567890123,
            ?, ?, nickname, avatar_filename, restore_last_task,
            new_task_workspace_mode, last_active_task_id, last_workspace_id, permission_mode,
            web_search_enabled, plan_enabled, subagents_enabled, max_turns,
            task_notifications_enabled
          FROM app_settings
        `).run(model, effort);
        raw.exec(`
          DROP TABLE app_settings;
          ALTER TABLE app_settings_v15 RENAME TO app_settings;
          PRAGMA user_version = 15;
        `);
      });
    }

    function seedV15(t: TestContext, model: string, effort: string): string {
      const path = temporaryDatabase(t);
      const seeded = conversationStore(path);
      seeded.updateAppSettings({
        expectedRevision: 1,
        nickname: "Owner",
        sidebarWidth: 333,
        permissionMode: "plan",
        startup: { webSearchEnabled: false, planEnabled: true, subagentsEnabled: false, maxTurns: 42 },
      });
      seeded.close();
      withRaw(path, (raw) => {
        raw.prepare(
          "INSERT INTO task_context_usage(task_id, session_id, tokens_used, updated_at_ms) VALUES(?, ?, 1234, 99)",
        ).run(taskId, sessionId);
      });
      downgradeToV15(path, model, effort);
      return path;
    }

    function realisticCatalog(): GrokModelCatalog {
      const efforts = (withXhigh: boolean) => [
        ...(withXhigh ? [{ id: "xhigh", label: "Extra High", isDefault: false }] : []),
        { id: "high", label: "High", isDefault: true },
        { id: "medium", label: "Medium", isDefault: false },
        { id: "low", label: "Low", isDefault: false },
      ];
      return freezeGrokModelCatalog({
        models: [
          {
            id: "grok-4.7",
            name: "Grok 4.7",
            reasoningEfforts: efforts(true),
            contextWindows: [256_000, 500_000],
            defaultContextWindow: 256_000,
          },
          {
            id: "grok-4.7-build-fast",
            name: "Grok 4.7 Build Fast",
            description: "Fast variant. 2x the price.",
            reasoningEfforts: [],
            contextWindows: [256_000],
          },
          { id: "grok-4.6", name: "Grok 4.6", reasoningEfforts: efforts(false), contextWindows: [256_000] },
          { id: "grok-4.5", name: "Grok 4.5", reasoningEfforts: efforts(false), contextWindows: [256_000] },
        ],
        runtimeDefaultModelId: "grok-4.7",
      });
    }

    it("migrates a v15 database: rewrites exactly the owner-approved pair and relaxes the constraints", (t) => {
      const owner = seedV15(t, "grok-4.6", "xhigh");
      const tuned = seedV15(t, "grok-4.6", "high");
      const older = seedV15(t, "grok-4.5", "medium");

      const migrated = openGuildPersistence({ path: owner });
      assert.equal(migrated.verifyIntegrity().schemaVersion, 19);
      const settings = migrated.loadAppSettings();
      assert.equal(settings.grokModel, "grok-4.7");
      assert.equal(settings.reasoningEffort, "high");
      // The rewrite is a migration: it keeps the revision and timestamp, and every other column.
      assert.equal(settings.revision, 7);
      assert.equal(settings.updatedAtMs, 1234567890123);
      assert.equal(settings.nickname, "Owner");
      assert.equal(settings.sidebarWidth, 333);
      assert.equal(settings.permissionMode, "plan");
      assert.deepEqual(settings.startup, {
        webSearchEnabled: false, planEnabled: true, subagentsEnabled: false, maxTurns: 42,
      });
      assert.equal(migrated.loadTaskRuntimeSettings(taskId), undefined);
      assert.equal(migrated.loadModelCatalogCache(), undefined);
      migrated.close();

      for (const [path, model, effort] of [
        [tuned, "grok-4.6", "high"],
        [older, "grok-4.5", "medium"],
      ] as const) {
        const other = openGuildPersistence({ path });
        const kept = other.loadAppSettings();
        assert.equal(kept.grokModel, model);
        assert.equal(kept.reasoningEffort, effort);
        assert.equal(kept.revision, 7);
        assert.equal(kept.updatedAtMs, 1234567890123);
        other.close();
      }

      withRaw(owner, (raw) => {
        assert.equal(raw.prepare("PRAGMA user_version").get()?.["user_version"], 19);
        assert.deepEqual(
          raw.prepare("SELECT version, name FROM schema_migrations WHERE version >= 15 ORDER BY version")
            .all().map((row) => ({ ...row })),
          [
            { version: 15, name: "streaming_write_path_and_context_usage" },
            { version: 16, name: "runtime_model_catalog_and_task_settings" },
            { version: 17, name: "steer_interjections_and_run_checkpoints" },
            { version: 18, name: "task_worktrees" },
            { version: 19, name: "dual_engine_and_model_sources" },
          ],
        );
        assert.deepEqual(
          raw.prepare("SELECT tokens_used, updated_at_ms FROM task_context_usage").all().map((row) => ({ ...row })),
          [{ tokens_used: 1234, updated_at_ms: 99 }],
        );
        const strictByTable = new Map(
          raw.prepare("PRAGMA table_list").all().map((row) => [row["name"], row["strict"]]),
        );
        assert.equal(strictByTable.get("task_runtime_settings"), 1);
        assert.equal(strictByTable.get("runtime_model_catalog"), 1);

        const setting = (column: string, value: string) =>
          raw.prepare(`UPDATE app_settings SET ${column} = ?`).run(value);
        // Accepted: a model and effort the old closed lists did not know, and the sentinel.
        setting("grok_model", "grok-4.9-preview");
        setting("reasoning_effort", "max");
        setting("grok_model", `grok-${"a".repeat(59)}`);
        setting("reasoning_effort", "a".repeat(32));
        setting("grok_model", "");
        setting("reasoning_effort", "");
        // Rejected: foreign models, injection text, control characters, over-long and malformed ids.
        for (const model of [
          "MiniMax-M3", "grok-4.7'; DROP TABLE app_settings; --", "grok-4.7\n", "GROK-4.7",
          "grok-4.7 fast", `grok-${"a".repeat(60)}`, "grok4.7",
        ]) {
          assert.throws(() => setting("grok_model", model), /CHECK constraint failed/u, model);
        }
        for (const effort of ["High", "1high", "high effort", "high\n", "a".repeat(33), "hi'gh"]) {
          assert.throws(() => setting("reasoning_effort", effort), /CHECK constraint failed/u, effort);
        }

        raw.prepare("INSERT INTO task_runtime_settings(task_id, model_id, revision, updated_at_ms) VALUES(?, ?, 1, 1)")
          .run(taskId, "grok-4.9-preview");
        // Malformed ids stay out for a Grok task (the guard trigger fires before the column CHECK,
        // which the Claude-task case in the schema v19 tests exercises on its own).
        for (const model of ["", "has space", "a/b", "x".repeat(129)]) {
          assert.throws(
            () => raw.prepare("UPDATE task_runtime_settings SET model_id = ?").run(model),
            /CHECK constraint failed|task_runtime_model_engine_mismatch/u,
            model,
          );
        }
        // A Grok task (the default engine) keeps the official-model guarantee at the database.
        for (const model of ["MiniMax-M3", `grok-${"a".repeat(60)}`, "grok4.7", "opus"]) {
          assert.throws(
            () => raw.prepare("UPDATE task_runtime_settings SET model_id = ?").run(model),
            /task_runtime_model_engine_mismatch/u,
            model,
          );
        }
        for (const window of [0, -1, 100_000_001]) {
          assert.throws(
            () => raw.prepare("UPDATE task_runtime_settings SET context_window = ?").run(window),
            /CHECK constraint failed/u,
            String(window),
          );
        }
        raw.prepare("UPDATE task_runtime_settings SET context_window = 100000000").run();
        assert.throws(
          () => raw.prepare("UPDATE task_runtime_settings SET reasoning_effort = 'Max'").run(),
          /CHECK constraint failed/u,
        );
        assert.throws(
          () => raw.prepare("INSERT INTO task_runtime_settings(task_id, revision, updated_at_ms) VALUES('missing', 1, 1)").run(),
          /FOREIGN KEY constraint failed/u,
        );
        assert.throws(
          () => raw.prepare("INSERT INTO runtime_model_catalog(engine, catalog_json, updated_at_ms) VALUES('codex', '{}', 1)").run(),
          /CHECK constraint failed/u,
        );
        assert.throws(
          () => raw.prepare("INSERT INTO runtime_model_catalog(engine, catalog_json, updated_at_ms) VALUES('grok', '', 1)").run(),
          /CHECK constraint failed/u,
        );
      });
    });

    it("starts a brand-new database on the runtime default instead of the rewritten pair", (t) => {
      const path = temporaryDatabase(t);
      const fresh = openGuildPersistence({ path });
      const settings = fresh.loadAppSettings();
      assert.equal(settings.grokModel, null);
      assert.equal(settings.reasoningEffort, null);
      assert.equal(settings.revision, 1);
      fresh.close();

      withRaw(path, (raw) => {
        assert.deepEqual(
          raw.prepare("SELECT grok_model, reasoning_effort FROM app_settings").all().map((row) => ({ ...row })),
          [{ grok_model: "", reasoning_effort: "" }],
        );
      });
      const reopened = openGuildPersistence({ path });
      assert.equal(reopened.loadAppSettings().grokModel, null);
      assert.equal(reopened.loadAppSettings().reasoningEffort, null);
      reopened.close();
    });

    it("updates the global model and effort: explicit values, back to the runtime default, undefined unchanged", (t) => {
      const path = temporaryDatabase(t);
      const store = openGuildPersistence({ path });
      const initial = store.loadAppSettings();

      const pinned = store.updateAppSettings({
        expectedRevision: initial.revision,
        grokModel: "grok-4.7",
        reasoningEffort: "xhigh",
      });
      assert.equal(pinned.grokModel, "grok-4.7");
      assert.equal(pinned.reasoningEffort, "xhigh");
      assert.equal(pinned.revision, initial.revision + 1);

      // The catalog is runtime data: a model or effort the old closed lists did not know is stored.
      const future = store.updateAppSettings({
        expectedRevision: pinned.revision,
        grokModel: "grok-4.9-preview",
        reasoningEffort: "max",
      });
      assert.equal(future.grokModel, "grok-4.9-preview");
      assert.equal(future.reasoningEffort, "max");

      const renamed = store.updateAppSettings({ expectedRevision: future.revision, nickname: "Owner" });
      assert.equal(renamed.grokModel, "grok-4.9-preview");
      assert.equal(renamed.reasoningEffort, "max");

      const effortOnly = store.updateAppSettings({
        expectedRevision: renamed.revision,
        reasoningEffort: "low",
      });
      assert.equal(effortOnly.grokModel, "grok-4.9-preview");
      assert.equal(effortOnly.reasoningEffort, "low");

      const reset = store.updateAppSettings({
        expectedRevision: effortOnly.revision,
        grokModel: null,
        reasoningEffort: null,
      });
      assert.equal(reset.grokModel, null);
      assert.equal(reset.reasoningEffort, null);
      assert.equal(reset.revision, effortOnly.revision + 1);
      // Setting the sentinel again is a no-op and does not advance the revision.
      const unchanged = store.updateAppSettings({
        expectedRevision: reset.revision,
        grokModel: null,
        reasoningEffort: null,
      });
      assert.equal(unchanged.revision, reset.revision);

      const modelOnly = store.updateAppSettings({
        expectedRevision: reset.revision,
        grokModel: "grok-4.6",
      });
      assert.equal(modelOnly.grokModel, "grok-4.6");
      assert.equal(modelOnly.reasoningEffort, null);

      for (const bad of [
        { grokModel: "MiniMax-M3" },
        { grokModel: "" },
        { grokModel: "grok-4.7; DROP TABLE app_settings" },
        { grokModel: `grok-${"a".repeat(60)}` },
        { reasoningEffort: "High" },
        { reasoningEffort: "" },
        { reasoningEffort: "x".repeat(33) },
      ]) {
        assert.throws(
          () => store.updateAppSettings({ expectedRevision: modelOnly.revision, ...bad }),
          invalidValue,
          JSON.stringify(bad),
        );
      }
      assert.equal(store.loadAppSettings().revision, modelOnly.revision);
      assert.throws(
        () => store.updateAppSettings({ expectedRevision: initial.revision, grokModel: "grok-4.5" }),
        failure("persistence_cas_conflict"),
      );
      store.close();

      const reopened = openGuildPersistence({ path });
      assert.equal(reopened.loadAppSettings().grokModel, "grok-4.6");
      assert.equal(reopened.loadAppSettings().reasoningEffort, null);
      assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
      reopened.close();
    });

    it("keeps per-task model overrides under compare-and-set and across reopen", (t) => {
      const path = temporaryDatabase(t);
      let store = conversationStore(path);
      const unknownTask = must(parseTaskId("task-unknown"));
      assert.equal(store.loadTaskRuntimeSettings(taskId), undefined);
      assert.throws(() => store.loadTaskRuntimeSettings(unknownTask), failure("aggregate_not_found"));

      const created = store.saveTaskRuntimeSettings({
        taskId,
        expectedRevision: 0,
        modelId: "grok-4.7-build-fast",
        reasoningEffort: "high",
        contextWindow: 500_000,
      });
      assert.deepEqual(
        { ...created, updatedAtMs: undefined },
        {
          taskId,
          modelId: "grok-4.7-build-fast",
          reasoningEffort: "high",
          contextWindow: 500_000,
          revision: 1,
          updatedAtMs: undefined,
        },
      );
      assert.equal(Object.isFrozen(created), true);
      assert.deepEqual(store.loadTaskRuntimeSettings(taskId), created);

      assert.throws(
        () => store.saveTaskRuntimeSettings({
          taskId, expectedRevision: 0, modelId: "grok-4.6", reasoningEffort: null, contextWindow: null,
        }),
        failure("persistence_cas_conflict"),
      );

      // NULL columns inherit the global default; clearing one field keeps the others.
      const updated = store.saveTaskRuntimeSettings({
        taskId, expectedRevision: 1, modelId: null, reasoningEffort: "low", contextWindow: null,
      });
      assert.equal(updated.revision, 2);
      assert.equal(updated.modelId, null);
      assert.equal(updated.reasoningEffort, "low");
      assert.equal(updated.contextWindow, null);
      const same = store.saveTaskRuntimeSettings({
        taskId, expectedRevision: 2, modelId: null, reasoningEffort: "low", contextWindow: null,
      });
      assert.equal(same.revision, 2);

      for (const stale of [1, 3]) {
        assert.throws(
          () => store.saveTaskRuntimeSettings({
            taskId, expectedRevision: stale, modelId: "grok-4.6", reasoningEffort: null, contextWindow: null,
          }),
          failure("persistence_cas_conflict"),
        );
      }
      assert.throws(
        () => store.saveTaskRuntimeSettings({
          taskId, expectedRevision: 2, modelId: null, reasoningEffort: null, contextWindow: null,
        }),
        failure("domain_operation_rejected"),
      );
      for (const bad of [
        { modelId: "MiniMax-M3" },
        { modelId: "" },
        { reasoningEffort: "High" },
        { contextWindow: 0 },
        { contextWindow: 1.5 },
        { contextWindow: 100_000_001 },
      ]) {
        assert.throws(
          () => store.saveTaskRuntimeSettings({
            taskId,
            expectedRevision: 2,
            modelId: "grok-4.6",
            reasoningEffort: null,
            contextWindow: null,
            ...bad,
          }),
          failure("domain_operation_rejected"),
          JSON.stringify(bad),
        );
      }
      assert.throws(
        () => store.saveTaskRuntimeSettings({
          taskId: unknownTask, expectedRevision: 0, modelId: "grok-4.6", reasoningEffort: null, contextWindow: null,
        }),
        failure("aggregate_not_found"),
      );
      assert.throws(
        () => store.clearTaskRuntimeSettings({ taskId: unknownTask, expectedRevision: 1 }),
        failure("aggregate_not_found"),
      );
      assert.deepEqual(store.loadTaskRuntimeSettings(taskId), updated);
      store.close();

      store = openGuildPersistence({ path });
      assert.deepEqual(store.loadTaskRuntimeSettings(taskId), updated);
      assert.equal(store.verifyIntegrity().schemaVersion, 19);
      assert.throws(
        () => store.clearTaskRuntimeSettings({ taskId, expectedRevision: 1 }),
        failure("persistence_cas_conflict"),
      );
      store.clearTaskRuntimeSettings({ taskId, expectedRevision: 2 });
      assert.equal(store.loadTaskRuntimeSettings(taskId), undefined);
      assert.throws(
        () => store.clearTaskRuntimeSettings({ taskId, expectedRevision: 2 }),
        failure("persistence_cas_conflict"),
      );
      const recreated = store.saveTaskRuntimeSettings({
        taskId, expectedRevision: 0, modelId: null, reasoningEffort: null, contextWindow: 256_000,
      });
      assert.equal(recreated.revision, 1);
      store.close();
    });

    it("catches a corrupted per-task settings row at verification and on read", (t) => {
      const path = temporaryDatabase(t);
      const seeded = conversationStore(path);
      seeded.saveTaskRuntimeSettings({
        taskId, expectedRevision: 0, modelId: "grok-4.7", reasoningEffort: null, contextWindow: null,
      });
      seeded.close();
      withRaw(path, (raw) => {
        raw.exec("PRAGMA ignore_check_constraints = ON");
        // Edited behind Guild's back: the database guard for Grok tasks is removed as well.
        raw.exec("DROP TRIGGER task_runtime_model_follows_engine_on_update");
        raw.prepare("UPDATE task_runtime_settings SET model_id = 'MiniMax-M3'").run();
      });

      const store = openGuildPersistence({ path });
      assert.throws(() => store.loadTaskRuntimeSettings(taskId), failure("aggregate_integrity_failed"));
      assert.throws(() => store.verifyIntegrity(), (error: unknown) =>
        error instanceof PersistenceError &&
        (error.code === "aggregate_integrity_failed" || error.code === "schema_integrity_failed"));
      store.close();
    });

    it("caches the runtime model list, ignores a bad cache, and skips unchanged writes", (t) => {
      const path = temporaryDatabase(t);
      let store = openGuildPersistence({ path });
      assert.equal(store.loadModelCatalogCache(), undefined);

      const catalog = realisticCatalog();
      store.saveModelCatalogCache({ catalog, runtimeVersion: "0.1.231" });
      const cached = store.loadModelCatalogCache();
      assert.deepEqual(cached?.catalog, catalog);
      assert.equal(cached?.runtimeVersion, "0.1.231");
      assert.equal(typeof cached?.updatedAtMs, "number");
      assert.equal(Object.isFrozen(cached?.catalog), true);
      assert.equal(Object.isFrozen(cached?.catalog.models[0]), true);
      assert.equal(cached?.catalog.models[1]?.description, "Fast variant. 2x the price.");
      store.close();

      // Rewind the stored timestamp so a rewrite is detectable whatever the clock resolution.
      withRaw(path, (raw) => {
        raw.prepare("UPDATE runtime_model_catalog SET updated_at_ms = 1000").run();
      });
      store = openGuildPersistence({ path });
      assert.deepEqual(store.loadModelCatalogCache()?.catalog, catalog);
      assert.equal(store.verifyIntegrity().schemaVersion, 19);

      // An identical list (even built with another key order) is not rewritten; a changed list
      // or runtime version is.
      const reordered: unknown = {
        runtimeDefaultModelId: "grok-4.7",
        models: catalog.models.map((model) => ({
          contextWindows: model.contextWindows,
          reasoningEfforts: model.reasoningEfforts.map((effort) => ({
            isDefault: effort.isDefault, label: effort.label, id: effort.id,
          })),
          name: model.name,
          id: model.id,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.defaultContextWindow === undefined
            ? {}
            : { defaultContextWindow: model.defaultContextWindow }),
        })),
      };
      store.saveModelCatalogCache({ catalog: reordered as GrokModelCatalog, runtimeVersion: "0.1.231" });
      assert.equal(store.loadModelCatalogCache()?.updatedAtMs, 1000);
      store.saveModelCatalogCache({ catalog, runtimeVersion: "0.1.232" });
      assert.equal(store.loadModelCatalogCache()?.runtimeVersion, "0.1.232");
      assert.notEqual(store.loadModelCatalogCache()?.updatedAtMs, 1000);
      store.saveModelCatalogCache({
        catalog: freezeGrokModelCatalog({ models: catalog.models.slice(1) }),
      });
      const shrunk = store.loadModelCatalogCache();
      assert.equal(shrunk?.catalog.models.length, 3);
      assert.equal(shrunk?.runtimeVersion, undefined);

      assert.throws(
        () => store.saveModelCatalogCache({
          catalog: { models: [{ id: "MiniMax-M3", name: "MiniMax", reasoningEfforts: [], contextWindows: [] }] } as never,
        }),
        failure("domain_operation_rejected"),
      );
      assert.throws(
        () => store.saveModelCatalogCache({ catalog, runtimeVersion: "v".repeat(129) }),
        failure("domain_operation_rejected"),
      );
      assert.equal(store.loadModelCatalogCache()?.catalog.models.length, 3);
      store.close();

      // A damaged cache is treated as absent: the database still opens and verifies, and the next
      // advertised list replaces the row.
      for (const damaged of ["{not json", '{"models":[{"id":"MiniMax-M3"}]}', "[]"]) {
        withRaw(path, (raw) => {
          raw.prepare("UPDATE runtime_model_catalog SET catalog_json = ?").run(damaged);
        });
        const reopened = openGuildPersistence({ path });
        assert.equal(reopened.loadModelCatalogCache(), undefined, damaged);
        assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
        reopened.saveModelCatalogCache({ catalog });
        assert.deepEqual(reopened.loadModelCatalogCache()?.catalog, catalog);
        reopened.close();
      }
    });
  });
});

describe("Steer interjections and run checkpoints (schema v17)", () => {
  function withRaw<T>(path: string, operation: (raw: DatabaseSync) => T): T {
    const raw = new DatabaseSync(path);
    try {
      return operation(raw);
    } finally {
      raw.close();
    }
  }

  function failure(code: string): (error: unknown) => boolean {
    return (error: unknown) => error instanceof PersistenceError && error.code === code;
  }

  it("tracks a Steer through sending, pending and delivered and creates its user entry once", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    const begun = store.beginInterjection({ taskId, interjectionId: "interject-1", runId, text: "go left" });
    assert.equal(begun.state, "sending");
    assert.equal(begun.entryId, undefined);
    assert.equal(store.listConversationEntries({ taskId }).some((entry) => entry.metadata["interjection"] === true), false,
      "no entry exists until the runtime accepted the interjection");
    // The intent is idempotent; the same id with other text is a different message.
    assert.equal(store.beginInterjection({ taskId, interjectionId: "interject-1", runId, text: "go left" }).state, "sending");
    assert.throws(
      () => store.beginInterjection({ taskId, interjectionId: "interject-1", runId, text: "go right" }),
      failure("aggregate_already_exists"),
    );
    assert.throws(
      () => store.beginInterjection({ taskId, interjectionId: "bad id", runId, text: "x" }),
      failure("domain_operation_rejected"),
    );
    assert.throws(
      () => store.beginInterjection({ taskId, interjectionId: "interject-empty", runId, text: "   " }),
      failure("domain_operation_rejected"),
    );

    const sent = store.commitInterjectionSent({
      taskId, interjectionId: "interject-1", entryId: "user-interject-1", delivered: false,
    });
    assert.equal(sent.state, "pending");
    assert.equal(sent.entryId, "user-interject-1");
    const entry = store.loadConversationEntry(taskId, "user-interject-1");
    assert.equal(entry.kind, "user");
    assert.equal(entry.runId, runId);
    assert.equal(entry.text, "go left");
    assert.equal(entry.status, "complete");
    assert.deepEqual({ ...entry.metadata }, { interjection: true, interjectionId: "interject-1" });
    // A retried commit is a no-op.
    assert.equal(store.commitInterjectionSent({
      taskId, interjectionId: "interject-1", entryId: "user-interject-1", delivered: false,
    }).state, "pending");

    const delivered = store.markInterjectionDelivered({ taskId, interjectionId: "interject-1" });
    assert.equal(delivered?.state, "delivered");
    assert.equal(store.markInterjectionDelivered({ taskId, interjectionId: "interject-1" })?.state, "delivered");
    assert.equal(store.markInterjectionDelivered({ taskId, interjectionId: "interject-unknown" }), undefined);
    assert.deepEqual(store.listInterjections(taskId).map((row) => [row.interjectionId, row.state]), [
      ["interject-1", "delivered"],
    ]);
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadInterjection(taskId, "interject-1")?.state, "delivered");
    assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
    reopened.close();
  });

  it("accepts an echo that arrived before the commit and cancels the converted queued turn atomically", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    store.enqueueQueuedTurn({
      taskId,
      queueId: "queue-steer",
      intendedSessionId: sessionId,
      reservedRunId: must(parseRunId("run-queued-steer")),
      entryId: "user-queued-steer",
      text: "steer me",
    });
    store.beginInterjection({ taskId, interjectionId: "interject-q", runId, text: "steer me" });
    // A queue id that does not exist rolls the whole commit back: no entry, still sending.
    assert.throws(
      () => store.commitInterjectionSent({
        taskId, interjectionId: "interject-q", entryId: "user-interject-q", delivered: true, removeQueueId: "queue-missing",
      }),
      failure("persistence_cas_conflict"),
    );
    assert.equal(store.loadInterjection(taskId, "interject-q")?.state, "sending");
    assert.throws(() => store.loadConversationEntry(taskId, "user-interject-q"), failure("aggregate_not_found"));
    assert.equal(store.listQueuedTurns(taskId).length, 1);

    const sent = store.commitInterjectionSent({
      taskId, interjectionId: "interject-q", entryId: "user-interject-q", delivered: true, removeQueueId: "queue-steer",
    });
    assert.equal(sent.state, "delivered");
    assert.equal(store.listQueuedTurns(taskId).length, 0);
    store.close();
  });

  it("records why a Steer fell back, keeps the explanatory notice, and recovers interrupted intents", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    store.beginInterjection({ taskId, interjectionId: "interject-f", runId, text: "later please" });
    const fallen = store.fallBackInterjection({
      taskId, interjectionId: "interject-f", reason: "unsupported",
      noticeEntryId: "notice-interject-f", noticeText: "Steer is not available.", queueId: "queue-f",
    });
    assert.equal(fallen.state, "fallen_back");
    assert.equal(fallen.reason, "unsupported");
    assert.equal(fallen.queueId, "queue-f");
    const notice = store.loadConversationEntry(taskId, "notice-interject-f");
    assert.equal(notice.kind, "notice");
    assert.deepEqual({ ...notice.metadata }, {
      interjection: true, interjectionId: "interject-f", interjectionFallback: true, reason: "unsupported",
    });
    // A fallen-back row cannot later be sent or failed.
    assert.throws(
      () => store.commitInterjectionSent({ taskId, interjectionId: "interject-f", entryId: "x-entry", delivered: false }),
      failure("domain_operation_rejected"),
    );
    assert.throws(
      () => store.failInterjection({ taskId, interjectionId: "interject-f", reason: "runtime_error" }),
      failure("domain_operation_rejected"),
    );

    store.beginInterjection({ taskId, interjectionId: "interject-g", runId, text: "crash window" });
    store.beginInterjection({ taskId, interjectionId: "interject-h", runId, text: "will fail" });
    store.failInterjection({ taskId, interjectionId: "interject-h", reason: "runtime_error" });
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.failInterruptedInterjections(taskId), 1);
    assert.equal(reopened.loadInterjection(taskId, "interject-g")?.state, "failed");
    assert.equal(reopened.loadInterjection(taskId, "interject-g")?.reason, "interrupted");
    assert.equal(reopened.loadInterjection(taskId, "interject-h")?.reason, "runtime_error");
    assert.equal(reopened.failInterruptedInterjections(taskId), 0);
    reopened.close();
  });

  it("links a Steer that the runtime ran as its own turn to the Run created for it", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    store.beginInterjection({ taskId, interjectionId: "interject-s", runId, text: "run me alone" });
    store.commitInterjectionSent({ taskId, interjectionId: "interject-s", entryId: "user-interject-s", delivered: true });
    const second = must(parseRunId("run-fallback-turn"));
    store.applyRun({ taskId, runId, event: { type: "application_quit", idempotencyKey: key("quit-first") } });
    store.createRun({ taskId, runId: second });
    const linked = store.linkInterjectionStartedRun({ taskId, interjectionId: "interject-s", startedRunId: second });
    assert.equal(linked.startedRunId, second);
    assert.equal(store.linkInterjectionStartedRun({ taskId, interjectionId: "interject-s", startedRunId: second }).startedRunId, second);
    assert.throws(
      () => store.linkInterjectionStartedRun({ taskId, interjectionId: "interject-s", startedRunId: runId }),
      failure("aggregate_already_exists"),
    );
    store.close();
  });

  it("stores per-Run checkpoints with stable ordinals, a capped file summary, and rollback markers", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    const first = store.createRunCheckpoint({
      taskId, runId, startRef: "refs/guild/checkpoints/task-1/1", status: "capturing",
    });
    assert.equal(first.ordinal, 1);
    assert.equal(first.status, "capturing");
    assert.equal(first.startRef, "refs/guild/checkpoints/task-1/1");
    assert.equal(store.createRunCheckpoint({ taskId, runId, status: "unavailable", detail: "not_a_git_repo" }).status, "capturing",
      "an existing row is returned unchanged");
    assert.throws(
      () => store.createRunCheckpoint({ taskId, runId: must(parseRunId("run-nope")), status: "unavailable" }),
      failure("aggregate_not_found"),
    );
    assert.throws(
      () => store.createRunCheckpoint({ taskId, runId, status: "capturing" }),
      failure("domain_operation_rejected"),
      "a capturing row needs its start ref",
    );

    const done = store.completeRunCheckpoint({
      taskId, runId, endRef: "refs/guild/checkpoints/task-1/2", status: "captured",
      files: [
        { path: "src/a.ts", status: "M", adds: 3, dels: 1 },
        { path: "new name.txt", oldPath: "old name.txt", status: "R", adds: 0, dels: 0 },
        { path: "logo.png", status: "A", adds: null, dels: null },
      ],
      filesTotal: 3, adds: 3, dels: 1,
    });
    assert.equal(done.status, "captured");
    assert.equal(done.endRef, "refs/guild/checkpoints/task-1/2");
    assert.deepEqual(done.files.map((file) => [file.path, file.oldPath, file.status, file.adds]), [
      ["src/a.ts", undefined, "M", 3],
      ["new name.txt", "old name.txt", "R", 0],
      ["logo.png", undefined, "A", null],
    ]);
    // A second completion does not rewrite a finished row.
    assert.equal(store.completeRunCheckpoint({
      taskId, runId, status: "unavailable", detail: "timeout", files: [], filesTotal: 0, adds: 0, dels: 0,
    }).status, "captured");
    assert.throws(
      () => store.completeRunCheckpoint({
        taskId, runId, status: "captured", files: [], filesTotal: 0, adds: 0, dels: 0,
      }),
      failure("domain_operation_rejected"),
      "a captured row needs its end ref",
    );

    // A Run without a row gets one when it is rolled back; ordinals follow insertion order.
    store.applyRun({ taskId, runId, event: { type: "application_quit", idempotencyKey: key("quit-ckpt") } });
    const later = must(parseRunId("run-later"));
    store.createRun({ taskId, runId: later });
    const marked = store.markRunsRolledBack({ taskId, runIds: [runId, later] });
    assert.deepEqual(marked.map((row) => [row.runId, row.ordinal, row.status]), [
      [runId, 1, "rolled_back"],
      [later, 2, "rolled_back"],
    ]);
    assert.equal(marked[1]?.detail, "capture_skipped");
    assert.equal(typeof marked[0]?.rolledBackAtMs, "number");
    assert.equal(marked[0]?.files.length, 3, "the summary is kept for audit");
    assert.equal(store.markRunsRolledBack({ taskId, runIds: [runId] })[0]?.status, "rolled_back");
    assert.deepEqual(store.listRunCheckpoints(taskId, [later]).map((row) => row.runId), [later]);
    assert.deepEqual(store.listTaskRuns(taskId).map((run) => run.runId), [runId, later]);
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadRunCheckpoint(taskId, runId)?.status, "rolled_back");
    reopened.close();
  });

  it("repairs checkpoints a crash left capturing without touching finished or rolled-back rows", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    store.createRunCheckpoint({ taskId, runId, startRef: "refs/guild/checkpoints/task-1/1", status: "capturing" });
    store.applyRun({ taskId, runId, event: { type: "application_quit", idempotencyKey: key("quit-repair") } });
    const second = must(parseRunId("run-second"));
    store.createRun({ taskId, runId: second });
    store.createRunCheckpoint({ taskId, runId: second, status: "unavailable", detail: "not_a_git_repo" });
    assert.equal(store.nextRunCheckpointOrdinal(taskId), 3);
    assert.equal(store.countRunCheckpoints(taskId), 2);
    assert.equal(store.failCapturingRunCheckpoints(taskId), 1);
    assert.equal(store.failCapturingRunCheckpoints(taskId), 0);
    assert.equal(store.loadRunCheckpoint(taskId, runId)?.status, "unavailable");
    assert.equal(store.loadRunCheckpoint(taskId, runId)?.detail, "capture_skipped");
    assert.equal(store.loadRunCheckpoint(taskId, second)?.detail, "not_a_git_repo");
    assert.deepEqual(store.listRolledBackRunIds(taskId), []);
    store.markRunsRolledBack({ taskId, runIds: [second] });
    assert.deepEqual(store.listRolledBackRunIds(taskId), [second]);
    assert.equal(store.failCapturingRunCheckpoints(taskId), 0);
    store.close();
  });

  it("rejects an oversized file summary and an inconsistent rolled-back row", (t) => {
    const path = temporaryDatabase(t);
    const store = liveReadyStore(path);
    store.createRunCheckpoint({ taskId, runId, startRef: "refs/guild/checkpoints/task-1/1", status: "capturing" });
    const huge = Array.from({ length: 80 }, (_, index) => ({
      path: `${String(index).padStart(3, "0")}/${"x".repeat(4_000)}`, status: "M" as const, adds: 1, dels: 1,
    }));
    assert.throws(
      () => store.completeRunCheckpoint({
        taskId, runId, endRef: "refs/guild/checkpoints/task-1/2", status: "captured",
        files: huge, filesTotal: 80, adds: 80, dels: 80,
      }),
      failure("domain_operation_rejected"),
    );
    assert.equal(store.loadRunCheckpoint(taskId, runId)?.status, "capturing");
    store.close();
    withRaw(path, (raw) => {
      assert.throws(() => raw.exec(
        `UPDATE run_checkpoints SET status = 'rolled_back' WHERE task_id = 'task-1'`,
      ), /CHECK constraint failed/u);
      assert.throws(() => raw.exec(
        `UPDATE run_checkpoints SET rolled_back_at_ms = 5 WHERE task_id = 'task-1'`,
      ), /CHECK constraint failed/u);
    });
  });

  it("migrates a v16 database forward without touching existing rows", (t) => {
    const path = temporaryDatabase(t);
    const legacy = liveReadyStore(path);
    legacy.createConversationEntry({ taskId, entryId: "history-1", kind: "user", runId, text: "old", status: "complete" });
    legacy.close();
    withRaw(path, (raw) => {
      raw.exec(`
        PRAGMA foreign_keys = OFF;
        ${REMOVE_V19_SQL}
        DROP TABLE task_worktrees;
        DROP TABLE run_checkpoints;
        DROP TABLE task_interjections;
        DELETE FROM schema_migrations WHERE version IN (17, 18);
        CREATE TABLE guild_meta_v16 (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          schema_version INTEGER NOT NULL CHECK(schema_version = 16),
          clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
          last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
        ) STRICT;
        INSERT INTO guild_meta_v16(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
        SELECT singleton, 16, clean_shutdown, last_integrity_at_ms FROM guild_meta;
        DROP TABLE guild_meta;
        ALTER TABLE guild_meta_v16 RENAME TO guild_meta;
        PRAGMA user_version = 16;
      `);
    });
    const migrated = openGuildPersistence({ path });
    assert.equal(migrated.verifyIntegrity().schemaVersion, 19);
    assert.equal(migrated.loadConversationEntry(taskId, "history-1").text, "old");
    assert.deepEqual(migrated.listInterjections(taskId), []);
    assert.deepEqual(migrated.listRunCheckpoints(taskId), []);
    migrated.beginInterjection({ taskId, interjectionId: "interject-after", runId, text: "works after migration" });
    migrated.close();
  });
});

describe("Task worktrees (schema v18)", () => {
  const baseCommit = "a".repeat(40);
  const input = {
    taskId,
    sourceWorkspaceId: workspaceId,
    sourceRepoPath: "/tmp/guild-source-repo",
    worktreePath: "/tmp/guild-data/worktrees/task-1",
    branch: "guild/task-1a2b3c4d",
    baseCommit,
    baseBranch: "main",
  } as const;

  function failure(code: string): (error: unknown) => boolean {
    return (error: unknown) => error instanceof PersistenceError && error.code === code;
  }

  function withRaw<T>(path: string, operation: (raw: DatabaseSync) => T): T {
    const raw = new DatabaseSync(path);
    try {
      return operation(raw);
    } finally {
      raw.close();
    }
  }

  it("records one worktree per task, reloads it, and walks the status", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    assert.equal(store.loadTaskWorktree(taskId), undefined);
    assert.deepEqual(store.listTaskWorktrees(), []);
    const created = store.createTaskWorktree(input);
    assert.equal(created.status, "active");
    assert.equal(created.branch, "guild/task-1a2b3c4d");
    assert.equal(created.baseBranch, "main");
    assert.equal(created.createdAtMs, created.updatedAtMs);
    assert.throws(() => store.createTaskWorktree(input), failure("aggregate_already_exists"));

    assert.equal(store.setTaskWorktreeStatus({ taskId, status: "applied" }).status, "applied");
    assert.equal(store.setTaskWorktreeStatus({ taskId, status: "applied" }).status, "applied", "same status is a no-op");
    assert.equal(store.setTaskWorktreeStatus({ taskId, status: "active" }).status, "active");
    assert.equal(store.setTaskWorktreeStatus({ taskId, status: "missing" }).status, "missing");
    assert.equal(store.setTaskWorktreeStatus({ taskId, status: "active" }).status, "active");
    assert.equal(store.setTaskWorktreeStatus({ taskId, status: "discarded" }).status, "discarded");
    assert.throws(
      () => store.setTaskWorktreeStatus({ taskId, status: "active" }),
      failure("domain_operation_rejected"),
      "a discarded worktree cannot come back",
    );
    assert.throws(
      () => store.setTaskWorktreeStatus({ taskId, status: "weird" as never }),
      failure("domain_operation_rejected"),
    );
    store.close();

    const reopened = openGuildPersistence({ path });
    const loaded = reopened.loadTaskWorktree(taskId);
    assert.equal(loaded?.status, "discarded");
    assert.equal(loaded?.worktreePath, input.worktreePath);
    assert.equal(loaded?.sourceRepoPath, input.sourceRepoPath);
    assert.equal(loaded?.baseCommit, baseCommit);
    assert.deepEqual(reopened.listTaskWorktrees().map((row) => row.taskId), [taskId]);
    reopened.close();
  });

  it("keeps a detached base without a branch name and refuses anything that is not a Guild branch", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    const { baseBranch: _omitted, ...detached } = input;
    const created = store.createTaskWorktree(detached);
    assert.equal(created.baseBranch, undefined);
    store.close();

    const second = conversationStore(temporaryDatabase(t));
    for (const rejected of [
      { ...input, branch: "main" },
      { ...input, branch: "guild/" },
      { ...input, branch: "feature/guild/x" },
      { ...input, baseCommit: "not-a-sha" },
      { ...input, baseCommit: "A".repeat(40) },
      { ...input, worktreePath: "" },
      { ...input, sourceRepoPath: "x".repeat(4_097) },
    ]) {
      assert.throws(() => second.createTaskWorktree(rejected), failure("domain_operation_rejected"), JSON.stringify(rejected));
    }
    assert.throws(
      () => second.createTaskWorktree({ ...input, taskId: must(parseTaskId("task-unknown")) }),
      failure("aggregate_not_found"),
    );
    second.close();
  });

  it("enforces the Guild branch and unique path rules in the table itself", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    store.close();
    withRaw(path, (raw) => {
      const insert = (branch: string, taskIdValue: string, worktree: string) => raw.prepare(`
        INSERT INTO task_worktrees(task_id, source_workspace_id, source_repo_path, worktree_path, branch,
          base_commit, base_branch, status, created_at_ms, updated_at_ms)
        VALUES(?, ?, '/r', ?, ?, ?, NULL, 'active', 1, 1)
      `).run(taskIdValue, workspaceId, worktree, branch, baseCommit);
      assert.throws(() => insert("main", taskId, "/w/a"), /CHECK constraint failed/u);
      assert.throws(() => insert("guild/x", "task-missing", "/w/b"), /FOREIGN KEY constraint failed/u);
      insert("guild/x", taskId, "/w/a");
      const other = must(parseTaskId("task-2"));
      raw.exec("PRAGMA foreign_keys = OFF");
      assert.throws(() => insert("guild/y", other, "/w/a"), /UNIQUE constraint failed/u);
      assert.throws(() => insert("guild/x", other, "/w/c"), /UNIQUE constraint failed/u);
      assert.throws(() => raw.exec("UPDATE task_worktrees SET status = 'gone'"), /CHECK constraint failed/u);
    });
  });
  it("migrates a v17 database forward without touching existing rows", (t) => {
    const path = temporaryDatabase(t);
    const legacy = liveReadyStore(path);
    legacy.createConversationEntry({ taskId, entryId: "history-1", kind: "user", runId, text: "old", status: "complete" });
    legacy.close();
    withRaw(path, (raw) => {
      raw.exec(`
        PRAGMA foreign_keys = OFF;
        ${REMOVE_V19_SQL}
        DROP TABLE task_worktrees;
        DELETE FROM schema_migrations WHERE version = 18;
        CREATE TABLE guild_meta_v17 (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          schema_version INTEGER NOT NULL CHECK(schema_version = 17),
          clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
          last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
        ) STRICT;
        INSERT INTO guild_meta_v17(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
        SELECT singleton, 17, clean_shutdown, last_integrity_at_ms FROM guild_meta;
        DROP TABLE guild_meta;
        ALTER TABLE guild_meta_v17 RENAME TO guild_meta;
        PRAGMA user_version = 17;
      `);
    });
    const migrated = openGuildPersistence({ path });
    assert.equal(migrated.verifyIntegrity().schemaVersion, 19);
    assert.equal(migrated.loadConversationEntry(taskId, "history-1").text, "old");
    assert.deepEqual(migrated.listTaskWorktrees(), []);
    assert.equal(migrated.createTaskWorktree(input).status, "active");
    migrated.close();
  });
});

describe("Guild 3.0 dual engine, model sources and preferences (schema v19)", () => {
  const claudeTaskId = must(parseTaskId("task-claude"));
  const otherWorkspaceId = "workspace-2";

  function failure(code: string): (error: unknown) => boolean {
    return (error: unknown) => error instanceof PersistenceError && error.code === code;
  }

  function withRaw<T>(path: string, operation: (raw: DatabaseSync) => T): T {
    const raw = new DatabaseSync(path);
    try {
      return operation(raw);
    } finally {
      raw.close();
    }
  }

  // A Grok task (task-1) and a Claude task (task-claude) in one workspace.
  function dualEngineStore(path: string): GuildPersistence {
    const store = conversationStore(path);
    store.createConversationTask({
      taskId: claudeTaskId,
      workspaceId,
      title: "Claude task",
      owningWindowId: windowId,
      engine: "claude",
    });
    return store;
  }

  const deepseek = {
    id: "deepseek",
    kind: "online",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    keyFile: null,
    keyVariable: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 128_000, supportsImages: false },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
    enabled: true,
  } as const;

  const workstation = {
    id: "workstation",
    kind: "local",
    label: "Workstation llama.cpp",
    baseUrl: "http://127.0.0.1:8081",
    keyFile: null,
    keyVariable: null,
    models: [{ id: "local-27b-model", label: "Local 27B" }],
    enabled: true,
  } as const;

  it("starts every task on the Grok engine and every default on 'follow the runtime'", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    const metadata = store.loadTaskMetadata(taskId);
    assert.equal(metadata.engine, "grok");
    assert.equal(metadata.routedAtMs, undefined);
    assert.equal(store.loadTaskEngine(taskId), "grok");
    const settings = store.loadAppSettings();
    assert.equal(settings.claudeModel, null);
    assert.equal(settings.claudeEffort, null);
    assert.equal(settings.claudePermissionMode, "default");
    assert.deepEqual(store.listModelSources(), []);
    assert.equal(store.loadModelSource("deepseek"), undefined);
    assert.deepEqual(store.loadWorkspacePrefs(workspaceId), { workspaceId, onlineReminderDismissed: false });
    assert.equal(store.loadModelCatalogCache("grok"), undefined);
    assert.equal(store.loadModelCatalogCache("claude"), undefined);
    assert.equal(store.countThinkingProvenance(), 0);
    store.close();
  });

  it("creates a Claude task, keeps its engine across reopen and refuses a different engine for the same task", (t) => {
    const path = temporaryDatabase(t);
    const store = dualEngineStore(path);
    assert.equal(store.loadTaskEngine(claudeTaskId), "claude");
    assert.equal(store.loadTaskEngine(taskId), "grok");
    assert.equal(store.listTasks({ workspaceId }).find((task) => task.taskId === claudeTaskId)?.engine, "claude");

    // Re-creating the same task is idempotent only for the same engine.
    const again = store.createConversationTask({
      taskId: claudeTaskId, workspaceId, title: "Claude task", owningWindowId: windowId, engine: "claude",
    });
    assert.equal(again.duplicate, true);
    assert.throws(
      () => store.createConversationTask({
        taskId: claudeTaskId, workspaceId, title: "Claude task", owningWindowId: windowId,
      }),
      failure("aggregate_already_exists"),
      "an unspecified engine means grok, which is not what the task has",
    );
    assert.throws(
      () => store.createConversationTask({
        taskId: must(parseTaskId("task-bad")), workspaceId, title: "x", engine: "codex" as never,
      }),
      failure("domain_operation_rejected"),
    );
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadTaskMetadata(claudeTaskId).engine, "claude");
    assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
    reopened.close();
  });

  it("changes a task's engine only before its first Run, under compare-and-set, and drops the override [PC-ENG-001]", (t) => {
    const path = temporaryDatabase(t);
    const store = dualEngineStore(path);
    const before = store.loadTaskMetadata(taskId);
    store.saveTaskRuntimeSettings({
      taskId, expectedRevision: 0, modelId: "grok-4.7", reasoningEffort: "high", contextWindow: null,
    });

    assert.throws(
      () => store.setTaskEngine({ taskId, expectedRevision: before.revision + 1, engine: "claude" }),
      failure("persistence_cas_conflict"),
    );
    assert.throws(
      () => store.setTaskEngine({ taskId, expectedRevision: before.revision, engine: "codex" as never }),
      failure("domain_operation_rejected"),
    );
    assert.equal(store.loadTaskEngine(taskId), "grok", "a rejected change leaves the engine alone");
    // The same engine is a no-op that costs no revision.
    assert.equal(store.setTaskEngine({ taskId, expectedRevision: before.revision, engine: "grok" }).revision, before.revision);

    const changed = store.setTaskEngine({ taskId, expectedRevision: before.revision, engine: "claude" });
    assert.equal(changed.engine, "claude");
    assert.equal(changed.revision, before.revision + 1);
    assert.equal(store.loadTaskRuntimeSettings(taskId), undefined, "the Grok override does not follow the task to Claude");
    // It can still be changed back while there is no Run.
    assert.equal(store.setTaskEngine({ taskId, expectedRevision: changed.revision, engine: "grok" }).engine, "grok");
    const back = store.loadTaskMetadata(taskId);
    store.setTaskEngine({ taskId, expectedRevision: back.revision, engine: "claude" });

    store.createRun({ taskId, runId });
    const withRun = store.loadTaskMetadata(taskId);
    assert.throws(
      () => store.setTaskEngine({ taskId, expectedRevision: withRun.revision, engine: "grok" }),
      failure("domain_operation_rejected"),
      "PC-TASK-001: no silent rebinding once the task has a Run",
    );
    assert.equal(store.loadTaskEngine(taskId), "claude");
    store.close();

    // The database enforces the same rule against any other writer.
    withRaw(path, (raw) => {
      assert.throws(
        () => raw.prepare("UPDATE task_metadata SET engine = 'grok' WHERE task_id = ?").run(taskId),
        /task_engine_fixed_after_first_run/u,
      );
      assert.throws(
        () => raw.prepare("UPDATE task_metadata SET engine = 'gemini' WHERE task_id = ?").run(claudeTaskId),
        /CHECK constraint failed/u,
      );
    });
  });

  it("refuses to change the engine of an archived task", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    const archived = store.archiveTask({ taskId, expectedRevision: store.loadTaskMetadata(taskId).revision });
    assert.throws(
      () => store.setTaskEngine({ taskId, expectedRevision: archived.revision, engine: "claude" }),
      failure("domain_operation_rejected"),
    );
    store.close();
  });

  it("marks a Claude task routed once, for good, without touching its revision [PC-ROUTE-002]", (t) => {
    const path = temporaryDatabase(t);
    const store = dualEngineStore(path);
    assert.throws(() => store.markTaskRouted({ taskId }), failure("domain_operation_rejected"), "a Grok task is never routed");
    assert.throws(
      () => store.markTaskRouted({ taskId: must(parseTaskId("task-unknown")) }),
      failure("aggregate_not_found"),
    );

    const before = store.loadTaskMetadata(claudeTaskId);
    assert.equal(before.routedAtMs, undefined);
    const routed = store.markTaskRouted({ taskId: claudeTaskId });
    assert.equal(typeof routed.routedAtMs, "number");
    assert.equal(routed.revision, before.revision);
    const again = store.markTaskRouted({ taskId: claudeTaskId });
    assert.equal(again.routedAtMs, routed.routedAtMs, "idempotent: the first time is kept");
    // A routed task cannot be sent back to the other engine.
    assert.throws(
      () => store.setTaskEngine({ taskId: claudeTaskId, expectedRevision: routed.revision, engine: "grok" }),
      failure("domain_operation_rejected"),
    );
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadTaskMetadata(claudeTaskId).routedAtMs, routed.routedAtMs);
    assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
    reopened.close();

    withRaw(path, (raw) => {
      assert.throws(
        () => raw.prepare("UPDATE task_metadata SET routed_at_ms = NULL WHERE task_id = ?").run(claudeTaskId),
        /task_routed_marker_immutable/u,
      );
      assert.throws(
        () => raw.prepare("UPDATE task_metadata SET routed_at_ms = routed_at_ms + 1 WHERE task_id = ?").run(claudeTaskId),
        /task_routed_marker_immutable/u,
      );
      assert.throws(
        () => raw.prepare("UPDATE task_metadata SET routed_at_ms = 5 WHERE task_id = ?").run(taskId),
        /CHECK constraint failed/u,
        "only a Claude task can be routed",
      );
    });
  });

  it("keeps Claude-engine defaults beside the Grok ones, validated with the Claude grammar [PC-SET-002]", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    const initial = store.loadAppSettings();
    const pinned = store.updateAppSettings({
      expectedRevision: initial.revision,
      claudeModel: "claude-fable-5-1[1m]",
      claudeEffort: "xhigh",
      claudePermissionMode: "acceptEdits",
    });
    assert.equal(pinned.claudeModel, "claude-fable-5-1[1m]");
    assert.equal(pinned.claudeEffort, "xhigh");
    assert.equal(pinned.claudePermissionMode, "acceptEdits");
    assert.equal(pinned.revision, initial.revision + 1);
    assert.equal(pinned.grokModel, initial.grokModel, "the Grok defaults are separate columns");
    assert.equal(pinned.permissionMode, initial.permissionMode);

    // undefined leaves a field alone; null returns to "follow the adapter".
    const modelOnly = store.updateAppSettings({ expectedRevision: pinned.revision, claudeModel: "deepseek-v4-flash" });
    assert.equal(modelOnly.claudeModel, "deepseek-v4-flash");
    assert.equal(modelOnly.claudeEffort, "xhigh");
    const cleared = store.updateAppSettings({
      expectedRevision: modelOnly.revision, claudeModel: null, claudeEffort: null, claudePermissionMode: "default",
    });
    assert.equal(cleared.claudeModel, null);
    assert.equal(cleared.claudeEffort, null);
    assert.equal(cleared.claudePermissionMode, "default");
    // An identical write costs no revision.
    assert.equal(
      store.updateAppSettings({ expectedRevision: cleared.revision, claudeModel: null }).revision,
      cleared.revision,
    );
    assert.throws(
      () => store.updateAppSettings({ expectedRevision: cleared.revision + 5, claudeModel: "opus" }),
      failure("persistence_cas_conflict"),
    );

    const invalid = (error: unknown) =>
      error instanceof TypeError || (error instanceof PersistenceError && error.code === "domain_operation_rejected");
    for (const patch of [
      { claudeModel: "claude opus" },
      { claudeModel: "a/b" },
      { claudeModel: "" },
      { claudeModel: "x".repeat(129) },
      { claudeEffort: "High" },
      { claudeEffort: "" },
      { claudePermissionMode: "dontAsk" as never },
      { claudePermissionMode: "root" as never },
    ]) {
      assert.throws(() => store.updateAppSettings({ expectedRevision: cleared.revision, ...patch }), invalid, JSON.stringify(patch));
    }
    // The Grok model rule did not loosen.
    assert.throws(() => store.updateAppSettings({ expectedRevision: cleared.revision, grokModel: "opus" }), invalid);
    store.close();

    withRaw(path, (raw) => {
      const setting = (column: string, value: string) =>
        raw.prepare(`UPDATE app_settings SET ${column} = ?`).run(value);
      for (const model of ["claude-opus-5-5", "claude-fable-5-1[1m]", "x".repeat(128), ""]) {
        setting("claude_model", model);
      }
      for (const model of ["claude opus", "claude/opus", "-opus", "opus\n", "x".repeat(129), "opus'; DROP TABLE app_settings; --", "caf\u00e9"]) {
        assert.throws(() => setting("claude_model", model), /CHECK constraint failed/u, model);
      }
      for (const effort of ["max", "default", "a".repeat(32), ""]) setting("claude_effort", effort);
      for (const effort of ["Max", "1x", "high effort", "a".repeat(33)]) {
        assert.throws(() => setting("claude_effort", effort), /CHECK constraint failed/u, effort);
      }
      for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]) setting("claude_permission_mode", mode);
      for (const mode of ["dontAsk", "", "Default"]) {
        assert.throws(() => setting("claude_permission_mode", mode), /CHECK constraint failed/u, mode);
      }
      // The Grok column still guarantees official ids.
      assert.throws(() => setting("grok_model", "claude-opus-5-5"), /CHECK constraint failed/u);
    });
  });

  it("validates a task's model override against the task's own engine", (t) => {
    const path = temporaryDatabase(t);
    const store = dualEngineStore(path);
    const save = (task: typeof taskId, modelId: string | null, reasoningEffort: string | null = null) =>
      store.saveTaskRuntimeSettings({ taskId: task, expectedRevision: 0, modelId, reasoningEffort, contextWindow: null });

    // Grok task: unchanged D-011 rule.
    for (const bad of ["opus", "deepseek-v4-flash", "MiniMax-M3", `grok-${"a".repeat(60)}`, "grok 4.7"]) {
      assert.throws(() => save(taskId, bad), failure("domain_operation_rejected"), bad);
    }
    assert.equal(save(taskId, "grok-4.7", "high").modelId, "grok-4.7");

    // Claude task: native, gateway and local ids; the Claude grammar.
    for (const bad of ["claude opus", "a/b", "x".repeat(129), "", "-opus"]) {
      assert.throws(() => save(claudeTaskId, bad), failure("domain_operation_rejected"), bad);
    }
    assert.throws(() => save(claudeTaskId, "opus", "High"), failure("domain_operation_rejected"));
    const saved = save(claudeTaskId, "claude-fable-5-1[1m]", "max");
    assert.equal(saved.modelId, "claude-fable-5-1[1m]");
    assert.equal(saved.reasoningEffort, "max");
    const updated = store.saveTaskRuntimeSettings({
      taskId: claudeTaskId, expectedRevision: saved.revision, modelId: "local-27b-model", reasoningEffort: null, contextWindow: 32_000,
    });
    assert.equal(updated.modelId, "local-27b-model");
    assert.equal(updated.contextWindow, 32_000);
    assert.equal(store.verifyIntegrity().schemaVersion, 19);
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadTaskRuntimeSettings(claudeTaskId)?.modelId, "local-27b-model");
    assert.equal(reopened.loadTaskRuntimeSettings(taskId)?.modelId, "grok-4.7");
    reopened.close();

    withRaw(path, (raw) => {
      // The column takes either grammar; only the Claude task may hold a non-grok id (guard trigger).
      assert.throws(
        () => raw.prepare("UPDATE task_runtime_settings SET model_id = 'opus' WHERE task_id = ?").run(taskId),
        /task_runtime_model_engine_mismatch/u,
      );
      raw.prepare("UPDATE task_runtime_settings SET model_id = 'x' || substr('aaaaaaaaaaaaaaaa', 1, 16) WHERE task_id = ?").run(claudeTaskId);
      for (const bad of ["has space", "a/b", "x".repeat(129)]) {
        assert.throws(
          () => raw.prepare("UPDATE task_runtime_settings SET model_id = ? WHERE task_id = ?").run(bad, claudeTaskId),
          /CHECK constraint failed/u,
          bad,
        );
      }
    });
  });

  it("flags a Claude-grammar override on a Grok task as corruption when the guard is bypassed", (t) => {
    const path = temporaryDatabase(t);
    const seeded = conversationStore(path);
    seeded.saveTaskRuntimeSettings({
      taskId, expectedRevision: 0, modelId: "grok-4.7", reasoningEffort: null, contextWindow: null,
    });
    seeded.close();
    withRaw(path, (raw) => {
      raw.exec("DROP TRIGGER task_runtime_model_follows_engine_on_update");
      raw.prepare("UPDATE task_runtime_settings SET model_id = 'opus'").run();
    });
    const store = openGuildPersistence({ path });
    assert.throws(() => store.loadTaskRuntimeSettings(taskId), failure("aggregate_integrity_failed"));
    assert.throws(() => store.verifyIntegrity(), failure("aggregate_integrity_failed"));
    store.close();
  });

  function claudeCatalog() {
    return {
      runtimeDefaultModelId: "default",
      models: [
        { id: "default", name: "Default", reasoningEfforts: [{ id: "high", label: "High", isDefault: true }], contextWindows: [] },
        { id: "opus", name: "Opus", group: "claude", reasoningEfforts: [], contextWindows: [200_000] },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", group: "online", reasoningEfforts: [], contextWindows: [128_000] },
        { id: "local-27b-model", name: "Local 27B", group: "local", reasoningEfforts: [], contextWindows: [] },
      ],
    };
  }

  it("caches one model list per engine and ignores a damaged one without touching the other [PC-MODEL-001]", (t) => {
    const path = temporaryDatabase(t);
    let store = openGuildPersistence({ path });
    const grok = freezeGrokModelCatalog({
      runtimeDefaultModelId: "grok-4.7",
      models: [{ id: "grok-4.7", name: "Grok 4.7", reasoningEfforts: [], contextWindows: [256_000] }],
    });
    store.saveModelCatalogCache({ catalog: grok, runtimeVersion: "0.1.231" });
    store.saveModelCatalogCache({ engine: "claude", catalog: claudeCatalog() as never, runtimeVersion: "0.89.1" });

    const loadedGrok = store.loadModelCatalogCache();
    const loadedClaude = store.loadModelCatalogCache("claude");
    assert.equal(loadedGrok?.engine, "grok");
    assert.equal(loadedGrok?.catalog.engine, undefined, "a Grok catalog keeps its Grok-era shape");
    assert.deepEqual(loadedGrok?.catalog, grok);
    assert.equal(loadedGrok?.runtimeVersion, "0.1.231");
    assert.equal(loadedClaude?.engine, "claude");
    assert.equal(loadedClaude?.catalog.engine, "claude");
    assert.deepEqual(loadedClaude?.catalog.models.map((model) => [model.id, model.group]), [
      ["default", "claude"], ["opus", "claude"], ["deepseek-v4-flash", "online"], ["local-27b-model", "local"],
    ]);
    assert.equal(loadedClaude?.catalog.runtimeDefaultModelId, "default");
    assert.equal(loadedClaude?.runtimeVersion, "0.89.1");
    assert.equal(Object.isFrozen(loadedClaude?.catalog.models[2]), true);

    // A list belongs to one engine: Claude ids are not Grok models, and a label must agree.
    assert.throws(
      () => store.saveModelCatalogCache({ catalog: claudeCatalog() as never }),
      failure("domain_operation_rejected"),
    );
    assert.throws(
      () => store.saveModelCatalogCache({ engine: "claude", catalog: { ...grok, engine: "grok" } }),
      failure("domain_operation_rejected"),
      "a catalog labelled grok is not stored as the Claude list",
    );
    assert.throws(
      () => store.saveModelCatalogCache({ engine: "grok", catalog: { ...claudeCatalog(), engine: "claude" } as never }),
      failure("domain_operation_rejected"),
      "nor a Claude list as the Grok one",
    );
    assert.throws(
      () => store.saveModelCatalogCache({ engine: "codex" as never, catalog: grok }),
      failure("domain_operation_rejected"),
    );
    store.close();

    withRaw(path, (raw) => {
      assert.deepEqual(
        raw.prepare("SELECT engine FROM runtime_model_catalog ORDER BY engine").all().map((row) => row["engine"]),
        ["claude", "grok"],
      );
      raw.prepare("UPDATE runtime_model_catalog SET catalog_json = '{\"models\":\"nope\"}' WHERE engine = 'claude'").run();
    });
    store = openGuildPersistence({ path });
    assert.equal(store.loadModelCatalogCache("claude"), undefined);
    assert.deepEqual(store.loadModelCatalogCache()?.catalog, grok);
    assert.equal(store.verifyIntegrity().schemaVersion, 19);
    store.close();
  });

  it("reads a Grok cache written before Guild 3.0 exactly as before", (t) => {
    const path = temporaryDatabase(t);
    const seeded = openGuildPersistence({ path });
    seeded.saveModelCatalogCache({
      catalog: freezeGrokModelCatalog({ models: [{ id: "grok-4.7", name: "Grok 4.7", reasoningEfforts: [], contextWindows: [] }] }),
    });
    seeded.close();
    withRaw(path, (raw) => {
      raw.prepare("UPDATE runtime_model_catalog SET catalog_json = ? WHERE engine = 'grok'").run(
        JSON.stringify({ models: [{ id: "grok-4.7", name: "Grok 4.7", reasoningEfforts: [], contextWindows: [] }] }),
      );
    });
    const store = openGuildPersistence({ path });
    const cached = store.loadModelCatalogCache();
    assert.equal(cached?.engine, "grok");
    assert.equal(cached?.catalog.models[0]?.id, "grok-4.7");
    assert.equal(cached?.catalog.engine, undefined);
    assert.equal(cached?.catalog.models[0]?.group, undefined);
    store.close();
  });

  it("stores model sources with no secret anywhere and asks for a native confirmation of the host [PC-ROUTE-002]", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    const created = store.upsertModelSource(deepseek);
    assert.equal(created.needsConfirmation, true);
    assert.equal(created.source.confirmedHost, null);
    assert.equal(created.source.revision, 1);
    assert.equal(created.source.baseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(created.source.keyVariable, "DEEPSEEK_API_KEY");
    assert.equal(created.source.keyFile, null);
    assert.deepEqual(created.source.models.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert.equal(created.source.models[0]?.contextWindow, 128_000);
    assert.equal(created.source.models[0]?.supportsImages, false);
    assert.equal(Object.isFrozen(created.source), true);
    assert.equal(Object.isFrozen(created.source.models[0]), true);

    // The confirmation names the revision the dialog was built from.
    assert.throws(() => store.confirmModelSource({ sourceId: "deepseek", expectedRevision: 9 }), failure("persistence_cas_conflict"));
    assert.throws(() => store.confirmModelSource({ sourceId: "nope", expectedRevision: 1 }), failure("aggregate_not_found"));
    assert.equal(store.loadModelSource("deepseek")?.confirmedHost, null, "a failed confirmation confirms nothing");
    const confirmed = store.confirmModelSource({ sourceId: "deepseek", expectedRevision: 1 });
    assert.equal(confirmed.confirmedHost, "api.deepseek.com");
    assert.equal(confirmed.revision, 2);
    assert.equal(store.confirmModelSource({ sourceId: "deepseek", expectedRevision: 2 }).revision, 2, "already confirmed: unchanged");

    // Names, labels, models and the enabled flag may change without voiding the confirmation.
    const relabelled = store.upsertModelSource({
      ...deepseek,
      label: "DeepSeek (work)",
      enabled: false,
      models: [...deepseek.models, { id: "deepseek-v4-lite", label: "Lite" }],
    });
    assert.equal(relabelled.needsConfirmation, false);
    assert.equal(relabelled.source.confirmedHost, "api.deepseek.com");
    assert.equal(relabelled.source.enabled, false);
    assert.equal(relabelled.source.models.length, 3);
    assert.equal(relabelled.source.revision, 3);
    // An identical upsert is a no-op.
    const same = store.upsertModelSource({ ...deepseek, label: "DeepSeek (work)", enabled: false, models: relabelled.source.models });
    assert.equal(same.source.revision, 3);
    assert.equal(same.needsConfirmation, false);

    // Anything that moves the key or its destination voids it.
    const afterConfirm = (patch: Record<string, unknown>) => {
      const current = store.loadModelSource("deepseek")!;
      if (current.confirmedHost === null) {
        store.confirmModelSource({ sourceId: "deepseek", expectedRevision: current.revision });
      }
      const result = store.upsertModelSource({ ...deepseek, label: "DeepSeek (work)", enabled: false, models: relabelled.source.models, ...patch } as never);
      return result;
    };
    for (const patch of [
      { baseUrl: "https://api.deepseek.com/v2/anthropic" },
      { baseUrl: "https://api.deepseek.net/anthropic" },
      { keyVariable: "DEEPSEEK_OTHER_KEY" },
      { keyFile: "/Users/owner/keys.env" },
      { kind: "local" },
    ]) {
      const result = afterConfirm(patch);
      assert.equal(result.source.confirmedHost, null, JSON.stringify(patch));
      assert.equal(result.needsConfirmation, true, JSON.stringify(patch));
      // put the baseline back for the next case
      afterConfirm({});
      const restored = store.upsertModelSource({ ...deepseek, label: "DeepSeek (work)", enabled: false, models: relabelled.source.models });
      assert.equal(restored.source.baseUrl, "https://api.deepseek.com/anthropic");
    }
    store.close();

    // Nothing in the database could hold a key: the columns name a file and a variable only.
    withRaw(path, (raw) => {
      assert.deepEqual(
        raw.prepare("PRAGMA table_info(model_sources)").all().map((row) => row["name"]),
        [
          "source_id", "kind", "label", "base_url", "key_file", "key_variable", "models_json",
          "enabled", "confirmed_host", "revision", "created_at_ms", "updated_at_ms",
        ],
      );
      const dump = JSON.stringify(raw.prepare("SELECT * FROM model_sources").all());
      assert.doesNotMatch(dump, /sk-|Bearer|apiKey|secret/iu);
    });
  });

  it("rejects anything that looks like a key, a bad address or an unknown field", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    const rejected = (patch: Record<string, unknown>, label: string) =>
      assert.throws(() => store.upsertModelSource({ ...deepseek, ...patch } as never), failure("domain_operation_rejected"), label);

    // A key variable must be a variable NAME; a pasted key is refused.
    rejected({ keyVariable: "sk-ant-api03-abcdefghijklmnop" }, "keyVariable containing sk-");
    rejected({ keyVariable: "MY_sk-abcdefghijkl" }, "keyVariable with a key inside");
    rejected({ keyVariable: "sk-" }, "keyVariable sk-");
    rejected({ keyVariable: "deepseek_key" }, "lower-case variable");
    rejected({ keyFile: "/Users/owner/keys.env", keyVariable: null }, "a key file without a variable");
    rejected({ keyFile: "keys.env" }, "relative key file");
    rejected({ keyFile: "/Users/owner/sk-ant-api03-abcdefghijkl.env" }, "a key in the path");
    rejected({ label: "DeepSeek sk-ant-api03-abcdefghijkl" }, "a key in the label");
    rejected({ label: "Bearer abcdefghijklmnop" }, "a bearer token in the label");
    rejected({ baseUrl: "http://api.deepseek.com/anthropic" }, "http for an Online source");
    rejected({ baseUrl: "https://user:sk-abcdef123456@api.deepseek.com" }, "user info in the address");
    rejected({ baseUrl: "https://api.deepseek.com/anthropic?key=abc" }, "query in the address");
    rejected({ baseUrl: "https://api.deepseek.com/@scope" }, "an @ in the address");
    rejected({ id: "has space" }, "bad id");
    rejected({ kind: "remote" }, "bad kind");
    rejected({ enabled: 1 }, "numeric enabled");
    rejected({ models: [] }, "no models");
    rejected({ models: [{ id: "a b", label: "x" }] }, "bad model id");
    rejected({ models: [{ id: "sk-abcdefghijkl", label: "x" }] }, "a key as a model id");
    rejected({ models: [{ id: "ok", label: "x", apiKey: "k" }] }, "extra model field");
    rejected({ apiKey: "sk-ant-api03-abcdefghijkl" }, "apiKey field");
    rejected({ confirmedHost: "api.deepseek.com" }, "a draft cannot carry the confirmation");
    assert.throws(() => store.upsertModelSource(null as never), failure("domain_operation_rejected"));
    assert.deepEqual(store.listModelSources(), [], "nothing was stored");
    // A local source may use plain http and needs no key.
    assert.equal(store.upsertModelSource(workstation).source.baseUrl, "http://127.0.0.1:8081");
    store.close();
  });

  it("keeps a model id on one source, caps the number of sources and lists them oldest first", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    store.upsertModelSource(deepseek);
    assert.throws(
      () => store.upsertModelSource({ ...workstation, models: [{ id: "deepseek-v4-flash", label: "Impostor" }] }),
      failure("domain_operation_rejected"),
      "a model id maps to one source",
    );
    store.upsertModelSource(workstation);
    // A source may keep and reorder its own ids.
    const reordered = store.upsertModelSource({ ...deepseek, models: [...deepseek.models].reverse() });
    assert.deepEqual(reordered.source.models.map((model) => model.id), ["deepseek-v4-pro", "deepseek-v4-flash"]);
    assert.deepEqual(store.listModelSources().map((source) => source.id), ["deepseek", "workstation"]);

    for (let index = 0; index < 30; index += 1) {
      store.upsertModelSource({
        ...workstation,
        id: `local-${index}`,
        label: `Local ${index}`,
        baseUrl: `http://127.0.0.1:${9000 + index}`,
        models: [{ id: `local-model-${index}`, label: `Local model ${index}` }],
      });
    }
    assert.equal(store.listModelSources().length, 32);
    assert.throws(
      () => store.upsertModelSource({
        ...workstation, id: "one-too-many", baseUrl: "http://127.0.0.1:9999", models: [{ id: "extra-model", label: "x" }],
      }),
      failure("domain_operation_rejected"),
    );
    // Updating an existing source is still fine at the cap.
    assert.equal(store.upsertModelSource({ ...workstation, label: "Workstation renamed" }).source.label, "Workstation renamed");
    store.close();
  });

  it("deletes a source and reloads the rest across reopen", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    store.upsertModelSource(deepseek);
    store.upsertModelSource(workstation);
    store.confirmModelSource({ sourceId: "workstation", expectedRevision: 1 });
    store.deleteModelSource("deepseek");
    assert.throws(() => store.deleteModelSource("deepseek"), failure("aggregate_not_found"));
    assert.throws(() => store.deleteModelSource("has space"), failure("domain_operation_rejected"));
    assert.equal(store.loadModelSource("deepseek"), undefined);
    // Its model ids are free again.
    store.upsertModelSource({ ...workstation, id: "other", baseUrl: "http://127.0.0.1:8082", models: [{ id: "deepseek-v4-flash", label: "Mine now" }] });
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.deepEqual(reopened.listModelSources().map((source) => source.id), ["workstation", "other"]);
    assert.equal(reopened.loadModelSource("workstation")?.confirmedHost, "127.0.0.1:8081");
    assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
    reopened.close();
  });

  it("enforces the address and key rules in the table and catches a doctored row on read", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    store.upsertModelSource(deepseek);
    store.close();
    withRaw(path, (raw) => {
      const update = (assignment: string) => raw.exec(`UPDATE model_sources SET ${assignment}`);
      for (const assignment of [
        "base_url = 'http://api.deepseek.com/anthropic'",
        "base_url = 'https://user:pw@api.deepseek.com'",
        "base_url = 'https://api.deepseek.com/a?key=1'",
        "base_url = 'https://api.deepseek.com/a#frag'",
        "base_url = 'ftp://api.deepseek.com'",
        "key_variable = 'sk-ant-api03-abcdefghijkl'",
        "key_variable = 'lower_case'",
        "key_file = '/Users/owner/keys.env', key_variable = NULL",
        "confirmed_host = 'evil.example'",
        "kind = 'remote'",
        "enabled = 2",
        "models_json = ''",
        "source_id = 'has space'",
      ]) {
        assert.throws(() => update(assignment), /CHECK constraint failed/u, assignment);
      }
      raw.exec("PRAGMA ignore_check_constraints = ON");
      raw.exec("UPDATE model_sources SET confirmed_host = 'evil.example'");
    });
    const reopened = openGuildPersistence({ path });
    assert.throws(() => reopened.loadModelSource("deepseek"), failure("aggregate_integrity_failed"));
    assert.throws(() => reopened.listModelSources(), failure("aggregate_integrity_failed"));
    assert.throws(() => reopened.verifyIntegrity(), (error: unknown) =>
      error instanceof PersistenceError &&
      (error.code === "aggregate_integrity_failed" || error.code === "schema_integrity_failed"));
    reopened.close();
  });

  it("keeps per-workspace privacy preferences [PC-PRIV-001]", (t) => {
    const path = temporaryDatabase(t);
    const store = conversationStore(path);
    store.createWorkspace({ workspaceId: otherWorkspaceId, canonicalPath: "/tmp/guild-workspace-2", displayName: "Second" });
    assert.deepEqual(store.loadWorkspacePrefs(workspaceId), { workspaceId, onlineReminderDismissed: false });
    assert.deepEqual(
      store.saveWorkspacePrefs({ workspaceId, onlineReminderDismissed: true }),
      { workspaceId, onlineReminderDismissed: true },
    );
    assert.equal(store.loadWorkspacePrefs(workspaceId).onlineReminderDismissed, true);
    assert.equal(store.loadWorkspacePrefs(otherWorkspaceId).onlineReminderDismissed, false, "the choice is per workspace");
    assert.equal(store.saveWorkspacePrefs({ workspaceId, onlineReminderDismissed: true }).onlineReminderDismissed, true, "idempotent");
    assert.equal(store.saveWorkspacePrefs({ workspaceId, onlineReminderDismissed: false }).onlineReminderDismissed, false);
    store.saveWorkspacePrefs({ workspaceId, onlineReminderDismissed: true });

    assert.throws(() => store.loadWorkspacePrefs("workspace-missing"), failure("aggregate_not_found"));
    assert.throws(
      () => store.saveWorkspacePrefs({ workspaceId: "workspace-missing", onlineReminderDismissed: true }),
      failure("aggregate_not_found"),
    );
    assert.throws(
      () => store.saveWorkspacePrefs({ workspaceId, onlineReminderDismissed: "yes" as never }),
      failure("domain_operation_rejected"),
    );
    store.close();

    const reopened = openGuildPersistence({ path });
    assert.equal(reopened.loadWorkspacePrefs(workspaceId).onlineReminderDismissed, true);
    assert.equal(reopened.verifyIntegrity().schemaVersion, 19);
    reopened.close();
    withRaw(path, (raw) => {
      assert.throws(
        () => raw.exec("INSERT INTO workspace_prefs(workspace_id, online_reminder_dismissed) VALUES('workspace-1', 2)"),
        /CHECK constraint failed|UNIQUE constraint failed/u,
      );
      assert.throws(
        () => raw.exec("INSERT INTO workspace_prefs(workspace_id, online_reminder_dismissed) VALUES('workspace-nope', 1)"),
        /FOREIGN KEY constraint failed/u,
      );
    });
  });

  it("records which source produced a thinking signature and prunes to a bounded size [D-058]", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    const hash = (n: number) => n.toString(16).padStart(32, "0");
    assert.equal(store.loadThinkingProvenance(hash(1)), undefined);
    store.saveThinkingProvenance({ hash: hash(1), sourceId: "deepseek" });
    assert.equal(store.loadThinkingProvenance(hash(1)), "deepseek");
    store.saveThinkingProvenance({ hash: hash(1), sourceId: "workstation" });
    assert.equal(store.loadThinkingProvenance(hash(1)), "deepseek", "the first writer wins");
    assert.equal(store.countThinkingProvenance(), 1);

    for (const bad of ["", "xyz", "ABCDEF0123456789", "a".repeat(15), "a".repeat(65), "0123456789abcdef'; --", 7]) {
      assert.throws(() => store.saveThinkingProvenance({ hash: bad as never, sourceId: "s" }), failure("domain_operation_rejected"), String(bad));
      assert.throws(() => store.loadThinkingProvenance(bad as never), failure("domain_operation_rejected"), String(bad));
    }
    for (const bad of ["", "x".repeat(65)]) {
      assert.throws(() => store.saveThinkingProvenance({ hash: hash(2), sourceId: bad }), failure("domain_operation_rejected"));
    }

    for (let n = 2; n <= 25; n += 1) store.saveThinkingProvenance({ hash: hash(n), sourceId: n % 2 === 0 ? "deepseek" : "workstation" });
    assert.equal(store.countThinkingProvenance(), 25);
    assert.equal(store.pruneThinkingProvenance(10), 15);
    assert.equal(store.countThinkingProvenance(), 10);
    assert.equal(store.loadThinkingProvenance(hash(25)), "workstation", "the newest rows stay");
    assert.equal(store.loadThinkingProvenance(hash(16)), "deepseek");
    assert.equal(store.loadThinkingProvenance(hash(15)), undefined, "the oldest rows go");
    assert.equal(store.loadThinkingProvenance(hash(1)), undefined);
    assert.equal(store.pruneThinkingProvenance(10), 0);
    assert.equal(store.pruneThinkingProvenance(0), 10);
    assert.equal(store.countThinkingProvenance(), 0);
    assert.throws(() => store.pruneThinkingProvenance(-1), failure("domain_operation_rejected"));
    assert.throws(() => store.pruneThinkingProvenance(1.5), failure("domain_operation_rejected"));
    store.close();
  });

  it("keeps thinking provenance rows of a deleted source so its signatures stay foreign", (t) => {
    const path = temporaryDatabase(t);
    const store = openGuildPersistence({ path });
    store.upsertModelSource(deepseek);
    store.saveThinkingProvenance({ hash: "0123456789abcdef0123456789abcdef", sourceId: "deepseek" });
    store.deleteModelSource("deepseek");
    assert.equal(store.loadThinkingProvenance("0123456789abcdef0123456789abcdef"), "deepseek");
    store.close();
  });

  // A v18 install: v19 artifacts removed, the two rebuilt tables back in their v18 shape.
  function downgradeToV18(path: string): void {
    withRaw(path, (raw) => {
      raw.exec(`
        PRAGMA foreign_keys = OFF;
        ${REMOVE_V19_SQL}
        CREATE TABLE runtime_model_catalog_v18 (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          catalog_json TEXT NOT NULL CHECK(length(catalog_json) BETWEEN 2 AND 262144),
          runtime_version TEXT CHECK(runtime_version IS NULL OR length(runtime_version) BETWEEN 1 AND 128),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
        ) STRICT;
        INSERT INTO runtime_model_catalog_v18(singleton, catalog_json, runtime_version, updated_at_ms)
        SELECT 1, catalog_json, runtime_version, updated_at_ms FROM runtime_model_catalog WHERE engine = 'grok';
        DROP TABLE runtime_model_catalog;
        ALTER TABLE runtime_model_catalog_v18 RENAME TO runtime_model_catalog;
        CREATE TABLE task_runtime_settings_v18 (
          task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE RESTRICT,
          model_id TEXT CHECK(model_id IS NULL OR (
            length(model_id) BETWEEN 1 AND 64
            AND model_id GLOB 'grok-*'
            AND model_id NOT GLOB '*[^A-Za-z0-9._:-]*'
          )),
          reasoning_effort TEXT CHECK(reasoning_effort IS NULL OR (
            length(reasoning_effort) BETWEEN 1 AND 32
            AND reasoning_effort GLOB '[a-z]*'
            AND reasoning_effort NOT GLOB '*[^a-z0-9_-]*'
          )),
          context_window INTEGER CHECK(context_window IS NULL OR context_window BETWEEN 1 AND 100000000),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
        ) STRICT;
        INSERT INTO task_runtime_settings_v18(task_id, model_id, reasoning_effort, context_window, revision, updated_at_ms)
        SELECT task_id, model_id, reasoning_effort, context_window, revision, updated_at_ms FROM task_runtime_settings;
        DROP TABLE task_runtime_settings;
        ALTER TABLE task_runtime_settings_v18 RENAME TO task_runtime_settings;
        CREATE TABLE guild_meta_v18 (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          schema_version INTEGER NOT NULL CHECK(schema_version = 18),
          clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0, 1)),
          last_integrity_at_ms INTEGER CHECK(last_integrity_at_ms IS NULL OR last_integrity_at_ms >= 0)
        ) STRICT;
        INSERT INTO guild_meta_v18(singleton, schema_version, clean_shutdown, last_integrity_at_ms)
        SELECT singleton, 18, clean_shutdown, last_integrity_at_ms FROM guild_meta;
        DROP TABLE guild_meta;
        ALTER TABLE guild_meta_v18 RENAME TO guild_meta;
        PRAGMA user_version = 18;
      `);
    });
  }

  it("migrates a v18 database forward and keeps every existing task, setting, catalog and override", (t) => {
    const path = temporaryDatabase(t);
    const legacy = liveReadyStore(path);
    legacy.createConversationEntry({ taskId, entryId: "history-1", kind: "user", runId, text: "old", status: "complete" });
    legacy.createConversationTask({ taskId: must(parseTaskId("task-2")), workspaceId, title: "Second", owningWindowId: windowId });
    const settings = legacy.updateAppSettings({
      expectedRevision: legacy.loadAppSettings().revision,
      grokModel: "grok-4.7",
      reasoningEffort: "high",
      permissionMode: "plan",
      nickname: "Owner",
    });
    legacy.saveTaskRuntimeSettings({
      taskId, expectedRevision: 0, modelId: "grok-4.5", reasoningEffort: "low", contextWindow: 256_000,
    });
    const catalog = freezeGrokModelCatalog({
      runtimeDefaultModelId: "grok-4.7",
      models: [
        { id: "grok-4.7", name: "Grok 4.7", reasoningEfforts: [{ id: "high", label: "High", isDefault: true }], contextWindows: [256_000] },
        { id: "grok-4.5", name: "Grok 4.5", reasoningEfforts: [], contextWindows: [256_000] },
      ],
    });
    legacy.saveModelCatalogCache({ catalog, runtimeVersion: "0.1.231" });
    const taskBefore = legacy.loadTaskMetadata(taskId);
    const savedOverride = legacy.loadTaskRuntimeSettings(taskId)!;
    legacy.close();
    downgradeToV18(path);

    withRaw(path, (raw) => {
      // The fixture really looks like v18: no engine column, the singleton catalog, no new tables.
      assert.equal(raw.prepare("PRAGMA user_version").get()?.["user_version"], 18);
      assert.equal(raw.prepare("SELECT count(*) AS n FROM pragma_table_info('task_metadata') WHERE name IN ('engine', 'routed_at_ms')").get()?.["n"], 0);
      assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('model_sources', 'workspace_prefs', 'thinking_provenance')").get()?.["n"], 0);
    });

    const migrated = openGuildPersistence({ path });
    assert.equal(migrated.verifyIntegrity().schemaVersion, 19);
    // Tasks: same rows, all on the Grok engine, none routed.
    const taskAfter = migrated.loadTaskMetadata(taskId);
    assert.deepEqual({ ...taskAfter, engine: undefined, routedAtMs: undefined }, { ...taskBefore, engine: undefined, routedAtMs: undefined });
    assert.equal(taskAfter.engine, "grok");
    assert.equal(taskAfter.routedAtMs, undefined);
    assert.equal(migrated.loadTaskEngine(must(parseTaskId("task-2"))), "grok");
    assert.equal(migrated.loadConversationEntry(taskId, "history-1").text, "old");
    assert.equal(migrated.loadRun(taskId, runId).state, "running");
    // Settings: the global pair, every other field and the revision are kept; the new defaults follow the runtime.
    const after = migrated.loadAppSettings();
    assert.equal(after.grokModel, "grok-4.7");
    assert.equal(after.reasoningEffort, "high");
    assert.equal(after.permissionMode, "plan");
    assert.equal(after.nickname, "Owner");
    assert.equal(after.revision, settings.revision);
    assert.equal(after.updatedAtMs, settings.updatedAtMs);
    assert.equal(after.claudeModel, null);
    assert.equal(after.claudeEffort, null);
    assert.equal(after.claudePermissionMode, "default");
    // The per-task override and the cached list survive; the cache becomes the Grok entry.
    assert.deepEqual(migrated.loadTaskRuntimeSettings(taskId), savedOverride);
    assert.deepEqual(migrated.loadModelCatalogCache()?.catalog, catalog);
    assert.equal(migrated.loadModelCatalogCache()?.runtimeVersion, "0.1.231");
    assert.equal(migrated.loadModelCatalogCache("claude"), undefined);
    // The new surface works on the migrated database.
    assert.deepEqual(migrated.listModelSources(), []);
    assert.equal(migrated.upsertModelSource(deepseek).needsConfirmation, true);
    assert.equal(migrated.saveWorkspacePrefs({ workspaceId, onlineReminderDismissed: true }).onlineReminderDismissed, true);
    assert.throws(
      () => migrated.setTaskEngine({ taskId, expectedRevision: taskAfter.revision, engine: "claude" }),
      failure("domain_operation_rejected"),
      "an existing task that already ran keeps its engine",
    );
    const second = must(parseTaskId("task-2"));
    assert.equal(migrated.setTaskEngine({ taskId: second, expectedRevision: migrated.loadTaskMetadata(second).revision, engine: "claude" }).engine, "claude");
    migrated.close();

    withRaw(path, (raw) => {
      assert.deepEqual(
        raw.prepare("SELECT version, name FROM schema_migrations WHERE version >= 17 ORDER BY version").all().map((row) => ({ ...row })),
        [
          { version: 17, name: "steer_interjections_and_run_checkpoints" },
          { version: 18, name: "task_worktrees" },
          { version: 19, name: "dual_engine_and_model_sources" },
        ],
      );
      assert.equal(raw.prepare("PRAGMA user_version").get()?.["user_version"], 19);
      assert.deepEqual(
        raw.prepare("SELECT schema_version FROM guild_meta").all().map((row) => row["schema_version"]),
        [19],
      );
      assert.deepEqual(
        raw.prepare("SELECT engine FROM runtime_model_catalog").all().map((row) => row["engine"]),
        ["grok"],
      );
      const strictByTable = new Map(raw.prepare("PRAGMA table_list").all().map((row) => [row["name"], row["strict"]]));
      for (const table of ["task_runtime_settings", "runtime_model_catalog", "model_sources", "workspace_prefs", "thinking_provenance"]) {
        assert.equal(strictByTable.get(table), 1, `${table} must be STRICT`);
      }
    });
  });

  it("migrates a v18 database that never saved a catalog or an override", (t) => {
    const path = temporaryDatabase(t);
    const legacy = conversationStore(path);
    legacy.close();
    downgradeToV18(path);
    const migrated = openGuildPersistence({ path });
    assert.equal(migrated.loadModelCatalogCache(), undefined);
    assert.equal(migrated.loadTaskRuntimeSettings(taskId), undefined);
    assert.equal(migrated.loadTaskEngine(taskId), "grok");
    assert.equal(migrated.verifyIntegrity().schemaVersion, 19);
    migrated.close();
  });

  it("refuses a database from a newer schema", (t) => {
    const path = temporaryDatabase(t);
    conversationStore(path).close();
    withRaw(path, (raw) => raw.exec("PRAGMA user_version = 20"));
    assert.throws(() => openGuildPersistence({ path }), failure("schema_version_unsupported"));
  });
});
