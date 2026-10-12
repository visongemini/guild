import { BrowserWindow, screen } from "electron";
import { denyPermissions, hardenWebContents } from "./window-guards.js";
import { fitInitialWindowBounds } from "./window-bounds.js";

// The guards live in window-guards.ts so they can be unit-tested without Electron. Guild's own
// window uses them exactly as before; browser-pane tabs get their policy from BrowserPaneController
// and are recognised only by the id registry in window-guards.ts.
export { browserPaneRegistry, isBrowserPaneContents, isTrustedGuildSender } from "./window-guards.js";

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
