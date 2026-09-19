import { BrowserWindow, screen, type Session, type WebContents } from "electron";
import { isTrustedGuildAppUrl } from "./guild-url.js";
import { fitInitialWindowBounds } from "./window-bounds.js";

export function createGuildWindow(
  preloadPath: string,
  devToolsEnabled: boolean,
  showWhenReady = true,
): BrowserWindow {
  const bounds = fitInitialWindowBounds(screen.getPrimaryDisplay().workAreaSize);
  const window = new BrowserWindow({
    ...bounds,
    center: true,
    show: false,
    backgroundColor: "#ffffff",
    title: "Guild",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false,
      navigateOnDragDrop: false,
      plugins: false,
      safeDialogs: true,
      spellcheck: true,
      devTools: devToolsEnabled,
    },
  });
  hardenWebContents(window.webContents);
  if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
    window.webContents.on("console-message", (_event, level, message) => {
      console.error("guild_renderer_console", level, boundedDiagnostic(message));
    });
    window.webContents.on("preload-error", (_event, _preloadPath, error) => {
      console.error("guild_preload_error", boundedDiagnostic(error.message));
    });
  }
  denyPermissions(window.webContents.session);
  if (showWhenReady) window.once("ready-to-show", () => window.show());
  return window;
}

function boundedDiagnostic(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

export function isTrustedGuildSender(window: BrowserWindow, sender: WebContents, frameUrl: string): boolean {
  if (sender !== window.webContents || sender.isDestroyed()) return false;
  try {
    const url = new URL(frameUrl);
    return isTrustedGuildAppUrl(url) && (url.pathname === "/" || url.pathname === "/index.html");
  } catch {
    return false;
  }
}

function hardenWebContents(contents: WebContents): void {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function denyPermissions(session: Session): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
}
