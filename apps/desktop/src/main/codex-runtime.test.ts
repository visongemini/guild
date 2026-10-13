import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  GrokProcessHostError,
  type AcpV1AdapterSink,
  type EngineProcessHost,
  type EngineProcessHostOptions,
  type ProcessHostEvent,
} from "@guild/runtime-grok";
import { allowDevelopmentLocatorSearch, resetDevelopmentLocatorSearchForTesting } from "./claude-locator.js";
import { CodexEngineIntegrityError, type LocatedCodexEngine } from "./codex-locator.js";
import { createCodexRuntime } from "./codex-runtime.js";
import { RelocatingEngineProcess } from "./relocating-engine-process.js";

/*
 * PC-ENG-001, PC-ENG-003: the Codex runtime locates the pieces, hands the pinned ones to the process host and
 * accepts a changed piece only when it is an update. These tests drive it with fake hosts; no process is started.
 */

const NODE_SHA = "a".repeat(64);
const SECOND_NODE_SHA = "b".repeat(64);
const SINK = {} as AcpV1AdapterSink;
const INPUT = { adapterEpoch: 1, sink: SINK, stagingRoot: "/tmp/staging", workingDirectory: "/tmp/work" } as const;

function located(
  over: Readonly<{
    nodeSha?: string;
    adapterVersion?: string;
    fingerprint?: string;
    core?: Readonly<{ executablePath: string; version: string; sizeBytes: number }>;
  }> = {},
): LocatedCodexEngine {
  return Object.freeze({
    node: Object.freeze({ executablePath: "/usr/local/bin/node", sha256: over.nodeSha ?? NODE_SHA, version: "26.8.1" }),
    adapter: Object.freeze({
      packageRoot: "/opt/codex-acp",
      entryPath: "/opt/codex-acp/dist/index.js",
      version: over.adapterVersion ?? "2.2.2",
      fingerprintSha256: over.fingerprint ?? "c".repeat(64),
    }),
    core: Object.freeze(over.core ?? { executablePath: "/opt/codex-acp/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex", version: "0.160.1", sizeBytes: 241_000_000 }),
  });
}

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

const asHost = (host: FakeHost): EngineProcessHost => host as unknown as EngineProcessHost;

afterEach(() => resetDevelopmentLocatorSearchForTesting());

describe("Codex runtime process [PC-ENG-003]", () => {
  it("builds the node plus adapter launch with the pinned adapter and the pinned core, and no routed environment", async () => {
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createCodexRuntime(INPUT, {
      locate: async () => located(),
      invalidateLocatorCache: () => undefined,
      baseEnvironment: async () => ({ PATH: "/usr/bin", OPENAI_API_KEY: "must-not-pass" }),
      createHost: (options) => { hosts.push(options); return asHost(new FakeHost(undefined)); },
    });
    assert.equal(runtime.adapter.engine, "codex");
    assert.equal(runtime.runtimeVersion, "Codex 0.160.1");
    assert.equal(runtime.refusedForIntegrity(), false);
    assert.equal(hosts.length, 1);
    const [options] = hosts;
    assert.equal(options!.executablePath, "/usr/local/bin/node");
    assert.equal(options!.expectedSha256, NODE_SHA);
    assert.equal(options!.workingDirectory, "/tmp/work");
    assert.equal(options!.stagingRoot, "/tmp/staging");
    // Not a development run: the files that run in place must be private to the user (PC-SEC-001).
    assert.deepEqual(options!.launch, { engine: "codex", adapter: located().adapter, core: located().core, privateInstall: { required: true } });
    assert.equal(options!.profile.engine, "codex");
    await runtime.adapter.close().catch(() => undefined);
  });

  it("locates again once when a pin fails because the installed pieces changed, hiding the first failure", async () => {
    for (const code of ["adapter_changed", "engine_core_invalid", "hash_mismatch"]) {
      const first = new FakeHost({ code });
      const second = new FakeHost(undefined);
      let relocations = 0;
      const process = new RelocatingEngineProcess<CodexEngineIntegrityError>({
        initial: asHost(first),
        relocatableCodes: new Set(["adapter_changed", "engine_core_invalid", "hash_mismatch"]),
        isRefusal: (cause): cause is CodexEngineIntegrityError => cause instanceof CodexEngineIntegrityError,
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

  it("reports a second failure and never retries a failure that is not about a changed pin", async () => {
    const codes = new Set(["adapter_changed", "engine_core_invalid", "hash_mismatch"]);
    const isRefusal = (cause: unknown): cause is CodexEngineIntegrityError => cause instanceof CodexEngineIntegrityError;
    const first = new FakeHost({ code: "adapter_changed" });
    const process = new RelocatingEngineProcess<CodexEngineIntegrityError>({
      initial: asHost(first), relocatableCodes: codes, isRefusal, relocate: async () => asHost(new FakeHost({ code: "adapter_changed" })),
    });
    const seen: string[] = [];
    process.onEvent((event) => seen.push(event.type));
    await assert.rejects(process.start(), GrokProcessHostError);
    assert.deepEqual(seen, ["preflight_failure"], "the final failure reaches the adapter");
    await assert.rejects(process.start(), GrokProcessHostError, "only one re-locate per process");

    let relocated = false;
    const direct = new RelocatingEngineProcess<CodexEngineIntegrityError>({
      initial: asHost(new FakeHost({ code: "working_directory_not_absolute" })),
      relocatableCodes: codes,
      isRefusal,
      relocate: async () => { relocated = true; return asHost(new FakeHost(undefined)); },
    });
    await assert.rejects(direct.start(), GrokProcessHostError);
    assert.equal(relocated, false);
  });

  it("names the path too when the refusal comes from the host built after a re-locate [PC-SEC-001]", async () => {
    const path = "/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js";
    let locates = 0;
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createCodexRuntime(INPUT, {
      locate: async () => {
        locates += 1;
        return locates === 1 ? located() : located({ adapterVersion: "2.3.0", fingerprint: "d".repeat(64) });
      },
      invalidateLocatorCache: () => undefined,
      baseEnvironment: async () => ({ PATH: "/usr/bin" }),
      createHost: (options) => {
        hosts.push(options);
        return asHost(new FakeHost(hosts.length === 1 ? { code: "adapter_changed" } : { code: "install_not_private", path }));
      },
    });
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(hosts.length, 2);
    assert.equal(runtime.refusedForInstall(), path);
    await runtime.adapter.close().catch(() => undefined);
  });

  it("re-pins an adapter that moved to a new version together with its own new core", async () => {
    let locates = 0;
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createCodexRuntime(INPUT, {
      locate: async () => {
        locates += 1;
        return locates === 1
          ? located()
          : located({
              adapterVersion: "2.3.0",
              fingerprint: "d".repeat(64),
              core: { executablePath: "/opt/codex-acp/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex", version: "0.170.0", sizeBytes: 250_000_000 },
            });
      },
      invalidateLocatorCache: () => undefined,
      baseEnvironment: async () => ({ PATH: "/usr/bin" }),
      createHost: (options) => {
        hosts.push(options);
        return asHost(new FakeHost(hosts.length === 1 ? { code: "adapter_changed" } : { code: "working_directory_not_absolute" }));
      },
    });
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(hosts.length, 2);
    const launch = hosts[1]!.launch;
    assert.equal(launch.engine === "codex" && launch.adapter.version, "2.3.0");
    assert.equal(launch.engine === "codex" && launch.core.version, "0.170.0");
    assert.equal(runtime.refusedForIntegrity(), false);
    await runtime.adapter.close().catch(() => undefined);
  });

  it("builds no second host when the bytes of a pinned piece changed without an update, and stays refused", async () => {
    const cases: Array<[string, string, (locates: number) => LocatedCodexEngine]> = [
      ["node", "hash_mismatch", (n) => located({ nodeSha: n === 1 ? NODE_SHA : SECOND_NODE_SHA })],
      ["adapter", "adapter_changed", (n) => located({ fingerprint: n === 1 ? "c".repeat(64) : "e".repeat(64) })],
      // The same adapter version with another Codex core is not an update: the adapter ships its own core.
      ["core", "engine_core_invalid", (n) => located({ core: { executablePath: "/opt/elsewhere/codex", version: "0.160.1", sizeBytes: n === 1 ? 241_000_000 : 1 } })],
    ];
    for (const [component, code, answer] of cases) {
      let locates = 0;
      const hosts: EngineProcessHostOptions[] = [];
      const runtime = await createCodexRuntime(INPUT, {
        locate: async () => { locates += 1; return answer(locates); },
        invalidateLocatorCache: () => undefined,
        baseEnvironment: async () => ({ PATH: "/usr/bin" }),
        createHost: (options) => { hosts.push(options); return asHost(new FakeHost({ code })); },
      });
      assert.equal(runtime.refusedForIntegrity(), false, "nothing is refused before a start fails");
      await runtime.adapter.start().catch(() => undefined);
      assert.equal(locates, 2, component);
      assert.equal(hosts.length, 1, `${component}: the unexpectedly changed files get no host`);
      assert.equal(runtime.refusedForIntegrity(), true, component);
      await runtime.adapter.close().catch(() => undefined);
    }
  });

  it("asks the process host to keep the core, its folder and the adapter private to the user in a packaged app, and not in a development run [PC-SEC-001]", async () => {
    const launch = async (): Promise<EngineProcessHostOptions["launch"]> => {
      const hosts: EngineProcessHostOptions[] = [];
      const runtime = await createCodexRuntime(INPUT, {
        locate: async () => located(),
        baseEnvironment: async () => ({ PATH: "/usr/bin" }),
        createHost: (options) => { hosts.push(options); return asHost(new FakeHost(undefined)); },
      });
      await runtime.adapter.close().catch(() => undefined);
      return hosts[0]!.launch;
    };
    const packaged = await launch();
    assert.deepEqual(packaged.engine === "codex" && packaged.privateInstall, { required: true });
    allowDevelopmentLocatorSearch();
    const development = await launch();
    assert.equal(development.engine === "codex" && "privateInstall" in development, false);
  });

  it("names the path of a start refused because others could change the install, without locating again [PC-SEC-001]", async () => {
    const path = "/usr/local/lib/node_modules/@agentclientprotocol/codex-acp";
    let locates = 0;
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createCodexRuntime(INPUT, {
      locate: async () => { locates += 1; return located(); },
      invalidateLocatorCache: () => undefined,
      baseEnvironment: async () => ({ PATH: "/usr/bin" }),
      createHost: (options) => { hosts.push(options); return asHost(new FakeHost({ code: "install_not_private", path })); },
    });
    assert.equal(runtime.refusedForInstall(), undefined);
    await runtime.adapter.start().catch(() => undefined);
    assert.equal(runtime.refusedForInstall(), path);
    assert.equal(runtime.refusedForIntegrity(), false);
    assert.equal(locates, 1);
    assert.equal(hosts.length, 1);
    await runtime.adapter.close().catch(() => undefined);
  });

  it("hands out a runtime that refuses to start when the pieces already differ at creation", async () => {
    const hosts: EngineProcessHostOptions[] = [];
    const runtime = await createCodexRuntime(INPUT, {
      locate: async () => { throw new CodexEngineIntegrityError("node"); },
      invalidateLocatorCache: () => undefined,
      baseEnvironment: async () => ({ PATH: "/usr/bin" }),
      createHost: (options) => { hosts.push(options); return asHost(new FakeHost(undefined)); },
    });
    assert.equal(runtime.refusedForIntegrity(), true);
    assert.equal(runtime.runtimeVersion, undefined);
    await assert.rejects(runtime.adapter.start());
    await assert.rejects(runtime.adapter.start(), "and again");
    await runtime.adapter.close().catch(() => undefined);
    assert.equal(hosts.length, 0, "no host, so nothing was executed");

    // Anything but an integrity refusal is the caller's to handle (a missing install becomes a status).
    await assert.rejects(
      createCodexRuntime(INPUT, { locate: async () => { throw new Error("adapter_missing"); }, baseEnvironment: async () => ({ PATH: "/usr/bin" }) }),
      /adapter_missing/u,
    );
  });
});
