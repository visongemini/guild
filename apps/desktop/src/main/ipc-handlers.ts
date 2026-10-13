import {
  DESKTOP_IPC_CHANNELS,
  parseDesktopRequest,
  type DesktopBootstrapProjection,
  type DesktopInvokeChannel,
  type DesktopRequestByChannel,
  type DesktopResponseByChannel,
} from "@guild/contracts";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { DesktopApplicationService } from "./application-service.js";
import { wireBrowserPaneToRenderer, type BrowserPaneIpcPort } from "./browser-pane-bridge.js";
import type { ModelSourcesService } from "./model-sources-service.js";
import { createStreamDeltaForwarder } from "./stream-delta-channel.js";
import { isTrustedGuildSender } from "./window-security.js";
import { toDesktopIpcFailure } from "./workspace-folder.js";

/** Guild 3.0 services that sit beside the application service (docs/20 section 3.4). */
export type DesktopIpcExtras = {
  readonly modelSources?: ModelSourcesService;
  /** The browser pane of this window (docs/20 section 3.5). */
  readonly browserPane?: BrowserPaneIpcPort;
};

export function registerDesktopIpc(
  window: BrowserWindow,
  service: DesktopApplicationService,
  extras: DesktopIpcExtras = {},
): () => void {
  const channels: DesktopInvokeChannel[] = [];
  const handle = <Channel extends DesktopInvokeChannel>(
    channel: Channel,
    operation: (
      request: DesktopRequestByChannel[Channel],
    ) => Promise<DesktopResponseByChannel[Channel]>,
  ): void => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      assertTrustedSender(window, event);
      try {
        const request = parseDesktopRequest(channel, raw);
        return await operation(request);
      } catch (cause: unknown) {
        if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
          const diagnostic = cause instanceof Error ? cause.message : "unknown_error";
          console.error("guild_operation_diagnostic", channel, diagnostic.slice(0, 240));
        }
        throw toDesktopIpcFailure(cause);
      }
    });
  };

  handle(DESKTOP_IPC_CHANNELS.bootstrap, async () => service.bootstrap());
  handle(DESKTOP_IPC_CHANNELS.chooseWorkspace, async () => service.chooseWorkspace());
  handle(DESKTOP_IPC_CHANNELS.choosePromptFiles, async (request) =>
    service.choosePromptFiles(request.taskId));
  handle(DESKTOP_IPC_CHANNELS.createTask, async (request) =>
    service.createTask(request.workspaceId, request.isolation, request.engine));
  handle(DESKTOP_IPC_CHANNELS.openTask, async (request) =>
    service.openTask(request.taskId, request.sequence));
  handle(DESKTOP_IPC_CHANNELS.loadEarlierTimeline, async (request) =>
    service.loadEarlierTimeline(request.taskId));
  handle(DESKTOP_IPC_CHANNELS.loadSlashCommands, async (request) =>
    service.loadSlashCommands(request.taskId));
  handle(DESKTOP_IPC_CHANNELS.forkTask, async (request) =>
    service.forkTask(request.taskId, request.throughSequence));
  handle(DESKTOP_IPC_CHANNELS.exportTask, async (request) =>
    service.exportTask(request.taskId, request.format));
  handle(DESKTOP_IPC_CHANNELS.searchConversations, async (request) =>
    service.searchConversations(request.query));
  handle(DESKTOP_IPC_CHANNELS.openTaskResource, async (request) => {
    await service.openTaskResource(request.taskId, request.action, request.action === "file" ? request.path : undefined);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.setSessionConfigOption, async (request) =>
    service.setSessionConfigOption(request.taskId, request.configId, request.value));
  handle(DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings, async (request) =>
    service.setTaskRuntimeSettings(request));
  handle(DESKTOP_IPC_CHANNELS.updateWorkspace, async (request) =>
    service.updateWorkspace(request.workspaceId, request.action));
  handle(DESKTOP_IPC_CHANNELS.updateTask, async (request) =>
    service.updateTask(request));
  handle(DESKTOP_IPC_CHANNELS.sendMessage, async (request) =>
    service.sendMessage(request.taskId, request.text, request.attachments, request.mode));
  handle(DESKTOP_IPC_CHANNELS.setContinuousTask, async (request) =>
    service.setContinuousTask(request.taskId, request.action));
  handle(DESKTOP_IPC_CHANNELS.prioritizeQueuedTurn, async (request) => {
    await service.prioritizeQueuedTurn(request.taskId, request.queueId);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.preemptQueuedTurn, async (request) => {
    await service.preemptQueuedTurn(request.taskId, request.queueId);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.cancelQueuedTurn, async (request) => {
    await service.cancelQueuedTurn(request.taskId, request.queueId);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.cancelRun, async (request) => {
    await service.cancelRun(request.taskId, request.runId);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.steerMessage, async (request) =>
    service.steerMessage(request.taskId, request.text));
  handle(DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer, async (request) =>
    service.convertQueuedTurnToSteer(request.taskId, request.queueId));
  handle(DESKTOP_IPC_CHANNELS.previewRewind, async (request) =>
    service.previewRewind(request.taskId, request.runId));
  handle(DESKTOP_IPC_CHANNELS.executeRewind, async (request) =>
    service.executeRewind(request));
  handle(DESKTOP_IPC_CHANNELS.loadRunFileDiff, async (request) =>
    service.loadRunFileDiff(request));
  handle(DESKTOP_IPC_CHANNELS.previewWorktreeApply, async (request) =>
    service.previewWorktreeApply(request.taskId));
  handle(DESKTOP_IPC_CHANNELS.applyWorktree, async (request) =>
    service.applyWorktree(request.taskId));
  handle(DESKTOP_IPC_CHANNELS.discardWorktree, async (request) =>
    service.discardWorktree(request.taskId));
  handle(DESKTOP_IPC_CHANNELS.openWorktreeResource, async (request) => {
    await service.openWorktreeResource(request.taskId, request.action);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.decidePermission, async (request) => {
    await service.decidePermission(request);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.setDraft, async (request) => {
    await service.setDraft(request.taskId, request.text);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.authorizeSessionReplacement, async (request) =>
    service.authorizeSessionReplacement(request.taskId));
  handle(DESKTOP_IPC_CHANNELS.refreshUsage, async () => service.refreshUsage());
  handle(DESKTOP_IPC_CHANNELS.openExternal, async (request) => {
    await service.openExternal(request.url);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.setLocale, async (request) =>
    service.setLocale(request.locale));
  handle(DESKTOP_IPC_CHANNELS.setRuntimeSettings, async (request) =>
    service.setRuntimeSettings(request.model, request.reasoningEffort, request.permissionMode, request.startup));
  handle(DESKTOP_IPC_CHANNELS.setSidebarWidth, async (request) => {
    await service.setSidebarWidth(request.width);
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.chooseAvatar, async () => service.chooseAvatar());
  handle(DESKTOP_IPC_CHANNELS.saveProfile, async (request) =>
    service.saveProfile(request.nickname, request.avatar));
  handle(DESKTOP_IPC_CHANNELS.setGeneralSettings, async (request) =>
    service.setGeneralSettings(
      request.restoreLastTask,
      request.newTaskWorkspaceMode,
      request.browserSyncEnabled,
      request.taskNotificationsEnabled,
      request.dockIcon,
    ));
  handle(DESKTOP_IPC_CHANNELS.openUserData, async () => {
    await service.openUserData();
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.restoreUserData, async () => service.restoreUserData());
  handle(DESKTOP_IPC_CHANNELS.backupUserData, async () => service.backupUserData());
  handle(DESKTOP_IPC_CHANNELS.openRuntimeDiagnostics, async () => {
    await service.openRuntimeDiagnostics();
    return Object.freeze({});
  });
  handle(DESKTOP_IPC_CHANNELS.runGrokManagement, async (request) =>
    service.runGrokManagement(request));
  handle(DESKTOP_IPC_CHANNELS.setTaskEngine, async (request) =>
    service.setTaskEngine(request.taskId, request.engine));
  handle(DESKTOP_IPC_CHANNELS.setClaudeSettings, async (request) =>
    service.setClaudeSettings(request.model, request.reasoningEffort, request.permissionMode));
  handle(DESKTOP_IPC_CHANNELS.setEngineSettings, async (request) =>
    service.setEngineSettings(request.engine, request.model, request.reasoningEffort, request.permissionMode));

  const modelSources = extras.modelSources;
  if (modelSources !== undefined) {
    handle(DESKTOP_IPC_CHANNELS.listModelSources, async () => modelSources.list());
    handle(DESKTOP_IPC_CHANNELS.upsertModelSource, async (request) => modelSources.upsert(request));
    handle(DESKTOP_IPC_CHANNELS.deleteModelSource, async (request) => {
      await modelSources.remove(request.id);
      return Object.freeze({});
    });
    handle(DESKTOP_IPC_CHANNELS.confirmModelSource, async (request) => modelSources.confirm(request.id));
    handle(DESKTOP_IPC_CHANNELS.testModelSource, async (request) => modelSources.test(request.id));
    handle(DESKTOP_IPC_CHANNELS.getWorkspacePrefs, async (request) => modelSources.getWorkspacePrefs(request));
    handle(DESKTOP_IPC_CHANNELS.setWorkspacePrefs, async (request) => modelSources.setWorkspacePrefs(request));
  }

  let disposeBrowserPane: (() => void) | undefined;
  if (extras.browserPane !== undefined) {
    // The sender check of `handle` and `parseBrowserCommand` guard this channel like every other.
    const wired = wireBrowserPaneToRenderer(extras.browserPane, {
      send: (projection) => {
        if (!window.isDestroyed()) window.webContents.send(DESKTOP_IPC_CHANNELS.browserPaneChanged, projection);
      },
      onRendererLoaded: (listener) => {
        window.webContents.on("did-finish-load", listener);
        return () => {
          if (!window.isDestroyed()) window.webContents.off("did-finish-load", listener);
        };
      },
    });
    disposeBrowserPane = wired.dispose;
    handle(DESKTOP_IPC_CHANNELS.browserCommand, async (request) => wired.command(request));
  }

  const unsubscribe = service.subscribe((projection: DesktopBootstrapProjection) => {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_IPC_CHANNELS.projectionChanged, projection);
    }
  });

  const forwardStreamDelta = createStreamDeltaForwarder(window);
  const unsubscribeDeltas = service.subscribeStreamDeltas((delta) => {
    forwardStreamDelta(delta);
  });

  return () => {
    unsubscribe();
    unsubscribeDeltas();
    disposeBrowserPane?.();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function assertTrustedSender(window: BrowserWindow, event: IpcMainInvokeEvent): void {
  if (
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedGuildSender(window, event.sender, event.senderFrame.url)
  ) {
    throw new Error("guild_ipc_sender_rejected");
  }
}
