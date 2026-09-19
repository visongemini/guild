import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import {
  createGrokAcpProductionArgv,
} from "../packages/runtime-grok/dist/grok-acp-profile.js";

const executable = join(homedir(), ".grok", "bin", "grok");
const cwd = process.argv[2] ?? process.cwd();
const outputPath = join(cwd, "../dev/clean-client-v2-impl/evidence/probes/grok-1.0.13-session-fork.json");
const nonce = `FORK-ANCHOR-${randomUUID()}`;
class ProbeStop extends Error {}

const result = {
  schemaVersion: 1,
  observedAtIso: new Date().toISOString(),
  runtime: "grok 1.0.13",
  protocolVersion: 1,
  capabilityAdvertised: false,
  capabilityShape: null,
  originalSessionHash: null,
  forkSessionHash: null,
  forkSessionDistinct: false,
  forkResumedInIndependentProcess: false,
  originalResumedInIndependentProcess: false,
  inheritedHiddenContext: false,
  forkCancellationTerminal: false,
  forkHealthyAfterCancellation: false,
  originalHealthyAfterFork: false,
  verdict: "not_run",
};

async function runProbe() {
let first;
let forkClient;
let originalClient;
try {
  first = await GrokProbeClient.start("source");
  const initialized = await first.initialize();
  result.capabilityShape = capabilityShape(initialized);
  result.capabilityAdvertised = hasForkCapability(initialized);
  if (!result.capabilityAdvertised) {
    result.verdict = "not_advertised";
    throw new ProbeStop("session/fork was not advertised");
  }
  await first.authenticate(initialized);
  const original = await first.request("session/new", { cwd, mcpServers: [] });
  const originalSessionId = exactSessionId(original, "session/new");
  result.originalSessionHash = digest(originalSessionId);
  const sourcePrompt = await first.prompt(
    originalSessionId,
    `Do not use tools. Remember this exact nonce for later: ${nonce}. Reply only ORIGINAL-READY.`,
  );
  if (!first.assistantText(originalSessionId).includes("ORIGINAL-READY")) {
    throw new Error(`source_prompt_missing_marker:${JSON.stringify(sourcePrompt)}`);
  }
  const forked = await first.request("session/fork", {
    sessionId: originalSessionId,
    cwd,
    mcpServers: [],
  });
  const forkSessionId = exactSessionId(forked, "session/fork");
  result.forkSessionHash = digest(forkSessionId);
  result.forkSessionDistinct = forkSessionId !== originalSessionId;
  if (!result.forkSessionDistinct) throw new Error("fork_reused_source_session_id");
  await first.close();
  first = undefined;

  forkClient = await GrokProbeClient.start("fork");
  await forkClient.initializeAndAuthenticate();
  await forkClient.request("session/resume", { sessionId: forkSessionId, cwd, mcpServers: [] });
  result.forkResumedInIndependentProcess = true;
  await forkClient.prompt(
    forkSessionId,
    "Do not use tools. Reply with only the exact nonce I asked you to remember before this session was forked.",
  );
  result.inheritedHiddenContext = forkClient.assistantText(forkSessionId).includes(nonce);
  if (!result.inheritedHiddenContext) throw new Error("fork_hidden_context_missing");

  const cancellable = forkClient.prompt(
    forkSessionId,
    "Use the terminal tool to execute `sleep 45`. When it finishes, reply FORK-CANCEL-SHOULD-NOT-COMPLETE.",
  );
  await forkClient.waitForUpdate(
    (params) => params?.sessionId === forkSessionId &&
      ["tool_call", "tool_call_update"].includes(params?.update?.sessionUpdate),
    120_000,
  );
  forkClient.notify("session/cancel", { sessionId: forkSessionId });
  const cancelResult = await cancellable;
  result.forkCancellationTerminal = ["cancelled", "cancelled_by_user"].includes(cancelResult?.stopReason) &&
    !forkClient.assistantText(forkSessionId).includes("FORK-CANCEL-SHOULD-NOT-COMPLETE");
  if (!result.forkCancellationTerminal) {
    throw new Error(`fork_cancel_not_terminal:${JSON.stringify({ stopReason: cancelResult?.stopReason })}`);
  }
  forkClient.clearAssistantText(forkSessionId);
  await forkClient.prompt(forkSessionId, "Do not use tools. Reply only FORK-AFTER-CANCEL-OK.");
  result.forkHealthyAfterCancellation = forkClient.assistantText(forkSessionId).includes("FORK-AFTER-CANCEL-OK");
  if (!result.forkHealthyAfterCancellation) throw new Error("fork_unhealthy_after_cancel");
  await forkClient.close();
  forkClient = undefined;

  originalClient = await GrokProbeClient.start("original");
  await originalClient.initializeAndAuthenticate();
  await originalClient.request("session/resume", { sessionId: originalSessionId, cwd, mcpServers: [] });
  result.originalResumedInIndependentProcess = true;
  await originalClient.prompt(originalSessionId, "Do not use tools. Reply only ORIGINAL-STILL-OK.");
  result.originalHealthyAfterFork = originalClient.assistantText(originalSessionId).includes("ORIGINAL-STILL-OK");
  if (!result.originalHealthyAfterFork) throw new Error("original_unhealthy_after_fork");
  result.verdict = "proven";
} catch (error) {
  if (!(error instanceof ProbeStop)) {
    result.verdict = "failed";
    result.failure = safeFailure(error);
  }
} finally {
  await Promise.allSettled([
    first?.close(),
    forkClient?.close(),
    originalClient?.close(),
  ].filter(Boolean));
  await mkdir(new URL("../evidence/probes/", import.meta.url), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log("grok_session_fork_probe", JSON.stringify(result));
}
}

class GrokProbeClient {
  static async start(label) {
    const argv = createGrokAcpProductionArgv({
      model: "grok-4.6",
      reasoningEffort: "low",
      permissionMode: "bypassPermissions",
    });
    const child = spawn(executable, argv, {
      cwd,
      env: Object.fromEntries(
        ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]
          .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
      ),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    return new GrokProbeClient(label, child);
  }

  constructor(label, child) {
    this.label = label;
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.updateWaiters = new Set();
    this.assistant = new Map();
    this.stderrBytes = 0;
    this.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk) => { this.stderrBytes += chunk.length; });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => this.failAll(new Error(`grok_exit:${label}:${code}:${signal}`)));
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
      clientInfo: { name: "guild-fork-probe", title: "Guild fork probe", version: "2.0.27" },
    });
  }

  async authenticate(initialized) {
    const methods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
    if (methods.length === 0) return;
    const preferred = methods.find((method) => method?.id === initialized?.defaultAuthMethodId) ?? methods[0];
    if (typeof preferred?.id !== "string" || preferred.id.length === 0) throw new Error("invalid_auth_method");
    await this.request("authenticate", { methodId: preferred.id });
  }

  async initializeAndAuthenticate() {
    const initialized = await this.initialize();
    await this.authenticate(initialized);
    return initialized;
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`grok_request_timeout:${this.label}:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async prompt(sessionId, text) {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    }, 180_000);
  }

  assistantText(sessionId) {
    return this.assistant.get(sessionId) ?? "";
  }

  clearAssistantText(sessionId) {
    this.assistant.set(sessionId, "");
  }

  waitForUpdate(predicate, timeoutMs) {
    const existing = this.updates.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      const timer = setTimeout(() => {
        this.updateWaiters.delete(waiter);
        reject(new Error(`grok_update_timeout:${this.label}`));
      }, timeoutMs);
      waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
      this.updateWaiters.add(waiter);
    });
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const stopped = await Promise.race([
      this.exited.then(() => true),
      delay(5_000).then(() => false),
    ]);
    if (!stopped && this.child.pid !== undefined) {
      try { process.kill(-this.child.pid, "SIGKILL"); } catch {}
      await this.exited;
    }
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(new Error(`grok_invalid_json:${this.label}`));
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const operation = this.pending.get(message.id);
      if (operation === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        operation.reject(new Error(`grok_remote_error:${operation.method}:${safeRemoteError(message.error)}`));
      } else operation.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    if (message.method !== "session/update") return;
    const params = message.params;
    this.updates.push(params);
    if (this.updates.length > 512) this.updates.shift();
    if (
      typeof params?.sessionId === "string" &&
      params?.update?.sessionUpdate === "agent_message_chunk" &&
      params?.update?.content?.type === "text" &&
      typeof params.update.content.text === "string"
    ) {
      this.assistant.set(params.sessionId, `${this.assistant.get(params.sessionId) ?? ""}${params.update.content.text}`);
    }
    for (const waiter of [...this.updateWaiters]) {
      if (!waiter.predicate(params)) continue;
      this.updateWaiters.delete(waiter);
      waiter.resolve(params);
    }
  }

  failAll(error) {
    for (const operation of this.pending.values()) operation.reject(error);
    this.pending.clear();
    for (const waiter of this.updateWaiters) waiter.reject(error);
    this.updateWaiters.clear();
  }
}

function hasForkCapability(initialized) {
  return initialized?.agentCapabilities?.session?.fork !== undefined ||
    initialized?.agentCapabilities?.sessionCapabilities?.fork !== undefined;
}

function capabilityShape(initialized) {
  const capabilities = initialized?.agentCapabilities;
  return {
    agentCapabilities: isRecord(capabilities) ? Object.keys(capabilities).sort() : [],
    session: isRecord(capabilities?.session) ? Object.keys(capabilities.session).sort() : [],
    sessionCapabilities: isRecord(capabilities?.sessionCapabilities)
      ? Object.keys(capabilities.sessionCapabilities).sort()
      : [],
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactSessionId(value, method) {
  if (typeof value?.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error(`${method}_session_id_missing`);
  }
  return value.sessionId;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRemoteError(error) {
  return JSON.stringify({
    code: Number.isSafeInteger(error?.code) ? error.code : null,
    message: typeof error?.message === "string" ? error.message.slice(0, 200) : "remote_error",
  });
}

function safeFailure(error) {
  return error instanceof Error ? `${error.name}:${error.message}`.slice(0, 500) : "unknown_failure";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await runProbe();
