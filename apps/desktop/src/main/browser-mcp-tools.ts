/**
 * The tools of the Guild browser MCP server (PC-BROWSER-002). Each tool is a small program over the
 * `BrowserPaneToolSurface`: the Chrome DevTools Protocol commands it sends are fixed here. There is
 * deliberately no tool that evaluates caller-supplied script; `get_text` evaluates one constant
 * expression.
 */

import { BrowserToolError, type BrowserPageInfo, type BrowserPaneToolSurface } from "./browser-pane.js";

export type McpContent =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image"; data: string; mimeType: string }>;

export type McpToolResult = Readonly<{ content: readonly McpContent[]; isError?: true }>;

export type BrowserMcpTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  run: (args: Readonly<Record<string, unknown>>, surface: BrowserPaneToolSurface) => Promise<McpToolResult>;
}>;

export const READ_PAGE_MAX_LINES = 4_000;
const READ_PAGE_MAX_CHARS = 100_000;
const FIND_MAX_MATCHES = 100;
const GET_TEXT_MAX_CHARS = 10_000;
const TYPE_MAX_CHARS = 10_000;
const LOG_TAIL = 100;
const SCREENSHOT_PNG_MAX_CHARS = 5_000_000;
const DEFAULT_SCROLL_PIXELS = 600;
const MAX_SCROLL_PIXELS = 5_000;
const NAME_MAX_CHARS = 120;
/** The one script this server ever evaluates. */
const GET_TEXT_EXPRESSION = "document.body ? document.body.innerText : ''";

// ---------------------------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------------------------

type Args = Readonly<Record<string, unknown>>;

function text(value: string): McpToolResult {
  return { content: [{ type: "text", text: value }] };
}

function requireString(args: Args, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BrowserToolError(`Invalid arguments: "${key}" must be a non-empty string.`);
  }
  if (value.length > max) throw new BrowserToolError(`Invalid arguments: "${key}" is longer than ${max} characters.`);
  return value;
}

function optionalFiniteNumber(args: Args, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrowserToolError(`Invalid arguments: "${key}" must be a number.`);
  }
  return value;
}

/** Screenshots and input need a page Chromium considers shown; a hidden pane would stall them for 20 seconds. */
function requireOnScreen(surface: BrowserPaneToolSurface): void {
  if (!surface.isOnScreen()) {
    throw new BrowserToolError("The Guild browser pane is hidden. Ask the user to open the Browser tab in the Guild workbench, then try again.");
  }
}

function describePage(verb: string, info: BrowserPageInfo): string {
  const title = info.title === "" ? "" : ` title=${JSON.stringify(info.title)}`;
  const loading = info.loading ? " (the page is still loading)" : "";
  return `${verb} ${info.url} in ${info.tabId}${title}${loading}`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------------------------
// Accessibility snapshot
// ---------------------------------------------------------------------------------------------

type AxValue = { value?: unknown } | undefined;
type AxNode = {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name?: string; value?: AxValue }>;
  backendDOMNodeId?: number;
};

const SKIPPED_ROLES = new Set(["none", "generic", "presentation", "InlineTextBox", "LineBreak", "RootWebArea", "WebArea"]);
const ALWAYS_LISTED_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem",
  "tab", "option", "slider", "spinbutton", "listbox", "heading", "textarea",
]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea", "spinbutton", "slider"]);

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  return collapsed.length > NAME_MAX_CHARS ? `${collapsed.slice(0, NAME_MAX_CHARS)}...` : collapsed;
}

/** `[ref_<backendDOMNodeId>] role "name"` for every ignored-free node worth showing, in tree order. */
export function axTreeToLines(nodes: readonly AxNode[]): string[] {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) if (node.nodeId !== undefined) byId.set(node.nodeId, node);
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = node.role?.value;
    if (typeof role !== "string" || role === "" || SKIPPED_ROLES.has(role)) continue;
    if (typeof node.backendDOMNodeId !== "number") continue;
    const name = cleanName(node.name?.value);
    if (name === "" && !ALWAYS_LISTED_ROLES.has(role)) continue;
    if (role === "StaticText" && node.parentId !== undefined) {
      const parentName = cleanName(byId.get(node.parentId)?.name?.value);
      if (parentName !== "" && parentName.includes(name)) continue;
    }
    let line = `[ref_${node.backendDOMNodeId}] ${role} ${JSON.stringify(name)}`;
    if (VALUE_ROLES.has(role)) {
      const value = cleanName(node.value?.value);
      if (value !== "") line += ` value=${JSON.stringify(value)}`;
    }
    for (const property of node.properties ?? []) {
      const flag = property.value?.value;
      if (property.name === "checked" && (flag === true || flag === "true" || flag === "mixed")) line += " [checked]";
      if (property.name === "disabled" && flag === true) line += " [disabled]";
    }
    lines.push(line);
  }
  return lines;
}

async function readPageLines(surface: BrowserPaneToolSurface): Promise<string[]> {
  await surface.send("Accessibility.enable");
  const result = recordOf(await surface.send("Accessibility.getFullAXTree"));
  const nodes = Array.isArray(result["nodes"]) ? (result["nodes"] as AxNode[]) : [];
  return axTreeToLines(nodes);
}

function boundedLines(lines: readonly string[], maxLines: number): string {
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || chars + line.length + 1 > READ_PAGE_MAX_CHARS) break;
    kept.push(line);
    chars += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  return omitted > 0 ? `${kept.join("\n")}\n... ${omitted} more lines not shown` : kept.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Pointer and keyboard
// ---------------------------------------------------------------------------------------------

function parseRef(raw: string): number {
  const match = /^(?:ref_)?(\d{1,12})$/u.exec(raw.trim());
  if (match?.[1] === undefined) {
    throw new BrowserToolError('Invalid arguments: "ref" must look like ref_123 (copy it from read_page or find).');
  }
  return Number(match[1]);
}

async function clickAt(surface: BrowserPaneToolSurface, x: number, y: number): Promise<void> {
  await surface.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await surface.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await surface.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function centerOfNode(surface: BrowserPaneToolSurface, backendNodeId: number): Promise<{ x: number; y: number }> {
  await surface.send("DOM.enable");
  try {
    await surface.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    // The box model below decides whether the element is usable.
  }
  let quad: unknown;
  try {
    quad = recordOf(recordOf(await surface.send("DOM.getBoxModel", { backendNodeId }))["model"])["content"];
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 160) : "no box";
    throw new BrowserToolError(`ref_${backendNodeId} cannot be clicked (${reason}). It may be hidden or stale; run read_page again.`);
  }
  if (!Array.isArray(quad) || quad.length < 8 || !quad.every((value) => typeof value === "number")) {
    throw new BrowserToolError(`ref_${backendNodeId} has no clickable box. Run read_page again.`);
  }
  const q = quad as number[];
  return { x: ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4, y: ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4 };
}

type KeySpec = Readonly<{ key: string; code: string; keyCode: number; text?: string }>;

const KEYS: Readonly<Record<string, KeySpec>> = Object.freeze({
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
});
const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  return: "Enter", esc: "Escape", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
});

export const BROWSER_MCP_KEY_NAMES: readonly string[] = Object.freeze(Object.keys(KEYS));

function resolveKey(raw: string): KeySpec {
  const lowered = raw.trim().toLowerCase();
  const name = KEY_ALIASES[lowered] ?? Object.keys(KEYS).find((candidate) => candidate.toLowerCase() === lowered);
  const spec = name === undefined ? undefined : KEYS[name];
  if (spec === undefined) {
    throw new BrowserToolError(`Unsupported key "${raw.slice(0, 40)}". Use one of: ${BROWSER_MCP_KEY_NAMES.join(", ")}.`);
  }
  return spec;
}

// ---------------------------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------------------------

const NO_ARGS = Object.freeze({ type: "object", properties: {}, additionalProperties: false });

export const BROWSER_MCP_TOOLS: readonly BrowserMcpTool[] = Object.freeze([
  {
    name: "navigate",
    description: "Open an http(s) address in the active Guild browser tab (a tab is opened when none exists) and wait for the page to load.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http:// or https:// address, or about:blank." } },
      required: ["url"],
      additionalProperties: false,
    },
    run: async (args, surface) => {
      const info = await surface.navigate(requireString(args, "url", 8_192));
      return text(describePage("Opened", info));
    },
  },
  {
    name: "back",
    description: "Go back one page in the active tab.",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => text(describePage("Went back to", await surface.goBack())),
  },
  {
    name: "forward",
    description: "Go forward one page in the active tab.",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => text(describePage("Went forward to", await surface.goForward())),
  },
  {
    name: "reload",
    description: "Reload the active tab.",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => text(describePage("Reloaded", await surface.reload())),
  },
  {
    name: "screenshot",
    description: "Take a screenshot (PNG) of the visible part of the active tab.",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => {
      requireOnScreen(surface);
      await surface.send("Page.enable");
      const png = recordOf(await surface.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }));
      let data = png["data"];
      let mimeType = "image/png";
      if (typeof data === "string" && data.length > SCREENSHOT_PNG_MAX_CHARS) {
        const jpeg = recordOf(await surface.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: false }));
        data = jpeg["data"];
        mimeType = "image/jpeg";
      }
      if (typeof data !== "string" || data.length === 0) throw new BrowserToolError("The browser returned no screenshot.");
      return { content: [{ type: "image", data, mimeType }] };
    },
  },
  {
    name: "read_page",
    description: 'Accessibility snapshot of the active tab, one line per element: [ref_<id>] role "name". Use the ref with click.',
    inputSchema: NO_ARGS,
    run: async (_args, surface) => {
      const lines = await readPageLines(surface);
      return text(lines.length === 0 ? "The page has no accessible elements yet." : boundedLines(lines, READ_PAGE_MAX_LINES));
    },
  },
  {
    name: "get_text",
    description: "The visible text of the active page (document.body.innerText), cut to a bounded length.",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => {
      const result = recordOf(await surface.send("Runtime.evaluate", { expression: GET_TEXT_EXPRESSION, returnByValue: true }));
      if (result["exceptionDetails"] !== undefined) throw new BrowserToolError("The page text could not be read.");
      const value = recordOf(result["result"])["value"];
      const body = typeof value === "string" ? value : "";
      if (body.length === 0) return text("The page has no visible text.");
      return text(body.length > GET_TEXT_MAX_CHARS ? `${body.slice(0, GET_TEXT_MAX_CHARS)}\n... ${body.length - GET_TEXT_MAX_CHARS} more characters not shown` : body);
    },
  },
  {
    name: "find",
    description: "Filter the read_page lines by a case-insensitive substring of the role or name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Text to look for in an element's role or name." } },
      required: ["query"],
      additionalProperties: false,
    },
    run: async (args, surface) => {
      const query = requireString(args, "query", 200).toLowerCase();
      const matches = (await readPageLines(surface)).filter((line) => line.toLowerCase().includes(query));
      if (matches.length === 0) return text("No matching elements.");
      return text(boundedLines(matches, FIND_MAX_MATCHES));
    },
  },
  {
    name: "click",
    description: "Click an element by ref (from read_page or find), or at viewport coordinates x and y (CSS pixels). Give either ref or both x and y.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref such as ref_123." },
        x: { type: "number", description: "Horizontal position in CSS pixels from the left of the viewport." },
        y: { type: "number", description: "Vertical position in CSS pixels from the top of the viewport." },
      },
      additionalProperties: false,
    },
    run: async (args, surface) => {
      requireOnScreen(surface);
      if (args["ref"] !== undefined) {
        const id = parseRef(requireString(args, "ref", 40));
        const point = await centerOfNode(surface, id);
        await clickAt(surface, point.x, point.y);
        return text(`Clicked ref_${id} at ${Math.round(point.x)},${Math.round(point.y)}`);
      }
      const x = optionalFiniteNumber(args, "x");
      const y = optionalFiniteNumber(args, "y");
      if (x === undefined || y === undefined) throw new BrowserToolError('Invalid arguments: give "ref", or both "x" and "y".');
      if (x < 0 || y < 0 || x > 20_000 || y > 20_000) throw new BrowserToolError("Invalid arguments: x and y are outside the page.");
      await clickAt(surface, x, y);
      return text(`Clicked at ${Math.round(x)},${Math.round(y)}`);
    },
  },
  {
    name: "type",
    description: "Insert text into the focused element (click a field first).",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The text to insert." } },
      required: ["text"],
      additionalProperties: false,
    },
    run: async (args, surface) => {
      requireOnScreen(surface);
      const value = requireString(args, "text", TYPE_MAX_CHARS);
      await surface.send("Input.insertText", { text: value });
      return text(`Typed ${value.length} characters`);
    },
  },
  {
    name: "key",
    description: `Press one key in the active page. Supported: ${BROWSER_MCP_KEY_NAMES.join(", ")}.`,
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", enum: [...BROWSER_MCP_KEY_NAMES], description: "Key name." } },
      required: ["key"],
      additionalProperties: false,
    },
    run: async (args, surface) => {
      requireOnScreen(surface);
      const spec = resolveKey(requireString(args, "key", 40));
      const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
      await surface.send("Input.dispatchKeyEvent", spec.text === undefined ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text: spec.text });
      await surface.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return text(`Pressed ${spec.key}`);
    },
  },
  {
    name: "scroll",
    description: "Scroll the active page with the mouse wheel from the middle of the viewport.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
        amount: { type: "integer", minimum: 1, maximum: MAX_SCROLL_PIXELS, description: `Distance in CSS pixels (default ${DEFAULT_SCROLL_PIXELS}).` },
      },
      required: ["direction"],
      additionalProperties: false,
    },
    run: async (args, surface) => {
      requireOnScreen(surface);
      const direction = requireString(args, "direction", 10);
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
        throw new BrowserToolError('Invalid arguments: "direction" must be up, down, left or right.');
      }
      const requested = optionalFiniteNumber(args, "amount") ?? DEFAULT_SCROLL_PIXELS;
      const amount = Math.min(Math.max(Math.round(requested), 1), MAX_SCROLL_PIXELS);
      const metrics = recordOf(await surface.send("Page.getLayoutMetrics"));
      const viewport = recordOf(metrics["cssVisualViewport"] ?? metrics["visualViewport"]);
      const width = typeof viewport["clientWidth"] === "number" ? viewport["clientWidth"] : 800;
      const height = typeof viewport["clientHeight"] === "number" ? viewport["clientHeight"] : 600;
      await surface.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(width / 2),
        y: Math.round(height / 2),
        deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0,
        deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0,
      });
      return text(`Scrolled ${direction} ${amount}px`);
    },
  },
  {
    name: "console_messages",
    description: "Recent console messages and uncaught errors of the active tab (the last 100).",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => {
      const entries = surface.consoleMessages().slice(-LOG_TAIL);
      return text(entries.length === 0 ? "No console messages." : entries.map((entry) => `[${entry.level}] ${entry.text}`).join("\n"));
    },
  },
  {
    name: "network_requests",
    description: "Recent network requests of the active tab with method, status and URL (the last 100).",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => {
      const entries = surface.networkRequests().slice(-LOG_TAIL);
      return text(entries.length === 0 ? "No network requests." : entries.map((entry) => `${entry.method} ${entry.status ?? (entry.failed ? "failed" : "pending")} ${entry.url}`).join("\n"));
    },
  },
  {
    name: "tabs_list",
    description: "List the open tabs of the Guild browser pane (up to 5); the active one is marked.",
    inputSchema: NO_ARGS,
    run: async (_args, surface) => {
      const active = surface.activeTab()?.id;
      const tabs = surface.tabs();
      if (tabs.length === 0) return text("No tabs are open. Use navigate to open one.");
      return text(tabs.map((tab) => `${tab.id}${tab.id === active ? " (active)" : ""} ${JSON.stringify(tab.title)} ${tab.url}${tab.loading ? " [loading]" : ""}`).join("\n"));
    },
  },
  {
    name: "tab_select",
    description: "Make a tab the active one. Use tabs_list to see the ids.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string", description: "Tab id such as tab-2." } },
      required: ["tabId"],
      additionalProperties: false,
    },
    run: async (args, surface) => {
      const tabId = requireString(args, "tabId", 40);
      if (!surface.selectTab(tabId)) throw new BrowserToolError(`There is no tab ${JSON.stringify(tabId)}. Use tabs_list.`);
      return text(`Selected ${tabId}`);
    },
  },
]);

const TOOLS_BY_NAME: ReadonlyMap<string, BrowserMcpTool> = new Map(BROWSER_MCP_TOOLS.map((tool) => [tool.name, tool]));

export function findBrowserMcpTool(name: string): BrowserMcpTool | undefined {
  return TOOLS_BY_NAME.get(name);
}
