import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GrokProcessHostError,
  type AcpV1AdapterSink,
  type EngineProcessHost,
  type EngineProcessHostOptions,
  type ProcessHostEvent,
} from "@guild/runtime-grok";
import { createClaudeRuntime, RelocatingEngineProcess } from "./claude-runtime.js";
import type { LocatedClaudeEngine } from "./claude-locator.js";

const NODE_SHA = "a".repeat(64);
const SECOND_NODE_SHA = "b".repeat(64);

function located(node: string, sha: string): LocatedClaudeEngine {
  return Object.freeze({
    node: Object.freeze({ executablePath: node, sha256: sha, version: "26.8.1" }),
    adapter: Object.freeze({
      packageRoot: "/opt/adapter",
      entryPath: "/opt/adapter/dist/index.js",
      version: "0.89.1",
      fingerprintSha256: "c".repeat(64),
    }),
    claude: Object.freeze({ executablePath: "/opt/claude/bin/claude", version: "2.1.291" }),
  });
}

class FakeHost {
  readonly listeners = new Set<(event: ProcessHostEvent) => void>();
  startCalls = 0;
  constructor(private readonly failure: { code: string } | undefined) {}
  onEvent(listener: (event: ProcessHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start(): Promise<unknown> {
    this.startCalls += 1;
    if (this.failure !== undefined) {
      const failure = { type: "preflight_failure" as const, code: this.failure.code, message: "pin" };
      for (const listener of [...this.listeners]) listener({ type: "preflight_failure", failure } as ProcessHostEvent);
      throw new GrokProcessHostError(failure as never);
    }
    return { type: "process_started", pid: 1, processGroupId: 1 };
  }
  async stop(): Promise<unknown> { return {}; }
  async waitForTermination(): Promise<unknown> { return {}; }
  async write(): Promise<unknown> { return {}; }
}

function asHost(host: FakeHost): EngineProcessHost {
  return host as unknown as EngineProcessHost;
}

describe("Claude runtime process [PC-ENG-002]", () => {
  it("locates again once when a pin fails because the installed pieces changed, hiding the first failure", async () => {
    for (const code of ["adapter_changed", "claude_executable_invalid", "hash_mismatch"]) {
      const first = new FakeHost({ code });
      const second = new FakeHost(undefined);
      let relocations = 0;
      const process = new RelocatingEngineProcess({
        initial: asHost(first),
        relocate: async () => { relocations += 1; return asHost(second); },
      });
      const seen: string[] = [];
      process.onEvent((event) => seen.push(event.type));
      await process.start();
      assert.equal(relocations, 1, code);
      assert.equal(second.startCalls, 1);
      assert.deepEqual(seen, [], "the adapter would treat a preflight failure as a dead process");
      assert.equal(first.listeners.size, 0, "the abandoned host is detached");
      assert.equal(second.listeners.size, 1);
    }
  });

  it("reports the second failure and never retries a failure that is not about a changed pin", async () => {
    const first = new FakeHost({ code: "adapter_changed" });
    const second = new FakeHost({ code: "adapter_changed" });
    const process = new RelocatingEngineProcess({ initial: asHost(first), relocate: async () => asHost(second) });
    const seen: string[] = [];
    process.onEvent((event) => seen.push(event.type));
    await assert.rejects(process.start(), GrokProcessHostError);
    assert.deepEqual(seen, ["preflight_failure"], "the final failure reaches the adapter");
    await assert.rejects(process.start(), GrokProcessHostError, "only one re-locate per process");

    const other = new FakeHost({ code: "working_directory_not_absolute" });
    let relocated = false;
    const direct = new RelocatingEngineProcess({
      initial: asHost(other),
      relocate: async () => { relocated = true; return asHost(new FakeHost(undefined)); },
    });
    await assert.rejects(direct.start(), GrokProcessHostError);
    assert.equal(relocated, false);
  });

  it("builds the node plus adapter launch with the located pins and the routed environment", async () => {
    const hosts: EngineProcessHostOptions[] = [];
    let invalidated = 0;
    let locates = 0;
    const sink = {} as AcpV1AdapterSink;
    const runtime = await createClaudeRuntime(
      {
        adapterEpoch: 3,
        sink,
        stagingRoot: "/tmp/staging",
        workingDirectory: "/tmp/work",
        extraEnvironment: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/token/" },
      },
      {
        locate: async () => { locates += 1; return located(locates === 1 ? "/usr/local/bin/node" : "/opt/node/bin/node", locates === 1 ? NODE_SHA : SECOND_NODE_SHA); },
        invalidateLocatorCache: () => { invalidated += 1; },
        baseEnvironment: async () => ({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "must-not-pass" }),
        createHost: (options) => {
          hosts.push(options);
          // The second host fails too (for another reason), so the adapter's start ends at once.
          return asHost(new FakeHost({ code: hosts.length === 1 ? "hash_mismatch" : "working_directory_not_absolute" }));
        },
      },
    );
    assert.equal(runtime.adapter.engine, "claude");
    assert.equal(runtime.runtimeVersion, "Claude Code 2.1.291");
    assert.equal(hosts.length, 1);
    const [options] = hosts;
    assert.equal(options!.executablePath, "/usr/local/bin/node");
    assert.equal(options!.expectedSha256, NODE_SHA);
    assert.equal(options!.workingDirectory, "/tmp/work");
    assert.equal(options!.stagingRoot, "/tmp/staging");
    assert.deepEqual(options!.launch, {
      engine: "claude",
      adapter: located("", "").adapter,
      claudeExecutablePath: "/opt/claude/bin/claude",
      extraEnvironment: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/token/" },
    });

    // The first start fails its pin: everything is located again and the new pins are used.
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(invalidated, 1);
    assert.equal(locates, 2);
    assert.equal(hosts[1]!.executablePath, "/opt/node/bin/node");
    assert.equal(hosts[1]!.expectedSha256, SECOND_NODE_SHA);
    await runtime.adapter.close().catch(() => undefined);
  });
});
