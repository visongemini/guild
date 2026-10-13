import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  GrokProcessHostError,
  type AcpV1AdapterSink,
  type EngineProcessHost,
  type EngineProcessHostOptions,
  type ProcessHostEvent,
} from "@guild/runtime-grok";
import { createClaudeRuntime, RelocatingEngineProcess } from "./claude-runtime.js";
import {
  ClaudeEngineIntegrityError,
  allowDevelopmentLocatorSearch,
  resetDevelopmentLocatorSearchForTesting,
  type LocatedClaudeEngine,
} from "./claude-locator.js";

const NODE_SHA = "a".repeat(64);
const SECOND_NODE_SHA = "b".repeat(64);

function located(
  node: string,
  sha: string,
  over: Readonly<{
    nodeVersion?: string;
    adapterVersion?: string;
    fingerprint?: string;
    claude?: Readonly<{ executablePath: string; version: string }>;
  }> = {},
): LocatedClaudeEngine {
  return Object.freeze({
    node: Object.freeze({ executablePath: node, sha256: sha, version: over.nodeVersion ?? "26.8.1" }),
    adapter: Object.freeze({
      packageRoot: "/opt/adapter",
      entryPath: "/opt/adapter/dist/index.js",
      version: over.adapterVersion ?? "0.89.1",
      fingerprintSha256: over.fingerprint ?? "c".repeat(64),
    }),
    claude: Object.freeze(over.claude ?? { executablePath: "/opt/claude/bin/claude", version: "2.1.291" }),
  });
}

const CLAUDE_RELEASE = (version: string, root = "/home/u/.local/share/claude") =>
  ({ executablePath: `${root}/versions/${version}`, version });

class FakeHost {
  readonly listeners = new Set<(event: ProcessHostEvent) => void>();
  startCalls = 0;
  constructor(private readonly failure: { code: string; path?: string } | undefined) {}
  onEvent(listener: (event: ProcessHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start(): Promise<unknown> {
    this.startCalls += 1;
    if (this.failure !== undefined) {
      const failure = {
        type: "preflight_failure" as const,
        code: this.failure.code,
        message: "pin",
        ...(this.failure.path === undefined ? {} : { path: this.failure.path }),
      };
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

afterEach(() => resetDevelopmentLocatorSearchForTesting());

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
        // The second answer is an adapter update (another package version), which a re-locate accepts.
        locate: async () => {
          locates += 1;
          return locates === 1
            ? located("/usr/local/bin/node", NODE_SHA)
            : located("/usr/local/bin/node", NODE_SHA, { adapterVersion: "0.89.2", fingerprint: "d".repeat(64) });
        },
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
      // Not a development run: the files that run in place must be private to the user (PC-SEC-001).
      privateInstall: { required: true },
      extraEnvironment: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/token/" },
    });

    // The first start fails its pin: everything is located again and the new pins are used.
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(invalidated, 1);
    assert.equal(locates, 2);
    assert.equal(hosts[1]!.executablePath, "/usr/local/bin/node");
    assert.equal(hosts[1]!.expectedSha256, NODE_SHA);
    assert.equal(hosts[1]!.launch.engine === "claude" && hosts[1]!.launch.adapter.version, "0.89.2");
    await runtime.adapter.close().catch(() => undefined);
  });

  it("refuses to run when the same version comes back with other bytes, and stays refused [PC-ENG-002]", async () => {
    const first = new FakeHost({ code: "hash_mismatch" });
    const process = new RelocatingEngineProcess({
      initial: asHost(first),
      relocate: async () => { throw new ClaudeEngineIntegrityError("node"); },
    });
    const seen: string[] = [];
    process.onEvent((event) => seen.push(event.type));
    await assert.rejects(process.start(), (cause: unknown) => {
      assert.ok(cause instanceof ClaudeEngineIntegrityError);
      assert.equal(cause.message, "engine_integrity_changed");
      assert.equal(cause.component, "node");
      return true;
    });
    assert.ok(process.refusal instanceof ClaudeEngineIntegrityError);
    await assert.rejects(process.start(), ClaudeEngineIntegrityError, "a later start is refused too");
    assert.equal(first.startCalls, 1, "the changed files are never executed");
    assert.deepEqual(seen, [], "the withheld preflight failure is not replayed to the adapter");
  });

  it("builds no second host when only the bytes of a pinned piece changed, and says so [PC-ENG-002]", async () => {
    const cases: Array<[string, (locates: number) => LocatedClaudeEngine]> = [
      ["node", (n) => located("/usr/local/bin/node", n === 1 ? NODE_SHA : SECOND_NODE_SHA)],
      // A node with a new version is no update either: a node change takes effect on the next launch.
      ["node", (n) => n === 1 ? located("/usr/local/bin/node", NODE_SHA) : located("/opt/node/bin/node", SECOND_NODE_SHA, { nodeVersion: "26.9.0" })],
      ["adapter", (n) => located("/usr/local/bin/node", NODE_SHA, { fingerprint: n === 1 ? "c".repeat(64) : "d".repeat(64) })],
    ];
    for (const [component, answer] of cases) {
      let locates = 0;
      const hosts: EngineProcessHostOptions[] = [];
      const runtime = await createClaudeRuntime(
        { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
        {
          locate: async () => { locates += 1; return answer(locates); },
          invalidateLocatorCache: () => undefined,
          baseEnvironment: async () => ({ PATH: "/usr/bin" }),
          createHost: (options) => {
            hosts.push(options);
            return asHost(new FakeHost({ code: component === "node" ? "hash_mismatch" : "adapter_changed" }));
          },
        },
      );
      assert.equal(runtime.refusedForIntegrity(), false, "nothing is refused before a start fails");
      await runtime.adapter.start().catch(() => undefined);
      assert.equal(locates, 2, component);
      assert.equal(hosts.length, 1, `${component}: the unexpectedly changed files get no host`);
      assert.equal(runtime.refusedForIntegrity(), true, component);
      await runtime.adapter.close().catch(() => undefined);
    }
  });

  it("hands the pieces of the first locate to the re-locate and accepts a new claude release only [PC-ENG-002]", async () => {
    const cases: Array<{ name: string; second: LocatedClaudeEngine; refused: boolean }> = [
      { name: "new release", second: located("/usr/local/bin/node", NODE_SHA, { claude: CLAUDE_RELEASE("2.1.300") }), refused: false },
      { name: "same release elsewhere", second: located("/usr/local/bin/node", NODE_SHA, { claude: CLAUDE_RELEASE("2.1.291", "/tmp/other") }), refused: true },
      { name: "outside the layout", second: located("/usr/local/bin/node", NODE_SHA, { claude: { executablePath: "/tmp/evil/claude", version: "2.1.300" } }), refused: true },
    ];
    for (const { name, second, refused } of cases) {
      const seen: Array<LocatedClaudeEngine | undefined> = [];
      const hosts: EngineProcessHostOptions[] = [];
      const first = located("/usr/local/bin/node", NODE_SHA, { claude: CLAUDE_RELEASE("2.1.291") });
      const runtime = await createClaudeRuntime(
        { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
        {
          locate: async (previous) => { seen.push(previous); return seen.length === 1 ? first : second; },
          invalidateLocatorCache: () => undefined,
          baseEnvironment: async () => ({ PATH: "/usr/bin" }),
          createHost: (options) => {
            hosts.push(options);
            return asHost(new FakeHost(hosts.length === 1 ? { code: "claude_executable_invalid" } : { code: "working_directory_not_absolute" }));
          },
        },
      );
      await runtime.adapter.start().catch(() => undefined);
      assert.deepEqual(seen, [undefined, first], `${name}: only the re-locate gets the earlier pieces`);
      assert.equal(runtime.refusedForIntegrity(), refused, name);
      assert.equal(hosts.length, refused ? 1 : 2, name);
      if (!refused) assert.equal(hosts[1]!.launch.engine === "claude" && hosts[1]!.launch.claudeExecutablePath, "/home/u/.local/share/claude/versions/2.1.300");
      await runtime.adapter.close().catch(() => undefined);
    }
  });

  it("hands out a runtime that refuses to start when the pieces already differ at creation [PC-ENG-002]", async () => {
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createClaudeRuntime(
      { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
      {
        locate: async () => { throw new ClaudeEngineIntegrityError("node"); },
        invalidateLocatorCache: () => undefined,
        baseEnvironment: async () => ({ PATH: "/usr/bin" }),
        createHost: (options) => { hosts.push(options); return asHost(new FakeHost(undefined)); },
      },
    );
    assert.equal(runtime.refusedForIntegrity(), true);
    assert.equal(runtime.runtimeVersion, undefined);
    await assert.rejects(runtime.adapter.start());
    await assert.rejects(runtime.adapter.start(), "and again");
    await runtime.adapter.close().catch(() => undefined);
    assert.equal(hosts.length, 0, "no host, so nothing was executed");

    // Anything but an integrity refusal is the caller's to handle.
    await assert.rejects(
      createClaudeRuntime(
        { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
        { locate: async () => { throw new Error("claude_missing"); }, baseEnvironment: async () => ({ PATH: "/usr/bin" }) },
      ),
      /claude_missing/u,
    );
  });

  it("asks the process host to keep the claude binary and the adapter private to the user in a packaged app, and not in a development run [PC-SEC-001]", async () => {
    const launches = async (privateInstallRule?: () => { required: true } | undefined): Promise<EngineProcessHostOptions["launch"]> => {
      const hosts: EngineProcessHostOptions[] = [];
      const runtime = await createClaudeRuntime(
        { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
        {
          locate: async () => located("/usr/local/bin/node", NODE_SHA),
          baseEnvironment: async () => ({ PATH: "/usr/bin" }),
          createHost: (options) => { hosts.push(options); return asHost(new FakeHost(undefined)); },
          ...(privateInstallRule === undefined ? {} : { privateInstallRule }),
        },
      );
      await runtime.adapter.close().catch(() => undefined);
      return hosts[0]!.launch;
    };
    // The default follows the process-wide switch: a packaged app requires it, a development run does not.
    const packaged = await launches();
    assert.deepEqual(packaged.engine === "claude" && packaged.privateInstall, { required: true });
    allowDevelopmentLocatorSearch();
    const development = await launches();
    assert.equal(development.engine === "claude" && "privateInstall" in development, false);
    resetDevelopmentLocatorSearchForTesting();
    // An explicit rule wins (the tests of the process host use it with an injected file system).
    const explicit = await launches(() => ({ required: true }));
    assert.deepEqual(explicit.engine === "claude" && explicit.privateInstall, { required: true });
  });

  it("names the path of a start that was refused because others could change the install, without a second locate or host [PC-SEC-001]", async () => {
    const path = "/Users/me/.local/share/claude/versions/2.1.291";
    let locates = 0;
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createClaudeRuntime(
      { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
      {
        locate: async () => { locates += 1; return located("/usr/local/bin/node", NODE_SHA); },
        baseEnvironment: async () => ({ PATH: "/usr/bin" }),
        createHost: (options) => { hosts.push(options); return asHost(new FakeHost({ code: "install_not_private", path })); },
      },
    );
    assert.equal(runtime.refusedForInstall(), undefined, "nothing is refused before a start fails");
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(runtime.refusedForInstall(), path);
    assert.equal(runtime.refusedForIntegrity(), false, "this is not a changed pin");
    assert.equal(locates, 1, "it is not a reason to locate again");
    assert.equal(hosts.length, 1);
    await runtime.adapter.close().catch(() => undefined);
  });

  it("names it too when the refusal comes from the host built after a re-locate [PC-SEC-001]", async () => {
    const path = "/Users/me/.npm-global/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js";
    let locates = 0;
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createClaudeRuntime(
      { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
      {
        locate: async () => {
          locates += 1;
          return locates === 1
            ? located("/usr/local/bin/node", NODE_SHA)
            : located("/usr/local/bin/node", NODE_SHA, { adapterVersion: "0.89.2", fingerprint: "d".repeat(64) });
        },
        invalidateLocatorCache: () => undefined,
        baseEnvironment: async () => ({ PATH: "/usr/bin" }),
        createHost: (options) => {
          hosts.push(options);
          return asHost(new FakeHost(hosts.length === 1 ? { code: "adapter_changed" } : { code: "install_not_private", path }));
        },
      },
    );
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(hosts.length, 2);
    assert.equal(runtime.refusedForInstall(), path);
    await runtime.adapter.close().catch(() => undefined);
  });

  it("re-pins an adapter that moved to a new version [PC-ENG-002]", async () => {
    let locates = 0;
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createClaudeRuntime(
      { adapterEpoch: 1, sink: {} as AcpV1AdapterSink, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" },
      {
        locate: async () => {
          locates += 1;
          return locates === 1
            ? located("/usr/local/bin/node", NODE_SHA)
            : located("/usr/local/bin/node", NODE_SHA, { adapterVersion: "0.89.2", fingerprint: "d".repeat(64) });
        },
        invalidateLocatorCache: () => undefined,
        baseEnvironment: async () => ({ PATH: "/usr/bin" }),
        createHost: (options) => {
          hosts.push(options);
          return asHost(new FakeHost(hosts.length === 1 ? { code: "adapter_changed" } : { code: "working_directory_not_absolute" }));
        },
      },
    );
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(hosts.length, 2);
    assert.equal(hosts[1]!.launch.engine === "claude" && hosts[1]!.launch.adapter.version, "0.89.2");
    assert.equal(runtime.refusedForIntegrity(), false);
    await runtime.adapter.close().catch(() => undefined);
  });
});
