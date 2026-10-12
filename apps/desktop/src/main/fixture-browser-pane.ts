import { GUILD_BROWSER_LIMITS, type BrowserAgentControl, type BrowserCommand, type BrowserPaneProjection, type BrowserTabProjection } from "@guild/contracts";
import type { BrowserPaneIpcPort } from "./browser-pane-bridge.js";

// In-memory browser pane for the UI fixture (GUILD_DESKTOP_FIXTURE=1). Not packaged. It loads nothing:
// it only keeps the tab list, the active tab and the agent control state a screenshot needs.

export function createFixtureBrowserPane(): BrowserPaneIpcPort {
  let sequence = 1;
  let agentControl: BrowserAgentControl = "idle";
  const tab = (url: string): BrowserTabProjection => ({
    id: `tab-${sequence++}`,
    url,
    title: url === "about:blank" ? "" : new URL(url).hostname,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });
  const tabs: BrowserTabProjection[] = [tab("https://example.com/")];
  let activeTabId: string | null = tabs[0]?.id ?? null;
  const listeners = new Set<(projection: BrowserPaneProjection) => void>();
  const projection = (): BrowserPaneProjection => ({ tabs: [...tabs], activeTabId, agentControl });
  const emit = (): void => {
    for (const listener of [...listeners]) listener(projection());
  };
  return {
    projection,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    command: async (command: BrowserCommand) => {
      switch (command.kind) {
        case "navigate": {
          const index = tabs.findIndex((candidate) => candidate.id === activeTabId);
          if (index >= 0) tabs[index] = { ...tab(command.url), id: tabs[index]?.id ?? "tab-0" };
          break;
        }
        case "newTab":
          if (tabs.length < GUILD_BROWSER_LIMITS.maxTabs) {
            const created = tab(command.url ?? "about:blank");
            tabs.push(created);
            activeTabId = created.id;
          }
          break;
        case "closeTab": {
          const index = tabs.findIndex((candidate) => candidate.id === command.tabId);
          if (index >= 0) tabs.splice(index, 1);
          if (activeTabId === command.tabId) activeTabId = tabs[0]?.id ?? null;
          break;
        }
        case "selectTab":
          if (tabs.some((candidate) => candidate.id === command.tabId)) activeTabId = command.tabId;
          break;
        case "takeOver":
          agentControl = "paused";
          break;
        case "resumeAgent":
          agentControl = "idle";
          break;
        default:
          break;
      }
      emit();
      return projection();
    },
  };
}
