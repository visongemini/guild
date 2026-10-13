import { restoreMessages } from "./restore-messages.js";
import { finishRestoreShutdown, finishLocalRestore, recoverLocalRestore } from "./local-backup.js";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, normalize } from "node:path";
import { app, dialog, nativeImage, Notification, powerMonitor, shell, type BrowserWindow } from "electron";
import type { GuildLocale } from "@guild/contracts";
import { openGuildPersistence } from "@guild/persistence";
import {
  installGuildAppProtocol,
  installGuildMediaProtocol,
  registerGuildScheme,
} from "./app-protocol.js";
import type { DesktopApplicationService } from "./application-service.js";
import { createBrowserPaneBridge, type BrowserPaneBridge, type BrowserPaneIpcPort } from "./browser-pane-bridge.js";
import { configureBrowserPaneProcess } from "./browser-pane.js";
import { createElectronBrowserPane } from "./browser-pane-electron.js";
import { resolveDevHooks } from "./dev-hooks.js";
import { createDockIconApplier } from "./dock-icon.js";
import { createElectronRouterFetches } from "./electron-router-fetch.js";
import { registerDesktopIpc } from "./ipc-handlers.js";
import { createLiveDesktopService } from "./live-service.js";
import {
  createModelRouterHost,
  createRouterFetch,
  DEFAULT_KEY_FILE_UNDER_HOME,
  readSourceKey,
  type ModelRouterHost,
} from "./model-router-host.js";
import { createModelSourcesService, type ModelSourcesService } from "./model-sources-service.js";
import type { HostConfirmationPrompt } from "./model-source-messages.js";
import { RouterDiagnosticLog } from "./router-diagnostic-log.js";
import { createGuildWindow } from "./window-security.js";
import {
  reloadRendererWithoutActivation,
  type WindowActivation,
} from "./window-focus-policy.js";
import {
  collectTaskNotificationEvents,
  deliverTaskNotification,
  taskNotificationBody,
  type TaskNotificationEvent,
  type TaskNotificationSnapshot,
} from "./task-notifications.js";

registerGuildScheme();
app.enableSandbox();
configureBrowserPaneProcess(app);

let closeIpc: (() => void) | undefined;
let closeTaskNotifications: (() => void) | undefined;
let service: DesktopApplicationService | undefined;
let modelRouterHost: ModelRouterHost | undefined;
let modelSources: ModelSourcesService | undefined;
let browserPane: BrowserPaneIpcPort | undefined;
let browserBridge: BrowserPaneBridge | undefined;
let routerLog: RouterDiagnosticLog | undefined;
let guildWindow: BrowserWindow | undefined;
let preloadPath = "";
let shutdownStarted = false;
let restoreStage: string | undefined;
let restoreChinese = true;
let validatingRestoreBoot = false;
let shutdownComplete = false;
let rendererRecoveryFailures = 0;
let rendererRecoveryErrorPending = false;
// Dev-only QA hooks; a packaged app ignores them (see dev-hooks.ts).
const devHooks = resolveDevHooks({ isPackaged: app.isPackaged, env: process.env });
const fixtureRequested = !app.isPackaged && process.env["GUILD_DESKTOP_FIXTURE"] === "1";
const fixtureCapturePath = fixtureRequested
  ? validatedFixtureCapturePath(process.env["GUILD_FIXTURE_CAPTURE_PATH"])
  : undefined;
const fixtureUiState = fixtureRequested
  ? validatedFixtureUiState(process.env["GUILD_FIXTURE_UI_STATE"])
  : undefined;
// GrokProcessHost may spend 2s on SIGTERM and another 2s proving the detached
// process group is gone after SIGKILL. Keep the Electron parent alive long
// enough for that ownership contract to finish, with margin for final commits.
const SHUTDOWN_GRACE_MS = 6_000;
const RENDERER_RECOVERY_LIMIT = 3;
const RENDERER_STABILITY_RESET_MS = 10_000;
const RENDERER_UNRESPONSIVE_RECOVERY_MS = 15_000;

app.setName("Guild");
// The clean-room branch never mutates the frozen 1.1.x application's data directory.
app.setPath(
  "userData",
  fixtureRequested
    ? join(app.getPath("temp"), `Guild-v2-fixture-${process.pid}`)
    : devHooks.userDataDir ?? join(app.getPath("appData"), "Guild-v2"),
);
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) app.quit();
app.on("second-instance", () => {
  if (guildWindow === undefined || guildWindow.isDestroyed()) {
    void openWindow("background-hidden");
  }
  // A child tool or macOS recovery may relaunch the executable. That is not
  // proof of user intent and must never steal focus. Dock/Finder activation is
  // delivered through the explicit `activate` event below.
});

app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;
  validatingRestoreBoot = await recoverLocalRestore(app.getPath("userData"));
  const rendererRoot = join(app.getAppPath(), "dist", "renderer");
  preloadPath = join(app.getAppPath(), "dist", "preload", "index.cjs");
  await installGuildAppProtocol(rendererRoot);
  const mediaRoot = join(app.getPath("userData"), "media");
  await installGuildMediaProtocol(mediaRoot);

  if (fixtureRequested) {
    const { createFixtureDesktopService } = await import("./fixture-service.js");
    service = createFixtureDesktopService();
    const { createFixtureModelSources } = await import("./fixture-model-sources.js");
    modelSources = createFixtureModelSources();
    const { createFixtureBrowserPane } = await import("./fixture-browser-pane.js");
    browserPane = createFixtureBrowserPane();
  } else {
    // One database owner: the model sources service and the router host share the live service's store.
    const persistence = openGuildPersistence({
      path: join(app.getPath("userData"), "guild.sqlite3"),
      initialLocale: systemLocale(),
    });
    const defaultKeyFile = join(app.getPath("home"), DEFAULT_KEY_FILE_UNDER_HOME);
    const fetches = createElectronRouterFetches();
    const log = new RouterDiagnosticLog(join(app.getPath("userData"), "diagnostics"));
    routerLog = log;
    const routerHost = createModelRouterHost({
      store: persistence,
      defaultKeyFile,
      fetchImpl: fetches.proxied,
      directFetchImpl: fetches.direct,
      log: (event, fields) => {
        void log.append(event, fields).catch(() => undefined);
      },
    });
    modelRouterHost = routerHost;
    // The one native dialog that binds a key to a host: a model source's and an engine's use the same (PC-ROUTE-002,
    // PC-ENG-004). Cancel is the default button; only "Allow" confirms, and nothing in the renderer can answer it.
    const confirmHost = async (prompt: HostConfirmationPrompt): Promise<boolean> => {
      const options = {
        type: "warning" as const,
        title: "Guild",
        message: prompt.message,
        detail: prompt.detail,
        buttons: [prompt.cancelLabel, prompt.allowLabel],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const owner = guildWindow;
      const answer = owner !== undefined && !owner.isDestroyed()
        ? await dialog.showMessageBox(owner, options)
        : await dialog.showMessageBox(options);
      return answer.response === 1;
    };
    // The Dock icon the user chose (PC-SET-002): the dark one is the bundle's own PNG, the light one a packaged resource.
    const dockIcons = createDockIconApplier({
      platform: process.platform,
      dock: app.dock,
      iconDirectory: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build"),
      loadImage: (path) => {
        const image = nativeImage.createFromPath(path);
        return image.isEmpty() ? undefined : image;
      },
      fileExists: existsSync,
    });
    modelSources = createModelSourcesService({
      store: persistence,
      defaultKeyFile,
      getLocale: currentLocale,
      confirmHost,
      onChanged: () => {
        void routerHost.refresh();
      },
      connectionTest: {
        fetchImpl: createRouterFetch({ fetchImpl: fetches.proxied, directFetchImpl: fetches.direct }),
        readKey: (record) => readSourceKey(record, defaultKeyFile, (event, fields) => {
          void log.append(event, fields).catch(() => undefined);
        }),
        logger: { info: (event, fields) => { void log.append(event, fields).catch(() => undefined); } },
      },
    });
    const bridge = createBrowserPaneBridge();
    browserBridge = bridge;
    browserPane = bridge;
    service = createLiveDesktopService({
        persistence,
        modelRouterHost: routerHost,
        browserMcp: bridge.mcp,
        claudeCaptureOff: devHooks.claudeCaptureOff,
        ...(devHooks.codexAdapterRoot === undefined ? {} : { codexAdapterRoot: devHooks.codexAdapterRoot }),
        ...(devHooks.geminiCliRoot === undefined ? {} : { geminiCliRoot: devHooks.geminiCliRoot }),
        defaultKeyFile,
        confirmEngineKey: confirmHost,
        applyDockIcon: (icon) => dockIcons.apply(icon),
        appVersion: app.getVersion(),
        databasePath: join(app.getPath("userData"), "guild.sqlite3"),
        initialLocale: app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US",
        stagingRoot: join(app.getPath("temp"), "guild-v2-runtime"),
        mediaRoot,
        openExternal: async (url) => {
          await shell.openExternal(url, { activate: true });
        },
        saveTaskExport: async ({ suggestedFilename, format, contents }) => {
          const locale = (await service?.bootstrap().catch(() => undefined))?.locale ??
            (app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
          const result = guildWindow !== undefined && !guildWindow.isDestroyed()
            ? await dialog.showSaveDialog(guildWindow, {
                title: locale === "zh-CN" ? "导出对话" : "Export conversation",
                defaultPath: suggestedFilename,
                filters: format === "markdown"
                  ? [{ name: "Markdown", extensions: ["md"] }]
                  : [{ name: "JSON", extensions: ["json"] }],
              })
            : await dialog.showSaveDialog({
                title: locale === "zh-CN" ? "导出对话" : "Export conversation",
                defaultPath: suggestedFilename,
                filters: format === "markdown"
                  ? [{ name: "Markdown", extensions: ["md"] }]
                  : [{ name: "JSON", extensions: ["json"] }],
              });
          if (result.canceled || result.filePath === undefined) return "cancelled";
          await writeFile(result.filePath, contents, { encoding: "utf8", mode: 0o600 });
          return "saved";
        },
        openWorkspaceFolder: async (path) => {
          const error = await shell.openPath(path);
          if (error !== "") throw new Error("workspace_folder_open_failed");
        },
        openWorkspaceTerminal: async (path) => {
          await new Promise<void>((resolvePromise, rejectPromise) => {
            const child = spawn("/usr/bin/open", ["-a", "Terminal", path], {
              stdio: "ignore",
              windowsHide: true,
            });
            child.once("error", rejectPromise);
            child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error("terminal_open_failed")));
          });
        },
        openTaskFile: async (path) => {
          const error = await shell.openPath(path);
          if (error !== "") throw new Error("task_file_open_failed");
        },
        chooseAvatarFile: async () => {
          const locale = (await service?.bootstrap().catch(() => undefined))?.locale ??
            (app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
          const copy = locale === "zh-CN"
            ? { title: "选择头像", buttonLabel: "选择" }
            : { title: "Choose avatar", buttonLabel: "Choose" };
          const owner = guildWindow;
          const result = owner !== undefined && !owner.isDestroyed()
            ? await dialog.showOpenDialog(owner, {
                ...copy,
                properties: ["openFile"],
                filters: [
                  { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
                ],
              })
            : await dialog.showOpenDialog({
                ...copy,
                properties: ["openFile"],
                filters: [
                  { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
                ],
              });
          return result.canceled ? undefined : result.filePaths[0];
        },
        choosePromptFiles: async ({ workspacePath, locale }) => {
          const copy = locale === "zh-CN"
            ? { title: "添加工作区文件", buttonLabel: "添加" }
            : { title: "Add workspace files", buttonLabel: "Add" };
          const owner = guildWindow;
          const result = owner !== undefined && !owner.isDestroyed()
            ? await dialog.showOpenDialog(owner, {
                ...copy,
                defaultPath: workspacePath,
                properties: ["openFile", "multiSelections"],
              })
            : await dialog.showOpenDialog({
                ...copy,
                defaultPath: workspacePath,
                properties: ["openFile", "multiSelections"],
              });
          return result.canceled ? undefined : result.filePaths;
        },
        openUserData: async () => {
          await shell.openPath(app.getPath("userData"));
        },
        requestRestoreRestart: (stagedRoot) => {
          restoreStage = stagedRoot;
          setTimeout(() => app.quit(), 150);
        },
        chooseUserDataRestorePath: async () => {
          restoreChinese = (await service?.bootstrap())?.locale === "zh-CN";
          const copy = restoreMessages(restoreChinese);
          const result = await dialog.showOpenDialog({
            title: copy.chooseTitle,
            properties: ["openDirectory"],
          });
          if (result.canceled || result.filePaths[0] === undefined) return undefined;
          const answer = await dialog.showMessageBox({
            type: "warning", title: copy.title, message: copy.question, detail: copy.detail,
            buttons: [copy.cancel, copy.restore], defaultId: 0, cancelId: 0,
          });
          return answer.response === 1 ? result.filePaths[0] : undefined;
        },
        chooseUserDataBackupPath: async () => {
          const locale = (await service?.bootstrap().catch(() => undefined))?.locale ??
            (app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
          const date = new Date().toISOString().slice(0, 10);
          const copy = locale === "zh-CN"
            ? { title: "创建 Guild 本地备份", buttonLabel: "创建备份" }
            : { title: "Create Guild local backup", buttonLabel: "Create backup" };
          const owner = guildWindow;
          const result = owner !== undefined && !owner.isDestroyed()
            ? await dialog.showSaveDialog(owner, {
                ...copy,
                defaultPath: join(app.getPath("documents"), `Guild-backup-${date}.guild-backup`),
                showsTagField: false,
              })
            : await dialog.showSaveDialog({
                ...copy,
                defaultPath: join(app.getPath("documents"), `Guild-backup-${date}.guild-backup`),
                showsTagField: false,
              });
          return result.canceled ? undefined : result.filePath;
        },
        openRuntimeDiagnostics: async () => {
          const diagnosticsPath = join(app.getPath("userData"), "diagnostics");
          await mkdir(diagnosticsPath, { recursive: true, mode: 0o700 });
          await shell.openPath(diagnosticsPath);
        },
        chooseWorkspace: async () => {
          const locale = (await service?.bootstrap().catch(() => undefined))?.locale ??
            (app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
          const copy = locale === "zh-CN"
            ? { title: "选择工作区", buttonLabel: "选择" }
            : { title: "Choose a workspace", buttonLabel: "Choose" };
          const owner = guildWindow;
          const result = owner !== undefined && !owner.isDestroyed()
            ? await dialog.showOpenDialog(owner, {
                ...copy,
                properties: ["openDirectory", "createDirectory"],
              })
            : await dialog.showOpenDialog({
                ...copy,
                properties: ["openDirectory", "createDirectory"],
              });
          return result.canceled ? undefined : result.filePaths[0];
        },
      });
  }

  void modelRouterHost?.refresh();
  if (!fixtureRequested) closeTaskNotifications = installTaskNotifications(service);
  if (validatingRestoreBoot) {
    await service.bootstrap();
    await finishLocalRestore(app.getPath("userData"));
    validatingRestoreBoot = false;
  }
  await openWindow();
  powerMonitor.on("suspend", () => {
    void service?.handleLifecycleEvent("suspend").catch(() => undefined);
  });
  powerMonitor.on("resume", () => {
    void service?.handleLifecycleEvent("resume").catch(() => undefined);
    if (guildWindow !== undefined && !guildWindow.isDestroyed()) {
      guildWindow.webContents.invalidate();
    }
  });

  app.on("activate", () => {
    if (guildWindow === undefined || guildWindow.isDestroyed()) {
      void openWindow();
      return;
    }
    guildWindow.show();
    guildWindow.focus();
    showPendingRendererRecoveryError();
  });
}).catch((cause: unknown) => {
  if (validatingRestoreBoot) {
    // The journal is still "booting"; the next process rolls back before opening persistence.
    app.relaunch();
    app.exit(1);
    return;
  }
  if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    console.error("guild_startup_failed", detail.replace(/[\r\n]+/gu, " ").slice(0, 1_000));
  }
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  dialog.showErrorBox(
    chinese ? "Guild 无法启动" : "Guild could not start",
    chinese
      ? "Guild 无法打开本地数据或官方 Grok 运行时。请重新启动；若仍失败，请重新安装 Guild。"
      : "Guild could not open its local data or the official Grok runtime. Restart the app; if it still fails, reinstall Guild.",
  );
  app.exit(1);
});

async function openWindow(activation: WindowActivation = "user"): Promise<void> {
  if (service === undefined || shutdownStarted) return;
  if (guildWindow !== undefined && !guildWindow.isDestroyed()) {
    if (activation === "user") {
      if (guildWindow.isMinimized()) guildWindow.restore();
      guildWindow.show();
      guildWindow.focus();
    }
    return;
  }
  closeIpc?.();
  closeIpc = undefined;
  const window = createGuildWindow(
    preloadPath,
    !app.isPackaged,
    fixtureCapturePath === undefined && activation === "user",
  );
  guildWindow = window;
  if (browserBridge !== undefined) {
    // One pane controller per window; the MCP server and the IPC talk to the current one.
    const detachPane = browserBridge.attach(createElectronBrowserPane(window));
    window.once("closed", detachPane);
  }
  closeIpc = registerDesktopIpc(window, service, { modelSources, browserPane });
  let rendererRecoveryStarted = false;
  let unresponsiveRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const clearUnresponsiveRecovery = () => {
    if (unresponsiveRecoveryTimer !== undefined) clearTimeout(unresponsiveRecoveryTimer);
    unresponsiveRecoveryTimer = undefined;
  };
  const recoverRenderer = () => {
    if (rendererRecoveryStarted || shutdownStarted) return;
    rendererRecoveryStarted = true;
    clearUnresponsiveRecovery();
    rendererRecoveryFailures += 1;
    if (rendererRecoveryFailures > RENDERER_RECOVERY_LIMIT) {
      rendererRecoveryErrorPending = true;
      if (window.isFocused()) showPendingRendererRecoveryError();
      return;
    }
    void service?.handleLifecycleEvent("renderer_reload")
      .catch(() => undefined)
      .finally(() => {
        if (shutdownStarted) return;
        try {
          reloadRendererWithoutActivation({
            isDestroyed: () => window.isDestroyed(),
            reload: () => window.webContents.reload(),
          });
        } catch {
          if (!window.isDestroyed()) void window.loadURL("guild-app://app/index.html");
        }
      });
  };
  window.once("closed", () => {
    clearUnresponsiveRecovery();
    if (guildWindow === window) guildWindow = undefined;
    closeIpc?.();
    closeIpc = undefined;
  });
  window.webContents.on("render-process-gone", recoverRenderer);
  window.webContents.on("unresponsive", () => {
    clearUnresponsiveRecovery();
    unresponsiveRecoveryTimer = setTimeout(recoverRenderer, RENDERER_UNRESPONSIVE_RECOVERY_MS);
    unresponsiveRecoveryTimer.unref?.();
  });
  window.webContents.on("responsive", clearUnresponsiveRecovery);
  window.webContents.on("did-finish-load", () => {
    rendererRecoveryStarted = false;
    clearUnresponsiveRecovery();
    const reset = setTimeout(() => {
      if (guildWindow === window && !window.isDestroyed()) rendererRecoveryFailures = 0;
    }, RENDERER_STABILITY_RESET_MS);
    reset.unref?.();
  });
  await window.loadURL("guild-app://app/index.html");
  if (fixtureCapturePath !== undefined) {
    await waitForFixtureShell(window);
    await applyFixtureUiState(window, fixtureUiState);
    const capture = await window.webContents.capturePage();
    await writeFile(fixtureCapturePath, capture.toPNG());
    app.quit();
    return;
  }
  // `ready-to-show` is an optimization, not a visibility guarantee. Some
  // packaged macOS launches finish loading without emitting it, which would
  // otherwise leave a healthy renderer permanently hidden.
  if (!window.isDestroyed() && !window.isVisible()) {
    if (activation === "user") window.show();
  }
}

function systemLocale(): GuildLocale {
  return app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

async function currentLocale(): Promise<GuildLocale> {
  return (await service?.bootstrap().catch(() => undefined))?.locale ?? systemLocale();
}

function installTaskNotifications(currentService: DesktopApplicationService): () => void {
  let snapshot: TaskNotificationSnapshot | undefined;
  return currentService.subscribe((projection) => {
    try {
      const tasks = projection.workspaces.flatMap((workspace) => workspace.tasks);
      const next = collectTaskNotificationEvents(snapshot, tasks);
      snapshot = next.snapshot;
      if (
        !projection.generalSettings.taskNotificationsEnabled ||
        guildWindow?.isFocused() === true ||
        !Notification.isSupported()
      ) return;
      for (const event of next.events) {
        const notification = new Notification({
          title: "Guild",
          body: taskNotificationBody(event, projection.locale),
          silent: false,
        });
        deliverTaskNotification(notification, () => {
          void revealTaskFromNotification(currentService, event.taskId);
        });
      }
    } catch {
      // Notification delivery must never fault task persistence or projection.
    }
  });
}

function showPendingRendererRecoveryError(): void {
  if (!rendererRecoveryErrorPending) return;
  rendererRecoveryErrorPending = false;
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  dialog.showErrorBox(
    chinese ? "Guild 窗口反复崩溃" : "Guild's window keeps crashing",
    chinese
      ? "自动恢复已暂停，避免无限重启。请退出并重新打开 Guild。你的对话仍保存在本地。"
      : "Automatic recovery stopped to avoid an endless restart loop. Quit and reopen Guild. Your chats remain stored locally.",
  );
}

async function revealTaskFromNotification(
  currentService: DesktopApplicationService,
  taskId: TaskNotificationEvent["taskId"],
): Promise<void> {
  await currentService.openTask(taskId).catch(() => undefined);
  if (guildWindow === undefined || guildWindow.isDestroyed()) {
    await openWindow();
    return;
  }
  if (guildWindow.isMinimized()) guildWindow.restore();
  guildWindow.show();
  guildWindow.focus();
}

async function applyFixtureUiState(
  window: BrowserWindow,
  state: "slash" | "command-palette" | "task-menu" | "task-hover" | "account" | "account-narrow" | "settings" | "settings-narrow" | "settings-grok" | "settings-grok-narrow" | "grok-control" | "grok-control-narrow" | "statuses" | "statuses-narrow" | "workbench" | "workbench-narrow" | "waiting" | "run-boundaries" | "recovery" | "recovery-narrow" | "recovery-wide" | "queue-preempt" | undefined,
): Promise<void> {
  if (state === "account-narrow" || state === "settings-narrow" || state === "settings-grok-narrow" || state === "grok-control-narrow" || state === "statuses-narrow" || state === "recovery-narrow") {
    window.setSize(680, 520, false);
    window.center();
  } else if (state === "workbench-narrow") {
    window.setSize(900, 620, false);
    window.center();
  } else if (state === "workbench") {
    window.setSize(1280, 820, false);
    window.center();
  } else if (state === "waiting" || state === "run-boundaries" || state === "recovery-wide") {
    window.setSize(1470, 956, false);
    window.center();
  }
  if (state === "slash") {
    await window.webContents.executeJavaScript(String.raw`
      (() => {
        const textarea = document.querySelector('.guild-composer textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('fixture_composer_missing');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(textarea, '/');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
      })()
    `, true);
  } else if (state === "command-palette") {
    await window.webContents.executeJavaScript(String.raw`
      (() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
      })()
    `, true);
  } else if (state === "task-menu") {
    await window.webContents.executeJavaScript(String.raw`
      (() => {
        const task = document.querySelector('.guild-task-row');
        if (!(task instanceof HTMLElement)) throw new Error('fixture_task_missing');
        const rect = task.getBoundingClientRect();
        task.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.min(120, rect.width / 2),
          clientY: rect.top + rect.height / 2,
        }));
      })()
    `, true);
  } else if (state === "task-hover") {
    const point = await window.webContents.executeJavaScript(String.raw`
      (() => {
        const task = document.querySelector('.guild-task-row');
        if (!(task instanceof HTMLElement)) throw new Error('fixture_task_missing');
        const rect = task.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()
    `, true) as { readonly x: number; readonly y: number };
    window.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  } else if (state === "account" || state === "account-narrow") {
    await window.webContents.executeJavaScript(String.raw`
      (() => {
        const profile = document.querySelector('.guild-profile');
        if (!(profile instanceof HTMLButtonElement)) throw new Error('fixture_profile_missing');
        profile.click();
      })()
    `, true);
  } else if (state === "settings" || state === "settings-narrow" || state === "settings-grok" || state === "settings-grok-narrow") {
    await window.webContents.executeJavaScript(String.raw`
      (async () => {
        const profile = document.querySelector('.guild-profile');
        if (!(profile instanceof HTMLButtonElement)) throw new Error('fixture_profile_missing');
        profile.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const settings = document.querySelector('.guild-profile-settings');
        if (!(settings instanceof HTMLButtonElement)) throw new Error('fixture_settings_missing');
        settings.click();
        ${state === "settings-grok" || state === "settings-grok-narrow" ? String.raw`
        await new Promise((resolve) => setTimeout(resolve, 50));
        const grokTab = Array.from(document.querySelectorAll('button[role="tab"]')).find((element) => element.textContent?.trim() === 'Grok');
        if (!(grokTab instanceof HTMLButtonElement)) throw new Error('fixture_grok_tab_missing');
        grokTab.click();
        ` : ""}
      })()
    `, true);
  } else if (state === "grok-control" || state === "grok-control-narrow") {
    await window.webContents.executeJavaScript(String.raw`
      (() => {
        const control = Array.from(document.querySelectorAll('.guild-primary-nav .guild-nav-item')).find((element) => element.textContent?.includes('Grok Build'));
        if (!(control instanceof HTMLButtonElement)) throw new Error('fixture_grok_control_missing');
        control.click();
      })()
    `, true);
  } else if (state === "workbench" || state === "workbench-narrow") {
    await window.webContents.executeJavaScript(String.raw`
      (async () => {
        const toggle = document.querySelector('.guild-top-actions .guild-icon-button');
        if (!(toggle instanceof HTMLButtonElement)) throw new Error('fixture_workbench_toggle_missing');
        toggle.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const shell = document.querySelector('.guild-shell');
        const main = document.querySelector('.guild-main');
        const panel = document.querySelector('.guild-workbench');
        if (!(shell instanceof HTMLElement) || !(main instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
          throw new Error('fixture_workbench_column_missing');
        }
        const mainRect = main.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        if (!shell.classList.contains('workbench-open') || Math.abs(mainRect.right - panelRect.left) > 1) {
          throw new Error('fixture_workbench_not_parallel');
        }
        if (getComputedStyle(panel).position === 'absolute') throw new Error('fixture_workbench_overlay');
        ${state === "workbench" ? String.raw`
        const separator = document.querySelector('.guild-workbench-resizer');
        if (!(separator instanceof HTMLElement)) throw new Error('fixture_workbench_resizer_missing');
        const before = Number(separator.getAttribute('aria-valuenow'));
        separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        const after = Number(separator.getAttribute('aria-valuenow'));
        if (!(after > before) || window.localStorage.getItem('guild:v1:workbench-width') !== String(after)) {
          throw new Error('fixture_workbench_resize_not_persisted');
        }
        ` : ""}
      })()
    `, true);
  } else if (state === "run-boundaries" || state === "recovery" || state === "recovery-narrow" || state === "recovery-wide" || state === "queue-preempt") {
    await window.webContents.executeJavaScript(String.raw`
      (() => {
        const conversation = document.querySelector('.guild-conversation');
        if (!(conversation instanceof HTMLElement)) throw new Error('fixture_conversation_missing');
        conversation.scrollTop = conversation.scrollHeight;
      })()
    `, true);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

async function waitForFixtureShell(window: BrowserWindow): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await window.webContents.executeJavaScript(
      "document.querySelector('.guild-shell') !== null",
      true,
    ) as unknown;
    if (ready === true) {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture_shell_timeout");
}

function validatedFixtureCapturePath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || normalize(value) !== value) throw new Error("fixture_capture_path_invalid");
  return value;
}

function validatedFixtureUiState(value: string | undefined): "slash" | "command-palette" | "task-menu" | "task-hover" | "account" | "account-narrow" | "settings" | "settings-narrow" | "settings-grok" | "settings-grok-narrow" | "grok-control" | "grok-control-narrow" | "statuses" | "statuses-narrow" | "workbench" | "workbench-narrow" | "waiting" | "run-boundaries" | "recovery" | "recovery-narrow" | "recovery-wide" | "queue-preempt" | undefined {
  if (value === undefined) return undefined;
  if (
    value !== "slash" &&
    value !== "command-palette" &&
    value !== "task-menu" &&
    value !== "task-hover" &&
    value !== "account" &&
    value !== "account-narrow" &&
    value !== "settings" &&
    value !== "settings-narrow" &&
    value !== "settings-grok" &&
    value !== "settings-grok-narrow" &&
    value !== "grok-control" &&
    value !== "grok-control-narrow" &&
    value !== "statuses" &&
    value !== "statuses-narrow" &&
    value !== "workbench" &&
    value !== "workbench-narrow" &&
    value !== "waiting" &&
    value !== "run-boundaries" &&
    value !== "recovery" &&
    value !== "recovery-narrow" &&
    value !== "recovery-wide" &&
    value !== "queue-preempt"
  ) throw new Error("fixture_ui_state_invalid");
  return value;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void completeShutdown();
});

async function completeShutdown(): Promise<void> {
  const clean = await shutdown().catch(() => false);
  if (restoreStage !== undefined) {
    const copy = restoreMessages(restoreChinese);
    const outcome = await finishRestoreShutdown(restoreStage, app.getPath("userData"), clean)
      .catch(() => "cancelled" as const);
    if (outcome === "cancelled") {
      dialog.showErrorBox(copy.failed, copy.closeFailed);
      shutdownComplete = true;
      app.exit(1);
      return;
    }
    if (outcome === "exchange_failed") dialog.showErrorBox(copy.failed, copy.exchangeFailed);
    app.relaunch();
  }
  shutdownComplete = true;
  if (clean) app.quit();
  else app.exit(1);
}

async function shutdown(): Promise<boolean> {
  closeTaskNotifications?.();
  closeTaskNotifications = undefined;
  closeIpc?.();
  closeIpc = undefined;
  const currentWindow = guildWindow;
  guildWindow = undefined;
  if (currentWindow !== undefined && !currentWindow.isDestroyed()) {
    currentWindow.destroy();
  }
  // The router's requests write thinking provenance into the store the service is about to close.
  const currentRouterHost = modelRouterHost;
  const currentBrowserBridge = browserBridge;
  modelRouterHost = undefined;
  modelSources = undefined;
  browserBridge = undefined;
  browserPane = undefined;
  await currentRouterHost?.close().catch(() => undefined);
  await currentBrowserBridge?.mcp.close().catch(() => undefined);
  await routerLog?.flush().catch(() => undefined);
  const currentService = service;
  service = undefined;
  if (currentService === undefined) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clean = await Promise.race([
    currentService.close().then(() => true, () => false),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!clean && process.env["GUILD_DESKTOP_DEBUG"] === "1") {
    console.error("guild_shutdown_forced");
  }
  return clean;
}
