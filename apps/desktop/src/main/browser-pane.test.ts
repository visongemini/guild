import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GUILD_BROWSER_LIMITS, type BrowserPaneProjection } from "@guild/contracts";
import {
  BROWSER_PANE_COMMAND_LINE_SWITCHES,
  BROWSER_PANE_IDLE_DEBOUNCE_MS,
  BROWSER_PANE_PARTITION,
  BROWSER_PANE_PAUSED_MESSAGE,
  BROWSER_PANE_TAB_CHANGED_MESSAGE,
  BROWSER_PANE_WEB_PREFERENCES,
  BrowserToolError,
  configureBrowserPaneProcess,
  createBrowserPaneController,
  safeDownloadName,
  type BrowserPaneBounds,
  type BrowserPaneController,
  type BrowserPaneToolSurface,
  type PaneContentsHandlers,
  type PaneDownload,
  type PaneNetworkEvent,
  type PaneTimers,
  type PaneView,
} from "./browser-pane.js";
import { createBrowserPaneRegistry } from "./window-guards.js";

// ---- fakes -----------------------------------------------------------------------------------

class FakeTimers implements PaneTimers {
  now = 0;
  private sequence = 0;
  private readonly pending = new Map<number, { at: number; run: () => void }>();
  setTimeout = (callback: () => void, ms: number): unknown => {
    this.sequence += 1;
    this.pending.set(this.sequence, { at: this.now + ms, run: callback });
    return this.sequence;
  };
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [handle, timer] of [...this.pending]) {
      if (timer.at <= this.now) {
        this.pending.delete(handle);
        timer.run();
      }
    }
  }
  get size(): number {
    return this.pending.size;
  }
}

type Cdp = { method: string; params: Record<string, unknown> | undefined };

class FakeContents {
  static next = 100;
  readonly id = ++FakeContents.next;
  attached = false;
  attachCalls = 0;
  detachCalls = 0;
  cdp: Cdp[] = [];
  cdpHandler: (method: string, params: Record<string, unknown> | undefined) => Promise<unknown> = () => Promise.resolve({});
  eventListeners: Array<(method: string, params: unknown) => void> = [];
  loads: string[] = [];
  url = "";
  title = "";
  loading = false;
  back = false;
  forward = false;
  history: string[] = [];
  autoFinish = true;
  loadError: Error | undefined;
  handlers!: PaneContentsHandlers;
  destroyed = false;
  actions: string[] = [];

  pane = {
    id: this.id,
    isDestroyed: () => this.destroyed,
    getURL: () => this.url,
    getTitle: () => this.title,
    isLoading: () => this.loading,
    canGoBack: () => this.back,
    canGoForward: () => this.forward,
    loadURL: (url: string) => {
      this.loads.push(url);
      if (this.loadError !== undefined) {
        const error = this.loadError;
        queueMicrotask(() => this.handlers.didFailLoad({ errorCode: -102, errorDescription: "ERR_CONNECTION_REFUSED", isMainFrame: true }));
        return Promise.reject(error);
      }
      this.loading = true;
      this.handlers.didStartLoading();
      if (!this.autoFinish) return new Promise<void>(() => undefined);
      return Promise.resolve().then(() => this.finishLoad(url));
    },
    goBack: () => { this.actions.push("back"); },
    goForward: () => { this.actions.push("forward"); },
    reload: () => { this.actions.push("reload"); },
    stop: () => { this.actions.push("stop"); },
    setHandlers: (handlers: PaneContentsHandlers) => { this.handlers = handlers; },
    debugger: {
      attach: () => { this.attached = true; this.attachCalls += 1; },
      detach: () => { this.attached = false; this.detachCalls += 1; },
      isAttached: () => this.attached,
      send: (method: string, params?: Record<string, unknown>) => {
        this.cdp.push({ method, params });
        return this.cdpHandler(method, params);
      },
      onEvent: (listener: (method: string, params: unknown) => void) => { this.eventListeners.push(listener); },
      onDetach: () => undefined,
    },
  };

  finishLoad(url: string): void {
    this.url = url;
    this.loading = false;
    this.handlers.didNavigate();
    this.handlers.didFinishLoad();
    this.handlers.didStopLoading();
  }

  emitDebugger(method: string, params: unknown): void {
    for (const listener of this.eventListeners) listener(method, params);
  }
}

type FakeViewState = {
  contents: FakeContents;
  bounds: BrowserPaneBounds | undefined;
  visible: boolean;
  destroyed: boolean;
  nativeCalls: number;
};

function setup(options: { registry?: ReturnType<typeof createBrowserPaneRegistry>; holdLoads?: boolean } = {}) {
  const registry = options.registry ?? createBrowserPaneRegistry();
  const timers = new FakeTimers();

  const views: FakeViewState[] = [];
  const stateOf = new Map<PaneView, FakeViewState>();
  let downloadListener: ((download: PaneDownload) => void) | undefined;
  let networkListener: ((event: PaneNetworkEvent) => void) | undefined;
  const controller: BrowserPaneController = createBrowserPaneController({
    registry,
    timers,
    host: {
      createView: () => {
        const state: FakeViewState = { contents: new FakeContents(), bounds: undefined, visible: false, destroyed: false, nativeCalls: 0 };
        state.contents.autoFinish = options.holdLoads !== true;
        const view: PaneView = {
          contents: state.contents.pane,
          setBounds: (bounds) => { state.bounds = bounds; state.nativeCalls += 1; },
          setVisible: (visible) => { state.visible = visible; state.nativeCalls += 1; },
        };
        views.push(state);
        stateOf.set(view, state);
        return view;
      },
      destroyView: (view) => {
        const state = stateOf.get(view);
        assert.ok(state);
        state.destroyed = true;
        state.contents.destroyed = true;
      },
      onDownload: (listener) => { downloadListener = listener; },
      onNetworkEvent: (listener) => { networkListener = listener; },
    },
  });
  const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
  return {
    controller, registry, timers, views, flush,
    download: (d: PaneDownload) => downloadListener?.(d),
    network: (e: PaneNetworkEvent) => networkListener?.(e),
  };
}

async function openTabs(env: ReturnType<typeof setup>, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const result = await env.controller.command({ kind: "newTab" });
    assert.deepEqual(result, { ok: true });
  }
  await env.flush();
}

// ---- policy constants ------------------------------------------------------------------------

test("every tab is created with the fixed isolated preferences, the dedicated partition and no preload", async () => {
  assert.equal(BROWSER_PANE_PARTITION, "persist:guild-browser");
  assert.equal(GUILD_BROWSER_LIMITS.maxTabs, 5);
  assert.deepEqual({ ...BROWSER_PANE_WEB_PREFERENCES }, {
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
  assert.equal(Object.isFrozen(BROWSER_PANE_WEB_PREFERENCES), true);
  const adapter = await readFile(new URL("../../src/main/browser-pane-electron.ts", import.meta.url), "utf8");
  assert.match(adapter, /\.\.\.BROWSER_PANE_WEB_PREFERENCES, partition: BROWSER_PANE_PARTITION/u);
  assert.doesNotMatch(adapter, /preload/u);
  assert.match(adapter, /denyPermissions\(paneSession\)/u);
  for (const event of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview", "did-finish-load", "did-fail-load"]) {
    assert.match(adapter, new RegExp(`"${event}"`, "u"), event);
  }
  assert.match(adapter, /setWindowOpenHandler\([\s\S]*?action: "deny"/u);
  assert.match(adapter, /will-download/u);
  assert.match(adapter, /window\.contentView\.addChildView/u);
});

test("the process switch that keeps a covered window's pages alive is applied before ready", () => {
  const applied: string[] = [];
  configureBrowserPaneProcess({ commandLine: { appendSwitch: (name) => { applied.push(name); } } });
  assert.deepEqual(applied, ["disable-backgrounding-occluded-windows"]);
  assert.deepEqual([...BROWSER_PANE_COMMAND_LINE_SWITCHES], applied);
});

test("the pane module names nothing from the Guild window's own policy and Electron only as types", async () => {
  const source = await readFile(new URL("../../src/main/browser-pane.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "electron"/u);
  assert.doesNotMatch(source, /executeJavaScript|eval\(/u);
});

// ---- tabs ------------------------------------------------------------------------------------

test("up to five tabs open, the sixth is refused, and each tab id is registered and unregistered", async () => {
  const env = setup();
  await openTabs(env, 5);
  assert.equal(env.controller.projection().tabs.length, 5);
  assert.equal(env.registry.size(), 5);
  for (const view of env.views) assert.equal(env.registry.has(view.contents.id), true);
  assert.deepEqual(await env.controller.command({ kind: "newTab" }), { ok: false, reason: "tab_limit" });
  assert.equal(env.views.length, 5);

  const [first] = env.controller.projection().tabs;
  assert.ok(first);
  assert.deepEqual(await env.controller.command({ kind: "closeTab", tabId: first.id }), { ok: true });
  assert.equal(env.registry.size(), 4);
  assert.equal(env.registry.has(env.views[0]!.contents.id), false);
  assert.equal(env.views[0]!.destroyed, true);
  assert.deepEqual(await env.controller.command({ kind: "newTab" }), { ok: true });
  assert.equal(env.registry.size(), 5);
});

test("a new tab becomes active; only the active tab is shown, and only while the pane is on screen", async () => {
  const env = setup();
  await openTabs(env, 3);
  const ids = env.controller.projection().tabs.map((tab) => tab.id);
  assert.equal(env.controller.projection().activeTabId, ids[2]);
  assert.deepEqual(env.views.map((view) => view.visible), [false, false, false]);
  assert.equal(env.controller.tools.isOnScreen(), false);

  await env.controller.command({ kind: "setVisible", visible: true });
  assert.equal(env.controller.tools.isOnScreen(), true);
  assert.deepEqual(env.views.map((view) => view.visible), [false, false, true]);

  assert.deepEqual(await env.controller.command({ kind: "selectTab", tabId: ids[0]! }), { ok: true });
  assert.deepEqual(env.views.map((view) => view.visible), [true, false, false]);
  assert.deepEqual(await env.controller.command({ kind: "selectTab", tabId: "tab-99" }), { ok: false, reason: "unknown_tab" });

  await env.controller.command({ kind: "setVisible", visible: false });
  assert.deepEqual(env.views.map((view) => view.visible), [false, false, false]);
  await env.controller.command({ kind: "setVisible", visible: true });

  await env.controller.command({ kind: "selectTab", tabId: ids[1]! });
  await env.controller.command({ kind: "closeTab", tabId: ids[1]! });
  assert.equal(env.controller.projection().activeTabId, ids[2]);
  await env.controller.command({ kind: "closeTab", tabId: ids[2]! });
  assert.equal(env.controller.projection().activeTabId, ids[0]);
  await env.controller.command({ kind: "closeTab", tabId: ids[0]! });
  assert.equal(env.controller.projection().activeTabId, null);
  assert.deepEqual(await env.controller.command({ kind: "closeTab", tabId: ids[0]! }), { ok: false, reason: "unknown_tab" });
});

test("unchanged layout is not pushed to the native view again", async () => {
  const env = setup();
  await openTabs(env, 1);
  await env.controller.command({ kind: "setBounds", x: 1, y: 2, width: 300, height: 400 });
  await env.controller.command({ kind: "setVisible", visible: true });
  const calls = env.views[0]!.nativeCalls;
  await env.controller.command({ kind: "setBounds", x: 1, y: 2, width: 300, height: 400 });
  await env.controller.command({ kind: "setVisible", visible: true });
  assert.equal(env.views[0]!.nativeCalls, calls);
});

test("setBounds rounds and applies to every tab; the default bounds are used until the UI reports", async () => {
  const env = setup();
  await openTabs(env, 2);
  for (const view of env.views) assert.deepEqual(view.bounds, { x: 0, y: 0, width: 800, height: 600 });
  assert.deepEqual(await env.controller.command({ kind: "setBounds", x: 10.4, y: 20.6, width: 300.5, height: 400.2 }), { ok: true });
  for (const view of env.views) assert.deepEqual(view.bounds, { x: 10, y: 21, width: 301, height: 400 });
  for (const bounds of [
    { x: -1, y: 0, width: 10, height: 10 },
    { x: 0, y: 0, width: Number.NaN, height: 10 },
    { x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY },
    { x: 0, y: 0, width: 99_999, height: 10 },
  ]) {
    assert.deepEqual(await env.controller.command({ kind: "setBounds", ...bounds }), { ok: false, reason: "invalid_bounds" });
  }
  for (const view of env.views) assert.deepEqual(view.bounds, { x: 10, y: 21, width: 301, height: 400 });
});

// ---- navigation policy -----------------------------------------------------------------------

test("will-navigate, will-frame-navigate and will-redirect all go through one policy: http(s) and about:blank", async () => {
  const env = setup();
  await openTabs(env, 1);
  const handlers = env.views[0]!.contents.handlers;
  const attempt = (url: string) => {
    let prevented = false;
    handlers.willNavigate({ url, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(attempt("https://example.com/next"), false);
  assert.equal(attempt("http://localhost:3000/"), false);
  assert.equal(attempt("about:blank"), false);
  for (const url of ["file:///etc/hosts", "data:text/html,x", "javascript:alert(1)", "guild-app://app/index.html", "blob:https://a/b", "ftp://example.com/"]) {
    assert.equal(attempt(url), true, url);
  }
});

test("a contents that left the registry no longer gets the pane policy", async () => {
  const env = setup();
  await openTabs(env, 1);
  const view = env.views[0]!;
  env.registry.register(view.contents.id)(); // simulate the id being unregistered
  let prevented = false;
  view.contents.handlers.willNavigate({ url: "https://example.com/", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test("will-attach-webview is always prevented", async () => {
  const env = setup();
  await openTabs(env, 1);
  let prevented = false;
  env.views[0]!.contents.handlers.willAttachWebview({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test("window.open becomes a new tab for http(s) while under the limit, and is dropped otherwise", async () => {
  const env = setup();
  await openTabs(env, 1);
  const opener = env.views[0]!.contents;
  opener.handlers.windowOpen({ url: "https://example.com/popup" });
  await env.flush();
  assert.equal(env.views.length, 2);
  assert.deepEqual(env.views[1]!.contents.loads, ["about:blank", "https://example.com/popup"]);
  assert.equal(env.controller.projection().activeTabId, env.controller.projection().tabs[1]!.id);

  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "guild-app://app/index.html", "about:blank", "data:text/html,x"]) {
    opener.handlers.windowOpen({ url });
  }
  await env.flush();
  assert.equal(env.views.length, 2);

  await openTabs(env, 3);
  assert.equal(env.views.length, 5);
  opener.handlers.windowOpen({ url: "https://example.com/sixth" });
  await env.flush();
  assert.equal(env.views.length, 5);
});

test("user navigation validates the address in main and loads it in the active tab", async () => {
  const env = setup();
  assert.deepEqual(await env.controller.command({ kind: "navigate", url: "file:///etc/passwd" }), { ok: false, reason: "invalid_url" });
  assert.deepEqual(await env.controller.command({ kind: "navigate", url: "example.com" }), { ok: false, reason: "invalid_url" });
  assert.equal(env.views.length, 0);
  assert.deepEqual(await env.controller.command({ kind: "navigate", url: "https://example.com/" }), { ok: true });
  await env.flush();
  assert.equal(env.views.length, 1);
  assert.deepEqual(env.views[0]!.contents.loads, ["about:blank", "https://example.com/"]);
  assert.deepEqual(await env.controller.command({ kind: "newTab", url: "javascript:1" }), { ok: false, reason: "invalid_url" });
  assert.deepEqual(await env.controller.command({ kind: "back" }), { ok: true });
});

test("back, forward, reload and stop act on the active tab only when they make sense", async () => {
  const env = setup();
  assert.deepEqual(await env.controller.command({ kind: "reload" }), { ok: false, reason: "no_tab" });
  await openTabs(env, 2);
  const contents = env.views[1]!.contents;
  await env.controller.command({ kind: "back" });
  await env.controller.command({ kind: "forward" });
  assert.deepEqual(contents.actions, []);
  contents.back = true;
  contents.forward = true;
  await env.controller.command({ kind: "back" });
  await env.controller.command({ kind: "forward" });
  await env.controller.command({ kind: "reload" });
  await env.controller.command({ kind: "stop" });
  assert.deepEqual(contents.actions, ["back", "forward", "reload", "stop"]);
  assert.deepEqual(env.views[0]!.contents.actions, []);
});

// ---- projection ------------------------------------------------------------------------------

test("the projection follows url, title, loading and history flags, and unchanged states emit nothing", async () => {
  const env = setup();
  const seen: BrowserPaneProjection[] = [];
  const unsubscribe = env.controller.subscribe((projection) => seen.push(projection));
  await env.controller.command({ kind: "navigate", url: "https://example.com/" });
  await env.flush();
  const contents = env.views[0]!.contents;
  contents.title = "Example";
  contents.back = true;
  contents.handlers.titleUpdated();
  const last = seen.at(-1)!;
  assert.deepEqual(last.tabs[0], { id: "tab-1", url: "https://example.com/", title: "Example", loading: false, canGoBack: true, canGoForward: false });
  assert.equal(last.activeTabId, "tab-1");
  assert.equal(last.agentControl, "idle");

  const before = seen.length;
  contents.handlers.titleUpdated();
  assert.equal(seen.length, before);
  unsubscribe();
  contents.title = "Changed";
  contents.handlers.titleUpdated();
  assert.equal(seen.length, before);
});

// ---- debugger --------------------------------------------------------------------------------

test("every tab starts at about:blank; the debugger attaches only after that first finished load", async () => {
  const env = setup({ holdLoads: true });
  await env.controller.command({ kind: "newTab" });
  await env.flush();
  const contents = env.views[0]!.contents;
  assert.deepEqual(contents.loads, ["about:blank"]);
  assert.equal(contents.attachCalls, 0);
  assert.equal(contents.cdp.length, 0);
  contents.finishLoad("about:blank");
  await env.flush();
  assert.equal(contents.attachCalls, 1);
  assert.deepEqual(contents.cdp.map((call) => call.method), ["Runtime.enable"]);
  // A later load does not attach again.
  contents.finishLoad("https://example.com/two");
  await env.flush();
  assert.equal(contents.attachCalls, 1);
});

test("the first real page is loaded only after the debugger is attached, so its requests and logs are seen", async () => {
  const env = setup({ holdLoads: true });
  await env.controller.command({ kind: "newTab", url: "https://example.com/first" });
  await env.flush();
  const contents = env.views[0]!.contents;
  assert.deepEqual(contents.loads, ["about:blank"]);
  contents.finishLoad("about:blank");
  await env.flush();
  assert.equal(contents.attachCalls, 1);
  assert.deepEqual(contents.loads, ["about:blank", "https://example.com/first"]);
  // The debugger was enabled before the real load started.
  assert.deepEqual(contents.cdp.map((call) => call.method), ["Runtime.enable"]);
});

test("a failed first load also unblocks the debugger so the error page can be inspected", async () => {
  const env = setup({ holdLoads: true });
  await env.controller.command({ kind: "newTab" });
  const contents = env.views[0]!.contents;
  contents.handlers.didFailLoad({ errorCode: -3, errorDescription: "ERR_ABORTED", isMainFrame: true });
  contents.handlers.didFailLoad({ errorCode: -102, errorDescription: "ERR_CONNECTION_REFUSED", isMainFrame: false });
  await env.flush();
  assert.equal(contents.attachCalls, 0);
  contents.handlers.didFailLoad({ errorCode: -102, errorDescription: "ERR_CONNECTION_REFUSED", isMainFrame: true });
  await env.controller.tools.send("Page.enable");
  assert.equal(contents.attachCalls, 1);
});

test("CDP commands wait for the first load, and an unfinished first load times out", async () => {
  const env = setup({ holdLoads: true });
  await env.controller.command({ kind: "newTab" });
  const contents = env.views[0]!.contents;
  let settled = false;
  const answer = env.controller.tools.send("Runtime.evaluate", { expression: "1" }).then(() => { settled = true; });
  await env.flush();
  assert.equal(settled, false);
  assert.equal(contents.attachCalls, 0);
  contents.finishLoad("about:blank");
  await answer;
  assert.deepEqual(contents.cdp.map((call) => call.method), ["Runtime.enable", "Runtime.evaluate"]);

  const stuck = setup({ holdLoads: true });
  await stuck.controller.command({ kind: "newTab" });
  const waiting = stuck.controller.tools.send("Page.enable");
  await stuck.flush();
  stuck.timers.advance(20_000);
  await assert.rejects(waiting, /not finished its first load/u);
  assert.equal(stuck.views[0]!.contents.attachCalls, 0);
});

test("a first load that never finishes delays navigate by the timeout but the real page is still requested", async () => {
  const env = setup({ holdLoads: true });
  const navigation = env.controller.tools.navigate("https://example.com/late");
  await env.flush();
  const contents = env.views[0]!.contents;
  assert.deepEqual(contents.loads, ["about:blank"]);
  env.timers.advance(20_000);
  await env.flush();
  assert.deepEqual(contents.loads, ["about:blank", "https://example.com/late"]);
  assert.equal(contents.attachCalls, 0);
  env.timers.advance(20_000);
  const info = await navigation;
  assert.equal(info.loading, true);
});

test("closing a tab detaches its debugger and destroys the view", async () => {
  const env = setup();
  await openTabs(env, 1);
  const contents = env.views[0]!.contents;
  assert.equal(contents.attached, true);
  await env.controller.command({ kind: "closeTab", tabId: "tab-1" });
  assert.equal(contents.attached, false);
  assert.equal(contents.detachCalls, 1);
  assert.equal(env.views[0]!.destroyed, true);
  assert.equal(env.registry.size(), 0);
});

test("a tab destroyed by the page leaves the projection and the registry", async () => {
  const env = setup();
  await openTabs(env, 2);
  env.views[0]!.contents.handlers.destroyed();
  assert.deepEqual(env.controller.projection().tabs.map((tab) => tab.id), ["tab-2"]);
  assert.equal(env.registry.size(), 1);
});

test("the console ring buffer follows the debugger events of the active tab", async () => {
  const env = setup();
  await openTabs(env, 1);
  const contents = env.views[0]!.contents;
  contents.emitDebugger("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "careful" }, { type: "number", value: 3 }, { type: "object", description: "Foo" }] });
  contents.emitDebugger("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: x is not defined" } } });
  assert.deepEqual(env.controller.tools.consoleMessages(), [
    { level: "warning", text: "careful 3 Foo" },
    { level: "error", text: "ReferenceError: x is not defined" },
  ]);
  for (let i = 0; i < 250; i += 1) contents.emitDebugger("Runtime.consoleAPICalled", { type: "log", args: [{ value: `m${i}` }] });
  const messages = env.controller.tools.consoleMessages();
  assert.equal(messages.length, 200);
  assert.equal(messages.at(-1)?.text, "m249");
});

test("the network log is fed by main-process request events, per tab, from the first request", async () => {
  const env = setup();
  await openTabs(env, 2);
  const [first, second] = env.views.map((view) => view.contents.id) as [number, number];
  const sent = (contentsId: number, requestId: string, url: string, method = "GET"): PaneNetworkEvent => ({ phase: "sent", contentsId, requestId, method, url });
  env.network(sent(first, "1", "https://example.com/a"));
  env.network(sent(first, "2", "https://example.com/b", "POST"));
  env.network({ phase: "response", contentsId: first, requestId: "1", method: "GET", url: "https://example.com/a", status: 200 });
  env.network({ phase: "failed", contentsId: first, requestId: "2", method: "POST", url: "https://example.com/b" });
  // A cached response may arrive without a "sent" event first.
  env.network({ phase: "response", contentsId: first, requestId: "3", method: "GET", url: "https://example.com/c", status: 304 });
  env.network(sent(second, "9", "https://other.example/x"));
  env.network(sent(424242, "10", "https://nobody.example/"));

  env.controller.tools.selectTab("tab-1");
  assert.deepEqual(env.controller.tools.networkRequests(), [
    { method: "GET", url: "https://example.com/a", status: 200, failed: false },
    { method: "POST", url: "https://example.com/b", status: undefined, failed: true },
    { method: "GET", url: "https://example.com/c", status: 304, failed: false },
  ]);
  env.controller.tools.selectTab("tab-2");
  assert.deepEqual(env.controller.tools.networkRequests(), [{ method: "GET", url: "https://other.example/x", status: undefined, failed: false }]);

  env.controller.tools.selectTab("tab-1");
  for (let i = 0; i < 250; i += 1) env.network(sent(first, `r${i}`, `https://e.com/${i}`));
  const requests = env.controller.tools.networkRequests();
  assert.equal(requests.length, 200);
  assert.equal(requests.at(-1)?.url, "https://e.com/249");
  assert.equal(requests[0]?.url, "https://e.com/50");
});

test("a CDP command that never answers fails with a timeout instead of hanging", async () => {
  const env = setup();
  await openTabs(env, 1);
  env.views[0]!.contents.cdpHandler = () => new Promise(() => undefined);
  const result = env.controller.tools.send("Page.captureScreenshot");
  await env.flush();
  env.timers.advance(20_000);
  await assert.rejects(result, /timed out on Page\.captureScreenshot.*minimized/su);
});

test("sending CDP with no open tab explains what to do", async () => {
  const env = setup();
  await assert.rejects(env.controller.tools.send("Page.enable"), /No tab is open/u);
});

// ---- agent control ---------------------------------------------------------------------------

test("a running tool shows operating and returns to idle 1.5 seconds after the last call ended", async () => {
  const env = setup();
  const states: string[] = [];
  env.controller.subscribe((projection) => states.push(projection.agentControl));
  let release!: () => void;
  const running = env.controller.tools.runAgentTool(() => new Promise<void>((resolve) => { release = resolve; }));
  assert.equal(env.controller.projection().agentControl, "operating");
  release();
  await running;
  assert.equal(env.controller.projection().agentControl, "operating");
  env.timers.advance(BROWSER_PANE_IDLE_DEBOUNCE_MS - 1);
  assert.equal(env.controller.projection().agentControl, "operating");

  // A second call inside the window keeps the badge on and restarts the debounce.
  await env.controller.tools.runAgentTool(() => Promise.resolve());
  env.timers.advance(BROWSER_PANE_IDLE_DEBOUNCE_MS - 1);
  assert.equal(env.controller.projection().agentControl, "operating");
  env.timers.advance(1);
  assert.equal(env.controller.projection().agentControl, "idle");
  assert.deepEqual(states, ["operating", "idle"]);
});

test("a failing tool still ends operating", async () => {
  const env = setup();
  await assert.rejects(env.controller.tools.runAgentTool(() => Promise.reject(new Error("boom"))), /boom/u);
  env.timers.advance(BROWSER_PANE_IDLE_DEBOUNCE_MS);
  assert.equal(env.controller.projection().agentControl, "idle");
});

test("Take over pauses the agent: every tool is refused until Resume agent", async () => {
  const env = setup();
  await openTabs(env, 1);
  assert.deepEqual(await env.controller.command({ kind: "takeOver" }), { ok: true });
  assert.equal(env.controller.projection().agentControl, "paused");
  await assert.rejects(env.controller.tools.runAgentTool(() => Promise.resolve(1)), (error: unknown) => error instanceof BrowserToolError && error.message === BROWSER_PANE_PAUSED_MESSAGE);
  await assert.rejects(env.controller.tools.navigate("https://example.com/"), new RegExp(BROWSER_PANE_PAUSED_MESSAGE, "u"));
  await assert.rejects(env.controller.tools.send("Page.enable"), new RegExp(BROWSER_PANE_PAUSED_MESSAGE, "u"));
  assert.equal(env.controller.projection().agentControl, "paused");

  // The user keeps full control of the pane itself.
  assert.deepEqual(await env.controller.command({ kind: "navigate", url: "https://example.com/mine" }), { ok: true });
  assert.deepEqual(await env.controller.command({ kind: "resumeAgent" }), { ok: true });
  assert.equal(env.controller.projection().agentControl, "idle");
  assert.equal(await env.controller.tools.runAgentTool(() => Promise.resolve("ok")), "ok");
});

test("taking over while a tool runs keeps the pane paused when that tool ends", async () => {
  const env = setup();
  let release!: () => void;
  const running = env.controller.tools.runAgentTool(() => new Promise<void>((resolve) => { release = resolve; }));
  await env.controller.command({ kind: "takeOver" });
  release();
  await running;
  env.timers.advance(10_000);
  assert.equal(env.controller.projection().agentControl, "paused");
  await env.controller.command({ kind: "resumeAgent" });
  assert.equal(env.controller.projection().agentControl, "idle");
});

// ---- tool navigation --------------------------------------------------------------------------

test("navigate opens a tab when none exists, loads the address and reports the page", async () => {
  const env = setup();
  const info = await env.controller.tools.navigate("https://example.com/start");
  assert.equal(env.views.length, 1);
  assert.deepEqual({ ...info, title: "" }, { tabId: "tab-1", url: "https://example.com/start", title: "", loading: false });
  await assert.rejects(env.controller.tools.navigate("file:///etc/passwd"), /only http, https and about:blank/u);
  await assert.rejects(env.controller.tools.navigate("javascript:alert(1)"), BrowserToolError);
  assert.equal(env.views.length, 1);
});

test("a failed load is reported as a navigation failure, not a hang", async () => {
  const env = setup();
  await openTabs(env, 1);
  env.views[0]!.contents.loadError = new Error("ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:1/'");
  await assert.rejects(env.controller.tools.navigate("http://localhost:1/"), /Navigation failed: ERR_CONNECTION_REFUSED/u);
});

test("a load that never finishes returns after the timeout and says the page is still loading", async () => {
  const env = setup();
  await openTabs(env, 1);
  env.views[0]!.contents.autoFinish = false;
  const pending = env.controller.tools.navigate("https://slow.example/");
  await env.flush();
  env.timers.advance(20_000);
  const info = await pending;
  assert.equal(info.loading, true);
});

test("history tools refuse when there is nowhere to go and otherwise wait for the page to settle", async () => {
  const env = setup();
  await assert.rejects(env.controller.tools.goBack(), /No tab is open/u);
  await openTabs(env, 1);
  await assert.rejects(env.controller.tools.goBack(), /no previous page/u);
  await assert.rejects(env.controller.tools.goForward(), /no next page/u);
  const contents = env.views[0]!.contents;
  contents.back = true;
  const done = env.controller.tools.goBack();
  await env.flush();
  env.timers.advance(100);
  const info = await done;
  assert.deepEqual(contents.actions, ["back"]);
  assert.equal(info.tabId, "tab-1");
});

test("tabs and selection are available to the agent", async () => {
  const env = setup();
  await openTabs(env, 2);
  assert.deepEqual(env.controller.tools.tabs().map((tab) => tab.id), ["tab-1", "tab-2"]);
  assert.equal(env.controller.tools.activeTab()?.id, "tab-2");
  assert.equal(env.controller.tools.selectTab("tab-1"), true);
  assert.equal(env.controller.tools.activeTab()?.id, "tab-1");
  assert.equal(env.controller.tools.selectTab("tab-9"), false);
  assert.equal(env.controller.projection().activeTabId, "tab-1");
});

// ---- downloads and lifecycle -----------------------------------------------------------------

test("downloads from a pane tab get the native save dialog with a safe name; others are cancelled", async () => {
  const env = setup();
  await openTabs(env, 1);
  const calls: string[] = [];
  env.download({
    contentsId: env.views[0]!.contents.id,
    filename: "../../etc/evil\u0000.sh",
    promptSave: (name) => calls.push(`prompt:${name}`),
    cancel: () => calls.push("cancel"),
  });
  env.download({
    contentsId: 424242,
    filename: "x.zip",
    promptSave: (name) => calls.push(`prompt:${name}`),
    cancel: () => calls.push("cancel"),
  });
  assert.deepEqual(calls, ["prompt:evil.sh", "cancel"]);
  assert.equal(safeDownloadName(""), "download");
  assert.equal(safeDownloadName("..."), "download");
  assert.equal(safeDownloadName("C:\\Users\\a\\report.pdf"), "report.pdf");
  assert.equal(safeDownloadName("a".repeat(500)).length, 120);
});

test("dispose closes every tab, stops timers and refuses further commands", async () => {
  const env = setup();
  await openTabs(env, 3);
  await env.controller.tools.runAgentTool(() => Promise.resolve());
  assert.equal(env.timers.size > 0, true);
  env.controller.dispose();
  assert.equal(env.registry.size(), 0);
  assert.equal(env.views.every((view) => view.destroyed), true);
  assert.equal(env.timers.size, 0);
  assert.deepEqual(await env.controller.command({ kind: "newTab" }), { ok: false, reason: "failed" });
  env.controller.dispose();
});

// ---- a tool call is bound to its start: control generation, tab and page [PC-BROWSER-002] -----

const paused = (error: unknown): boolean => error instanceof BrowserToolError && error.message === BROWSER_PANE_PAUSED_MESSAGE;
const tabChanged = (error: unknown): boolean => error instanceof BrowserToolError && error.message === BROWSER_PANE_TAB_CHANGED_MESSAGE;
const MOUSE = { type: "mousePressed", x: 1, y: 2, button: "left", clickCount: 1 };

/** What a tab's debugger was sent, without the `Runtime.enable` that attaching itself sends. */
function sentTo(env: ReturnType<typeof setup>, index: number): string[] {
  return env.views[index]!.contents.cdp.map((entry) => entry.method).filter((method) => method !== "Runtime.enable");
}

test("a tool call that started before Take over sends nothing after it, not even after Resume agent", async () => {
  const env = setup();
  await openTabs(env, 1);
  let stale!: BrowserPaneToolSurface;
  const outcome = await env.controller.tools.runAgentTool(async (tool) => {
    stale = tool;
    await tool.send("DOM.enable");
    await env.controller.command({ kind: "takeOver" });
    return tool.send("Input.dispatchMouseEvent", MOUSE).then(() => "sent", (error: unknown) => error);
  });
  assert.equal(paused(outcome), true);
  assert.deepEqual(sentTo(env, 0), ["DOM.enable"]);

  await env.controller.command({ kind: "resumeAgent" });
  await assert.rejects(stale.send("Input.dispatchMouseEvent", MOUSE), paused);
  await assert.rejects(stale.navigate("https://example.com/"), paused);
  assert.deepEqual(sentTo(env, 0), ["DOM.enable"]);
  // A call that starts after the resume is a new call with the new generation.
  await env.controller.tools.runAgentTool((tool) => tool.send("DOM.enable"));
  assert.deepEqual(sentTo(env, 0), ["DOM.enable", "DOM.enable"]);
});

test("Take over while a command waits for the debugger stops it before it is dispatched", async () => {
  const env = setup({ holdLoads: true });
  await env.controller.command({ kind: "newTab" });
  const contents = env.views[0]!.contents;
  const running = env.controller.tools.runAgentTool((tool) => tool.send("Runtime.evaluate", { expression: "1" }));
  await env.flush();
  await env.controller.command({ kind: "takeOver" });
  contents.finishLoad("about:blank");
  await env.flush();
  await assert.rejects(running, paused);
  assert.deepEqual(sentTo(env, 0), [], "the tool's command was never dispatched");
});

test("Take over while a navigation waits for the tab stops it before the page is requested", async () => {
  const env = setup({ holdLoads: true });
  await env.controller.command({ kind: "newTab" });
  const contents = env.views[0]!.contents;
  const running = env.controller.tools.runAgentTool((tool) => tool.navigate("https://example.com/"));
  await env.flush();
  await env.controller.command({ kind: "takeOver" });
  contents.finishLoad("about:blank");
  await env.flush();
  await assert.rejects(running, paused);
  assert.deepEqual(contents.loads, ["about:blank"], "only the tab's own blank page was loaded");
});

test("history steps are refused after Take over", async () => {
  const env = setup();
  await openTabs(env, 1);
  const contents = env.views[0]!.contents;
  contents.back = true;
  contents.forward = true;
  await env.controller.tools.runAgentTool(async (tool) => {
    await env.controller.command({ kind: "takeOver" });
    await assert.rejects(tool.goBack(), paused);
    await assert.rejects(tool.goForward(), paused);
    await assert.rejects(tool.reload(), paused);
  });
  assert.deepEqual(contents.actions, []);
});

test("every step of a call goes to the tab it started on; a hidden tab gets no input or screenshot", async () => {
  const env = setup();
  await openTabs(env, 2);
  env.views[0]!.contents.emitDebugger("Runtime.consoleAPICalled", { type: "log", args: [{ value: "one" }] });
  env.views[1]!.contents.emitDebugger("Runtime.consoleAPICalled", { type: "log", args: [{ value: "two" }] });
  assert.equal(env.controller.tools.activeTab()?.id, "tab-2");

  await env.controller.tools.runAgentTool(async (tool) => {
    await tool.send("DOM.enable");
    // The user (or a pop-up) makes another tab the shown one while the call runs.
    assert.equal(env.controller.tools.selectTab("tab-1"), true);
    await tool.send("DOM.getBoxModel", { backendNodeId: 5 });
    assert.deepEqual(tool.consoleMessages(), [{ level: "log", text: "two" }], "reads follow the bound tab");
    await tool.send("Accessibility.getFullAXTree");
    await assert.rejects(tool.send("Input.dispatchMouseEvent", MOUSE), tabChanged);
    await assert.rejects(tool.send("Page.captureScreenshot"), tabChanged);
  });
  assert.deepEqual(sentTo(env, 1), ["DOM.enable", "DOM.getBoxModel", "Accessibility.getFullAXTree"]);
  assert.deepEqual(sentTo(env, 0), [], "the tab the user switched to was never touched");
  assert.deepEqual(env.controller.tools.consoleMessages(), [{ level: "log", text: "one" }]);
});

test("a call aborts with the tab-changed message when its tab was closed", async () => {
  const env = setup();
  await openTabs(env, 2);
  await env.controller.tools.runAgentTool(async (tool) => {
    await tool.send("DOM.enable");
    assert.deepEqual(await env.controller.command({ kind: "closeTab", tabId: "tab-2" }), { ok: true });
    await assert.rejects(tool.send("Accessibility.getFullAXTree"), tabChanged);
    await assert.rejects(tool.navigate("https://example.com/"), tabChanged);
    await assert.rejects(tool.goBack(), tabChanged);
  });
  assert.deepEqual(sentTo(env, 0), [], "the remaining tab was not used in its place");
  assert.deepEqual(env.views[0]!.contents.loads, ["about:blank"]);
});

test("a click by ref aborts when the page navigated after the call started, before any input", async () => {
  const env = setup();
  await openTabs(env, 1);
  const contents = env.views[0]!.contents;
  contents.finishLoad("https://a.example/");
  await env.controller.tools.runAgentTool(async (tool) => {
    await tool.send("DOM.enable");
    contents.finishLoad("https://b.example/");
    await tool.send("Accessibility.getFullAXTree");
    await assert.rejects(tool.send("DOM.getBoxModel", { backendNodeId: 1 }), tabChanged);
    await assert.rejects(tool.send("Input.dispatchMouseEvent", MOUSE), tabChanged);
  });
  assert.deepEqual(sentTo(env, 0), ["DOM.enable", "Accessibility.getFullAXTree"]);

  // A same-document change (hash, pushState) also moves the ref targets.
  await env.controller.tools.runAgentTool(async (tool) => {
    contents.url = "https://b.example/#next";
    contents.handlers.didNavigate();
    await assert.rejects(tool.send("DOM.getBoxModel", { backendNodeId: 1 }), tabChanged);
  });
  assert.equal(sentTo(env, 0).includes("DOM.getBoxModel"), false);
});

test("once a call has sent input, a navigation it caused does not cut the gesture in half", async () => {
  const env = setup();
  await openTabs(env, 1);
  const contents = env.views[0]!.contents;
  contents.finishLoad("https://a.example/");
  await env.controller.tools.runAgentTool(async (tool) => {
    await tool.send("DOM.getBoxModel", { backendNodeId: 1 });
    await tool.send("Input.dispatchMouseEvent", { ...MOUSE, type: "mousePressed" });
    contents.finishLoad("https://b.example/");
    await tool.send("Input.dispatchMouseEvent", { ...MOUSE, type: "mouseReleased" });
  });
  assert.deepEqual(sentTo(env, 0), ["DOM.getBoxModel", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
});

test("calls made outside runAgentTool bind to the pane as it is when they are made", async () => {
  const env = setup();
  await openTabs(env, 2);
  await env.controller.tools.send("DOM.enable");
  env.controller.tools.selectTab("tab-1");
  await env.controller.tools.send("DOM.enable");
  assert.deepEqual(sentTo(env, 1), ["DOM.enable"]);
  assert.deepEqual(sentTo(env, 0), ["DOM.enable"]);
});
