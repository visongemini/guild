/**
 * The real Electron side of the browser pane: builds the hardened `WebContentsView` tabs in the
 * `persist:guild-browser` partition and maps Electron events onto the `PaneContentsHandlers` seam
 * of browser-pane.ts. It holds no policy of its own; every decision is made by the controller.
 * Not unit-tested (it needs Electron); source-shape tests pin what it wires, and the installed-app
 * acceptance in docs/20 section 6 item 5 exercises it for real.
 */

import { session, WebContentsView, type BaseWindow, type WebContents } from "electron";
import {
  BROWSER_PANE_PARTITION,
  BROWSER_PANE_WEB_PREFERENCES,
  createBrowserPaneController,
  type BrowserPaneController,
  type BrowserPaneHost,
  type PaneContentsHandlers,
  type PaneDebugger,
  type PaneDownload,
  type PaneNetworkEvent,
  type PaneView,
  type PaneWebContents,
} from "./browser-pane.js";
import { denyPermissions } from "./window-guards.js";

const CDP_VERSION = "1.3";

function wrapDebugger(contents: WebContents): PaneDebugger {
  const dbg = contents.debugger;
  return {
    attach: () => dbg.attach(CDP_VERSION),
    detach: () => {
      try {
        dbg.detach();
      } catch {
        // Already detached.
      }
    },
    isAttached: () => dbg.isAttached(),
    send: (method, params) => dbg.sendCommand(method, params),
    onEvent: (listener) => {
      dbg.on("message", (_event, method, params) => listener(method, params));
    },
    onDetach: (listener) => {
      dbg.on("detach", () => listener());
    },
  };
}

function wrapContents(contents: WebContents): PaneWebContents {
  return {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    getURL: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    isLoading: () => contents.isLoading(),
    // Every tab starts at about:blank; that first entry is not a page the user can go back to.
    canGoBack: () => {
      const history = contents.navigationHistory;
      return history.getAllEntries().slice(0, history.getActiveIndex()).some((entry) => entry.url !== "about:blank");
    },
    canGoForward: () => contents.navigationHistory.canGoForward(),
    loadURL: (url) => contents.loadURL(url),
    goBack: () => contents.navigationHistory.goBack(),
    goForward: () => contents.navigationHistory.goForward(),
    reload: () => contents.reload(),
    stop: () => contents.stop(),
    setHandlers: (handlers: PaneContentsHandlers) => {
      // Programmatic loads do not fire these; the controller validates those itself.
      contents.on("will-navigate", (event) => handlers.willNavigate(event));
      contents.on("will-frame-navigate", (event) => handlers.willNavigate(event));
      contents.on("will-redirect", (event) => handlers.willNavigate(event));
      contents.on("will-attach-webview", (event) => handlers.willAttachWebview(event));
      contents.setWindowOpenHandler((details) => {
        handlers.windowOpen({ url: details.url });
        return { action: "deny" };
      });
      contents.on("did-start-loading", () => handlers.didStartLoading());
      contents.on("did-stop-loading", () => handlers.didStopLoading());
      contents.on("did-finish-load", () => handlers.didFinishLoad());
      contents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        handlers.didFailLoad({ errorCode, errorDescription, isMainFrame });
      });
      contents.on("did-navigate", () => handlers.didNavigate());
      contents.on("did-navigate-in-page", () => handlers.didNavigate());
      contents.on("page-title-updated", () => handlers.titleUpdated());
      contents.on("render-process-gone", () => handlers.renderProcessGone());
      contents.on("destroyed", () => handlers.destroyed());
    },
    debugger: wrapDebugger(contents),
  };
}

/** Creates the controller for the Guild window and disposes it when the window closes. */
export function createElectronBrowserPane(window: BaseWindow): BrowserPaneController {
  const paneSession = session.fromPartition(BROWSER_PANE_PARTITION);
  denyPermissions(paneSession);

  const nativeViews = new WeakMap<PaneView, WebContentsView>();
  const downloadListeners: Array<(download: PaneDownload) => void> = [];

  const onWillDownload = (event: Electron.Event, item: Electron.DownloadItem, contents: WebContents | undefined) => {
    const download: PaneDownload = {
      contentsId: contents?.id ?? -1,
      filename: item.getFilename(),
      // Electron shows its native save dialog unless a path is set; cancelling it cancels the download.
      promptSave: (defaultFilename) => item.setSaveDialogOptions({ defaultPath: defaultFilename }),
      cancel: () => {
        event.preventDefault();
      },
    };
    if (downloadListeners.length === 0) {
      download.cancel();
      return;
    }
    for (const listener of downloadListeners) listener(download);
  };
  paneSession.on("will-download", onWillDownload);

  // The network log is fed from the main process (see PaneNetworkEvent). These three listeners are
  // the only webRequest handlers on this session; none of them needs a callback, so no request waits on us.
  const networkListeners: Array<(event: PaneNetworkEvent) => void> = [];
  const emitNetwork = (event: PaneNetworkEvent) => {
    for (const listener of networkListeners) listener(event);
  };
  paneSession.webRequest.onSendHeaders((details) => {
    if (details.webContentsId === undefined) return;
    emitNetwork({ phase: "sent", contentsId: details.webContentsId, requestId: String(details.id), method: details.method, url: details.url });
  });
  paneSession.webRequest.onResponseStarted((details) => {
    if (details.webContentsId === undefined) return;
    emitNetwork({ phase: "response", contentsId: details.webContentsId, requestId: String(details.id), method: details.method, url: details.url, status: details.statusCode });
  });
  paneSession.webRequest.onErrorOccurred((details) => {
    if (details.webContentsId === undefined) return;
    emitNetwork({ phase: "failed", contentsId: details.webContentsId, requestId: String(details.id), method: details.method, url: details.url });
  });

  const host: BrowserPaneHost = {
    createView: () => {
      const native = new WebContentsView({
        webPreferences: { ...BROWSER_PANE_WEB_PREFERENCES, partition: BROWSER_PANE_PARTITION },
      });
      native.setVisible(false);
      window.contentView.addChildView(native);
      const view: PaneView = {
        contents: wrapContents(native.webContents),
        setBounds: (bounds) => native.setBounds(bounds),
        setVisible: (visible) => native.setVisible(visible),
      };
      nativeViews.set(view, native);
      return view;
    },
    destroyView: (view) => {
      const native = nativeViews.get(view);
      if (native === undefined) return;
      nativeViews.delete(view);
      if (!window.isDestroyed()) window.contentView.removeChildView(native);
      if (!native.webContents.isDestroyed()) native.webContents.close();
    },
    onDownload: (listener) => {
      downloadListeners.push(listener);
    },
    onNetworkEvent: (listener) => {
      networkListeners.push(listener);
    },
  };

  const controller = createBrowserPaneController({ host });
  window.once("closed", () => {
    controller.dispose();
    // The session outlives the window; leave nothing of this controller on it for the next one.
    paneSession.off("will-download", onWillDownload);
    paneSession.webRequest.onSendHeaders(null);
    paneSession.webRequest.onResponseStarted(null);
    paneSession.webRequest.onErrorOccurred(null);
  });
  return controller;
}
