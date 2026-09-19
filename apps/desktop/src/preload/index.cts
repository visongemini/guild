import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopBootstrapProjection,
  DesktopInvokeChannel,
  DesktopRequestByChannel,
  DesktopResponseByChannel,
  GuildRendererApi,
} from "@guild/contracts" with { "resolution-mode": "import" };

const DESKTOP_IPC_CHANNELS = Object.freeze({
  bootstrap: "guild:v1:bootstrap",
  chooseWorkspace: "guild:v1:workspace:choose",
  choosePromptFiles: "guild:v1:prompt-files:choose",
  createTask: "guild:v1:task:create",
  openTask: "guild:v1:task:open",
  loadEarlierTimeline: "guild:v1:task:timeline:earlier",
  loadSlashCommands: "guild:v1:task:slash-commands",
  forkTask: "guild:v1:task:fork",
  exportTask: "guild:v1:task:export",
  searchConversations: "guild:v1:conversation:search",
  openTaskResource: "guild:v1:task:resource:open",
  setSessionConfigOption: "guild:v1:task:session-config:set",
  updateWorkspace: "guild:v1:workspace:update",
  updateTask: "guild:v1:task:update",
  sendMessage: "guild:v1:run:send",
  setContinuousTask: "guild:v1:task:continuous:set",
  prioritizeQueuedTurn: "guild:v1:queue:prioritize",
  preemptQueuedTurn: "guild:v1:queue:preempt",
  cancelQueuedTurn: "guild:v1:queue:cancel",
  cancelRun: "guild:v1:run:cancel",
  decidePermission: "guild:v1:permission:decide",
  setDraft: "guild:v1:draft:set",
  authorizeSessionReplacement: "guild:v1:session:authorize-replacement",
  refreshUsage: "guild:v1:account:usage:refresh",
  openExternal: "guild:v1:platform:open-external",
  setLocale: "guild:v1:settings:locale",
  setRuntimeSettings: "guild:v1:settings:runtime",
  setSidebarWidth: "guild:v1:settings:sidebar-width",
  chooseAvatar: "guild:v1:profile:avatar:choose",
  saveProfile: "guild:v1:profile:save",
  setGeneralSettings: "guild:v1:settings:general",
  openUserData: "guild:v1:settings:open-user-data",
  backupUserData: "guild:v1:settings:backup-user-data",
  restoreUserData: "guild:v1:settings:restore-user-data",
  openRuntimeDiagnostics: "guild:v1:diagnostics:open-runtime-log",
  runGrokManagement: "guild:v1:grok:management:run",
  projectionChanged: "guild:v1:event:projection-changed",
} as const);

const invoke = <Channel extends DesktopInvokeChannel>(
  channel: Channel,
  request: DesktopRequestByChannel[Channel],
): Promise<DesktopResponseByChannel[Channel]> =>
  ipcRenderer.invoke(channel, request) as Promise<DesktopResponseByChannel[Channel]>;

const api = {
  apiVersion: 1,
  bootstrap: () => invoke(DESKTOP_IPC_CHANNELS.bootstrap, {}),
  chooseWorkspace: () => invoke(DESKTOP_IPC_CHANNELS.chooseWorkspace, {}),
  choosePromptFiles: (request) => invoke(DESKTOP_IPC_CHANNELS.choosePromptFiles, request),
  createTask: (request) => invoke(DESKTOP_IPC_CHANNELS.createTask, request),
  openTask: (request) => invoke(DESKTOP_IPC_CHANNELS.openTask, request),
  loadEarlierTimeline: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.loadEarlierTimeline, request),
  loadSlashCommands: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.loadSlashCommands, request),
  forkTask: (request) => invoke(DESKTOP_IPC_CHANNELS.forkTask, request),
  exportTask: (request) => invoke(DESKTOP_IPC_CHANNELS.exportTask, request),
  searchConversations: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.searchConversations, request),
  openTaskResource: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.openTaskResource, request),
  setSessionConfigOption: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.setSessionConfigOption, request),
  updateWorkspace: (request) => invoke(DESKTOP_IPC_CHANNELS.updateWorkspace, request),
  updateTask: (request) => invoke(DESKTOP_IPC_CHANNELS.updateTask, request),
  sendMessage: (request) => invoke(DESKTOP_IPC_CHANNELS.sendMessage, request),
  setContinuousTask: (request) => invoke(DESKTOP_IPC_CHANNELS.setContinuousTask, request),
  prioritizeQueuedTurn: (request) => invoke(DESKTOP_IPC_CHANNELS.prioritizeQueuedTurn, request),
  preemptQueuedTurn: (request) => invoke(DESKTOP_IPC_CHANNELS.preemptQueuedTurn, request),
  cancelQueuedTurn: (request) => invoke(DESKTOP_IPC_CHANNELS.cancelQueuedTurn, request),
  cancelRun: (request) => invoke(DESKTOP_IPC_CHANNELS.cancelRun, request),
  decidePermission: (request) => invoke(DESKTOP_IPC_CHANNELS.decidePermission, request),
  setDraft: (request) => invoke(DESKTOP_IPC_CHANNELS.setDraft, request),
  authorizeSessionReplacement: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.authorizeSessionReplacement, request),
  refreshUsage: () => invoke(DESKTOP_IPC_CHANNELS.refreshUsage, {}),
  openExternal: (request) => invoke(DESKTOP_IPC_CHANNELS.openExternal, request),
  setLocale: (request) => invoke(DESKTOP_IPC_CHANNELS.setLocale, request),
  setRuntimeSettings: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.setRuntimeSettings, request),
  setSidebarWidth: (request) => invoke(DESKTOP_IPC_CHANNELS.setSidebarWidth, request),
  chooseAvatar: () => invoke(DESKTOP_IPC_CHANNELS.chooseAvatar, {}),
  saveProfile: (request) => invoke(DESKTOP_IPC_CHANNELS.saveProfile, request),
  setGeneralSettings: (request) =>
    invoke(DESKTOP_IPC_CHANNELS.setGeneralSettings, request),
  openUserData: () => invoke(DESKTOP_IPC_CHANNELS.openUserData, {}),
  restoreUserData: () => invoke(DESKTOP_IPC_CHANNELS.restoreUserData, {}),
  backupUserData: () => invoke(DESKTOP_IPC_CHANNELS.backupUserData, {}),
  openRuntimeDiagnostics: () => invoke(DESKTOP_IPC_CHANNELS.openRuntimeDiagnostics, {}),
  runGrokManagement: (request) => invoke(DESKTOP_IPC_CHANNELS.runGrokManagement, request),
  onProjectionChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, projection: DesktopBootstrapProjection) => listener(projection);
    ipcRenderer.on(DESKTOP_IPC_CHANNELS.projectionChanged, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.projectionChanged, wrapped);
  },
} satisfies GuildRendererApi;

contextBridge.exposeInMainWorld("guild", Object.freeze(api));
