/**
 * Browser pane commands and projection (PC-BROWSER-001, PC-BROWSER-002, D-059).
 *
 * The pane is an isolated `WebContentsView` owned by the main process. The renderer only sends the
 * closed command set below and receives `BrowserPaneProjection` snapshots; it never gets a handle
 * to the page. Navigation is limited to `http:`, `https:` and `about:blank`.
 */

import { boundedText, exactRecord } from "./request-record.js";

export const GUILD_BROWSER_LIMITS = Object.freeze({
  /** `window.open` opens a new pane tab up to this many; beyond it the request is denied. */
  maxTabs: 5,
  urlLength: 2_048,
  titleLength: 512,
  tabIdLength: 64,
  maxCoordinate: 100_000,
});

export const GUILD_BROWSER_AGENT_CONTROL_STATES = Object.freeze(["idle", "operating", "paused"] as const);
/** `operating`: the agent is driving the pane; `paused`: the user took over and tools answer "paused by user". */
export type BrowserAgentControl = (typeof GUILD_BROWSER_AGENT_CONTROL_STATES)[number];

export type BrowserTabProjection = Readonly<{
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}>;

export type BrowserPaneProjection = Readonly<{
  tabs: readonly BrowserTabProjection[];
  activeTabId: string | null;
  agentControl: BrowserAgentControl;
}>;

export type BrowserCommand =
  | Readonly<{ kind: "navigate"; url: string }>
  | Readonly<{ kind: "back" }>
  | Readonly<{ kind: "forward" }>
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "stop" }>
  | Readonly<{ kind: "newTab"; url?: string }>
  | Readonly<{ kind: "closeTab"; tabId: string }>
  | Readonly<{ kind: "selectTab"; tabId: string }>
  /** Where the page view sits inside the window, in CSS pixels; the renderer reports its placeholder box. */
  | Readonly<{ kind: "setBounds"; x: number; y: number; width: number; height: number }>
  | Readonly<{ kind: "setVisible"; visible: boolean }>
  /** The user takes control: agent tool calls answer "paused by user" until `resumeAgent`. */
  | Readonly<{ kind: "takeOver" }>
  | Readonly<{ kind: "resumeAgent" }>;

export type BrowserCommandKind = BrowserCommand["kind"];

const TAB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

/**
 * Canonical address of a URL the pane may load: absolute `http:` / `https:` without user info, or
 * exactly `about:blank`. Anything else (`file:`, `javascript:`, `data:`, `chrome:`, relative text)
 * is refused; turning typed text into a URL is the address bar's job.
 */
export function parseBrowserUrl(value: unknown): string {
  const text = boundedText(value, GUILD_BROWSER_LIMITS.urlLength);
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(text)) throw new TypeError("invalid_browser_url");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError("invalid_browser_url");
  }
  if (parsed.protocol === "about:") {
    if (parsed.href !== "about:blank") throw new TypeError("invalid_browser_url");
    return parsed.href;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new TypeError("invalid_browser_url");
  }
  return parsed.href;
}

export function parseBrowserTabId(value: unknown): string {
  if (typeof value !== "string" || !TAB_ID_PATTERN.test(value)) {
    throw new TypeError("invalid_browser_tab_id");
  }
  return value;
}

function browserCoordinate(value: unknown, min: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > GUILD_BROWSER_LIMITS.maxCoordinate
  ) {
    throw new TypeError("invalid_browser_bounds");
  }
  return Math.round(value);
}

/** Validates the closed command union a renderer may send. Unknown kinds and extra keys are refused. */
export function parseBrowserCommand(input: unknown): BrowserCommand {
  const head = exactRecord(input, ["kind"], [
    "url",
    "tabId",
    "x",
    "y",
    "width",
    "height",
    "visible",
  ]);
  const kind = head["kind"];
  switch (kind) {
    case "navigate": {
      const record = exactRecord(input, ["kind", "url"]);
      return Object.freeze({ kind, url: parseBrowserUrl(record["url"]) });
    }
    case "back":
    case "forward":
    case "reload":
    case "stop":
    case "takeOver":
    case "resumeAgent": {
      exactRecord(input, ["kind"]);
      return Object.freeze({ kind });
    }
    case "newTab": {
      const record = exactRecord(input, ["kind"], ["url"]);
      return Object.freeze({
        kind,
        ...(record["url"] === undefined ? {} : { url: parseBrowserUrl(record["url"]) }),
      });
    }
    case "closeTab":
    case "selectTab": {
      const record = exactRecord(input, ["kind", "tabId"]);
      return Object.freeze({ kind, tabId: parseBrowserTabId(record["tabId"]) });
    }
    case "setBounds": {
      const record = exactRecord(input, ["kind", "x", "y", "width", "height"]);
      return Object.freeze({
        kind,
        x: browserCoordinate(record["x"], -GUILD_BROWSER_LIMITS.maxCoordinate),
        y: browserCoordinate(record["y"], -GUILD_BROWSER_LIMITS.maxCoordinate),
        width: browserCoordinate(record["width"], 0),
        height: browserCoordinate(record["height"], 0),
      });
    }
    case "setVisible": {
      const record = exactRecord(input, ["kind", "visible"]);
      if (typeof record["visible"] !== "boolean") throw new TypeError("invalid_browser_command");
      return Object.freeze({ kind, visible: record["visible"] });
    }
    default:
      throw new TypeError("invalid_browser_command");
  }
}
