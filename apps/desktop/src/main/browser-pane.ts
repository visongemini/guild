/**
 * The isolated browser pane (PC-BROWSER-001): up to five tabs, each its own web contents in the
 * partition `persist:guild-browser`, attached to the Guild window and driven by the user (through
 * `command`) or by the agent (through the `tools` surface the loopback MCP server uses).
 *
 * Electron is reached only through the small `BrowserPaneHost` / `PaneWebContents` seam below, so
 * every policy in this file (navigation, window.open, downloads, webview, debugger timing, agent
 * control) is unit-tested with fakes. `browser-pane-electron.ts` is the thin real implementation.
 */

import {
  GUILD_BROWSER_LIMITS,
  type BrowserAgentControl,
  type BrowserCommand,
  type BrowserPaneProjection,
  type BrowserTabProjection,
} from "@guild/contracts";
import {
  browserPaneRegistry,
  isPaneNavigationAllowed,
  isPaneUrlAllowed,
  type BrowserPaneRegistry,
} from "./window-guards.js";

// ---------------------------------------------------------------------------------------------
// Public shapes (the command and projection types are the canonical ones from @guild/contracts)
// ---------------------------------------------------------------------------------------------

/** The rectangle handed to the native view: the four fields of the contracts `setBounds` command. */
export type BrowserPaneBounds = Readonly<Pick<Extract<BrowserCommand, { kind: "setBounds" }>, "x" | "y" | "width" | "height">>;

export type BrowserPaneCommandFailure =
  | "invalid_url"
  | "invalid_bounds"
  | "tab_limit"
  | "unknown_tab"
  | "no_tab"
  | "failed";

export type BrowserPaneCommandResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: BrowserPaneCommandFailure }>;

// ---------------------------------------------------------------------------------------------
// Fixed policy values
// ---------------------------------------------------------------------------------------------

export const BROWSER_PANE_PARTITION = "persist:guild-browser";
/** The agent badge goes back to idle this long after the last tool call ended. */
export const BROWSER_PANE_IDLE_DEBOUNCE_MS = 1_500;
export const BROWSER_PANE_PAUSED_MESSAGE = "Paused by the user in Guild";

/**
 * Web preferences of every pane tab: the docs/09 baseline plus the pane specifics. There is no
 * preload, no Node, no webview tag and no DevTools; the partition is applied by the host.
 */
export const BROWSER_PANE_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  plugins: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
  backgroundThrottling: false,
  devTools: false,
});

/**
 * Chromium switches the pane needs; `configureBrowserPaneProcess` must run before the app is ready.
 * Without `disable-backgrounding-occluded-windows` a window that another app covers (or that is in
 * the background) counts as hidden: pages report `visibilityState: "hidden"`, stop producing frames,
 * and the agent's first clicks and screenshots are silently dropped (verified on Electron 43.4.1,
 * 2026-10-12). The cost is that Guild's own page keeps painting while covered, which is negligible.
 */
export const BROWSER_PANE_COMMAND_LINE_SWITCHES: readonly string[] = Object.freeze(["disable-backgrounding-occluded-windows"]);

export function configureBrowserPaneProcess(app: Readonly<{ commandLine: Readonly<{ appendSwitch: (name: string) => void }> }>): void {
  for (const name of BROWSER_PANE_COMMAND_LINE_SWITCHES) app.commandLine.appendSwitch(name);
}

const DEFAULT_BOUNDS: BrowserPaneBounds = Object.freeze({ x: 0, y: 0, width: 800, height: 600 });
const MAX_BOUNDS_VALUE = 16_384;
const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 8_192;
const NETWORK_BUFFER_SIZE = 200;
const CONSOLE_BUFFER_SIZE = 200;
const CDP_TIMEOUT_MS = 20_000;
const FIRST_LOAD_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 20_000;
const HISTORY_SETTLE_DELAY_MS = 100;

// ---------------------------------------------------------------------------------------------
// The Electron seam
// ---------------------------------------------------------------------------------------------

export type PaneNavigationEvent = Readonly<{ url: string; preventDefault: () => void }>;

/** Everything a pane web contents reports. The controller makes every decision. */
export type PaneContentsHandlers = Readonly<{
  /** Fired for will-navigate, will-frame-navigate and will-redirect alike. */
  willNavigate: (event: PaneNavigationEvent) => void;
  willAttachWebview: (event: Readonly<{ preventDefault: () => void }>) => void;
  /** window.open and target=_blank. The host always denies the native window. */
  windowOpen: (details: Readonly<{ url: string }>) => void;
  didStartLoading: () => void;
  didStopLoading: () => void;
  didFinishLoad: () => void;
  didFailLoad: (details: Readonly<{ errorCode: number; errorDescription: string; isMainFrame: boolean }>) => void;
  /** Cross-document and in-page navigations: the URL or history flags changed. */
  didNavigate: () => void;
  titleUpdated: () => void;
  renderProcessGone: () => void;
  destroyed: () => void;
}>;

export type PaneDebugger = Readonly<{
  attach: () => void;
  detach: () => void;
  isAttached: () => boolean;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onEvent: (listener: (method: string, params: unknown) => void) => void;
  onDetach: (listener: () => void) => void;
}>;

export type PaneWebContents = Readonly<{
  id: number;
  isDestroyed: () => boolean;
  getURL: () => string;
  getTitle: () => string;
  isLoading: () => boolean;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  loadURL: (url: string) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  /** Installs the handlers once, right after creation, before anything is loaded. */
  setHandlers: (handlers: PaneContentsHandlers) => void;
  debugger: PaneDebugger;
}>;

export type PaneView = Readonly<{
  contents: PaneWebContents;
  setBounds: (bounds: BrowserPaneBounds) => void;
  setVisible: (visible: boolean) => void;
}>;

/**
 * One request of the pane session as the main process sees it (Electron webRequest). The network log
 * comes from here, not from CDP Network events: on a tab's first navigation Chromium swaps the render
 * frame host and the CDP Network domain can miss the page's first requests (8 of 30 fresh-tab loads in
 * a race test on Electron 43.4.1), while the main-process view missed none in the same test.
 */
export type PaneNetworkEvent = Readonly<{
  phase: "sent" | "response" | "failed";
  contentsId: number;
  requestId: string;
  method: string;
  url: string;
  status?: number;
}>;

export type PaneDownload = Readonly<{
  /** Id of the web contents that started the download. */
  contentsId: number;
  filename: string;
  /** Lets the native save dialog decide; cancelling the dialog cancels the download. */
  promptSave: (defaultFilename: string) => void;
  cancel: () => void;
}>;

export type BrowserPaneHost = Readonly<{
  /** A new hardened tab (partition, preferences, no preload), attached to the Guild window and hidden. */
  createView: () => PaneView;
  /** Detaches the view from the window and closes its contents. Must tolerate destroyed contents. */
  destroyView: (view: PaneView) => void;
  onDownload: (listener: (download: PaneDownload) => void) => void;
  onNetworkEvent: (listener: (event: PaneNetworkEvent) => void) => void;
}>;

export type PaneTimers = Readonly<{
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

// ---------------------------------------------------------------------------------------------
// The agent tool surface (used by browser-mcp)
// ---------------------------------------------------------------------------------------------

/** An error whose message is safe and useful to show to the model. */
export class BrowserToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserToolError";
  }
}

export type BrowserPageInfo = Readonly<{ tabId: string; url: string; title: string; loading: boolean }>;
export type BrowserConsoleEntry = Readonly<{ level: string; text: string }>;
export type BrowserNetworkEntry = Readonly<{ method: string; url: string; status: number | undefined; failed: boolean }>;

export type BrowserPaneToolSurface = Readonly<{
  /**
   * Runs one agent tool call. Rejects with the paused message when the user has taken over;
   * otherwise shows "operating" for as long as the call runs and returns to idle shortly after.
   */
  runAgentTool: <T>(run: () => Promise<T>) => Promise<T>;
  /** Loads the URL in the active tab (opening a tab when there is none) and waits for the load. */
  navigate: (url: string) => Promise<BrowserPageInfo>;
  goBack: () => Promise<BrowserPageInfo>;
  goForward: () => Promise<BrowserPageInfo>;
  reload: () => Promise<BrowserPageInfo>;
  /** One Chrome DevTools Protocol command on the active tab; waits for the debugger to be ready. */
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /**
   * False while the user has the pane hidden (another workbench tab, workbench closed). A hidden page
   * still loads, reads and answers script, but screenshots and input events stall, so those tools
   * check this first.
   */
  isOnScreen: () => boolean;
  activeTab: () => BrowserTabProjection | undefined;
  tabs: () => readonly BrowserTabProjection[];
  selectTab: (tabId: string) => boolean;
  consoleMessages: () => readonly BrowserConsoleEntry[];
  networkRequests: () => readonly BrowserNetworkEntry[];
}>;

export type BrowserPaneController = Readonly<{
  projection: () => BrowserPaneProjection;
  /** Called whenever the projection changes. Returns the unsubscribe function. */
  subscribe: (listener: (projection: BrowserPaneProjection) => void) => () => void;
  command: (command: BrowserCommand) => Promise<BrowserPaneCommandResult>;
  tools: BrowserPaneToolSurface;
  /** Closes every tab and stops all timers. */
  dispose: () => void;
}>;

export type BrowserPaneDeps = Readonly<{
  host: BrowserPaneHost;
  /** Defaults to the process-wide registry that the app-level guards consult. */
  registry?: BrowserPaneRegistry;
  timers?: PaneTimers;
}>;

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

type RingBuffer<T> = { readonly items: T[]; readonly capacity: number };

function ringPush<T>(buffer: RingBuffer<T>, item: T): void {
  buffer.items.push(item);
  if (buffer.items.length > buffer.capacity) buffer.items.splice(0, buffer.items.length - buffer.capacity);
}

type NetworkRecord = { method: string; url: string; status: number | undefined; failed: boolean };

type Tab = {
  readonly id: string;
  readonly view: PaneView;
  readonly contents: PaneWebContents;
  readonly unregister: () => void;
  readonly console: RingBuffer<BrowserConsoleEntry>;
  /** Insertion ordered by request id (from the webRequest feed); the oldest entries are dropped past the capacity. */
  readonly network: Map<string, NetworkRecord>;
  readonly stopWaiters: Set<() => void>;
  firstLoadDone: boolean;
  readonly firstLoadWaiters: Set<() => void>;
  attaching: Promise<void> | undefined;
  closed: boolean;
  /** What was last pushed to the native view, so unchanged layout is not re-applied. */
  applied: { bounds: string; visible: boolean } | undefined;
};

function boundedText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function createBrowserPaneController(deps: BrowserPaneDeps): BrowserPaneController {
  const { host } = deps;
  const registry = deps.registry ?? browserPaneRegistry;
  const timers: PaneTimers = deps.timers ?? {
    setTimeout: (callback, ms) => {
      const handle = setTimeout(callback, ms);
      handle.unref?.();
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  const tabs: Tab[] = [];
  const listeners = new Set<(projection: BrowserPaneProjection) => void>();
  let tabSequence = 0;
  let activeTabId: string | null = null;
  let bounds: BrowserPaneBounds = DEFAULT_BOUNDS;
  let visible = false;
  let agentControl: BrowserAgentControl = "idle";
  let operatingCalls = 0;
  let idleTimer: unknown;
  let lastKey = "";
  let disposed = false;

  // ---- projection -----------------------------------------------------------------------

  function tabProjection(tab: Tab): BrowserTabProjection {
    if (tab.closed || tab.contents.isDestroyed()) {
      return { id: tab.id, url: "about:blank", title: "", loading: false, canGoBack: false, canGoForward: false };
    }
    const url = tab.contents.getURL();
    return {
      id: tab.id,
      url: boundedText(url === "" ? "about:blank" : url, MAX_URL_LENGTH),
      title: boundedText(tab.contents.getTitle(), MAX_TITLE_LENGTH),
      loading: tab.contents.isLoading(),
      canGoBack: tab.contents.canGoBack(),
      canGoForward: tab.contents.canGoForward(),
    };
  }

  function projection(): BrowserPaneProjection {
    return { tabs: tabs.map(tabProjection), activeTabId, agentControl };
  }

  function emit(): void {
    if (disposed) return;
    const next = projection();
    const key = JSON.stringify(next);
    if (key === lastKey) return;
    lastKey = key;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A faulty subscriber must not break the pane.
      }
    }
  }

  function activeTab(): Tab | undefined {
    return tabs.find((tab) => tab.id === activeTabId);
  }

  /**
   * Only the active tab is shown, and only while the pane is on screen. A hidden view (or one outside
   * the window, or zero-sized) is hidden for Chromium too: it stops answering screenshots and input,
   * which is why the render-dependent tools refuse while `visible` is false.
   */
  function applyLayout(): void {
    const boundsKey = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    for (const tab of tabs) {
      const show = visible && tab.id === activeTabId;
      const before = tab.applied;
      if (before === undefined || before.bounds !== boundsKey) tab.view.setBounds(bounds);
      if (before === undefined || before.visible !== show) tab.view.setVisible(show);
      tab.applied = { bounds: boundsKey, visible: show };
    }
  }

  // ---- agent control --------------------------------------------------------------------

  function setAgentControl(next: BrowserAgentControl): void {
    if (agentControl === next) return;
    agentControl = next;
    emit();
  }

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) timers.clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function scheduleIdle(): void {
    clearIdleTimer();
    idleTimer = timers.setTimeout(() => {
      idleTimer = undefined;
      if (operatingCalls === 0 && agentControl === "operating") setAgentControl("idle");
    }, BROWSER_PANE_IDLE_DEBOUNCE_MS);
  }

  function assertNotPaused(): void {
    if (agentControl === "paused") throw new BrowserToolError(BROWSER_PANE_PAUSED_MESSAGE);
  }

  async function runAgentTool<T>(run: () => Promise<T>): Promise<T> {
    assertNotPaused();
    operatingCalls += 1;
    clearIdleTimer();
    setAgentControl("operating");
    try {
      return await run();
    } finally {
      operatingCalls -= 1;
      if (operatingCalls === 0 && agentControl === "operating") scheduleIdle();
    }
  }

  // ---- helpers --------------------------------------------------------------------------

  function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = timers.setTimeout(() => reject(new BrowserToolError(message)), ms);
      promise.then(
        (value) => {
          timers.clearTimeout(handle);
          resolve(value);
        },
        (error: unknown) => {
          timers.clearTimeout(handle);
          reject(error);
        },
      );
    });
  }

  /** Resolves true when the callback-style waiter fired, false on timeout. */
  function waitFor(waiters: Set<() => void>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let handle: unknown;
      const onEvent = () => done(true);
      const done = (value: boolean) => {
        if (handle !== undefined) timers.clearTimeout(handle);
        waiters.delete(onEvent);
        resolve(value);
      };
      waiters.add(onEvent);
      handle = timers.setTimeout(() => done(false), ms);
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      timers.setTimeout(resolve, ms);
    });
  }

  function flush(waiters: Set<() => void>): void {
    for (const waiter of [...waiters]) waiter();
  }

  // ---- debugger -------------------------------------------------------------------------

  function recordDebuggerEvent(tab: Tab, method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(p["args"]) ? (p["args"] as Record<string, unknown>[]) : [];
      const text = args
        .map((arg) => {
          const value = arg["value"];
          if (typeof value === "string") return value;
          if (value !== undefined) return JSON.stringify(value);
          const description = arg["description"];
          return typeof description === "string" ? description : String(arg["type"] ?? "");
        })
        .join(" ");
      ringPush(tab.console, { level: String(p["type"] ?? "log"), text: boundedText(text, 500) });
    } else if (method === "Runtime.exceptionThrown") {
      const details = (p["exceptionDetails"] ?? {}) as Record<string, unknown>;
      const exception = (details["exception"] ?? {}) as Record<string, unknown>;
      const text = typeof exception["description"] === "string" ? exception["description"] : String(details["text"] ?? "exception");
      ringPush(tab.console, { level: "error", text: boundedText(text, 500) });
    }
  }

  function recordNetworkEvent(event: PaneNetworkEvent): void {
    const tab = tabs.find((candidate) => candidate.contents.id === event.contentsId);
    if (tab === undefined) return;
    let record = tab.network.get(event.requestId);
    if (record === undefined) {
      record = { method: event.method, url: boundedText(event.url, 500), status: undefined, failed: false };
      tab.network.set(event.requestId, record);
      while (tab.network.size > NETWORK_BUFFER_SIZE) {
        const oldest = tab.network.keys().next();
        if (oldest.done === true) break;
        tab.network.delete(oldest.value);
      }
    }
    if (event.phase === "response" && event.status !== undefined) record.status = event.status;
    if (event.phase === "failed") record.failed = true;
  }

  async function attachDebugger(tab: Tab): Promise<void> {
    if (!tab.firstLoadDone) {
      const loaded = await waitFor(tab.firstLoadWaiters, FIRST_LOAD_TIMEOUT_MS);
      if (!loaded) throw new BrowserToolError("The page has not finished its first load");
    }
    if (tab.closed || tab.contents.isDestroyed()) throw new BrowserToolError("The tab was closed");
    const dbg = tab.contents.debugger;
    if (dbg.isAttached()) return;
    dbg.attach();
    await withTimeout(dbg.send("Runtime.enable"), CDP_TIMEOUT_MS, "Browser debugger did not answer");
  }

  function ensureDebugger(tab: Tab): Promise<void> {
    if (tab.contents.debugger.isAttached()) return Promise.resolve();
    if (tab.attaching === undefined) {
      const attempt = attachDebugger(tab).finally(() => {
        if (tab.attaching === attempt) tab.attaching = undefined;
      });
      tab.attaching = attempt;
    }
    return tab.attaching;
  }

  async function sendCdp(tab: Tab, method: string, params?: Record<string, unknown>): Promise<unknown> {
    await ensureDebugger(tab);
    return withTimeout(
      tab.contents.debugger.send(method, params),
      CDP_TIMEOUT_MS,
      `Browser debugger timed out on ${method}. If the Guild window is minimized or the Browser tab is closed, ask the user to bring it back.`,
    );
  }

  // ---- tabs -----------------------------------------------------------------------------

  function openTab(): Tab | undefined {
    if (tabs.length >= GUILD_BROWSER_LIMITS.maxTabs || disposed) return undefined;
    const view = host.createView();
    const contents = view.contents;
    tabSequence += 1;
    const tab: Tab = {
      id: `tab-${tabSequence}`,
      view,
      contents,
      unregister: registry.register(contents.id),
      console: { items: [], capacity: CONSOLE_BUFFER_SIZE },
      network: new Map(),
      stopWaiters: new Set(),
      firstLoadDone: false,
      firstLoadWaiters: new Set(),
      attaching: undefined,
      closed: false,
      applied: undefined,
    };
    contents.setHandlers({
      willNavigate: (event) => {
        if (!isPaneNavigationAllowed(contents.id, event.url, registry)) event.preventDefault();
      },
      willAttachWebview: (event) => event.preventDefault(),
      windowOpen: ({ url }) => {
        // Deferred: the opener is still inside Electron's window.open handler.
        if (isPaneNavigationAllowed(contents.id, url, registry) && url !== "about:blank" && tabs.length < GUILD_BROWSER_LIMITS.maxTabs) {
          queueMicrotask(() => {
            if (tab.closed || disposed) return;
            const opened = openTab();
            if (opened !== undefined) void load(opened, url).catch(() => undefined);
          });
        }
      },
      didStartLoading: () => emit(),
      didStopLoading: () => {
        flush(tab.stopWaiters);
        emit();
      },
      didFinishLoad: () => {
        markFirstLoad(tab);
        void ensureDebugger(tab).catch(() => undefined);
        emit();
      },
      didFailLoad: ({ errorCode, isMainFrame }) => {
        // -3 (aborted) means another navigation superseded this one; its own events follow.
        if (isMainFrame && errorCode !== -3) markFirstLoad(tab);
        emit();
      },
      didNavigate: () => emit(),
      titleUpdated: () => emit(),
      renderProcessGone: () => {
        flush(tab.stopWaiters);
        emit();
      },
      destroyed: () => removeTab(tab, false),
    });
    contents.debugger.onEvent((method, params) => recordDebuggerEvent(tab, method, params));
    contents.debugger.onDetach(() => {
      tab.attaching = undefined;
    });
    tabs.push(tab);
    activeTabId = tab.id;
    applyLayout();
    emit();
    // Every tab is born at about:blank. Its first finished load is when the debugger may attach, so
    // the real page (loaded afterwards) is observed from its first request and console line.
    void contents.loadURL("about:blank").catch(() => undefined);
    return tab;
  }

  function markFirstLoad(tab: Tab): void {
    if (tab.firstLoadDone) return;
    tab.firstLoadDone = true;
    flush(tab.firstLoadWaiters);
  }

  function removeTab(tab: Tab, destroyNative: boolean): void {
    if (tab.closed) return;
    tab.closed = true;
    const index = tabs.indexOf(tab);
    if (index >= 0) tabs.splice(index, 1);
    flush(tab.firstLoadWaiters);
    flush(tab.stopWaiters);
    try {
      if (tab.contents.debugger.isAttached()) tab.contents.debugger.detach();
    } catch {
      // The contents may already be gone.
    }
    tab.unregister();
    if (destroyNative) {
      try {
        host.destroyView(tab.view);
      } catch {
        // Closing is best effort; the tab is already out of the registry and the projection.
      }
    }
    if (activeTabId === tab.id) {
      activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    }
    applyLayout();
    emit();
  }

  /** Waits for the tab's about:blank load and the debugger attach; the real load goes ahead either way. */
  async function settleInitialLoad(tab: Tab): Promise<void> {
    if (!tab.firstLoadDone && !(await waitFor(tab.firstLoadWaiters, FIRST_LOAD_TIMEOUT_MS))) return;
    try {
      await ensureDebugger(tab);
    } catch {
      // Without a debugger the page still loads; the tools report the problem when they need it.
    }
  }

  /** Loads the address and resolves true when the load ended, false when it was still going after the timeout. */
  async function load(tab: Tab, url: string): Promise<boolean> {
    await settleInitialLoad(tab);
    if (tab.closed || tab.contents.isDestroyed()) throw new BrowserToolError("The tab was closed");
    try {
      await withTimeout(tab.contents.loadURL(url), LOAD_TIMEOUT_MS, "navigation_timeout");
      return true;
    } catch (error) {
      if (error instanceof BrowserToolError && error.message === "navigation_timeout") return false;
      throw error;
    }
  }

  function pageInfo(tab: Tab, settled: boolean): BrowserPageInfo {
    const projected = tabProjection(tab);
    return { tabId: tab.id, url: projected.url, title: projected.title, loading: !settled };
  }

  function requireActive(): Tab {
    const tab = activeTab();
    if (tab === undefined) throw new BrowserToolError("No tab is open. Use navigate first.");
    return tab;
  }

  async function navigateTool(url: string): Promise<BrowserPageInfo> {
    assertNotPaused();
    if (!isPaneUrlAllowed(url)) {
      throw new BrowserToolError("This address cannot be opened: only http, https and about:blank are allowed.");
    }
    const tab = activeTab() ?? openTab();
    if (tab === undefined) throw new BrowserToolError("The browser pane is not available.");
    try {
      const settled = await load(tab, url);
      return pageInfo(tab, settled);
    } catch (error) {
      const message = error instanceof Error ? error.message : "load failed";
      throw new BrowserToolError(`Navigation failed: ${boundedText(message, 200)}`);
    }
  }

  async function historyTool(direction: "back" | "forward" | "reload"): Promise<BrowserPageInfo> {
    assertNotPaused();
    const tab = requireActive();
    if (direction === "back") {
      if (!tab.contents.canGoBack()) throw new BrowserToolError("There is no previous page.");
      tab.contents.goBack();
    } else if (direction === "forward") {
      if (!tab.contents.canGoForward()) throw new BrowserToolError("There is no next page.");
      tab.contents.goForward();
    } else {
      tab.contents.reload();
    }
    await sleep(HISTORY_SETTLE_DELAY_MS);
    const settled = tab.contents.isLoading() ? await waitFor(tab.stopWaiters, LOAD_TIMEOUT_MS) : true;
    return pageInfo(tab, settled);
  }

  const tools: BrowserPaneToolSurface = Object.freeze({
    runAgentTool,
    navigate: navigateTool,
    goBack: () => historyTool("back"),
    goForward: () => historyTool("forward"),
    reload: () => historyTool("reload"),
    send: async (method: string, params?: Record<string, unknown>) => {
      assertNotPaused();
      return sendCdp(requireActive(), method, params);
    },
    isOnScreen: () => visible,
    activeTab: () => {
      const tab = activeTab();
      return tab === undefined ? undefined : tabProjection(tab);
    },
    tabs: () => tabs.map(tabProjection),
    selectTab: (tabId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) return false;
      activeTabId = tab.id;
      applyLayout();
      emit();
      return true;
    },
    consoleMessages: () => [...(activeTab()?.console.items ?? [])],
    networkRequests: () => [...(activeTab()?.network.values() ?? [])].map((record) => ({ ...record })),
  });

  // ---- downloads ------------------------------------------------------------------------

  host.onNetworkEvent(recordNetworkEvent);

  host.onDownload((download) => {
    if (!registry.has(download.contentsId)) {
      download.cancel();
      return;
    }
    download.promptSave(safeDownloadName(download.filename));
  });

  // ---- user commands --------------------------------------------------------------------

  function validBounds(candidate: BrowserPaneBounds): boolean {
    const values = [candidate.x, candidate.y, candidate.width, candidate.height];
    return values.every((value) => Number.isFinite(value) && value >= 0 && value <= MAX_BOUNDS_VALUE);
  }

  async function command(input: BrowserCommand): Promise<BrowserPaneCommandResult> {
    if (disposed) return { ok: false, reason: "failed" };
    switch (input.kind) {
      case "navigate": {
        if (!isPaneUrlAllowed(input.url)) return { ok: false, reason: "invalid_url" };
        const tab = activeTab() ?? openTab();
        if (tab === undefined) return { ok: false, reason: "tab_limit" };
        void load(tab, input.url).catch(() => undefined);
        return { ok: true };
      }
      case "newTab": {
        if (input.url !== undefined && !isPaneUrlAllowed(input.url)) return { ok: false, reason: "invalid_url" };
        if (tabs.length >= GUILD_BROWSER_LIMITS.maxTabs) return { ok: false, reason: "tab_limit" };
        const tab = openTab();
        if (tab === undefined) return { ok: false, reason: "failed" };
        if (input.url !== undefined) void load(tab, input.url).catch(() => undefined);
        return { ok: true };
      }
      case "closeTab": {
        const tab = tabs.find((candidate) => candidate.id === input.tabId);
        if (tab === undefined) return { ok: false, reason: "unknown_tab" };
        removeTab(tab, true);
        return { ok: true };
      }
      case "selectTab": {
        return tools.selectTab(input.tabId) ? { ok: true } : { ok: false, reason: "unknown_tab" };
      }
      case "back":
      case "forward":
      case "reload":
      case "stop": {
        const tab = activeTab();
        if (tab === undefined) return { ok: false, reason: "no_tab" };
        if (input.kind === "back") {
          if (tab.contents.canGoBack()) tab.contents.goBack();
        } else if (input.kind === "forward") {
          if (tab.contents.canGoForward()) tab.contents.goForward();
        } else if (input.kind === "reload") {
          tab.contents.reload();
        } else {
          tab.contents.stop();
        }
        return { ok: true };
      }
      case "setBounds": {
        if (!validBounds(input)) return { ok: false, reason: "invalid_bounds" };
        bounds = {
          x: Math.round(input.x),
          y: Math.round(input.y),
          width: Math.round(input.width),
          height: Math.round(input.height),
        };
        applyLayout();
        return { ok: true };
      }
      case "setVisible": {
        visible = input.visible === true;
        applyLayout();
        return { ok: true };
      }
      case "takeOver": {
        clearIdleTimer();
        setAgentControl("paused");
        return { ok: true };
      }
      case "resumeAgent": {
        if (agentControl === "paused") setAgentControl(operatingCalls > 0 ? "operating" : "idle");
        return { ok: true };
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    for (const tab of [...tabs]) removeTab(tab, true);
    disposed = true;
    clearIdleTimer();
    listeners.clear();
  }

  return Object.freeze({
    projection,
    subscribe: (listener: (projection: BrowserPaneProjection) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    command,
    tools,
    dispose,
  });
}

/** A download suggestion: the last path segment only, no control characters, bounded length. */
export function safeDownloadName(filename: string): string {
  const segment = filename.split(/[\\/]/u).pop() ?? "";
  const cleaned = segment.replace(/[\u0000-\u001f\u007f]/gu, "").trim().replace(/^\.+/u, "");
  const bounded = cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
  return bounded === "" ? "download" : bounded;
}
