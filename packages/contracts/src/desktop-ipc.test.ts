import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  GUILD_STREAM_DELTA_LIMITS,
  GUILD_GROK_PERMISSION_MODES,
  GUILD_MAX_MESSAGE_LENGTH,
  parseDesktopRequest,
  parseGuildGrokPermissionMode,
  parseGuildLocale,
  parseGuildNickname,
  parseStreamDeltaEvent,
} from "./desktop-ipc.js";
import { parseGuildGrokModel, parseGuildGrokReasoningEffort } from "./grok-models.js";

test("desktop IPC accepts only closed request shapes", () => {
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
      taskId: "task-1",
      text: "hello",
      attachments: [{
        relativePath: "docs/README.md",
        name: "README.md",
        size: 42,
        mimeType: "text/markdown",
      }],
    }),
    {
      taskId: "task-1",
      text: "hello",
      attachments: [{
        relativePath: "docs/README.md",
        name: "README.md",
        size: 42,
        mimeType: "text/markdown",
      }],
    },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
      taskId: "task-1",
      text: "ship the complete release",
      mode: "continuous",
    }),
    { taskId: "task-1", text: "ship the complete release", mode: "continuous" },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setContinuousTask, {
      taskId: "task-1",
      action: "pause",
    }),
    { taskId: "task-1", action: "pause" },
  );
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
    taskId: "task-1",
    text: "ship",
    mode: "goal",
  }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setContinuousTask, {
    taskId: "task-1",
    action: "restart",
  }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
    taskId: "task-1",
    text: "hello",
    attachments: [{ relativePath: "../secret.txt", name: "secret.txt", size: 1 }],
  }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
    taskId: "task-1",
    text: "hello",
    attachments: [{ relativePath: "docs/a.txt", name: "wrong.txt", size: 1 }],
  }));
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
      taskId: "task-1",
      text: "hello",
      channel: "anything",
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.forkTask, {
      taskId: "task-1",
      throughSequence: 7,
    }),
    { taskId: "task-1", throughSequence: 7 },
  );
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.forkTask, {
    taskId: "task-1",
    throughSequence: 0,
  }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.forkTask, {
    taskId: "task-1",
    throughSequence: 1.5,
  }));
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.updateTask, {
      taskId: "task-1",
      action: "rename",
      title: "  新标题  ",
    }),
    { taskId: "task-1", action: "rename", title: "新标题" },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.updateTask, {
      taskId: "task-1",
      action: "pin",
    }),
    { taskId: "task-1", action: "pin" },
  );
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.updateTask, {
    taskId: "task-1",
    action: "rename",
    title: "bad\nname",
  }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.updateTask, {
    taskId: "task-1",
    action: "pin",
    title: "smuggled",
  }));
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
      taskId: "task-1",
      text: "   ",
    }),
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.sendMessage, {
      taskId: "task-1",
      text: "x".repeat(GUILD_MAX_MESSAGE_LENGTH + 1),
    }),
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setDraft, {
      taskId: "task-1",
      text: "x".repeat(GUILD_MAX_MESSAGE_LENGTH + 1),
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setDraft, {
      taskId: "task-1",
      text: "",
    }),
    { taskId: "task-1", text: "" },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setDraft, {
      taskId: "task-1",
      text: "draft",
      revision: 1,
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.prioritizeQueuedTurn, {
      taskId: "task-1",
      queueId: "queue-2",
    }),
    { taskId: "task-1", queueId: "queue-2" },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.prioritizeQueuedTurn, {
      taskId: "task-1",
      queueId: "queue-2",
      position: 0,
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.preemptQueuedTurn, {
      taskId: "task-1",
      queueId: "queue-2",
    }),
    { taskId: "task-1", queueId: "queue-2" },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.preemptQueuedTurn, {
      taskId: "task-1",
      queueId: "queue-2",
      runId: "run-stale",
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.cancelQueuedTurn, {
      taskId: "task-1",
      queueId: "queue-1",
    }),
    { taskId: "task-1", queueId: "queue-1" },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.cancelQueuedTurn, {
      taskId: "task-1",
      queueId: "queue-1",
      runId: "run-1",
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.loadEarlierTimeline, {
      taskId: "task-1",
    }),
    { taskId: "task-1" },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.loadEarlierTimeline, {
      taskId: "task-1",
      beforeSequence: 500,
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.loadSlashCommands, {
      taskId: "task-1",
    }),
    { taskId: "task-1" },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.loadSlashCommands, {
      taskId: "task-1",
      command: "context",
    }),
  );
});

test("Grok management IPC is an allowlisted typed surface", () => {
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.runGrokManagement, {
      action: "mcp_add",
      taskId: "task-1",
      parameters: {
        name: "sentry",
        transport: "http",
        endpoint: "https://mcp.example.test/mcp",
        headers: ["Authorization: Bearer secret"],
      },
    }),
    {
      action: "mcp_add",
      taskId: "task-1",
      parameters: {
        name: "sentry",
        transport: "http",
        endpoint: "https://mcp.example.test/mcp",
        headers: ["Authorization: Bearer secret"],
      },
    },
  );
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.runGrokManagement, {
    action: "agent_serve",
  }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.runGrokManagement, {
    action: "version",
    parameters: { argv: ["agent", "serve"] },
  }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.runGrokManagement, {
    action: "version",
    parameters: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`p${index}`, "x"])),
  }));
});

test("permission decisions cannot smuggle an option into cancellation", () => {
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.decidePermission, {
      taskId: "task-1",
      runId: "run-1",
      permissionId: "permission-1",
      decision: { type: "cancelled", optionId: "allow" },
    }),
  );
});

test("locale and sidebar width validation are bounded", () => {
  assert.equal(parseGuildLocale("zh-CN"), "zh-CN");
  assert.equal(parseGuildLocale("en-US"), "en-US");
  assert.throws(() => parseGuildLocale("zh"));
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setSidebarWidth, { width: 331.6 }),
    { width: 332 },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setSidebarWidth, { width: 1000 }),
  );
});

test("runtime settings accept advertised model ids as bounded identifiers, not an enum", () => {
  assert.equal(parseGuildGrokModel("grok-4.6"), "grok-4.6");
  assert.equal(parseGuildGrokModel("grok-4.7-build-fast"), "grok-4.7-build-fast");
  assert.equal(parseGuildGrokModel("grok-5.0-preview"), "grok-5.0-preview");
  assert.equal(parseGuildGrokReasoningEffort("medium"), "medium");
  assert.equal(parseGuildGrokReasoningEffort("ultra"), "ultra");
  assert.deepEqual(GUILD_GROK_PERMISSION_MODES, [
    "default",
    "acceptEdits",
    "auto",
    "dontAsk",
    "bypassPermissions",
    "plan",
  ]);
  assert.equal(parseGuildGrokPermissionMode("bypassPermissions"), "bypassPermissions");
  assert.equal(parseGuildGrokPermissionMode("acceptEdits"), "acceptEdits");
  assert.equal(parseGuildGrokPermissionMode("auto"), "auto");
  assert.equal(parseGuildGrokPermissionMode("dontAsk"), "dontAsk");
  assert.equal(parseGuildGrokPermissionMode("plan"), "plan");
  assert.throws(() => parseGuildGrokPermissionMode("always-approve"));
  for (const rejected of [
    "MiniMax-M3", "ornith-1.5-35b-a3b-unc", "", " grok-4.7", "grok-4.7 ", "grok-4.7;rm -rf",
    "../grok-4.7", "grok-4.7\n", `grok-${"x".repeat(64)}`, 4.7, null, undefined, {},
  ]) {
    assert.throws(() => parseGuildGrokModel(rejected), /invalid_grok_model/u);
  }
  for (const rejected of ["", "High", "x high", "a".repeat(33), 3, null, "-low"]) {
    assert.throws(() => parseGuildGrokReasoningEffort(rejected), /invalid_grok_reasoning_effort/u);
  }
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: "grok-4.5",
      reasoningEffort: "high",
      permissionMode: "bypassPermissions",
      startup: {
        webSearchEnabled: true,
        planEnabled: false,
        subagentsEnabled: true,
        maxTurns: 240,
      },
    }),
    {
      model: "grok-4.5",
      reasoningEffort: "high",
      permissionMode: "bypassPermissions",
      startup: {
        webSearchEnabled: true,
        planEnabled: false,
        subagentsEnabled: true,
        maxTurns: 240,
      },
    },
  );
  const startup = { webSearchEnabled: true, planEnabled: true, subagentsEnabled: true, maxTurns: null };
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: null, reasoningEffort: null, permissionMode: "default", startup,
    }),
    { model: null, reasoningEffort: null, permissionMode: "default", startup },
    "null follows the runtime default",
  );
  assert.throws(
    () => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: null, reasoningEffort: "high", permissionMode: "default", startup,
    }),
    /invalid_grok_model/u,
    "an effort without a model is ambiguous",
  );
  assert.throws(
    () => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: "grok-4.7", reasoningEffort: "high", permissionMode: "default", startup, extra: 1,
    }),
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: "grok-4.6",
      reasoningEffort: "xhigh",
      permissionMode: "default",
      startup: {
        webSearchEnabled: true,
        planEnabled: true,
        subagentsEnabled: true,
        maxTurns: 0,
      },
    }),
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: "MiniMax-M3",
      reasoningEffort: "high",
      permissionMode: "default",
    }),
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: "grok-4.6",
      reasoningEffort: "xhigh",
      permissionMode: "allow-all",
    }),
  );
});

test("external navigation accepts credential-free HTTPS and loopback HTTP URLs", () => {
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.openExternal, {
      url: "https://grok.com/?_s=usage",
    }),
    { url: "https://grok.com/?_s=usage" },
  );
  for (const url of [
    "http://127.0.0.1:4176/",
    "http://localhost:3000/path",
    "http://[::1]:8080/",
  ]) {
    assert.deepEqual(
      parseDesktopRequest(DESKTOP_IPC_CHANNELS.openExternal, { url }),
      { url },
    );
  }
  for (const url of [
    "http://example.com",
    "file:///tmp/a",
    "https://user:secret@example.com/",
    "http://user:secret@127.0.0.1:4176/",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.throws(() =>
      parseDesktopRequest(DESKTOP_IPC_CHANNELS.openExternal, { url }),
    );
  }
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.refreshUsage, {}),
    {},
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.refreshUsage, { force: true }),
  );

  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.authorizeSessionReplacement, {
      taskId: "task-1",
    }),
    { taskId: "task-1" },
  );
});

test("profile and general settings stay closed and validate nicknames", () => {
  assert.equal(parseGuildNickname(" BDV "), "BDV");
  assert.equal(parseGuildNickname("庄松"), "庄松");
  assert.throws(() => parseGuildNickname(""));
  assert.throws(() => parseGuildNickname("   "));
  assert.throws(() => parseGuildNickname("line\nbreak"));
  assert.throws(() => parseGuildNickname("a".repeat(33)));
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.saveProfile, {
      nickname: "  BDV  ",
      avatar: "keep",
    }),
    { nickname: "BDV", avatar: "keep" },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setGeneralSettings, {
      restoreLastTask: true,
      newTaskWorkspaceMode: "last",
      browserSyncEnabled: false,
      taskNotificationsEnabled: true,
    }),
    {
      restoreLastTask: true,
      newTaskWorkspaceMode: "last",
      browserSyncEnabled: false,
      taskNotificationsEnabled: true,
    },
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.saveProfile, {
      nickname: "\nBDV",
      avatar: "reset",
    }),
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setGeneralSettings, {
      restoreLastTask: true,
      newTaskWorkspaceMode: "always",
      browserSyncEnabled: false,
      taskNotificationsEnabled: true,
    }),
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.chooseAvatar, {}),
    {},
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.openUserData, {}),
    {},
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.openRuntimeDiagnostics, {}),
    {},
  );
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.openRuntimeDiagnostics, { path: "/tmp" }),
  );
});

const validDelta = Object.freeze({
  taskId: "task-1",
  runId: "run-1",
  entryId: "assistant-1",
  kind: "assistant",
  offset: 0,
  appendText: "hello",
  revision: 1,
  updatedAtMs: 1_700_000_000_000,
});

test("stream delta channel is registered once and is a main-to-renderer event", () => {
  assert.equal(DESKTOP_IPC_CHANNELS.streamDelta, "guild:v1:event:stream-delta");
  assert.ok(DESKTOP_EVENT_CHANNELS.includes(DESKTOP_IPC_CHANNELS.streamDelta));
  assert.ok(DESKTOP_EVENT_CHANNELS.includes(DESKTOP_IPC_CHANNELS.projectionChanged));
  assert.equal(new Set(DESKTOP_EVENT_CHANNELS).size, DESKTOP_EVENT_CHANNELS.length);
  const registered = Object.values(DESKTOP_IPC_CHANNELS);
  assert.equal(new Set(registered).size, registered.length, "channel strings are unique");
  for (const channel of registered) assert.match(channel, /^guild:v1:[a-z-]+(?::[a-z-]+)*$/u);
  // An event channel is never accepted as a renderer request.
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.streamDelta as never, {}));
});

test("stream delta validation accepts exactly the closed event shape", () => {
  const parsed = parseStreamDeltaEvent({ ...validDelta });
  assert.deepEqual(parsed, validDelta);
  assert.equal(Object.isFrozen(parsed), true);
  const { runId: _runId, ...withoutRun } = validDelta;
  assert.deepEqual(parseStreamDeltaEvent(withoutRun), withoutRun);
  assert.equal(parseStreamDeltaEvent({ ...validDelta, kind: "thought" }).kind, "thought");
  assert.equal(
    parseStreamDeltaEvent({ ...validDelta, appendText: "你好\u{1F600}" }).appendText,
    "你好\u{1F600}",
  );
});

test("stream delta validation rejects unknown, malformed, and oversized events", () => {
  const bad = (patch: Record<string, unknown>) =>
    assert.throws(() => parseStreamDeltaEvent({ ...validDelta, ...patch }), TypeError, JSON.stringify(patch));
  bad({ extra: true });
  bad({ kind: "tool" });
  bad({ kind: "user" });
  bad({ taskId: "" });
  bad({ taskId: 7 });
  bad({ runId: "" });
  bad({ runId: undefined });
  bad({ entryId: "" });
  bad({ entryId: "e".repeat(513) });
  bad({ offset: -1 });
  bad({ offset: 1.5 });
  bad({ offset: GUILD_STREAM_DELTA_LIMITS.maxOffset + 1 });
  bad({ offset: Number.NaN });
  bad({ offset: Number.POSITIVE_INFINITY });
  bad({ revision: 0 });
  bad({ revision: "1" });
  bad({ updatedAtMs: -1 });
  bad({ appendText: "" });
  bad({ appendText: "a\0b" });
  bad({ appendText: 12 });
  bad({ appendText: "x".repeat(GUILD_STREAM_DELTA_LIMITS.maxAppendTextLength + 1) });
  const largest = "x".repeat(GUILD_STREAM_DELTA_LIMITS.maxAppendTextLength);
  assert.equal(parseStreamDeltaEvent({ ...validDelta, appendText: largest }).appendText.length, largest.length);
  const missing = { ...validDelta } as Record<string, unknown>;
  delete missing["entryId"];
  assert.throws(() => parseStreamDeltaEvent(missing), TypeError);
  assert.throws(() => parseStreamDeltaEvent(null), TypeError);
  assert.throws(() => parseStreamDeltaEvent([validDelta]), TypeError);
  assert.throws(() => parseStreamDeltaEvent("delta"), TypeError);
  assert.throws(() => parseStreamDeltaEvent(Object.create({ ...validDelta })), TypeError);
  const symbolKeyed = { ...validDelta, [Symbol("x")]: 1 };
  assert.throws(() => parseStreamDeltaEvent(symbolKeyed), TypeError);
});

test("per-task runtime settings parse a pinned pair, a full clear, and nothing in between", () => {
  const taskId = "task-1";
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, {
      taskId, model: "grok-4.7-build-fast", reasoningEffort: "low",
    }),
    { taskId, model: "grok-4.7-build-fast", reasoningEffort: "low" },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, {
      taskId, model: "grok-4.7", reasoningEffort: "high", contextWindow: 500_000,
    }),
    { taskId, model: "grok-4.7", reasoningEffort: "high", contextWindow: 500_000 },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, {
      taskId, model: null, reasoningEffort: null, contextWindow: null,
    }),
    { taskId, model: null, reasoningEffort: null, contextWindow: null },
  );
  for (const rejected of [
    { taskId, model: null, reasoningEffort: "low" },
    { taskId, model: null, reasoningEffort: null, contextWindow: 256_000 },
    { taskId, model: "Mini Max/M3", reasoningEffort: null },
    { taskId, model: "x".repeat(129), reasoningEffort: null },
    { taskId, model: "grok-4.7", reasoningEffort: "Low Effort" },
    { taskId, model: "grok-4.7", reasoningEffort: null, contextWindow: 0 },
    { taskId, model: "grok-4.7", reasoningEffort: null, contextWindow: 1.5 },
    { taskId, model: "grok-4.7", reasoningEffort: null, extra: true },
    { model: "grok-4.7", reasoningEffort: null },
    { taskId: "", model: "grok-4.7", reasoningEffort: null },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, rejected));
  }
});

test("a per-task model request takes the wider id grammar; the task's own engine decides at main and the store [PC-MODEL-001]", () => {
  const taskId = "task-1";
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, {
      taskId, model: "claude-fable-5-1[1m]", reasoningEffort: "max",
    }),
    { taskId, model: "claude-fable-5-1[1m]", reasoningEffort: "max" },
  );
  for (const model of ["opus", "deepseek-v4-flash", "local-27b-model", "grok-4.7"]) {
    assert.equal(
      (parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, { taskId, model, reasoningEffort: null }) as { model: string }).model,
      model,
    );
  }
  for (const model of ["", "a b", "a/b", "-opus", "x".repeat(129), 4]) {
    assert.throws(
      () => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, { taskId, model, reasoningEffort: null }),
      TypeError,
      String(model),
    );
  }
  // The global Grok defaults stay Grok-only.
  assert.throws(() => parseGuildGrokModel("claude-opus-5-5"), /invalid_grok_model/u);
});

test("Steer, rewind and run diff requests accept only their exact shape [F4, F2]", () => {
  const taskId = "task-1";
  const runId = "run-1";
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.steerMessage, { taskId, text: "go left\nthen right" }),
    { taskId, text: "go left\nthen right" },
  );
  for (const rejected of [
    { taskId, text: "" },
    { taskId, text: "   \n" },
    { taskId, text: "x".repeat(200_001) },
    { taskId, text: "a\0b" },
    { taskId, text: "hi", attachments: [] },
    { taskId, text: "hi", mode: "continuous" },
    { taskId: "", text: "hi" },
    { text: "hi" },
    null,
    "hi",
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.steerMessage, rejected), TypeError, JSON.stringify(rejected));
  }

  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer, { taskId, queueId: "queue-7" }),
    { taskId, queueId: "queue-7" },
  );
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer, { taskId, queueId: "" }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer, { taskId, queueId: "q", text: "x" }));

  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.previewRewind, { taskId, runId }),
    { taskId, runId },
  );
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.previewRewind, { taskId, runId, scope: "files_only" }));
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.previewRewind, { taskId }));

  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.executeRewind, { taskId, runId }),
    { taskId, runId },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.executeRewind, {
      taskId, runId, scope: "files_only", overwriteConflicts: true,
    }),
    { taskId, runId, scope: "files_only", overwriteConflicts: true },
  );
  for (const rejected of [
    { taskId, runId, scope: "everything" },
    { taskId, runId, scope: 1 },
    { taskId, runId, overwriteConflicts: "yes" },
    { taskId, runId, force: true },
    { taskId },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.executeRewind, rejected), TypeError, JSON.stringify(rejected));
  }

  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.loadRunFileDiff, { taskId, runId, path: "src/dir/a.ts" }),
    { taskId, runId, path: "src/dir/a.ts" },
  );
  for (const path of ["", "/etc/passwd", "\\windows", "../x", "a/../b", "a/..", "x".repeat(4_097), "a\0b"]) {
    assert.throws(
      () => parseDesktopRequest(DESKTOP_IPC_CHANNELS.loadRunFileDiff, { taskId, runId, path }),
      TypeError,
      JSON.stringify(path),
    );
  }
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.loadRunFileDiff, { taskId, runId, path: "a", oldPath: "b" }));
});

test("the new request channels are registered invoke channels and unknown names stay denied [F4, F2]", () => {
  for (const channel of [
    DESKTOP_IPC_CHANNELS.steerMessage,
    DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer,
    DESKTOP_IPC_CHANNELS.previewRewind,
    DESKTOP_IPC_CHANNELS.executeRewind,
    DESKTOP_IPC_CHANNELS.loadRunFileDiff,
  ]) {
    assert.match(channel, /^guild:v1:(run|queue):/u);
    assert.equal((DESKTOP_EVENT_CHANNELS as readonly string[]).includes(channel), false);
  }
  assert.throws(
    () => parseDesktopRequest("guild:v1:run:rewind:undo-everything" as never, { taskId: "task-1" }),
    /unregistered_channel/u,
  );
  assert.equal(new Set(Object.values(DESKTOP_IPC_CHANNELS)).size, Object.values(DESKTOP_IPC_CHANNELS).length, "no channel name is reused");
});

test("createTask accepts an optional worktree isolation and nothing else [F3]", () => {
  const workspaceId = "workspace-1";
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.createTask, { workspaceId }),
    { workspaceId },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.createTask, { workspaceId, isolation: "worktree" }),
    { workspaceId, isolation: "worktree" },
  );
  for (const rejected of [
    { workspaceId, isolation: "container" },
    { workspaceId, isolation: "" },
    { workspaceId, isolation: true },
    { workspaceId, isolation: null },
    { workspaceId, isolation: "worktree", branch: "guild/x" },
    { workspaceId, path: "/tmp/x" },
    { isolation: "worktree" },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.createTask, rejected), TypeError, JSON.stringify(rejected));
  }
});

test("worktree requests take a task id and nothing a renderer could aim at a path, branch or revision [F3]", () => {
  const taskId = "task-1";
  for (const channel of [
    DESKTOP_IPC_CHANNELS.previewWorktreeApply,
    DESKTOP_IPC_CHANNELS.applyWorktree,
    DESKTOP_IPC_CHANNELS.discardWorktree,
  ]) {
    assert.deepEqual(parseDesktopRequest(channel, { taskId }), { taskId });
    for (const rejected of [
      {},
      { taskId: "" },
      { taskId, branch: "guild/other" },
      { taskId, path: "/tmp" },
      { taskId, base: "main" },
      { taskId, force: true },
      { taskId: 1 },
    ]) {
      assert.throws(() => parseDesktopRequest(channel, rejected), TypeError, `${channel} ${JSON.stringify(rejected)}`);
    }
  }
  for (const action of ["folder", "terminal"] as const) {
    assert.deepEqual(
      parseDesktopRequest(DESKTOP_IPC_CHANNELS.openWorktreeResource, { taskId, action }),
      { taskId, action },
    );
  }
  for (const rejected of [
    { taskId },
    { taskId, action: "file" },
    { taskId, action: "folder", path: "/etc" },
    { taskId, action: "Folder" },
    { taskId, action: "../.." },
  ]) {
    assert.throws(
      () => parseDesktopRequest(DESKTOP_IPC_CHANNELS.openWorktreeResource, rejected),
      TypeError,
      JSON.stringify(rejected),
    );
  }
});

test("the worktree channels are registered invoke channels, not events [F3]", () => {
  for (const channel of [
    DESKTOP_IPC_CHANNELS.previewWorktreeApply,
    DESKTOP_IPC_CHANNELS.applyWorktree,
    DESKTOP_IPC_CHANNELS.discardWorktree,
    DESKTOP_IPC_CHANNELS.openWorktreeResource,
  ]) {
    assert.match(channel, /^guild:v1:worktree:/u);
    assert.equal((DESKTOP_EVENT_CHANNELS as readonly string[]).includes(channel), false);
  }
  assert.throws(
    () => parseDesktopRequest("guild:v1:worktree:merge-anything" as never, { taskId: "task-1" }),
    /unregistered_channel/u,
  );
});

test("createTask accepts an optional engine and nothing else new (PC-ENG-001)", () => {
  const workspaceId = "workspace-1";
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.createTask, { workspaceId, engine: "claude" }),
    { workspaceId, engine: "claude" },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.createTask, { workspaceId, engine: "grok", isolation: "worktree" }),
    { workspaceId, isolation: "worktree", engine: "grok" },
  );
  assert.deepEqual(parseDesktopRequest(DESKTOP_IPC_CHANNELS.createTask, { workspaceId }), { workspaceId });
  for (const rejected of [
    { workspaceId, engine: "codex" },
    { workspaceId, engine: "Claude" },
    { workspaceId, engine: "" },
    { workspaceId, engine: null },
    { workspaceId, engine: 1 },
    { workspaceId, engine: "claude", model: "opus" },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.createTask, rejected), TypeError, JSON.stringify(rejected));
  }
});

test("setTaskEngine takes a task id and an engine; the routed marker has no channel [PC-ENG-001, PC-ROUTE-002]", () => {
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskEngine, { taskId: "task-1", engine: "claude" }),
    { taskId: "task-1", engine: "claude" },
  );
  for (const rejected of [
    {},
    { taskId: "task-1" },
    { engine: "claude" },
    { taskId: "task-1", engine: "gemini" },
    { taskId: "", engine: "claude" },
    { taskId: "task-1", engine: "claude", routed: true },
    { taskId: "task-1", engine: "claude", expectedRevision: 1 },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setTaskEngine, rejected), TypeError, JSON.stringify(rejected));
  }
  // markTaskRouted is main-internal: no registered channel carries it.
  assert.equal(Object.keys(DESKTOP_IPC_CHANNELS).some((name) => /routed/iu.test(name)), false);
  assert.equal(Object.values(DESKTOP_IPC_CHANNELS).some((channel) => /routed/iu.test(channel)), false);
});

test("Claude-engine defaults are validated with the Claude grammar and the five Claude modes [PC-SET-002]", () => {
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setClaudeSettings, {
      model: "claude-fable-5-1[1m]", reasoningEffort: "xhigh", permissionMode: "acceptEdits",
    }),
    { model: "claude-fable-5-1[1m]", reasoningEffort: "xhigh", permissionMode: "acceptEdits" },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setClaudeSettings, {
      model: null, reasoningEffort: null, permissionMode: "default",
    }),
    { model: null, reasoningEffort: null, permissionMode: "default" },
    "null follows the adapter default",
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setClaudeSettings, {
      model: null, reasoningEffort: "high", permissionMode: "plan",
    }),
    { model: null, reasoningEffort: "high", permissionMode: "plan" },
    "an effort does not need a pinned model on the Claude engine",
  );
  for (const rejected of [
    { model: "claude opus", reasoningEffort: null, permissionMode: "default" },
    { model: "a/b", reasoningEffort: null, permissionMode: "default" },
    { model: "", reasoningEffort: null, permissionMode: "default" },
    { model: "x".repeat(129), reasoningEffort: null, permissionMode: "default" },
    { model: "opus", reasoningEffort: "High", permissionMode: "default" },
    { model: "opus", reasoningEffort: null, permissionMode: "dontAsk" },
    { model: "opus", reasoningEffort: null, permissionMode: "allow-all" },
    { model: "opus", reasoningEffort: null },
    { model: "opus", permissionMode: "default" },
    { model: "opus", reasoningEffort: null, permissionMode: "default", startup: {} },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setClaudeSettings, rejected), TypeError, JSON.stringify(rejected));
  }
  // The Grok defaults still reject Claude-only values.
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
    model: "opus", reasoningEffort: null, permissionMode: "default",
    startup: { webSearchEnabled: true, planEnabled: true, subagentsEnabled: true, maxTurns: null },
  }), /invalid_grok_model/u);
});

test("model source requests carry no secret and no confirmation a renderer could forge [PC-ROUTE-002]", () => {
  const draft = {
    id: "deepseek",
    kind: "online",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    keyFile: null,
    keyVariable: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }],
    enabled: true,
  };
  assert.deepEqual(parseDesktopRequest(DESKTOP_IPC_CHANNELS.listModelSources, {}), {});
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.listModelSources, { id: "deepseek" }), TypeError);
  assert.deepEqual(parseDesktopRequest(DESKTOP_IPC_CHANNELS.upsertModelSource, draft), draft);
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.upsertModelSource, { ...draft, apiKey: "secret" }), TypeError);
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.upsertModelSource, { ...draft, confirmedHost: "api.deepseek.com" }), TypeError);
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.upsertModelSource, { ...draft, baseUrl: "http://api.deepseek.com" }), TypeError);
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.upsertModelSource, { ...draft, keyVariable: "sk-ant-api03-abcdefghijkl" }), TypeError);
  for (const channel of [DESKTOP_IPC_CHANNELS.deleteModelSource, DESKTOP_IPC_CHANNELS.confirmModelSource, DESKTOP_IPC_CHANNELS.testModelSource]) {
    assert.deepEqual(parseDesktopRequest(channel, { id: "deepseek" }), { id: "deepseek" });
    for (const rejected of [
      {}, { id: "" }, { id: "a b" }, { id: 1 },
      { id: "deepseek", confirmedHost: "api.deepseek.com" },
      { id: "deepseek", host: "evil.example" },
      { id: "deepseek", expectedRevision: 1 },
    ]) {
      assert.throws(() => parseDesktopRequest(channel, rejected), TypeError, `${channel} ${JSON.stringify(rejected)}`);
    }
  }
});

test("workspace prefs requests name a workspace and one boolean [PC-PRIV-001]", () => {
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.getWorkspacePrefs, { workspaceId: "workspace-1" }),
    { workspaceId: "workspace-1" },
  );
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setWorkspacePrefs, { workspaceId: "workspace-1", onlineReminderDismissed: true }),
    { workspaceId: "workspace-1", onlineReminderDismissed: true },
  );
  for (const rejected of [
    {}, { workspaceId: "" }, { workspaceId: 1 },
    { workspaceId: "workspace-1", onlineReminderDismissed: true },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.getWorkspacePrefs, rejected), TypeError, JSON.stringify(rejected));
  }
  for (const rejected of [
    { workspaceId: "workspace-1" },
    { workspaceId: "workspace-1", onlineReminderDismissed: "yes" },
    { workspaceId: "workspace-1", onlineReminderDismissed: 1 },
    { onlineReminderDismissed: true },
    { workspaceId: "workspace-1", onlineReminderDismissed: true, localReminder: false },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.setWorkspacePrefs, rejected), TypeError, JSON.stringify(rejected));
  }
});

test("the browser command channel validates the closed command union; the pane projection is a push event [PC-BROWSER-001]", () => {
  assert.deepEqual(
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.browserCommand, { kind: "navigate", url: "https://example.com" }),
    { kind: "navigate", url: "https://example.com/" },
  );
  assert.deepEqual(parseDesktopRequest(DESKTOP_IPC_CHANNELS.browserCommand, { kind: "takeOver" }), { kind: "takeOver" });
  for (const rejected of [
    {}, { kind: "eval", script: "1" }, { kind: "navigate", url: "file:///etc/passwd" }, { kind: "navigate" },
  ]) {
    assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.browserCommand, rejected), TypeError, JSON.stringify(rejected));
  }
  assert.equal(DESKTOP_IPC_CHANNELS.browserPaneChanged, "guild:v1:event:browser-pane-changed");
  assert.ok(DESKTOP_EVENT_CHANNELS.includes(DESKTOP_IPC_CHANNELS.browserPaneChanged));
  assert.equal((DESKTOP_EVENT_CHANNELS as readonly string[]).includes(DESKTOP_IPC_CHANNELS.browserCommand), false);
  assert.throws(() => parseDesktopRequest(DESKTOP_IPC_CHANNELS.browserPaneChanged as never, { kind: "back" }), /unregistered_channel/u);
  assert.equal(new Set(DESKTOP_EVENT_CHANNELS).size, DESKTOP_EVENT_CHANNELS.length);
});

test("the Guild 3.0 channels are registered, unique invoke channels in the closed table", () => {
  const added = [
    DESKTOP_IPC_CHANNELS.setTaskEngine,
    DESKTOP_IPC_CHANNELS.setClaudeSettings,
    DESKTOP_IPC_CHANNELS.listModelSources,
    DESKTOP_IPC_CHANNELS.upsertModelSource,
    DESKTOP_IPC_CHANNELS.deleteModelSource,
    DESKTOP_IPC_CHANNELS.confirmModelSource,
    DESKTOP_IPC_CHANNELS.testModelSource,
    DESKTOP_IPC_CHANNELS.getWorkspacePrefs,
    DESKTOP_IPC_CHANNELS.setWorkspacePrefs,
    DESKTOP_IPC_CHANNELS.browserCommand,
  ];
  assert.equal(new Set(added).size, added.length);
  for (const channel of added) {
    assert.match(channel, /^guild:v1:[a-z-]+(?::[a-z-]+)*$/u);
    assert.equal((DESKTOP_EVENT_CHANNELS as readonly string[]).includes(channel), false, channel);
  }
  assert.throws(() => parseDesktopRequest("guild:v1:model-sources:reveal-key" as never, { id: "deepseek" }), /unregistered_channel/u);
});
