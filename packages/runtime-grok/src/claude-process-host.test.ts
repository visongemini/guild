import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, constants, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readdir } from "node:fs/promises";
import {
  CLAUDE_ADAPTER_PACKAGE_NAME,
  pinClaudeAdapter,
  type ClaudeAdapterPin,
} from "./adapter-pin.js";
import { CLAUDE_ENGINE_PROFILE, CLAUDE_ENVIRONMENT_POLICY_VERSION } from "./engine-profile.js";
import { pruneStalePinnedExecutables } from "./executable-pin.js";
import {
  EngineProcessHost,
  GrokProcessHostError,
  type EngineProcessHostOptions,
  type ProcessHostEvent,
  type ProcessStartReceipt,
} from "./process-host.js";

// A real child process: a copy of this test's own node stands in for the pinned node and for the
// claude binary, and a tiny script stands in for the ACP adapter. The real adapter, claude and
// grok are never started here.
const ADAPTER_SCRIPT = `
const env = Object.fromEntries(Object.entries(process.env));
process.stdout.write("REPORT:" + JSON.stringify({ argv: process.argv.slice(1), env, execPath: process.execPath }) + "\\n");
process.stderr.write("diagnostic " + (process.env.ANTHROPIC_BASE_URL ?? "none") + "\\n");
process.stdin.resume();
`;

let root: string;
let stagingRoot: string;
let nodePath: string;
let nodeSha256: string;
let claudePath: string;
let adapterRoot: string;
let adapter: ClaudeAdapterPin;

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "guild-claude-host-")));
  stagingRoot = join(root, "staging");
  await mkdir(stagingRoot, { mode: 0o700 });
  nodePath = join(root, "node");
  claudePath = join(root, "claude");
  // Clone-on-write where the file system supports it; a plain copy elsewhere.
  await copyFile(await realpath(process.execPath), nodePath, constants.COPYFILE_FICLONE);
  await chmod(nodePath, 0o700);
  await copyFile(nodePath, claudePath, constants.COPYFILE_FICLONE);
  await chmod(claudePath, 0o700);
  nodeSha256 = createHash("sha256").update(await readFile(nodePath)).digest("hex");
  adapterRoot = join(root, "adapter");
  await mkdir(join(adapterRoot, "dist"), { recursive: true });
  await writeFile(join(adapterRoot, "package.json"), JSON.stringify({ name: CLAUDE_ADAPTER_PACKAGE_NAME, version: "0.89.1" }));
  await writeFile(join(adapterRoot, "dist", "index.js"), ADAPTER_SCRIPT);
  adapter = await pinClaudeAdapter(adapterRoot);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function hostOptions(overrides: Partial<EngineProcessHostOptions> = {}): EngineProcessHostOptions {
  return {
    profile: CLAUDE_ENGINE_PROFILE,
    launch: { engine: "claude", adapter, claudeExecutablePath: claudePath },
    executablePath: nodePath,
    expectedSha256: nodeSha256,
    workingDirectory: root,
    stagingRoot,
    stopGraceMs: 2_000,
    killGraceMs: 2_000,
    ...overrides,
  };
}

type Report = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly execPath: string;
};

async function startAndReport(
  host: EngineProcessHost,
): Promise<{ started: ProcessStartReceipt; report: Report; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let resolveReport!: (value: string) => void;
  const reported = new Promise<string>((resolve) => {
    resolveReport = resolve;
  });
  host.onEvent((event) => {
    if (event.type === "stdout_data") {
      stdout += Buffer.from(event.chunk).toString("utf8");
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("REPORT:"));
      if (line !== undefined) resolveReport(line.slice("REPORT:".length));
    } else if (event.type === "stderr_diagnostic") {
      stderr += event.text;
    }
  });
  const started = await bounded(host.start());
  const report = JSON.parse(await bounded(reported)) as Report;
  // Wait for the stderr line the script writes right after the report.
  await bounded((async () => {
    while (!stderr.includes("diagnostic")) await new Promise((resolve) => setTimeout(resolve, 10));
  })());
  return { started, report, stderr };
}

async function bounded<T>(promise: Promise<T>, milliseconds = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`exceeded ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("Claude engine on the process host (PC-ENG-001, PC-ENG-002)", { concurrency: false }, () => {
  it("spawns the staged node copy with the adapter entry as argv[0] and the Claude environment", async () => {
    const host = new EngineProcessHost(hostOptions({
      baseEnvironment: {
        PATH: "/usr/bin:/bin",
        LC_MESSAGES: "C",
        ANTHROPIC_API_KEY: "sk-must-not-pass",
        CLAUDE_CODE_OAUTH_TOKEN: "token-must-not-pass",
        NODE_OPTIONS: "--no-warnings",
        DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
        OPENVIKING_MEMORY_ENABLED: "1",
        HTTPS_PROXY: "http://proxy.invalid:8080",
      },
    }));
    try {
      const { started, report } = await startAndReport(host);
      assert.notEqual(started.executablePath, nodePath, "the staged copy is spawned, not the original");
      assert.equal(started.executablePath.startsWith(join(stagingRoot, ".grok-pin-")), true);
      assert.deepEqual(started.argv, [adapter.entryPath]);
      assert.equal(started.environmentPolicyVersion, CLAUDE_ENVIRONMENT_POLICY_VERSION);
      assert.equal(started.shell, false);
      assert.deepEqual(report.argv, [adapter.entryPath]);
      assert.equal(report.env["CLAUDE_CODE_EXECUTABLE"], claudePath);
      assert.equal(report.env["LC_MESSAGES"], "C");
      assert.equal(report.env["HTTPS_PROXY"], "http://proxy.invalid:8080");
      assert.equal(report.env["NO_PROXY"], "127.0.0.1,localhost");
      assert.equal(report.env["no_proxy"], "127.0.0.1,localhost");
      for (const key of Object.keys(report.env)) {
        assert.equal(key.startsWith("ANTHROPIC_"), false, key);
        assert.equal(key.startsWith("OPENVIKING_"), false, key);
        assert.equal(key.startsWith("DYLD_"), false, key);
        assert.equal(key.startsWith("GROK_"), false, key);
      }
      assert.equal(report.env["CLAUDE_CODE_OAUTH_TOKEN"], undefined);
      assert.equal(report.env["NODE_OPTIONS"], undefined);
    } finally {
      const stopped = await bounded(host.stop());
      assert.equal(stopped.type, "stop_reaped");
    }
  });

  it("passes routed-session variables per spawn and redacts the token-bearing URL from stderr", async () => {
    const baseUrl = "http://127.0.0.1:43120/0123456789abcdef0123456789abcdef/";
    const host = new EngineProcessHost(hostOptions({
      launch: {
        engine: "claude",
        adapter,
        claudeExecutablePath: claudePath,
        extraEnvironment: {
          ANTHROPIC_BASE_URL: baseUrl,
          ENABLE_TOOL_SEARCH: "true",
          OPENVIKING_AUTO_CAPTURE: "false",
        },
      },
      baseEnvironment: { PATH: "/usr/bin:/bin", ANTHROPIC_BASE_URL: "http://evil.invalid" },
    }));
    try {
      const { report, stderr } = await startAndReport(host);
      assert.equal(report.env["ANTHROPIC_BASE_URL"], baseUrl);
      assert.equal(report.env["ENABLE_TOOL_SEARCH"], "true");
      assert.equal(report.env["OPENVIKING_AUTO_CAPTURE"], "false");
      assert.equal(stderr.includes("0123456789abcdef"), false, "the router token never reaches diagnostics");
      assert.equal(stderr.includes("[REDACTED]"), true);
    } finally {
      await bounded(host.stop());
    }
  });

  it("rejects per-spawn variables outside the allowlist before any process exists", () => {
    const rejected: readonly Readonly<Record<string, string>>[] = [
      { ANTHROPIC_API_KEY: "sk-x" },
      { CLAUDE_CODE_EXECUTABLE: "/tmp/claude" },
      { ANTHROPIC_BASE_URL: "https://api.example.com/" },
    ];
    for (const extraEnvironment of rejected) {
      assert.throws(
        () => new EngineProcessHost(hostOptions({
          launch: { engine: "claude", adapter, claudeExecutablePath: claudePath, extraEnvironment },
        })),
        TypeError,
      );
    }
  });

  it("refuses to spawn with adapter_changed when the adapter files differ from the pin", async () => {
    const entry = adapter.entryPath;
    const original = await readFile(entry, "utf8");
    const host = new EngineProcessHost(hostOptions());
    const events: ProcessHostEvent[] = [];
    host.onEvent((event) => events.push(event));
    await writeFile(entry, `${original}\n// tampered\n`);
    try {
      await assert.rejects(bounded(host.start()), (cause: unknown) => {
        assert.ok(cause instanceof GrokProcessHostError);
        assert.deepEqual(
          [cause.failure.type, cause.failure.type === "preflight_failure" ? cause.failure.code : undefined],
          ["preflight_failure", "adapter_changed"],
        );
        return true;
      });
      assert.equal((await bounded(host.waitForTermination())).type, "not_spawned");
      assert.equal(events.some((event) => event.type === "process_started"), false);
    } finally {
      await writeFile(entry, original);
    }
    const recovered = new EngineProcessHost(hostOptions());
    try {
      await bounded(recovered.start());
    } finally {
      await bounded(recovered.stop());
    }
  });

  it("refuses to spawn when the claude path is a symlink or not a Mach-O binary", async () => {
    const linked = join(root, "claude-link");
    await symlink(claudePath, linked);
    const script = join(root, "claude-script");
    await writeFile(script, "#!/bin/sh\nexit 0\n");
    await chmod(script, 0o700);
    for (const claudeExecutablePath of [linked, script, join(root, "does-not-exist")]) {
      const host = new EngineProcessHost(hostOptions({
        launch: { engine: "claude", adapter, claudeExecutablePath },
      }));
      await assert.rejects(bounded(host.start()), (cause: unknown) => {
        assert.ok(cause instanceof GrokProcessHostError);
        assert.equal(cause.failure.type === "preflight_failure" && cause.failure.code, "claude_executable_invalid");
        return true;
      });
      assert.equal((await bounded(host.waitForTermination())).type, "not_spawned");
    }
  });

  it("keeps the node pin: a node whose bytes differ from the pinned SHA-256 never starts", async () => {
    const host = new EngineProcessHost(hostOptions({ expectedSha256: "0".repeat(64) }));
    await assert.rejects(bounded(host.start()), (cause: unknown) => {
      assert.ok(cause instanceof GrokProcessHostError);
      assert.equal(cause.failure.type === "preflight_failure" && cause.failure.code, "hash_mismatch");
      return true;
    });
  });
  it("lets one staging root hold the Grok and the node pin: pruning keeps every pin still in use", async () => {
    const host = new EngineProcessHost(hostOptions());
    try {
      await bounded(host.start());
    } finally {
      await bounded(host.stop());
    }
    const stage = `.grok-pin-${nodeSha256}`;
    const otherPin = `.grok-pin-${"1".repeat(64)}`;
    await mkdir(join(stagingRoot, otherPin), { mode: 0o700 });
    assert.equal((await readdir(stagingRoot)).includes(stage), true);
    // The Grok warm-up passes its own pin and the node pin; only the unrelated stage is removed.
    assert.equal(await pruneStalePinnedExecutables(stagingRoot, ["2".repeat(64), nodeSha256]), 1);
    assert.deepEqual((await readdir(stagingRoot)).filter((name) => name.startsWith(".grok-pin-")), [stage]);
    // A single string still works as before and drops the node stage when it is not the kept pin.
    assert.equal(await pruneStalePinnedExecutables(stagingRoot, "2".repeat(64)), 1);
  });
});
