import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AdapterPinError, pinCodexAdapter } from "./adapter-pin.js";
import { pinCodexCore } from "./codex-core-pin.js";
import {
  CLAUDE_ENGINE_PROFILE,
  CODEX_ENGINE_PROFILE,
  CODEX_ENVIRONMENT_POLICY,
  CODEX_ENVIRONMENT_POLICY_VERSION,
  buildEngineEnvironment,
  engineProfileFor,
  isAdapterDialect,
  type CodexLaunch,
} from "./engine-profile.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const adapter = Object.freeze({
  packageRoot: "/opt/codex-acp",
  entryPath: "/opt/codex-acp/dist/index.js",
  version: "2.2.2",
  fingerprintSha256: "0".repeat(64),
});
const core = Object.freeze({ executablePath: "/opt/codex-acp/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex", version: "0.160.1", sizeBytes: 12 });

function launch(overrides: Partial<CodexLaunch> = {}): CodexLaunch {
  return { engine: "codex", adapter, core, ...overrides };
}

const rich = {
  PATH: "/usr/bin:/bin",
  HOME: "/somewhere/else",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_MESSAGES: "C",
  USER: "someone",
  LOGNAME: "someone",
  TMPDIR: "/tmp/x/",
  HTTP_PROXY: "http://proxy.invalid:8080",
  https_proxy: "http://proxy.invalid:8080",
  NO_PROXY: "10.0.0.0/8,localhost",
  SSL_CERT_FILE: "/etc/ssl/cert.pem",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  // Everything the Codex adapter reads from its environment to pick a credential, a provider, a state directory or a binary.
  CODEX_API_KEY: "sk-must-not-pass",
  OPENAI_API_KEY: "sk-must-not-pass",
  OPENAI_BASE_URL: "http://evil.invalid",
  CODEX_HOME: "/tmp/other-codex-home",
  CODEX_PATH: "/tmp/other-codex",
  CODEX_CONFIG: "{\"x\":1}",
  CODEX_MANAGED_BY_NPM: "1",
  MODEL_PROVIDER: "evil",
  DEFAULT_AUTH_REQUEST: "{\"methodId\":\"api-key\"}",
  INITIAL_AGENT_MODE: "agent-full-access",
  NO_BROWSER: "1",
  APP_SERVER_LOGS: "/tmp/logs",
  ANTHROPIC_API_KEY: "sk-ant-nope",
  GROK_API_KEY: "xai-nope",
  NODE_OPTIONS: "--require /tmp/hook.js",
  NODE_PATH: "/tmp/modules",
  ELECTRON_RUN_AS_NODE: "1",
  DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
  LD_PRELOAD: "/tmp/x.so",
  BASH_ENV: "/tmp/rc",
  OPENVIKING_MEMORY_ENABLED: "1",
  OPENVIKING_AUTO_CAPTURE: "true",
  OPENVIKING_API_KEY: "ov-key",
  OPENVIKING_URL: "http://real.invalid",
};

describe("Codex engine profile (PC-ENG-003)", () => {
  it("is a node-script adapter engine that Guild never authenticates for", () => {
    assert.deepEqual(
      [CODEX_ENGINE_PROFILE.engine, CODEX_ENGINE_PROFILE.dialect, CODEX_ENGINE_PROFILE.pinStrategy, CODEX_ENGINE_PROFILE.authPolicy],
      ["codex", "codex", "node-script", "never"],
    );
    assert.deepEqual(CODEX_ENGINE_PROFILE.features, {
      billing: false,
      steer: true,
      conversationRewind: false,
      xaiSignals: false,
      agentInitiatedTurns: false,
    });
    assert.equal(engineProfileFor("codex"), CODEX_ENGINE_PROFILE);
    assert.equal(engineProfileFor("claude"), CLAUDE_ENGINE_PROFILE);
    assert.equal(isAdapterDialect("codex") && isAdapterDialect("claude") && !isAdapterDialect("grok"), true);
    assert.equal(Object.isFrozen(CODEX_ENGINE_PROFILE) && Object.isFrozen(CODEX_ENGINE_PROFILE.features), true);
  });

  it("runs the adapter entry alone: no argv for rules, credentials or a model", () => {
    const argv = CODEX_ENGINE_PROFILE.buildArgv(launch());
    assert.deepEqual(argv, ["/opt/codex-acp/dist/index.js"]);
  });

  it("rejects a launch for another engine or with unusable paths", () => {
    assert.throws(() => CODEX_ENGINE_PROFILE.planLaunch({ engine: "grok" }), TypeError);
    assert.throws(() => CLAUDE_ENGINE_PROFILE.planLaunch(launch() as never), TypeError);
    assert.throws(() => CODEX_ENGINE_PROFILE.planLaunch(launch({ adapter: { ...adapter, entryPath: "dist/index.js" } })), TypeError);
    assert.throws(() => CODEX_ENGINE_PROFILE.planLaunch(launch({ core: { ...core, executablePath: "codex" } })), TypeError);
    assert.throws(() => CODEX_ENGINE_PROFILE.planLaunch(launch({ core: { ...core, executablePath: "/opt/co\0dex" } })), TypeError);
  });

  it("allowlists the documented keys and strips every credential, provider, state and loader variable", () => {
    const environment = buildEngineEnvironment(CODEX_ENVIRONMENT_POLICY, rich);
    const kept = Object.keys(environment).filter((key) => !key.startsWith("OPENVIKING_")).sort();
    assert.deepEqual(kept, [
      "HOME", "HTTP_PROXY", "LANG", "LC_ALL", "LC_MESSAGES", "LOGNAME", "NO_PROXY", "PATH", "SSH_AUTH_SOCK", "SSL_CERT_FILE",
      "TMPDIR", "USER", "https_proxy", "no_proxy",
    ].sort());
    assert.equal(environment.HOME, homedir(), "HOME is the real home, so Codex finds its own login and never another");
    assert.equal(environment.USER, "someone");
    for (const stripped of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CODEX_PATH", "CODEX_CONFIG", "CODEX_MANAGED_BY_NPM",
      "MODEL_PROVIDER", "DEFAULT_AUTH_REQUEST", "INITIAL_AGENT_MODE", "NO_BROWSER", "APP_SERVER_LOGS", "ANTHROPIC_API_KEY", "GROK_API_KEY",
      "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "BASH_ENV"]) {
      assert.equal(stripped in environment, false, stripped);
    }
    assert.equal(Object.isFrozen(environment), true);
  });

  it("switches OpenViking recall and capture off by the Codex plugin's own variables and points the rest at nothing", () => {
    const environment = buildEngineEnvironment(CODEX_ENVIRONMENT_POLICY, rich);
    // The Codex plugin ignores OPENVIKING_MEMORY_ENABLED (its doctor says so): recall and capture have their own switches.
    assert.equal(environment.OPENVIKING_AUTO_RECALL, "false");
    assert.equal(environment.OPENVIKING_AUTO_CAPTURE, "false");
    assert.equal(environment.OPENVIKING_MEMORY_ENABLED, "0");
    assert.equal(environment.OPENVIKING_CONFIG_FILE, "/dev/null");
    assert.equal(environment.OPENVIKING_CLI_CONFIG_FILE, "/dev/null");
    assert.equal(environment.OPENVIKING_URL, "http://127.0.0.1:9");
    assert.equal(environment.OPENVIKING_BASE_URL, "http://127.0.0.1:9");
    assert.equal("OPENVIKING_API_KEY" in environment, false, "no store credential reaches the engine");
    // The Grok-only values are not Codex's.
    for (const key of Object.keys(environment)) assert.equal(key.startsWith("GROK_"), false, key);
  });

  it("always includes the loopback in NO_PROXY, which the browser MCP server needs", () => {
    assert.equal(buildEngineEnvironment(CODEX_ENVIRONMENT_POLICY, {}).NO_PROXY, "127.0.0.1,localhost");
    const merged = buildEngineEnvironment(CODEX_ENVIRONMENT_POLICY, rich);
    assert.equal(merged.NO_PROXY, "127.0.0.1,localhost,10.0.0.0/8");
    assert.equal(merged.no_proxy, merged.NO_PROXY);
  });

  it("hands the adapter exactly the core it checked, as CODEX_PATH, through the launch plan only", () => {
    const plan = CODEX_ENGINE_PROFILE.planLaunch(launch());
    const environment = plan.buildEnvironment(rich);
    assert.equal(environment.CODEX_PATH, core.executablePath, "not the parent's CODEX_PATH");
    assert.equal(environment.CODEX_HOME, undefined);
    assert.equal(plan.environmentPolicyVersion, CODEX_ENVIRONMENT_POLICY_VERSION);
    assert.deepEqual(plan.argv, ["/opt/codex-acp/dist/index.js"]);
    assert.deepEqual(plan.redactValues, []);
    assert.equal(typeof plan.verifyBeforeSpawn, "function");
    // No per-spawn variable exists for Codex: there is no routed mode.
    assert.deepEqual(Object.keys(CODEX_ENVIRONMENT_POLICY.perSpawnKeys), []);
  });

  it("verifies the adapter and the core before every spawn, and says which piece changed", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "guild-codex-profile-")));
    roots.push(root);
    const adapterRoot = join(root, "codex-acp");
    await mkdir(join(adapterRoot, "dist"), { recursive: true });
    await writeFile(join(adapterRoot, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "2.2.2" }));
    await writeFile(join(adapterRoot, "dist", "index.js"), "console.log(1);\n");
    const vendor = join(adapterRoot, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin");
    await mkdir(join(vendor, "bin"), { recursive: true });
    await writeFile(join(vendor, "codex-package.json"), JSON.stringify({ version: "0.160.1", entrypoint: "bin/codex" }));
    const executable = join(vendor, "bin", "codex");
    await writeFile(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
    await chmod(executable, 0o755);

    const pinnedAdapter = await pinCodexAdapter(adapterRoot);
    const pinnedCore = await pinCodexCore(adapterRoot, { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" });
    const plan = CODEX_ENGINE_PROFILE.planLaunch({ engine: "codex", adapter: pinnedAdapter, core: pinnedCore });
    await plan.verifyBeforeSpawn!();

    await writeFile(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4, 5]));
    await assert.rejects(plan.verifyBeforeSpawn!(), (cause: unknown) => cause instanceof AdapterPinError && cause.code === "engine_core_invalid");
    await writeFile(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
    await plan.verifyBeforeSpawn!();
    await writeFile(join(adapterRoot, "dist", "index.js"), "console.log('tampered');\n");
    await assert.rejects(plan.verifyBeforeSpawn!(), (cause: unknown) => cause instanceof AdapterPinError && cause.code === "adapter_changed");
  });
});
