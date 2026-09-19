import { restoreMessages } from "./restore-messages.js";
import { finishRestoreShutdown, finishLocalRestore, recoverLocalRestore } from "./local-backup.js";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, normalize } from "node:path";
import { app, dialog, Notification, powerMonitor, shell, type BrowserWindow } from "electron";
import {
  installGuildAppProtocol,
  installGuildMediaProtocol,
  registerGuildScheme,
} from "./app-protocol.js";
import type { DesktopApplicationService } from "./application-service.js";
import { registerDesktopIpc } from "./ipc-handlers.js";
import { createLiveDesktopService } from "./live-service.js";
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

let closeIpc: (() => void) | undefined;
let closeTaskNotifications: (() => void) | undefined;
let service: DesktopApplicationService | undefined;
let guildWindow: BrowserWindow | undefined;
let preloadPath = "";
let shutdownStarted = false;
let restoreStage: string | undefined;
let restoreChinese = true;
let validatingRestoreBoot = false;
let shutdownComplete = false;
let rendererRecoveryFailures = 0;
let rendererRecoveryErrorPending = false;
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
    : join(app.getPath("appData"), "Guild-v2"),
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
  } else {
    service = createLiveDesktopService({
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
  closeIpc = registerDesktopIpc(window, service);
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
  state: "slash" | "command-palette" | "task-menu" | "task-hover" | "account" | "account-narrow" | "settings" | "settings-narrow" | "settings-grok" | "settings-grok-narrow" | "grok-control" | "grok-control-narrow" | "statuses" | "statuses-narrow" | "workbench" | "workbench-narrow" | "waiting" | "run-boundaries" | "recovery" | "recovery-narrow" | "recovery-wide" | "queue-preempt" | "banny-seat" | "banny-home" | "banny-free" | undefined,
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
  } else if (state === "banny-seat" || state === "banny-home" || state === "banny-free") {
    await window.webContents.executeJavaScript(String.raw`
      (async () => {
        const newTask = document.querySelector('.guild-new-task');
        if (!(newTask instanceof HTMLButtonElement)) throw new Error('fixture_new_task_missing');
        newTask.click();
        for (let attempt = 0; attempt < 40 && document.querySelector('.guild-banny') === null; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const banny = document.querySelector('.guild-banny');
        const tasks = document.querySelectorAll('.guild-task-row');
        const target = tasks.item(1);
        if (!(banny instanceof HTMLImageElement)) throw new Error('fixture_banny_missing');
        if (!(target instanceof HTMLButtonElement)) throw new Error('fixture_banny_target_missing');
        const dataTransfer = new DataTransfer();
        banny.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        ${state === "banny-home" || state === "banny-free" ? String.raw`
        await new Promise((resolve) => setTimeout(resolve, 50));
        const seated = document.querySelector('.guild-task-banny');
        const shell = document.querySelector('.guild-shell');
        const conversation = document.querySelector('.guild-conversation');
        if (!(seated instanceof HTMLImageElement)) throw new Error('fixture_banny_seat_missing');
        if (!(shell instanceof HTMLDivElement)) throw new Error('fixture_banny_shell_missing');
        if (!(conversation instanceof HTMLElement)) throw new Error('fixture_banny_conversation_missing');
        const nextTransfer = new DataTransfer();
        const shellRect = shell.getBoundingClientRect();
        const conversationRect = conversation.getBoundingClientRect();
        seated.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: nextTransfer }));
        shell.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: nextTransfer,
          clientX: ${state === "banny-home" ? "conversationRect.left + conversationRect.width / 2" : "shellRect.right - 100"},
          clientY: ${state === "banny-home" ? "conversationRect.top + conversationRect.height / 2" : "shellRect.top + 180"},
        }));
        shell.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: nextTransfer,
          clientX: ${state === "banny-home" ? "conversationRect.left + conversationRect.width / 2" : "shellRect.right - 100"},
          clientY: ${state === "banny-home" ? "conversationRect.top + conversationRect.height / 2" : "shellRect.top + 180"},
        }));
        ` : ""}
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

function validatedFixtureUiState(value: string | undefined): "slash" | "command-palette" | "task-menu" | "task-hover" | "account" | "account-narrow" | "settings" | "settings-narrow" | "settings-grok" | "settings-grok-narrow" | "grok-control" | "grok-control-narrow" | "statuses" | "statuses-narrow" | "workbench" | "workbench-narrow" | "waiting" | "run-boundaries" | "recovery" | "recovery-narrow" | "recovery-wide" | "queue-preempt" | "banny-seat" | "banny-home" | "banny-free" | undefined {
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
    value !== "queue-preempt" &&
    value !== "banny-seat" &&
    value !== "banny-home" &&
    value !== "banny-free"
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
