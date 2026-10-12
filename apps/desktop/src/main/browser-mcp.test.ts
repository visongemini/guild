import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { BROWSER_MCP_TOOLS } from "./browser-mcp-tools.js";
import {
  BROWSER_MCP_DEFAULT_PROTOCOL,
  createBrowserMcpHandler,
  isLoopbackHost,
  startBrowserMcpServer,
  type BrowserMcpServer,
} from "./browser-mcp.js";
import { BROWSER_PANE_PAUSED_MESSAGE, BrowserToolError, type BrowserPaneToolSurface } from "./browser-pane.js";

function surfaceFake(options: { paused?: boolean; send?: BrowserPaneToolSurface["send"] } = {}) {
  const order: string[] = [];
  const state = { paused: options.paused === true };
  const surface: BrowserPaneToolSurface = {
    runAgentTool: async (run) => {
      if (state.paused) throw new BrowserToolError(BROWSER_PANE_PAUSED_MESSAGE);
      order.push("operating");
      try {
        return await run();
      } finally {
        order.push("done");
      }
    },
    isOnScreen: () => true,
    navigate: async (url) => {
      order.push(`navigate:${url}`);
      return { tabId: "tab-1", url, title: "T", loading: false };
    },
    goBack: async () => ({ tabId: "tab-1", url: "about:blank", title: "", loading: false }),
    goForward: async () => ({ tabId: "tab-1", url: "about:blank", title: "", loading: false }),
    reload: async () => ({ tabId: "tab-1", url: "about:blank", title: "", loading: false }),
    send: options.send ?? (async () => ({})),
    activeTab: () => undefined,
    tabs: () => [],
    selectTab: () => false,
    consoleMessages: () => [],
    networkRequests: () => [],
  };
  return { surface, order, state };
}

const rpc = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

// ---- protocol (transport free) ----------------------------------------------------------------

test("initialize echoes a supported protocol version, announces tools only and names the server", async () => {
  const handle = createBrowserMcpHandler(surfaceFake().surface);
  const echoed = await handle(rpc(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude", version: "2" } }));
  assert.equal(echoed.status, 200);
  assert.deepEqual(echoed.body, {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "guild-browser", version: "1.0.0" } },
  });
  for (const params of [{ protocolVersion: "1999-01-01" }, { protocolVersion: 5 }, {}, undefined]) {
    const outcome = await handle(rpc("a", "initialize", params));
    assert.equal((outcome.body as { result: { protocolVersion: string } }).result.protocolVersion, BROWSER_MCP_DEFAULT_PROTOCOL);
  }
  assert.equal(BROWSER_MCP_DEFAULT_PROTOCOL, "2025-06-18");
});

test("notifications are accepted with 202 and no body, whatever their name", async () => {
  const handle = createBrowserMcpHandler(surfaceFake().surface);
  for (const method of ["notifications/initialized", "notifications/cancelled", "something/unknown"]) {
    assert.deepEqual(await handle({ jsonrpc: "2.0", method }), { status: 202, body: undefined });
  }
  // A client's answer to a server request carries no method and also needs no reply.
  assert.deepEqual(await handle({ jsonrpc: "2.0", id: 1, result: {} }), { status: 202, body: undefined });
});

test("ping answers an empty result", async () => {
  const handle = createBrowserMcpHandler(surfaceFake().surface);
  assert.deepEqual((await handle(rpc(7, "ping"))).body, { jsonrpc: "2.0", id: 7, result: {} });
});

test("tools/list returns every tool with its JSON Schema", async () => {
  const handle = createBrowserMcpHandler(surfaceFake().surface);
  const outcome = await handle(rpc(2, "tools/list"));
  const tools = (outcome.body as { result: { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } }).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), BROWSER_MCP_TOOLS.map((tool) => tool.name));
  assert.equal(tools.length, 16);
  for (const tool of tools) {
    assert.equal(tool.inputSchema["type"], "object");
    assert.equal(typeof tool.description, "string");
  }
  const navigate = tools.find((tool) => tool.name === "navigate");
  assert.deepEqual(navigate?.inputSchema["required"], ["url"]);
  const key = tools.find((tool) => tool.name === "key");
  assert.deepEqual((key?.inputSchema["properties"] as { key: { enum: string[] } }).key.enum.slice(0, 4), ["Enter", "Tab", "Escape", "Backspace"]);
});

test("tools/call runs the tool inside an agent operation and returns MCP content", async () => {
  const { surface, order } = surfaceFake();
  const handle = createBrowserMcpHandler(surface);
  const outcome = await handle(rpc(3, "tools/call", { name: "navigate", arguments: { url: "https://example.com/" } }));
  assert.deepEqual(outcome.body, {
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: 'Opened https://example.com/ in tab-1 title="T"' }] },
  });
  assert.deepEqual(order, ["operating", "navigate:https://example.com/", "done"]);
});

test("tool failures are MCP error results the model can read, not protocol errors", async () => {
  const handle = createBrowserMcpHandler(surfaceFake({ send: async () => { throw new Error("Could not find node with given id"); } }).surface);
  const bad = await handle(rpc(4, "tools/call", { name: "navigate", arguments: {} }));
  assert.deepEqual((bad.body as { result: unknown }).result, {
    content: [{ type: "text", text: 'Invalid arguments: "url" must be a non-empty string.' }],
    isError: true,
  });
  const cdp = await handle(rpc(5, "tools/call", { name: "type", arguments: { text: "x" } }));
  assert.deepEqual((cdp.body as { result: unknown }).result, {
    content: [{ type: "text", text: "The browser tool failed: Could not find node with given id" }],
    isError: true,
  });
  const notObject = await handle(rpc(6, "tools/call", { name: "back", arguments: "nope" }));
  assert.equal((notObject.body as { result: { isError: boolean } }).result.isError, true);
});

test("an unknown tool or a missing name is a JSON-RPC invalid-params error", async () => {
  const handle = createBrowserMcpHandler(surfaceFake().surface);
  for (const params of [{ name: "eval", arguments: { expression: "1" } }, { name: "execute_script" }]) {
    const outcome = await handle(rpc(8, "tools/call", params));
    assert.equal((outcome.body as { error: { code: number } }).error.code, -32602);
  }
  assert.equal(((await handle(rpc(9, "tools/call", {}))).body as { error: { code: number } }).error.code, -32602);
  assert.equal(((await handle(rpc(9, "tools/call"))).body as { error: { code: number } }).error.code, -32602);
});

test("server/discover and every other unknown method answer -32601", async () => {
  const handle = createBrowserMcpHandler(surfaceFake().surface);
  for (const method of ["server/discover", "resources/list", "prompts/list", "tools/list_changed", "logging/setLevel", ""]) {
    const outcome = await handle(rpc(10, method));
    assert.equal(outcome.status, 200, method);
    assert.deepEqual(outcome.body, { jsonrpc: "2.0", id: 10, error: { code: -32601, message: "Method not found" } }, method);
  }
});

test("batches and malformed envelopes are rejected with -32600", async () => {
  const handle = createBrowserMcpHandler(surfaceFake().surface);
  for (const message of [[rpc(1, "ping")], [], "ping", 5, null, { id: 1, method: "ping" }, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1 }]) {
    const outcome = await handle(message);
    assert.equal(outcome.status, 400, JSON.stringify(message));
    assert.equal((outcome.body as { error: { code: number } }).error.code, -32600, JSON.stringify(message));
  }
});

test("while the user has taken over, every tool returns the pause error and does no work", async () => {
  const { surface, order } = surfaceFake({ paused: true });
  const handle = createBrowserMcpHandler(surface);
  for (const tool of BROWSER_MCP_TOOLS) {
    const outcome = await handle(rpc(11, "tools/call", { name: tool.name, arguments: { url: "https://example.com/", query: "a", text: "a", key: "Enter", direction: "down", tabId: "tab-1", x: 1, y: 1 } }));
    assert.deepEqual((outcome.body as { result: unknown }).result, { content: [{ type: "text", text: "Paused by the user in Guild" }], isError: true }, tool.name);
  }
  assert.deepEqual(order, []);
});

test("overlapping tool calls run one after another", async () => {
  const log: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const { surface } = surfaceFake({
    send: async (method) => {
      log.push(`start:${method}`);
      if (method === "Input.insertText") await gate;
      log.push(`end:${method}`);
      return {};
    },
  });
  const handle = createBrowserMcpHandler(surface);
  const first = handle(rpc(1, "tools/call", { name: "type", arguments: { text: "a" } }));
  const second = handle(rpc(2, "tools/call", { name: "scroll", arguments: { direction: "down" } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["start:Input.insertText"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(log.slice(0, 3), ["start:Input.insertText", "end:Input.insertText", "start:Page.getLayoutMetrics"]);
});

// ---- HTTP transport ---------------------------------------------------------------------------

async function withServer(run: (server: BrowserMcpServer, base: URL) => Promise<void>, surface = surfaceFake().surface): Promise<void> {
  const server = await startBrowserMcpServer({ surface });
  try {
    await run(server, new URL(server.url));
  } finally {
    await server.close();
  }
}

function post(server: BrowserMcpServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("the server listens on loopback behind a 32-hex token path and speaks JSON", async () => {
  await withServer(async (server, base) => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/mcp$/u);
    assert.equal(base.hostname, "127.0.0.1");
    const response = await post(server, rpc(1, "initialize", { protocolVersion: "2025-06-18" }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    assert.equal(body.result.serverInfo.name, "guild-browser");

    const accepted = await post(server, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(accepted.status, 202);
    assert.equal(await accepted.text(), "");

    const discover = await post(server, rpc(2, "server/discover"));
    assert.equal(((await discover.json()) as { error: { code: number } }).error.code, -32601);

    const call = await post(server, rpc(3, "tools/call", { name: "navigate", arguments: { url: "https://example.com/" } }));
    assert.match(JSON.stringify(await call.json()), /Opened https:\/\/example\.com\//u);
  });
});

test("every path other than the exact token path is 404", async () => {
  await withServer(async (server, base) => {
    const token = base.pathname.split("/")[1]!;
    const origin = base.origin;
    for (const path of ["/", "/mcp", `/${"0".repeat(32)}/mcp`, `/${token}`, `/${token}/`, `/${token}/mcp/`, `/${token}/mcp2`, `/${token.toUpperCase()}/mcp`, `/x/${token}/mcp`]) {
      const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rpc(1, "ping")) });
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), "", path);
    }
    const getWrong = await fetch(`${origin}/nope`);
    assert.equal(getWrong.status, 404);
  });
});

test("tokens are random per server", async () => {
  const one = await startBrowserMcpServer({ surface: surfaceFake().surface });
  const two = await startBrowserMcpServer({ surface: surfaceFake().surface });
  try {
    assert.notEqual(new URL(one.url).pathname, new URL(two.url).pathname);
    assert.notEqual(new URL(one.url).port, new URL(two.url).port);
  } finally {
    await one.close();
    await two.close();
  }
});

test("GET and other methods on the right path are 405", async () => {
  await withServer(async (server) => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await fetch(server.url, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "POST");
    }
  });
});

test("bad bodies are reported as JSON-RPC errors", async () => {
  await withServer(async (server) => {
    const broken = await post(server, "{not json");
    assert.equal(broken.status, 400);
    assert.equal(((await broken.json()) as { error: { code: number } }).error.code, -32700);
    const batch = await post(server, [rpc(1, "ping")]);
    assert.equal(batch.status, 400);
    assert.equal(((await batch.json()) as { error: { code: number } }).error.code, -32600);
    const huge = await post(server, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1_100_000) } }));
    assert.equal(huge.status, 413);
  });
});

function rawPost(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(rpc(1, "ping"));
    const request = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...headers } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("a foreign Host or Origin header is refused, a loopback one is fine (DNS rebinding defence)", async () => {
  await withServer(async (server, base) => {
    assert.equal(await rawPost(base, {}), 200);
    assert.equal(await rawPost(base, { Host: "evil.example" }), 403);
    assert.equal(await rawPost(base, { Host: `evil.example:${base.port}` }), 403);
    assert.equal(await rawPost(base, { Host: `localhost:${base.port}` }), 200);
    assert.equal(await rawPost(base, { Origin: "https://evil.example" }), 403);
    assert.equal(await rawPost(base, { Origin: "null" }), 403);
    assert.equal(await rawPost(base, { Origin: "http://localhost:5173" }), 200);
    assert.equal(server.url.includes("evil"), false);
  });
});

test("binding to anything but a loopback address fails before listening", async () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "100.64.0.1", "example.com", "localhost", "", "127.0.0.1.evil"]) {
    await assert.rejects(startBrowserMcpServer({ surface: surfaceFake().surface, host }), /browser_mcp_non_loopback_bind/u, host);
  }
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.0.0.2"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("128.0.0.1"), false);
  assert.equal(isLoopbackHost("127.0.0.256"), false);
});

test("close stops the listener", async () => {
  const server = await startBrowserMcpServer({ surface: surfaceFake().surface });
  assert.equal((await post(server, rpc(1, "ping"))).status, 200);
  await server.close();
  await assert.rejects(post(server, rpc(2, "ping")));
});
