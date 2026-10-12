import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserCommand, BrowserPaneProjection } from "@guild/contracts";
import {
  createBrowserPaneBridge,
  EMPTY_BROWSER_PANE_PROJECTION,
  wireBrowserPaneToRenderer,
  type BrowserPaneIpcPort,
} from "./browser-pane-bridge.js";
import type { BrowserPaneCommandResult, BrowserPaneController } from "./browser-pane.js";
import { createFixtureBrowserPane } from "./fixture-browser-pane.js";

// PC-BROWSER-001 / PC-BROWSER-002: the main-side wiring of the browser pane, with fake controllers.

function projectionOf(url: string, agentControl: BrowserPaneProjection["agentControl"] = "idle"): BrowserPaneProjection {
  return {
    tabs: [{ id: "tab-1", url, title: "", loading: false, canGoBack: false, canGoForward: false }],
    activeTabId: "tab-1",
    agentControl,
  };
}

type FakeController = BrowserPaneController & {
  readonly commands: BrowserCommand[];
  readonly toolCalls: string[];
  push(projection: BrowserPaneProjection): void;
  readonly subscriberCount: () => number;
};

function fakeController(initial: BrowserPaneProjection, refuse = false): FakeController {
  let current = initial;
  const listeners = new Set<(projection: BrowserPaneProjection) => void>();
  const commands: BrowserCommand[] = [];
  const toolCalls: string[] = [];
  const page = (url: string) => ({ tabId: "tab-1", url, title: "Page", loading: false });
  const controller: FakeController = {
    commands,
    toolCalls,
    push: (projection) => {
      current = projection;
      for (const listener of [...listeners]) listener(projection);
    },
    subscriberCount: () => listeners.size,
    projection: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    command: async (command): Promise<BrowserPaneCommandResult> => {
      commands.push(command);
      if (refuse) return { ok: false, reason: "invalid_url" };
      if (command.kind === "navigate") current = projectionOf(command.url);
      return { ok: true };
    },
    dispose: () => undefined,
    refreshLayout: () => undefined,
    tools: {
      runAgentTool: (run) => run(controller.tools),
      navigate: async (url) => {
        toolCalls.push(`navigate ${url}`);
        return page(url);
      },
      goBack: async () => page("about:blank"),
      goForward: async () => page("about:blank"),
      reload: async () => page("about:blank"),
      send: async () => ({}),
      isOnScreen: () => true,
      activeTab: () => current.tabs[0],
      tabs: () => current.tabs,
      selectTab: () => true,
      consoleMessages: () => [],
      networkRequests: () => [],
    },
  };
  return controller;
}

async function callTool(url: string, name: string, args: Record<string, unknown>): Promise<{ readonly isError?: boolean; readonly text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: body.result.isError, text: body.result.content.map((part) => part.text).join("\n") };
}

describe("browser pane bridge: commands and projections", () => {
  it("answers the projection after the command, and the unchanged one when the pane refuses", async () => {
    const bridge = createBrowserPaneBridge();
    assert.deepEqual(await bridge.command({ kind: "reload" }), EMPTY_BROWSER_PANE_PROJECTION, "no window, nothing to drive");
    assert.deepEqual(bridge.projection(), EMPTY_BROWSER_PANE_PROJECTION);

    const controller = fakeController(projectionOf("about:blank"));
    bridge.attach(controller);
    const navigated = await bridge.command({ kind: "navigate", url: "https://example.com/" });
    assert.equal(navigated.tabs[0]?.url, "https://example.com/");
    assert.deepEqual(controller.commands, [{ kind: "navigate", url: "https://example.com/" }]);

    const refusing = createBrowserPaneBridge();
    refusing.attach(fakeController(projectionOf("about:blank"), true));
    assert.equal((await refusing.command({ kind: "navigate", url: "https://example.com/" })).tabs[0]?.url, "about:blank");
  });

  it("forwards projection changes of the attached pane and stops after detach; a stale detach cannot drop a newer pane", async () => {
    const bridge = createBrowserPaneBridge();
    const seen: string[] = [];
    bridge.subscribe((projection) => {
      seen.push(projection.tabs[0]?.url ?? "none");
    });
    const first = fakeController(projectionOf("about:blank"));
    const detachFirst = bridge.attach(first);
    first.push(projectionOf("https://one.test/"));
    const second = fakeController(projectionOf("about:blank"));
    const detachSecond = bridge.attach(second);
    detachFirst();
    assert.equal(first.subscriberCount(), 0);
    assert.equal(bridge.projection().tabs[0]?.url, "about:blank", "the newer pane is still current");
    second.push(projectionOf("https://two.test/"));
    detachSecond();
    second.push(projectionOf("https://ignored.test/"));
    assert.deepEqual(seen, ["https://one.test/", "https://two.test/"]);
    assert.deepEqual(bridge.projection(), EMPTY_BROWSER_PANE_PROJECTION);
  });
});

describe("browser pane bridge: loopback MCP server for engines", () => {
  it("starts lazily on loopback with a random token, reuses the server, and never exposes it without a window", async () => {
    const bridge = createBrowserPaneBridge();
    const first = await bridge.mcp.ensureStarted();
    const second = await bridge.mcp.ensureStarted();
    assert.equal(first.url, second.url);
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/mcp$/u);

    // No window yet: the model gets a readable reason, not a crash.
    const early = await callTool(first.url, "navigate", { url: "https://example.com/" });
    assert.equal(early.isError, true);
    assert.match(early.text, /browser pane is not open/iu);

    const controller = fakeController(projectionOf("about:blank"));
    const detach = bridge.attach(controller);
    const opened = await callTool(first.url, "navigate", { url: "https://example.com/" });
    assert.equal(opened.isError, undefined);
    assert.deepEqual(controller.toolCalls, ["navigate https://example.com/"]);

    // The window closes: the same server answers again with the reason.
    detach();
    assert.equal((await callTool(first.url, "navigate", { url: "https://example.com/" })).isError, true);

    const wrongToken = await fetch(first.url.replace(/[0-9a-f]{32}/u, "0".repeat(32)), { method: "POST", body: "{}" });
    assert.equal(wrongToken.status, 404);

    await bridge.mcp.close();
    await bridge.mcp.close();
    await assert.rejects(fetch(first.url, { method: "POST", body: "{}" }), "the listener is gone");
  });

  it("a failed start can be retried", async () => {
    let attempts = 0;
    const bridge = createBrowserPaneBridge({
      startServer: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("port busy");
        return { url: "http://127.0.0.1:1/token/mcp", close: async () => undefined };
      },
    });
    await assert.rejects(bridge.mcp.ensureStarted(), /port busy/u);
    assert.deepEqual(await bridge.mcp.ensureStarted(), { url: "http://127.0.0.1:1/token/mcp" });
  });
});

describe("browser pane renderer wiring", () => {
  function sink() {
    const sent: BrowserPaneProjection[] = [];
    const loadListeners = new Set<() => void>();
    return {
      sent,
      loadListeners,
      port: {
        send: (projection: BrowserPaneProjection) => {
          sent.push(projection);
        },
        onRendererLoaded: (listener: () => void) => {
          loadListeners.add(listener);
          return () => {
            loadListeners.delete(listener);
          };
        },
      },
    };
  }

  it("pushes every change, pushes the current state again when the renderer (re)loads, and answers commands", async () => {
    const controller = fakeController(projectionOf("about:blank"));
    const bridge = createBrowserPaneBridge();
    bridge.attach(controller);
    const target = sink();
    const wired = wireBrowserPaneToRenderer(bridge, target.port);

    controller.push(projectionOf("https://one.test/"));
    assert.deepEqual(target.sent.map((projection) => projection.tabs[0]?.url), ["https://one.test/"]);
    for (const listener of [...target.loadListeners]) listener();
    assert.equal(target.sent.at(-1)?.tabs[0]?.url, "https://one.test/", "a reloaded renderer gets the pane state back");

    const answer = await wired.command({ kind: "takeOver" });
    assert.deepEqual(controller.commands, [{ kind: "takeOver" }]);
    assert.equal(answer.tabs[0]?.url, "https://one.test/");

    wired.dispose();
    controller.push(projectionOf("https://two.test/"));
    assert.equal(target.loadListeners.size, 0);
    assert.equal(target.sent.length, 2, "nothing is sent after the window is gone");
  });

  it("the fixture pane keeps the UI fixture working without loading anything", async () => {
    const pane: BrowserPaneIpcPort = createFixtureBrowserPane();
    const target = sink();
    const wired = wireBrowserPaneToRenderer(pane, target.port);
    assert.equal(pane.projection().tabs.length, 1);
    const withTab = await wired.command({ kind: "newTab", url: "https://example.org/" });
    assert.equal(withTab.tabs.length, 2);
    assert.equal(withTab.activeTabId, withTab.tabs[1]?.id);
    for (let index = 0; index < 8; index += 1) await wired.command({ kind: "newTab" });
    assert.equal(pane.projection().tabs.length, 5, "the tab limit holds");
    assert.equal((await wired.command({ kind: "takeOver" })).agentControl, "paused");
    assert.equal((await wired.command({ kind: "resumeAgent" })).agentControl, "idle");
    assert.ok(target.sent.length >= 10);
    wired.dispose();
  });
});
