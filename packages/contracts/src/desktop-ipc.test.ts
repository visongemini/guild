import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_IPC_CHANNELS,
  GUILD_GROK_MODELS,
  GUILD_GROK_PERMISSION_MODES,
  GUILD_MAX_MESSAGE_LENGTH,
  parseDesktopRequest,
  parseGuildGrokModel,
  parseGuildGrokPermissionMode,
  parseGuildGrokReasoningEffort,
  parseGuildLocale,
  parseGuildNickname,
} from "./desktop-ipc.js";

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

test("runtime settings expose only official Grok models and valid effort pairs", () => {
  assert.deepEqual(GUILD_GROK_MODELS.map((model) => model.id), [
    "grok-4.6",
    "grok-4.5",
  ]);
  assert.equal(parseGuildGrokModel("grok-4.6"), "grok-4.6");
  assert.equal(parseGuildGrokReasoningEffort("medium"), "medium");
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
  for (const rejected of ["MiniMax-M3", "ornith-1.5-35b-a3b-unc", "grok-custom"]){
    assert.throws(() => parseGuildGrokModel(rejected));
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
  assert.throws(() =>
    parseDesktopRequest(DESKTOP_IPC_CHANNELS.setRuntimeSettings, {
      model: "grok-4.5",
      reasoningEffort: "xhigh",
      permissionMode: "default",
      startup: {
        webSearchEnabled: true,
        planEnabled: true,
        subagentsEnabled: true,
        maxTurns: null,
      },
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
