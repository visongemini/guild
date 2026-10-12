/**
 * The loopback browser MCP server (PC-BROWSER-002): the smallest Model Context Protocol server that
 * Claude Code and Grok can use over Streamable HTTP with JSON responses. It listens on 127.0.0.1
 * only, on a random port, behind a random 128-bit path token, and exposes the tools of
 * browser-mcp-tools.ts. No SDK dependency, no SSE, no sessions.
 *
 * Methods: initialize, notifications/*, ping, tools/list, tools/call. Everything else (including
 * the `server/discover` probe Claude sends first) is answered with JSON-RPC -32601.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BrowserToolError, type BrowserPaneToolSurface } from "./browser-pane.js";
import { BROWSER_MCP_TOOLS, findBrowserMcpTool, type BrowserMcpTool, type McpToolResult } from "./browser-mcp-tools.js";

export const BROWSER_MCP_SERVER_NAME = "guild-browser";
export const BROWSER_MCP_SERVER_VERSION = "1.0.0";
export const BROWSER_MCP_DEFAULT_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const MAX_BODY_BYTES = 1_048_576;
/** An oversized upload is read and dropped up to this size so the 413 reaches the client; beyond it the socket is cut. */
const DRAIN_LIMIT_BYTES = 8 * 1_048_576;
const MAX_ERROR_TEXT = 300;

type JsonRpcId = string | number;
type JsonRpcErrorBody = Readonly<{ code: number; message: string }>;
type JsonRpcResponse =
  | Readonly<{ jsonrpc: "2.0"; id: JsonRpcId | null; result: unknown }>
  | Readonly<{ jsonrpc: "2.0"; id: JsonRpcId | null; error: JsonRpcErrorBody }>;

/** What to send back over HTTP for one POST body. `body: undefined` means 202 with no content. */
export type BrowserMcpOutcome = Readonly<{ status: number; body: JsonRpcResponse | undefined }>;

function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Transport-free request handling, so tests can drive the protocol without a socket. Tool calls are
 * serialized: the pane has one active tab and two overlapping click/type sequences would interleave.
 */
export function createBrowserMcpHandler(surface: BrowserPaneToolSurface): (message: unknown) => Promise<BrowserMcpOutcome> {
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  }

  async function callTool(tool: BrowserMcpTool, rawArgs: unknown): Promise<McpToolResult> {
    if (rawArgs !== undefined && !isRecord(rawArgs)) return errorResult('Invalid arguments: "arguments" must be an object.');
    const args = rawArgs ?? {};
    try {
      return await serialized(() => surface.runAgentTool(() => tool.run(args, surface)));
    } catch (error) {
      if (error instanceof BrowserToolError) return errorResult(error.message);
      const detail = error instanceof Error ? error.message : "unknown error";
      return errorResult(`The browser tool failed: ${detail.slice(0, MAX_ERROR_TEXT)}`);
    }
  }

  return async (message) => {
    if (Array.isArray(message)) {
      return { status: 400, body: rpcError(null, -32600, "Batch requests are not supported") };
    }
    if (!isRecord(message) || message["jsonrpc"] !== "2.0") {
      return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
    }
    const method = message["method"];
    if (typeof method !== "string") {
      // A client answering a server request, or garbage. We send no requests, so nothing to do.
      if ("result" in message || "error" in message) return { status: 202, body: undefined };
      return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
    }
    if (!("id" in message)) return { status: 202, body: undefined };
    const id = message["id"];
    if (typeof id !== "string" && typeof id !== "number") {
      return { status: 400, body: rpcError(null, -32600, "Invalid Request") };
    }
    const params = message["params"];
    const respond = (result: unknown): BrowserMcpOutcome => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

    switch (method) {
      case "initialize": {
        const requested = isRecord(params) ? params["protocolVersion"] : undefined;
        const protocolVersion = typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested) ? requested : BROWSER_MCP_DEFAULT_PROTOCOL;
        return respond({
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: BROWSER_MCP_SERVER_NAME, version: BROWSER_MCP_SERVER_VERSION },
        });
      }
      case "ping":
        return respond({});
      case "tools/list":
        return respond({
          tools: BROWSER_MCP_TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      case "tools/call": {
        const name = isRecord(params) ? params["name"] : undefined;
        if (typeof name !== "string" || name === "") {
          return { status: 200, body: rpcError(id, -32602, "Invalid params: tool name is required") };
        }
        const tool = findBrowserMcpTool(name);
        if (tool === undefined) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name.slice(0, 80)}`) };
        return respond(await callTool(tool, isRecord(params) ? params["arguments"] : undefined));
      }
      default:
        return { status: 200, body: rpcError(id, -32601, "Method not found") };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------------------------

export type BrowserMcpServerOptions = Readonly<{
  surface: BrowserPaneToolSurface;
  /** Only loopback addresses are accepted; anything else makes the start fail. Default 127.0.0.1. */
  host?: string;
}>;

export type BrowserMcpServer = Readonly<{
  /** `http://127.0.0.1:<port>/<token>/mcp`; the token is the only secret and never leaves main. */
  url: string;
  close: () => Promise<void>;
}>;

export function isLoopbackHost(host: string): boolean {
  if (host === "::1") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function isLoopbackName(hostname: string | undefined): boolean {
  return hostname === "localhost" || hostname === "[::1]" || (hostname !== undefined && isLoopbackHost(hostname));
}

function send(response: ServerResponse, status: number, body?: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    ...(payload === undefined ? { "Content-Length": "0" } : { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }),
    ...extraHeaders,
  });
  response.end(payload);
}

/** The body as text, or `undefined` when it is larger than the limit (the rest is read and dropped). */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT_BYTES) {
        resolve(undefined);
        request.destroy();
        return;
      }
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString("utf8")));
    request.on("close", () => resolve(undefined));
    request.on("error", reject);
  });
}

function tokenMatches(pathname: string, expected: string): boolean {
  const a = Buffer.from(pathname);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startBrowserMcpServer(options: BrowserMcpServerOptions): Promise<BrowserMcpServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("browser_mcp_non_loopback_bind");
  const handle = createBrowserMcpHandler(options.surface);
  const path = `/${randomBytes(16).toString("hex")}/mcp`;

  const server: Server = createServer((request, response) => {
    void (async () => {
      let pathname = "";
      try {
        pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        send(response, 404);
        return;
      }
      if (!tokenMatches(pathname, path)) {
        send(response, 404);
        return;
      }
      // DNS-rebinding defence in depth: browsers always send a Host naming the page's own origin
      // and an Origin on cross-site posts. Local MCP clients send a loopback Host and no Origin.
      const hostHeader = request.headers.host;
      const origin = request.headers.origin;
      if (
        hostHeader === undefined ||
        !isLoopbackName(hostnameOf(`http://${hostHeader}`)) ||
        (origin !== undefined && !isLoopbackName(hostnameOf(origin)))
      ) {
        send(response, 403, rpcError(null, -32600, "Forbidden"));
        return;
      }
      if (request.method !== "POST") {
        send(response, 405, undefined, { Allow: "POST" });
        return;
      }
      const raw = await readBody(request);
      if (raw === undefined) {
        send(response, 413, rpcError(null, -32600, "Request too large"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(response, 400, rpcError(null, -32700, "Parse error"));
        return;
      }
      const outcome = await handle(parsed);
      send(response, outcome.status, outcome.body);
    })().catch(() => {
      if (!response.headersSent) send(response, 500, rpcError(null, -32603, "Internal error"));
      else response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("browser_mcp_no_address");
  }
  const authority = host === "::1" ? `[::1]:${address.port}` : `${host}:${address.port}`;
  return {
    url: `http://${authority}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
