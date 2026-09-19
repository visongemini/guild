import {
  GUILD_API_VERSION,
  GUILD_GROK_MODELS,
  GUILD_GROK_PERMISSION_MODES,
  GUILD_DEFAULT_GROK_STARTUP_SETTINGS,
  type DesktopBootstrapProjection,
  type GuildLocale,
  type GuildGrokModel,
  type GuildGrokPermissionMode,
  type GuildGrokReasoningEffort,
  type GuildGrokStartupSettings,
  type RunId,
  type TaskId,
  type TaskViewProjection,
  type WorkspaceId,
} from "@guild/contracts";
import type { DesktopApplicationService } from "./application-service.js";

const NOW = new Date("2026-08-27T08:30:00+08:00").getTime();
const SEND_DELAY_MS = boundedFixtureDelay(process.env["GUILD_FIXTURE_SEND_DELAY_MS"]);
const SESSION_REPLACEMENT_REQUIRED =
  process.env["GUILD_FIXTURE_SESSION_REPLACEMENT_REQUIRED"] === "1";
const COMMAND_STATUS_RUNNING = process.env["GUILD_FIXTURE_COMMAND_STATUS"] === "1";
const EMPTY_COMMANDS = process.env["GUILD_FIXTURE_EMPTY_COMMANDS"] === "1";
const STATUS_VARIANTS =
  process.env["GUILD_FIXTURE_UI_STATE"] === "statuses" ||
  process.env["GUILD_FIXTURE_UI_STATE"] === "statuses-narrow";
const WAITING_STATUS = process.env["GUILD_FIXTURE_UI_STATE"] === "waiting";
const RUN_BOUNDARIES = process.env["GUILD_FIXTURE_UI_STATE"] === "run-boundaries";
const RECOVERY_STATE =
  process.env["GUILD_FIXTURE_UI_STATE"] === "recovery" ||
  process.env["GUILD_FIXTURE_UI_STATE"] === "recovery-narrow" ||
  process.env["GUILD_FIXTURE_UI_STATE"] === "recovery-wide";
const QUEUE_PREEMPT_STATE = process.env["GUILD_FIXTURE_UI_STATE"] === "queue-preempt";

export function createFixtureDesktopService(): DesktopApplicationService {
  const listeners = new Set<(projection: DesktopBootstrapProjection) => void>();
  let locale: GuildLocale = "zh-CN";
  let grokModel: GuildGrokModel = "grok-4.6";
  let reasoningEffort: GuildGrokReasoningEffort = "xhigh";
  let permissionMode: GuildGrokPermissionMode = "default";
  let startup: GuildGrokStartupSettings = GUILD_DEFAULT_GROK_STARTUP_SETTINGS;
  let sidebarWidth = 280;
  let nickname = "BDV";
  let restoreLastTask = true;
  let newTaskWorkspaceMode: "ask" | "last" = "ask";
  let browserSyncEnabled = false;
  let taskNotificationsEnabled = true;
  let usage: DesktopBootstrapProjection["usage"] = Object.freeze({
    status: "unavailable",
    reason: "not_reported_by_runtime",
  });
  let activeTask = fixtureTask(
    SESSION_REPLACEMENT_REQUIRED,
    COMMAND_STATUS_RUNNING || STATUS_VARIANTS,
    WAITING_STATUS,
    RUN_BOUNDARIES,
    RECOVERY_STATE,
    QUEUE_PREEMPT_STATE,
  );
  let projection = buildProjection();

  function buildProjection(): DesktopBootstrapProjection {
    const task = activeTask.task;
    return Object.freeze({
      apiVersion: GUILD_API_VERSION,
      appVersion: "2.0.28-dev",
      runtimeVersion: "grok 1.0.13",
      locale,
      runtimeSettings: Object.freeze({
        model: grokModel,
        reasoningEffort,
        permissionMode,
        startup,
        availableModels: GUILD_GROK_MODELS,
        availablePermissionModes: GUILD_GROK_PERMISSION_MODES,
        canChange: true,
      }),
      generalSettings: Object.freeze({
        restoreLastTask,
        newTaskWorkspaceMode,
        taskNotificationsEnabled,
        lastWorkspaceId: "workspace-cowork" as WorkspaceId,
      }),
      profile: Object.freeze({ nickname }),
      sidebarWidth,
      browserSyncEnabled,
      recoveredAfterUncleanShutdown: false,
      workspaces: Object.freeze([
        Object.freeze({
          workspaceId: "workspace-cowork" as WorkspaceId,
          name: "Cowork",
          archived: false,
          tasks: Object.freeze([
            task,
            Object.freeze({
              taskId: "task-bananafit" as TaskId,
              workspaceId: "workspace-cowork" as WorkspaceId,
              title: "看一下 bananafit 这个项目",
              pinned: true,
              archived: false,
              updatedAtMs: NOW - 86_400_000,
            }),
            Object.freeze({
              taskId: "task-intro" as TaskId,
              workspaceId: "workspace-cowork" as WorkspaceId,
              title: "介绍一下你自己",
              pinned: false,
              archived: false,
              updatedAtMs: NOW - 86_400_000,
            }),
            ...(STATUS_VARIANTS ? [
              Object.freeze({
                taskId: "task-queued" as TaskId,
                workspaceId: "workspace-cowork" as WorkspaceId,
                title: "排队等待继续的任务",
                pinned: false,
                archived: false,
                updatedAtMs: NOW - 90_000,
                queuedTurnCount: 2,
              }),
              Object.freeze({
                taskId: "task-permission" as TaskId,
                workspaceId: "workspace-cowork" as WorkspaceId,
                title: "等待确认文件访问",
                pinned: false,
                archived: false,
                updatedAtMs: NOW - 120_000,
                activeRunState: "awaiting_permission" as const,
              }),
              Object.freeze({
                taskId: "task-failed" as TaskId,
                workspaceId: "workspace-cowork" as WorkspaceId,
                title: "需要查看的失败任务",
                pinned: false,
                archived: false,
                updatedAtMs: NOW - 180_000,
                activeRunState: "failed" as const,
              }),
              Object.freeze({
                taskId: "task-interrupted" as TaskId,
                workspaceId: "workspace-cowork" as WorkspaceId,
                title: "休眠后可继续的任务",
                pinned: false,
                archived: false,
                updatedAtMs: NOW - 240_000,
                activeRunState: "interrupted" as const,
              }),
            ] : []),
          ]),
        }),
      ]),
      activeTask,
      usage,
    });
  }

  function publish() {
    projection = buildProjection();
    for (const listener of listeners) listener(projection);
  }

  const service: DesktopApplicationService = {
    bootstrap: async () => projection,
    chooseWorkspace: async () => projection,
    choosePromptFiles: async () => Object.freeze({ status: "cancelled" as const }),
    createTask: async (workspaceId) => {
      activeTask = Object.freeze({
        task: Object.freeze({
          taskId: `task-${Date.now()}` as TaskId,
          workspaceId,
          title: locale === "zh-CN" ? "新任务" : "New task",
          pinned: false,
          archived: false,
          updatedAtMs: Date.now(),
        }),
        timeline: Object.freeze([]),
        hasEarlierTimeline: false,
        queuedTurns: Object.freeze([]),
        draft: "",
        canSend: true,
        sessionRecovery: "available",
        contextWindow: Object.freeze({ status: "unavailable" }),
        availableCommands: Object.freeze([]),
        sessionModes: null,
        sessionConfigOptions: Object.freeze([]),
        workbench: Object.freeze({ files: Object.freeze([]), diffs: Object.freeze([]), terminalObserved: false }),
      });
      publish();
      return activeTask;
    },
    openTask: async (taskId) => {
      if (taskId === activeTask.task.taskId) return activeTask;
      throw new Error("fixture_task_not_found");
    },
    loadEarlierTimeline: async (taskId) => {
      if (taskId === activeTask.task.taskId) return activeTask;
      throw new Error("fixture_task_not_found");
    },
    loadSlashCommands: async (taskId) => {
      if (taskId === activeTask.task.taskId) return activeTask;
      throw new Error("fixture_task_not_found");
    },
    forkTask: async () => activeTask,
    exportTask: async () => Object.freeze({ status: "cancelled" as const }),
    searchConversations: async () => Object.freeze({ results: Object.freeze([]) }),
    openTaskResource: async () => undefined,
    setSessionConfigOption: async () => activeTask,
    updateWorkspace: async () => projection,
    updateTask: async () => projection,
    sendMessage: async (taskId, text) => {
      if (taskId !== activeTask.task.taskId) throw new Error("fixture_task_not_found");
      if (SEND_DELAY_MS > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, SEND_DELAY_MS));
      }
      const runId = `run-${Date.now()}` as RunId;
      activeTask = Object.freeze({
        ...activeTask,
        task: Object.freeze({ ...activeTask.task, activeRunState: "completed", updatedAtMs: Date.now() }),
        timeline: Object.freeze([
          ...activeTask.timeline,
          Object.freeze({
            entryId: `user-${Date.now()}`,
            taskId,
            runId,
            sequence: activeTask.timeline.length + 1,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            status: "completed",
            kind: "user",
            text,
          } as const),
          Object.freeze({
            entryId: `assistant-${Date.now()}`,
            taskId,
            runId,
            sequence: activeTask.timeline.length + 2,
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            status: "completed",
            kind: "assistant",
            text: locale === "zh-CN" ? "这是确定性界面夹具，真实运行时将在主进程服务接入后回复。" : "This is a deterministic UI fixture. The live runtime replies through the main-process service.",
          } as const),
        ]),
      });
      publish();
      return Object.freeze({ status: "started", runId });
    },
    setContinuousTask: async () => activeTask,
    prioritizeQueuedTurn: async () => undefined,
    preemptQueuedTurn: async () => undefined,
    cancelQueuedTurn: async () => undefined,
    cancelRun: async () => undefined,
    decidePermission: async () => undefined,
    setDraft: async (taskId, text) => {
      if (taskId !== activeTask.task.taskId) throw new Error("fixture_task_not_found");
      activeTask = Object.freeze({ ...activeTask, draft: text });
      publish();
    },
    authorizeSessionReplacement: async () => {
      activeTask = Object.freeze({
        ...activeTask,
        canSend: true,
        sessionRecovery: "available",
      });
      publish();
      return activeTask;
    },
    refreshUsage: async () => {
      usage = Object.freeze({
        status: "available",
        usedLabel: locale === "zh-CN" ? "已使用 4%" : "4% used",
        resetsAtIso: "2026-09-01T01:00:29.066410+00:00",
        fetchedAtIso: "2026-08-27T08:30:00.000+08:00",
      });
      publish();
      return projection;
    },
    openExternal: async () => undefined,
    setLocale: async (nextLocale) => {
      locale = nextLocale;
      publish();
      return projection;
    },
    setRuntimeSettings: async (nextModel, nextReasoningEffort, nextPermissionMode, nextStartup) => {
      grokModel = nextModel;
      reasoningEffort = nextReasoningEffort;
      permissionMode = nextPermissionMode;
      startup = nextStartup;
      publish();
      return projection;
    },
    setSidebarWidth: async (width) => {
      sidebarWidth = width;
      publish();
    },
    chooseAvatar: async () => Object.freeze({ status: "cancelled" as const }),
    saveProfile: async (nextNickname) => {
      nickname = nextNickname.trim();
      publish();
      return projection;
    },
    setGeneralSettings: async (nextRestore, nextMode, nextBrowserSync, nextNotifications) => {
      restoreLastTask = nextRestore;
      newTaskWorkspaceMode = nextMode;
      browserSyncEnabled = nextBrowserSync;
      taskNotificationsEnabled = nextNotifications;
      publish();
      return projection;
    },
    openUserData: async () => undefined,
    restoreUserData: async () => Object.freeze({ status: "cancelled" as const }),
    backupUserData: async () => Object.freeze({ status: "cancelled" as const }),
    openRuntimeDiagnostics: async () => undefined,
    runGrokManagement: async (request) => Object.freeze({
      action: request.action,
      commandLabel: `grok ${request.action.replaceAll("_", " ")}`,
      completedAtIso: new Date(NOW).toISOString(),
      durationMs: 42,
      output: "Fixture result: official Grok management action completed.",
      status: "completed" as const,
    }),
    handleLifecycleEvent: async () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => listeners.clear(),
  };

  return Object.freeze(service);
}

function boundedFixtureDelay(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : 0;
}

function fixtureTask(
  replacementRequired = false,
  commandStatusRunning = false,
  waitingForGrok = false,
  runBoundaries = false,
  recoveryState = false,
  queuePreemptState = false,
): TaskViewProjection {
  const taskId = "task-market-review" as TaskId;
  const runId = "run-market-review" as RunId;
  return Object.freeze({
    task: Object.freeze({
      taskId,
      workspaceId: "workspace-cowork" as WorkspaceId,
      title: "评审一下仓库里面最新的持仓",
      pinned: false,
      archived: false,
      updatedAtMs: NOW,
      activeRunState: recoveryState
        ? "interrupted"
        : commandStatusRunning || waitingForGrok || runBoundaries || queuePreemptState
          ? "running"
          : "completed",
      ...(commandStatusRunning || runBoundaries || queuePreemptState ? { activeActivity: "reading" as const } : {}),
    }),
    draft: "",
    canSend: !replacementRequired,
    sessionRecovery: replacementRequired ? "replacement_required" : "available",
    contextWindow: Object.freeze({ status: "available", used: 81_920, size: 262_144 }),
    availableCommands: EMPTY_COMMANDS ? Object.freeze([]) : Object.freeze([
      Object.freeze({ name: "context", description: "显示当前上下文用量" }),
      Object.freeze({ name: "plan", description: "创建实施计划", inputHint: "目标" }),
    ]),
    sessionModes: Object.freeze({
      currentModeId: "xhigh",
      availableModes: Object.freeze([
        Object.freeze({ id: "xhigh", name: "超高" }),
        Object.freeze({ id: "high", name: "高" }),
      ]),
    }),
    sessionConfigOptions: Object.freeze([]),
    workbench: Object.freeze({
      files: Object.freeze([
        Object.freeze({ path: "/Users/example/Workspace/portfolio_report.md", displayPath: "portfolio_report.md", line: 1 }),
      ]),
      diffs: Object.freeze([Object.freeze({ path: "/fixture/Cowork/portfolio_report.md", displayPath: "portfolio_report.md", oldText: "Draft report", newText: "Reviewed report" })]),
      terminalObserved: true,
    }),
    ...(recoveryState ? {
      recentResult: Object.freeze({
        runId: "run-recovery-interrupted" as RunId,
        state: "interrupted" as const,
        workbench: Object.freeze({
          files: Object.freeze([]),
          diffs: Object.freeze([]),
          terminalObserved: true,
        }),
      }),
    } : !commandStatusRunning && !waitingForGrok && !runBoundaries ? {
      recentResult: Object.freeze({
        runId,
        state: "completed" as const,
        workbench: Object.freeze({
          files: Object.freeze([
            Object.freeze({ path: "/Users/example/Workspace/portfolio_report.md", displayPath: "portfolio_report.md", line: 1 }),
          ]),
          diffs: Object.freeze([]),
          terminalObserved: true,
        }),
      }),
    } : {}),
    queuedTurns: queuePreemptState ? Object.freeze([
      Object.freeze({
        queueId: "queue-preempt-1",
        text: "先停下当前任务，马上检查刚改坏的登录流程",
        createdAtMs: NOW + 2_000,
      }),
      Object.freeze({
        queueId: "queue-preempt-2",
        text: "然后再继续原来的界面打磨",
        createdAtMs: NOW + 3_000,
      }),
    ]) : Object.freeze([]),
    hasEarlierTimeline: false,
    timeline: Object.freeze([
      Object.freeze({ entryId: "user-1", taskId, runId, sequence: 1, createdAtMs: NOW - 60_000, updatedAtMs: NOW - 60_000, status: "completed", kind: "user", text: "评审一下我现在仓库里面最新的持仓。" }),
      Object.freeze({ entryId: "thought-1", taskId, runId, sequence: 2, createdAtMs: NOW - 58_000, updatedAtMs: NOW - 35_000, status: "completed", kind: "thought", text: "先核对仓位和行情时间，再检查风险暴露。", startedAtMs: NOW - 58_000, elapsedMs: 23_000 }),
      Object.freeze({ entryId: "tool-1", taskId, runId, sequence: 3, createdAtMs: NOW - 34_000, updatedAtMs: NOW - 33_000, status: "completed", kind: "tool", title: "读取组合报告", toolKind: "read", toolStatus: "completed", content: Object.freeze([]), locations: Object.freeze([]) }),
      Object.freeze({ entryId: "tool-2", taskId, runId, sequence: 4, createdAtMs: NOW - 32_000, updatedAtMs: NOW - 30_000, status: "completed", kind: "tool", title: "检索最新行情", toolKind: "search", toolStatus: "completed", content: Object.freeze([]), locations: Object.freeze([]) }),
      Object.freeze({ entryId: "assistant-1", taskId, runId, sequence: 5, createdAtMs: NOW - 20_000, updatedAtMs: NOW - 5_000, status: "completed", kind: "assistant", text: "仓位已经核对完成。下一步应先处理集中度和过期数据，再讨论个股观点。\n\n我会把事实、推断和仍待确认的部分分开显示。" }),
      Object.freeze({ entryId: "user-2", taskId, runId, sequence: 6, createdAtMs: NOW - 4_000, updatedAtMs: NOW - 4_000, status: "completed", kind: "user", text: "把每一条持仓的风险和后续动作再展开写一遍，我要能往下翻完整页。" }),
      Object.freeze({
        entryId: "assistant-2",
        taskId,
        runId,
        sequence: 7,
        createdAtMs: NOW - 3_000,
        updatedAtMs: NOW - 1_000,
        status: "completed",
        kind: "assistant",
        text: [
          "下面按仓位逐条展开，方便你把对话区滚到底。",
          "",
          "1. 进攻池核心仓要先看集中度，而不是先改方向。",
          "2. 防守翼只做年检，不在这里用短线理由挪名额。",
          "3. 卫星仓如果连续两个财报周期都没有被验证，就进入三选一复审。",
          "4. 现金和保证金要分开看，避免把可用购买力当成安全垫。",
          "5. 过期数据必须标出来，不能和实时价混在同一段结论里。",
          "",
          "滚动检查用的补充段落：".concat(
            " 这一段足够长，确保在默认窗口高度下会出现纵向滚动条。",
            " 如果你已经滑到这里，说明对话区不再被 auto 行撑开。",
            " 继续往下还有一段，用来确认贴底滚动和中途停住都能工作。",
          ),
          "",
          "最后一条：先核对事实，再谈加减仓。",
        ].join("\n"),
      }),
      ...(commandStatusRunning ? [
        Object.freeze({ entryId: "user-goal", taskId, runId, sequence: 8, createdAtMs: NOW, updatedAtMs: NOW, status: "completed", kind: "user", text: "/goal 继续打磨这款游戏，补足关卡和画面细节" } as const),
        Object.freeze({ entryId: "thought-goal", taskId, runId, sequence: 9, createdAtMs: NOW + 100, updatedAtMs: NOW + 1_000, status: "streaming", kind: "thought", text: "先盘点现有关卡和视觉层，再选择风险最低的增量。", startedAtMs: NOW + 100, elapsedMs: 900 } as const),
        Object.freeze({ entryId: "tool-goal-search", taskId, runId, sequence: 10, createdAtMs: NOW + 1_100, updatedAtMs: NOW + 1_300, status: "completed", kind: "tool", title: "搜索关卡入口", toolKind: "search", toolStatus: "completed", content: Object.freeze([]), locations: Object.freeze([]) } as const),
        Object.freeze({ entryId: "tool-goal-read", taskId, runId, sequence: 11, createdAtMs: NOW + 1_400, updatedAtMs: NOW + 1_500, status: "streaming", kind: "tool", title: "读取关卡脚本", toolKind: "read", toolStatus: "in_progress", content: Object.freeze([]), locations: Object.freeze([]) } as const),
      ] : []),
      ...(waitingForGrok ? [
        Object.freeze({
          entryId: "user-waiting",
          taskId,
          runId: "run-waiting" as RunId,
          sequence: 8,
          createdAtMs: Date.now() - 76_000,
          updatedAtMs: Date.now() - 76_000,
          status: "completed",
          kind: "user",
          text: "可以的，没数还需要你继续优化。",
        } as const),
      ] : []),
      ...(runBoundaries ? [
        Object.freeze({
          entryId: "user-old-goal",
          taskId,
          runId: "run-old-interrupted" as RunId,
          sequence: 8,
          createdAtMs: NOW,
          updatedAtMs: NOW,
          status: "completed",
          kind: "user",
          text: "/goal 继续打磨这款游戏，补足关卡和画面细节",
        } as const),
        Object.freeze({
          entryId: "thought-old-goal",
          taskId,
          runId: "run-old-interrupted" as RunId,
          sequence: 9,
          createdAtMs: NOW + 100,
          updatedAtMs: NOW + 600_100,
          status: "interrupted",
          kind: "thought",
          text: "先盘点现有关卡和视觉层，再逐项完成修改与验证。",
          startedAtMs: NOW + 100,
          elapsedMs: 600_000,
        } as const),
        Object.freeze({
          entryId: "tool-old-goal",
          taskId,
          runId: "run-old-interrupted" as RunId,
          sequence: 10,
          createdAtMs: NOW + 1_100,
          updatedAtMs: NOW + 600_100,
          status: "interrupted",
          kind: "tool",
          title: "运行完整测试",
          toolKind: "execute",
          toolStatus: "in_progress",
          content: Object.freeze([]),
          locations: Object.freeze([]),
        } as const),
        Object.freeze({
          entryId: "error-old-goal",
          taskId,
          runId: "run-old-interrupted" as RunId,
          sequence: 11,
          createdAtMs: NOW + 600_200,
          updatedAtMs: NOW + 600_200,
          status: "failed",
          kind: "error",
          text: "Grok 运行时连接中断。你可以重新发送这条消息。",
        } as const),
        Object.freeze({
          entryId: "user-new-run",
          taskId,
          runId: "run-new-active" as RunId,
          sequence: 12,
          createdAtMs: NOW + 610_000,
          updatedAtMs: NOW + 610_000,
          status: "completed",
          kind: "user",
          text: "继续制作",
        } as const),
        Object.freeze({
          entryId: "thought-new-run",
          taskId,
          runId: "run-new-active" as RunId,
          sequence: 13,
          createdAtMs: NOW + 610_100,
          updatedAtMs: NOW + 622_100,
          status: "streaming",
          kind: "thought",
          text: "已接续上一轮目标，先核对现状，再从中断点继续。",
          startedAtMs: NOW + 610_100,
          elapsedMs: 12_000,
        } as const),
        Object.freeze({
          entryId: "tool-new-run",
          taskId,
          runId: "run-new-active" as RunId,
          sequence: 14,
          createdAtMs: NOW + 611_000,
          updatedAtMs: NOW + 622_100,
          status: "streaming",
          kind: "tool",
          title: "读取当前项目状态",
          toolKind: "read",
          toolStatus: "in_progress",
          content: Object.freeze([]),
          locations: Object.freeze([]),
        } as const),
      ] : []),
      ...(recoveryState ? [
        Object.freeze({
          entryId: "user-recovery",
          taskId,
          runId: "run-recovery-interrupted" as RunId,
          sequence: 8,
          createdAtMs: NOW,
          updatedAtMs: NOW,
          status: "interrupted",
          kind: "user",
          text: "/goal 继续完成当前任务并运行全部测试",
        } as const),
        Object.freeze({
          entryId: "tool-recovery",
          taskId,
          runId: "run-recovery-interrupted" as RunId,
          sequence: 9,
          createdAtMs: NOW + 100,
          updatedAtMs: NOW + 30_100,
          status: "interrupted",
          kind: "tool",
          title: "运行完整测试",
          toolKind: "execute",
          toolStatus: "failed",
          content: Object.freeze([]),
          locations: Object.freeze([]),
        } as const),
        Object.freeze({
          entryId: "notice-recovery",
          taskId,
          sequence: 10,
          createdAtMs: NOW + 31_000,
          updatedAtMs: NOW + 31_000,
          status: "completed",
          kind: "notice",
          text: "原 Grok 会话已恢复。",
          noticeType: "session_restored",
          incidentId: "fixture-incident",
        } as const),
      ] : []),
    ]),
  });
}
