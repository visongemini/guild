import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserTabProjection } from "@guild/contracts";
import {
  BROWSER_MCP_KEY_NAMES,
  BROWSER_MCP_TOOLS,
  READ_PAGE_MAX_LINES,
  axTreeToLines,
  findBrowserMcpTool,
} from "./browser-mcp-tools.js";
import {
  BROWSER_PANE_PAUSED_MESSAGE,
  BrowserToolError,
  type BrowserPaneToolSurface,
} from "./browser-pane.js";

type Cdp = { method: string; params: Record<string, unknown> | undefined };

function fakeSurface(options: {
  respond?: (method: string, params: Record<string, unknown> | undefined) => unknown;
  tabs?: BrowserTabProjection[];
  paused?: boolean;
  onScreen?: boolean;
} = {}) {
  const sent: Cdp[] = [];
  const events: string[] = [];
  const state = { paused: options.paused === true, active: options.tabs?.[0]?.id };
  const tabs = options.tabs ?? [];
  const surface: BrowserPaneToolSurface = {
    runAgentTool: async (run) => {
      if (state.paused) throw new BrowserToolError(BROWSER_PANE_PAUSED_MESSAGE);
      events.push("start");
      try {
        return await run(surface);
      } finally {
        events.push("end");
      }
    },
    isOnScreen: () => options.onScreen !== false,
    navigate: async (url) => ({ tabId: "tab-1", url, title: "Example", loading: false }),
    goBack: async () => ({ tabId: "tab-1", url: "https://example.com/prev", title: "", loading: false }),
    goForward: async () => ({ tabId: "tab-1", url: "https://example.com/next", title: "", loading: true }),
    reload: async () => ({ tabId: "tab-1", url: "https://example.com/", title: "Example", loading: false }),
    send: async (method, params) => {
      sent.push({ method, params });
      const reply = options.respond?.(method, params);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
    activeTab: () => tabs.find((tab) => tab.id === state.active),
    tabs: () => tabs,
    selectTab: (tabId) => {
      if (!tabs.some((tab) => tab.id === tabId)) return false;
      state.active = tabId;
      return true;
    },
    consoleMessages: () => [
      { level: "log", text: "hello" },
      { level: "error", text: "boom" },
    ],
    networkRequests: () => [
      { method: "GET", url: "https://example.com/", status: 200, failed: false },
      { method: "POST", url: "https://example.com/api", status: undefined, failed: false },
      { method: "GET", url: "https://example.com/gone", status: undefined, failed: true },
    ],
  };
  return { surface, sent, events, state };
}

async function run(name: string, args: Record<string, unknown>, surface: BrowserPaneToolSurface) {
  const tool = findBrowserMcpTool(name);
  assert.ok(tool, `tool ${name} missing`);
  return tool.run(args, surface);
}

function textOf(result: Awaited<ReturnType<typeof run>>): string {
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return first.text;
}

const tab = (id: string, patch: Partial<BrowserTabProjection> = {}): BrowserTabProjection => ({
  id, url: `https://example.com/${id}`, title: id, loading: false, canGoBack: false, canGoForward: false, ...patch,
});

// ---- catalogue -------------------------------------------------------------------------------

test("the tool list is exactly the specified surface and has no eval-like tool", () => {
  assert.deepEqual(BROWSER_MCP_TOOLS.map((tool) => tool.name), [
    "navigate", "back", "forward", "reload", "screenshot", "read_page", "get_text", "find",
    "click", "type", "key", "scroll", "console_messages", "network_requests", "tabs_list", "tab_select",
  ]);
  for (const tool of BROWSER_MCP_TOOLS) {
    assert.doesNotMatch(tool.name, /eval|exec|script|js/u);
    assert.equal(tool.inputSchema["type"], "object", tool.name);
    assert.equal(tool.inputSchema["additionalProperties"], false, tool.name);
    assert.equal(tool.description.length > 10, true, tool.name);
    const properties = tool.inputSchema["properties"] as Record<string, unknown>;
    for (const required of (tool.inputSchema["required"] as string[] | undefined) ?? []) {
      assert.ok(required in properties, `${tool.name}.${required}`);
    }
    // Top-level combinators are rejected by some model APIs.
    for (const forbidden of ["oneOf", "anyOf", "allOf", "not"]) assert.equal(forbidden in tool.inputSchema, false, tool.name);
  }
  const required = (name: string) => findBrowserMcpTool(name)?.inputSchema["required"];
  assert.deepEqual(required("navigate"), ["url"]);
  assert.deepEqual(required("find"), ["query"]);
  assert.deepEqual(required("type"), ["text"]);
  assert.deepEqual(required("key"), ["key"]);
  assert.deepEqual(required("scroll"), ["direction"]);
  assert.deepEqual(required("tab_select"), ["tabId"]);
  assert.equal(required("click"), undefined);
});

// ---- hidden pane -----------------------------------------------------------------------------

test("with the pane hidden, tools that need a rendered page refuse at once and send nothing", async () => {
  const { surface, sent } = fakeSurface({ onScreen: false });
  const calls: Array<[string, Record<string, unknown>]> = [
    ["screenshot", {}], ["click", { x: 1, y: 1 }], ["click", { ref: "ref_1" }], ["type", { text: "a" }], ["key", { key: "Enter" }], ["scroll", { direction: "down" }],
  ];
  for (const [name, args] of calls) {
    await assert.rejects(run(name, args, surface), /browser pane is hidden.*Browser tab/su, name);
  }
  assert.equal(sent.length, 0);
  // Reading and navigating do not need the page to be on screen.
  const reading = fakeSurface({ onScreen: false, respond: (method) => (method === "Runtime.evaluate" ? { result: { value: "still readable" } } : method === "Accessibility.getFullAXTree" ? AX_TREE : {}) });
  assert.equal(textOf(await run("get_text", {}, reading.surface)), "still readable");
  assert.match(textOf(await run("read_page", {}, reading.surface)), /button "Press me"/u);
  assert.match(textOf(await run("navigate", { url: "https://example.com/" }, reading.surface)), /Opened/u);
});

// ---- navigation ------------------------------------------------------------------------------

test("navigate, back, forward and reload report the resulting page", async () => {
  const { surface } = fakeSurface();
  assert.match(textOf(await run("navigate", { url: "https://example.com/x" }, surface)), /^Opened https:\/\/example\.com\/x in tab-1 title="Example"$/u);
  assert.match(textOf(await run("back", {}, surface)), /^Went back to https:\/\/example\.com\/prev in tab-1$/u);
  assert.match(textOf(await run("forward", {}, surface)), /still loading/u);
  assert.match(textOf(await run("reload", {}, surface)), /^Reloaded /u);
  await assert.rejects(run("navigate", {}, surface), /"url" must be a non-empty string/u);
  await assert.rejects(run("navigate", { url: 5 }, surface), BrowserToolError);
});

// ---- screenshot ------------------------------------------------------------------------------

test("screenshot asks CDP for a PNG of the viewport and returns it as MCP image content", async () => {
  const { surface, sent } = fakeSurface({ respond: (method) => (method === "Page.captureScreenshot" ? { data: "iVBORw0KGgo=" } : {}) });
  const result = await run("screenshot", {}, surface);
  assert.deepEqual(result.content, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
  assert.deepEqual(sent, [
    { method: "Page.enable", params: undefined },
    { method: "Page.captureScreenshot", params: { format: "png", captureBeyondViewport: false } },
  ]);
});

test("an oversized PNG is retaken as JPEG, and an empty capture is an error", async () => {
  let calls = 0;
  const big = fakeSurface({
    respond: (method, params) => {
      if (method !== "Page.captureScreenshot") return {};
      calls += 1;
      return params?.["format"] === "png" ? { data: "A".repeat(5_000_001) } : { data: "/9j/small" };
    },
  });
  const result = await run("screenshot", {}, big.surface);
  assert.equal(calls, 2);
  assert.deepEqual(result.content, [{ type: "image", data: "/9j/small", mimeType: "image/jpeg" }]);
  const empty = fakeSurface();
  await assert.rejects(run("screenshot", {}, empty.surface), /no screenshot/u);
});

// ---- read_page / find ------------------------------------------------------------------------

const node = (nodeId: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({
  nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId: Number(nodeId) + 1000, ...extra,
});

const AX_TREE = {
  nodes: [
    node("1", "RootWebArea", "Spike page"),
    node("2", "heading", "Spike test page", { parentId: "1" }),
    node("3", "StaticText", "Spike test page", { parentId: "2" }),
    node("4", "paragraph", "", { parentId: "1" }),
    node("5", "StaticText", "not clicked", { parentId: "4" }),
    node("6", "button", "Press me", { parentId: "1" }),
    node("7", "StaticText", "Press me", { parentId: "6" }),
    node("8", "generic", "", { parentId: "1" }),
    node("9", "none", "ignored role", { parentId: "1" }),
    node("10", "link", "Docs", { parentId: "1", ignored: true }),
    node("11", "textbox", "Email", { parentId: "1", value: { value: "a@b.c" } }),
    node("12", "checkbox", "Remember me", { parentId: "1", properties: [{ name: "checked", value: { value: "true" } }, { name: "disabled", value: { value: true } }] }),
    node("13", "button", "", { parentId: "1" }),
    { nodeId: "14", role: { value: "link" }, name: { value: "No backend id" } },
    node("15", "link", `  Long   name ${"x".repeat(200)} `, { parentId: "1" }),
  ],
};

test("read_page lists refs, roles and names, skips ignored/generic/none and duplicate static text", async () => {
  const { surface, sent } = fakeSurface({ respond: (method) => (method === "Accessibility.getFullAXTree" ? AX_TREE : {}) });
  const lines = textOf(await run("read_page", {}, surface)).split("\n");
  assert.deepEqual(sent.map((call) => call.method), ["Accessibility.enable", "Accessibility.getFullAXTree"]);
  assert.deepEqual(lines.slice(0, 7), [
    '[ref_1002] heading "Spike test page"',
    '[ref_1005] StaticText "not clicked"',
    '[ref_1006] button "Press me"',
    '[ref_1011] textbox "Email" value="a@b.c"',
    '[ref_1012] checkbox "Remember me" [checked] [disabled]',
    '[ref_1013] button ""',
    lines[6]!,
  ]);
  assert.match(lines[6]!, /^\[ref_1015\] link "Long name x+\.\.\."$/u);
  assert.equal(lines.length, 7);
  for (const line of lines) assert.match(line, /^\[ref_\d+\] \S+ ".*"/u);
});

test("read_page is bounded to 4000 lines and about 100k characters, and says how many were left out", async () => {
  const short = Array.from({ length: 4_500 }, (_, i) => node(String(i + 1), "link", "a"));
  const { surface } = fakeSurface({ respond: (method) => (method === "Accessibility.getFullAXTree" ? { nodes: short } : {}) });
  const lines = textOf(await run("read_page", {}, surface)).split("\n");
  assert.equal(lines.length, READ_PAGE_MAX_LINES + 1);
  assert.equal(lines.at(-1), "... 500 more lines not shown");

  const wide = Array.from({ length: 3_000 }, (_, i) => node(String(i + 1), "link", `${"w".repeat(100)}${i}`));
  const heavy = fakeSurface({ respond: (method) => (method === "Accessibility.getFullAXTree" ? { nodes: wide } : {}) });
  const heavyText = textOf(await run("read_page", {}, heavy.surface));
  assert.equal(heavyText.length <= 100_100, true);
  assert.match(heavyText, /\n\.\.\. \d+ more lines not shown$/u);

  assert.deepEqual(axTreeToLines([]), []);
  const empty = fakeSurface();
  assert.match(textOf(await run("read_page", {}, empty.surface)), /no accessible elements/u);
});

test("find filters the read_page lines by a case-insensitive substring", async () => {
  const { surface } = fakeSurface({ respond: (method) => (method === "Accessibility.getFullAXTree" ? AX_TREE : {}) });
  assert.equal(textOf(await run("find", { query: "PRESS" }, surface)), '[ref_1006] button "Press me"');
  assert.equal(textOf(await run("find", { query: "checkbox" }, surface)), '[ref_1012] checkbox "Remember me" [checked] [disabled]');
  assert.equal(textOf(await run("find", { query: "nothing here" }, surface)), "No matching elements.");
  await assert.rejects(run("find", { query: "" }, surface), BrowserToolError);
});

// ---- get_text --------------------------------------------------------------------------------

test("get_text evaluates one fixed expression and bounds the result", async () => {
  const { surface, sent } = fakeSurface({ respond: () => ({ result: { type: "string", value: "Hello world" } }) });
  assert.equal(textOf(await run("get_text", {}, surface)), "Hello world");
  assert.deepEqual(sent, [{ method: "Runtime.evaluate", params: { expression: "document.body ? document.body.innerText : ''", returnByValue: true } }]);

  const long = fakeSurface({ respond: () => ({ result: { value: "x".repeat(12_345) } }) });
  const text = textOf(await run("get_text", {}, long.surface));
  assert.equal(text.startsWith("x".repeat(10_000)), true);
  assert.match(text, /\n\.\.\. 2345 more characters not shown$/u);

  const none = fakeSurface({ respond: () => ({ result: { value: "" } }) });
  assert.match(textOf(await run("get_text", {}, none.surface)), /no visible text/u);
  const failing = fakeSurface({ respond: () => ({ exceptionDetails: { text: "x" } }) });
  await assert.rejects(run("get_text", { expression: "1+1" }, failing.surface), /could not be read/u);
  // Arguments never reach the page: the sent expression is the constant above.
  const spy = fakeSurface({ respond: () => ({ result: { value: "ok" } }) });
  await run("get_text", { expression: "window.secret" }, spy.surface);
  assert.equal(spy.sent[0]?.params?.["expression"], "document.body ? document.body.innerText : ''");
});

// ---- click -----------------------------------------------------------------------------------

test("click by ref scrolls the element into view, finds its box and clicks the centre", async () => {
  const { surface, sent } = fakeSurface({
    respond: (method) => (method === "DOM.getBoxModel" ? { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } } : {}),
  });
  const result = await run("click", { ref: "ref_1006" }, surface);
  assert.equal(textOf(result), "Clicked ref_1006 at 60,40");
  assert.deepEqual(sent, [
    { method: "DOM.enable", params: undefined },
    { method: "DOM.scrollIntoViewIfNeeded", params: { backendNodeId: 1006 } },
    { method: "DOM.getBoxModel", params: { backendNodeId: 1006 } },
    { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 60, y: 40 } },
    { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 60, y: 40, button: "left", clickCount: 1 } },
    { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 60, y: 40, button: "left", clickCount: 1 } },
  ]);
  const bare = fakeSurface({ respond: (method) => (method === "DOM.getBoxModel" ? { model: { content: [0, 0, 2, 0, 2, 2, 0, 2] } } : {}) });
  assert.equal(textOf(await run("click", { ref: "1006" }, bare.surface)), "Clicked ref_1006 at 1,1");
});

test("click by coordinates sends only mouse events", async () => {
  const { surface, sent } = fakeSurface();
  assert.equal(textOf(await run("click", { x: 12.4, y: 99.6 }, surface)), "Clicked at 12,100");
  assert.deepEqual(sent.map((call) => call.method), Array(3).fill("Input.dispatchMouseEvent"));
  assert.deepEqual(sent.map((call) => call.params?.["type"]), ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("click rejects malformed or missing targets and explains stale refs", async () => {
  const { surface, sent } = fakeSurface();
  await assert.rejects(run("click", {}, surface), /give "ref", or both "x" and "y"/u);
  await assert.rejects(run("click", { x: 5 }, surface), /both "x" and "y"/u);
  await assert.rejects(run("click", { x: -1, y: 5 }, surface), /outside the page/u);
  await assert.rejects(run("click", { x: "5", y: 5 }, surface), /must be a number/u);
  await assert.rejects(run("click", { ref: "button" }, surface), /ref_123/u);
  await assert.rejects(run("click", { ref: "ref_1; DROP" }, surface), /ref_123/u);
  assert.equal(sent.length, 0);
  const stale = fakeSurface({ respond: (method) => (method === "DOM.getBoxModel" ? new Error("Could not compute box model.") : {}) });
  await assert.rejects(run("click", { ref: "ref_7" }, stale.surface), /ref_7 cannot be clicked.*run read_page again/su);
  assert.equal(stale.sent.some((call) => call.method === "Input.dispatchMouseEvent"), false);
});

// ---- type / key / scroll ---------------------------------------------------------------------

test("type inserts text into the focused element with Input.insertText", async () => {
  const { surface, sent } = fakeSurface();
  assert.equal(textOf(await run("type", { text: "hello \u4e16\u754c" }, surface)), "Typed 8 characters");
  assert.deepEqual(sent, [{ method: "Input.insertText", params: { text: "hello \u4e16\u754c" } }]);
  await assert.rejects(run("type", { text: "" }, surface), BrowserToolError);
  await assert.rejects(run("type", { text: "x".repeat(10_001) }, surface), /longer than 10000/u);
});

test("key presses Enter with a character, other keys as raw key events, and accepts aliases", async () => {
  const { surface, sent } = fakeSurface();
  await run("key", { key: "Enter" }, surface);
  assert.deepEqual(sent, [
    { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" } },
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } },
  ]);
  sent.length = 0;
  assert.equal(textOf(await run("key", { key: "esc" }, surface)), "Pressed Escape");
  assert.deepEqual(sent.map((call) => [call.params?.["type"], call.params?.["key"], call.params?.["windowsVirtualKeyCode"]]), [["rawKeyDown", "Escape", 27], ["keyUp", "Escape", 27]]);
  for (const [key, code] of [["Tab", 9], ["Backspace", 8], ["ArrowUp", 38], ["ArrowDown", 40], ["ArrowLeft", 37], ["ArrowRight", 39]] as const) {
    sent.length = 0;
    await run("key", { key }, surface);
    assert.equal(sent[0]?.params?.["windowsVirtualKeyCode"], code, key);
  }
  await assert.rejects(run("key", { key: "F13" }, surface), /Unsupported key/u);
  assert.deepEqual([...BROWSER_MCP_KEY_NAMES].slice(0, 4), ["Enter", "Tab", "Escape", "Backspace"]);
});

test("scroll turns a direction and amount into a mouse wheel at the middle of the viewport", async () => {
  const { surface, sent } = fakeSurface({ respond: (method) => (method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 500, clientHeight: 700 } } : {}) });
  assert.equal(textOf(await run("scroll", { direction: "down" }, surface)), "Scrolled down 600px");
  assert.deepEqual(sent.at(-1), { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 250, y: 350, deltaX: 0, deltaY: 600 } });
  await run("scroll", { direction: "up", amount: 120 }, surface);
  assert.deepEqual(sent.at(-1)?.params, { type: "mouseWheel", x: 250, y: 350, deltaX: 0, deltaY: -120 });
  await run("scroll", { direction: "left", amount: 50 }, surface);
  assert.deepEqual(sent.at(-1)?.params, { type: "mouseWheel", x: 250, y: 350, deltaX: -50, deltaY: 0 });
  await run("scroll", { direction: "right", amount: 99_999 }, surface);
  assert.deepEqual(sent.at(-1)?.params, { type: "mouseWheel", x: 250, y: 350, deltaX: 5_000, deltaY: 0 });
  await assert.rejects(run("scroll", { direction: "sideways" }, surface), /up, down, left or right/u);
  await assert.rejects(run("scroll", {}, surface), BrowserToolError);
});

// ---- logs and tabs ---------------------------------------------------------------------------

test("console_messages and network_requests format the ring buffers", async () => {
  const { surface } = fakeSurface();
  assert.equal(textOf(await run("console_messages", {}, surface)), "[log] hello\n[error] boom");
  assert.equal(textOf(await run("network_requests", {}, surface)), "GET 200 https://example.com/\nPOST pending https://example.com/api\nGET failed https://example.com/gone");
});

test("tabs_list marks the active tab and tab_select switches it", async () => {
  const { surface, state } = fakeSurface({ tabs: [tab("tab-1", { title: "One" }), tab("tab-2", { title: "Two", loading: true })] });
  assert.equal(textOf(await run("tabs_list", {}, surface)), 'tab-1 (active) "One" https://example.com/tab-1\ntab-2 "Two" https://example.com/tab-2 [loading]');
  assert.equal(textOf(await run("tab_select", { tabId: "tab-2" }, surface)), "Selected tab-2");
  assert.equal(state.active, "tab-2");
  await assert.rejects(run("tab_select", { tabId: "tab-9" }, surface), /There is no tab "tab-9"/u);
  const none = fakeSurface();
  assert.match(textOf(await run("tabs_list", {}, none.surface)), /No tabs are open/u);
});
