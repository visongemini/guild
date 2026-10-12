import type { BrowserCommand, BrowserPaneProjection } from "@guild/contracts";
import type { BrowserMcpPort } from "./engine-ports.js";
import { startBrowserMcpServer, type BrowserMcpServer } from "./browser-mcp.js";
import { BrowserToolError, type BrowserPageInfo, type BrowserPaneController, type BrowserPaneToolSurface } from "./browser-pane.js";

// Glue between the window-bound browser pane (browser-pane-electron.ts) and the two things that
// outlive any one window: the loopback browser MCP server handed to the live service, and the IPC
// handlers. A Guild window can be closed and reopened (macOS keeps the app alive), and each window
// gets its own pane controller; the bridge always talks to the current one (PC-BROWSER-001/002).

/** What the renderer-facing IPC needs from a pane. */
export interface BrowserPaneIpcPort {
  projection(): BrowserPaneProjection;
  subscribe(listener: (projection: BrowserPaneProjection) => void): () => void;
  /** Runs the command and answers the projection afterwards; a refused command leaves it unchanged. */
  command(command: BrowserCommand): Promise<BrowserPaneProjection>;
}

export interface BrowserPaneBridge extends BrowserPaneIpcPort {
  /** Makes the controller of a new window current; call the result when that window closes. */
  attach(controller: BrowserPaneController): () => void;
  /** Lazily started loopback MCP server; the URL carries a token that changes on every launch. */
  readonly mcp: BrowserMcpPort & { close(): Promise<void> };
}

export const EMPTY_BROWSER_PANE_PROJECTION: BrowserPaneProjection = Object.freeze({
  tabs: Object.freeze([]),
  activeTabId: null,
  agentControl: "idle",
});

const NO_PANE_MESSAGE = "The browser pane is not open in Guild right now";

function unavailable<T>(): Promise<T> {
  return Promise.reject(new BrowserToolError(NO_PANE_MESSAGE));
}

export type BrowserPaneBridgeOptions = {
  /** Test seam; production starts the real server. */
  readonly startServer?: (options: { readonly surface: BrowserPaneToolSurface }) => Promise<BrowserMcpServer>;
};

export function createBrowserPaneBridge(options: BrowserPaneBridgeOptions = {}): BrowserPaneBridge {
  const startServer = options.startServer ?? startBrowserMcpServer;
  const listeners = new Set<(projection: BrowserPaneProjection) => void>();
  let current: BrowserPaneController | undefined;
  let server: Promise<BrowserMcpServer> | undefined;

  // Tool calls reach whichever pane is current when they run; with no window they fail with a message the model can read.
  const surface: BrowserPaneToolSurface = Object.freeze({
    runAgentTool: <T>(run: (bound: BrowserPaneToolSurface) => Promise<T>): Promise<T> => (current === undefined ? unavailable<T>() : current.tools.runAgentTool(run)),
    navigate: (url: string) => (current === undefined ? unavailable<BrowserPageInfo>() : current.tools.navigate(url)),
    goBack: () => (current === undefined ? unavailable<BrowserPageInfo>() : current.tools.goBack()),
    goForward: () => (current === undefined ? unavailable<BrowserPageInfo>() : current.tools.goForward()),
    reload: () => (current === undefined ? unavailable<BrowserPageInfo>() : current.tools.reload()),
    send: (method: string, params?: Record<string, unknown>) => (current === undefined ? unavailable<unknown>() : current.tools.send(method, params)),
    isOnScreen: () => current?.tools.isOnScreen() ?? false,
    activeTab: () => current?.tools.activeTab(),
    tabs: () => current?.tools.tabs() ?? [],
    selectTab: (tabId: string) => current?.tools.selectTab(tabId) ?? false,
    consoleMessages: () => current?.tools.consoleMessages() ?? [],
    networkRequests: () => current?.tools.networkRequests() ?? [],
  });

  const bridge: BrowserPaneBridge = {
    projection: () => current?.projection() ?? EMPTY_BROWSER_PANE_PROJECTION,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    command: async (command) => {
      if (current === undefined) return EMPTY_BROWSER_PANE_PROJECTION;
      await current.command(command);
      return current.projection();
    },
    attach: (controller) => {
      current = controller;
      const stop = controller.subscribe((projection) => {
        for (const listener of [...listeners]) {
          try {
            listener(projection);
          } catch {
            // One faulty listener must not stop the others.
          }
        }
      });
      return () => {
        stop();
        if (current === controller) current = undefined;
      };
    },
    mcp: {
      ensureStarted: async () => {
        server ??= startServer({ surface }).catch((error: unknown) => {
          server = undefined;
          throw error;
        });
        return { url: (await server).url };
      },
      close: async () => {
        const started = server;
        server = undefined;
        if (started !== undefined) await (await started.catch(() => undefined))?.close();
      },
    },
  };
  return Object.freeze(bridge);
}

/** The window-side wiring of one pane: pushes projections to the renderer and answers its commands. */
export type BrowserPaneRendererSink = {
  readonly send: (projection: BrowserPaneProjection) => void;
  /** Registers a callback for every (re)load of the renderer page; returns the unregister function. */
  readonly onRendererLoaded: (listener: () => void) => () => void;
};

export function wireBrowserPaneToRenderer(
  pane: BrowserPaneIpcPort,
  sink: BrowserPaneRendererSink,
): { readonly command: BrowserPaneIpcPort["command"]; readonly dispose: () => void } {
  // A renderer that reloads (crash recovery, Cmd+R in dev) starts with no pane state and gets it again here.
  const stopLoaded = sink.onRendererLoaded(() => sink.send(pane.projection()));
  const stopChanges = pane.subscribe((projection) => sink.send(projection));
  return {
    command: (command) => pane.command(command),
    dispose: () => {
      stopLoaded();
      stopChanges();
    },
  };
}
