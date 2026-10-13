import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AdapterPinError, pinGeminiCli } from "./adapter-pin.js";
import {
  CLAUDE_ENGINE_PROFILE,
  CODEX_ENGINE_PROFILE,
  GEMINI_ENGINE_PROFILE,
  GEMINI_ENVIRONMENT_POLICY,
  GEMINI_ENVIRONMENT_POLICY_VERSION,
  GEMINI_NEUTRAL_ENVIRONMENT,
  assertGeminiEnvironment,
  buildEngineEnvironment,
  engineProfileFor,
  isAdapterDialect,
  isPlausibleGeminiApiKey,
  type GeminiLaunch,
} from "./engine-profile.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const KEY = "AIzaSyD-test-key-0123456789abcdefghijk";
const adapter = Object.freeze({
  packageRoot: "/opt/gemini-cli",
  entryPath: "/opt/gemini-cli/bundle/gemini.js",
  version: "0.63.0",
  fingerprintSha256: "0".repeat(64),
});
const home = "/Users/someone/Library/Application Support/Guild-v2/engines/gemini-home";

function launch(overrides: Partial<GeminiLaunch> = {}): GeminiLaunch {
  return { engine: "gemini", adapter, homeDirectory: home, apiKey: KEY, ...overrides };
}

const rich = {
  PATH: "/usr/bin:/bin",
  HOME: "/somewhere/else",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  USER: "someone",
  LOGNAME: "someone",
  TMPDIR: "/tmp/x/",
  HTTPS_PROXY: "http://proxy.invalid:8080",
  http_proxy: "http://proxy.invalid:8080",
  NO_PROXY: "10.0.0.0/8,localhost",
  SSL_CERT_FILE: "/etc/ssl/cert.pem",
  // Everything the CLI reads to pick a credential, an endpoint, a sign-in method or a state directory.
  GEMINI_API_KEY: "AIza-parent-key-must-not-pass",
  GOOGLE_API_KEY: "AIza-other-must-not-pass",
  GOOGLE_GEMINI_BASE_URL: "https://evil.invalid",
  GOOGLE_GENAI_USE_GCA: "true",
  GOOGLE_GENAI_USE_VERTEXAI: "true",
  GOOGLE_CLOUD_PROJECT: "someproject",
  GOOGLE_APPLICATION_CREDENTIALS: "/tmp/creds.json",
  GEMINI_CLI_HOME: "/Users/someone",
  GEMINI_MODEL: "gemini-2.5-pro",
  GEMINI_SANDBOX: "docker",
  GEMINI_TELEMETRY_ENABLED: "true",
  GEMINI_SYSTEM_MD: "/tmp/system.md",
  NO_BROWSER: "false",
  OPENAI_API_KEY: "sk-must-not-pass",
  ANTHROPIC_API_KEY: "sk-ant-nope",
  NODE_OPTIONS: "--require /tmp/hook.js",
  NODE_PATH: "/tmp/modules",
  ELECTRON_RUN_AS_NODE: "1",
  DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
  LD_PRELOAD: "/tmp/x.so",
  BASH_ENV: "/tmp/rc",
  OPENVIKING_MEMORY_ENABLED: "1",
  OPENVIKING_URL: "http://real.invalid",
};

describe("Gemini engine profile (PC-ENG-004)", () => {
  it("is a node-script adapter engine that Guild never authenticates for and cannot steer", () => {
    assert.deepEqual(
      [GEMINI_ENGINE_PROFILE.engine, GEMINI_ENGINE_PROFILE.dialect, GEMINI_ENGINE_PROFILE.pinStrategy, GEMINI_ENGINE_PROFILE.authPolicy],
      ["gemini", "gemini", "node-script", "never"],
    );
    assert.deepEqual(GEMINI_ENGINE_PROFILE.features, {
      billing: false,
      steer: false,
      conversationRewind: false,
      xaiSignals: false,
      agentInitiatedTurns: false,
    });
    assert.equal(engineProfileFor("gemini"), GEMINI_ENGINE_PROFILE);
    assert.equal(engineProfileFor("codex"), CODEX_ENGINE_PROFILE);
    assert.equal(engineProfileFor("claude"), CLAUDE_ENGINE_PROFILE);
    assert.equal(isAdapterDialect("gemini"), true);
    assert.equal(Object.isFrozen(GEMINI_ENGINE_PROFILE) && Object.isFrozen(GEMINI_ENGINE_PROFILE.features), true);
  });

  it("runs the bundle in ACP mode with --skip-trust and no key, model or home in argv", () => {
    const argv = GEMINI_ENGINE_PROFILE.buildArgv(launch());
    assert.deepEqual(argv, ["/opt/gemini-cli/bundle/gemini.js", "--acp", "--skip-trust"]);
    assert.equal(argv.some((argument) => argument.includes(KEY) || argument.includes(home)), false);
    assert.deepEqual(GEMINI_ENGINE_PROFILE.planLaunch(launch()).argv, argv);
  });

  it("rejects a launch for another engine, unusable paths and a key that could change the environment", () => {
    assert.throws(() => GEMINI_ENGINE_PROFILE.planLaunch({ engine: "grok" }), TypeError);
    assert.throws(() => CODEX_ENGINE_PROFILE.planLaunch(launch() as never), TypeError);
    assert.throws(() => GEMINI_ENGINE_PROFILE.planLaunch(launch({ adapter: { ...adapter, entryPath: "bundle/gemini.js" } })), TypeError);
    assert.throws(() => GEMINI_ENGINE_PROFILE.planLaunch(launch({ homeDirectory: "relative/home" })), TypeError);
    assert.throws(() => GEMINI_ENGINE_PROFILE.planLaunch(launch({ homeDirectory: "/tmp/ho\0me" })), TypeError);
    for (const key of ["", "short", "with space inside-key", "line\nbreak-key-0123", "tab\tkey-0123456789", "nul\0key-0123456789", "café-key-0123456789", "a".repeat(513)]) {
      assert.throws(() => GEMINI_ENGINE_PROFILE.planLaunch(launch({ apiKey: key })), TypeError, JSON.stringify(key));
      assert.equal(isPlausibleGeminiApiKey(key), false, JSON.stringify(key));
    }
    assert.equal(isPlausibleGeminiApiKey(KEY), true);
    assert.equal(isPlausibleGeminiApiKey("a".repeat(512)), true);
  });

  it("allowlists the documented keys and replaces every credential, endpoint and sign-in variable with Guild's own neutral value", () => {
    const environment = buildEngineEnvironment(GEMINI_ENVIRONMENT_POLICY, rich);
    const kept = Object.keys(environment).filter((key) => !key.startsWith("OPENVIKING_") && !Object.hasOwn(GEMINI_NEUTRAL_ENVIRONMENT, key)).sort();
    assert.deepEqual(kept, [
      "GEMINI_CLI_NO_RELAUNCH", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "LOGNAME", "NODE_USE_ENV_PROXY", "NO_PROXY", "PATH",
      "SSL_CERT_FILE", "TMPDIR", "USER", "http_proxy", "no_proxy",
    ].sort());
    // Nothing the parent had survives: each of these is absent, or present only with the value Guild chose.
    for (const stripped of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_GCA", "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GEMINI_CLI_HOME", "GEMINI_MODEL", "GEMINI_SANDBOX", "GEMINI_TELEMETRY_ENABLED",
      "GEMINI_SYSTEM_MD", "NO_BROWSER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE",
      "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "BASH_ENV"]) {
      assert.equal(stripped in environment ? environment[stripped] === GEMINI_NEUTRAL_ENVIRONMENT[stripped] : true, true, stripped);
      assert.notEqual(environment[stripped], (rich as Record<string, string>)[stripped], stripped);
    }
    for (const gone of ["GEMINI_API_KEY", "GEMINI_CLI_HOME", "GEMINI_MODEL", "GEMINI_SANDBOX", "GEMINI_TELEMETRY_ENABLED", "GEMINI_SYSTEM_MD", "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "BASH_ENV"]) {
      assert.equal(gone in environment, false, gone);
    }
    assert.equal(environment.GEMINI_CLI_NO_RELAUNCH, "1", "one process: a relaunched child would outlive a SIGKILL of its parent");
    assert.equal(environment.NODE_USE_ENV_PROXY, "1", "node 26 ignores HTTPS_PROXY otherwise");
    assert.equal(Object.isFrozen(environment), true);
  });

  it("holds every variable a .env could use to move the key or change the sign-in at a value of Guild's choosing [finding: dotenv colon form]", () => {
    const environment = buildEngineEnvironment(GEMINI_ENVIRONMENT_POLICY, rich);
    // The CLI copies a .env variable only when the environment does not have it, so presence is what protects.
    for (const name of ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_GENAI_USE_GCA", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_ACCESS_TOKEN", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "CLOUD_SHELL",
      "GEMINI_CLI_USE_COMPUTE_ADC", "GEMINI_CLI_AUTH_OVERRIDE", "GOOGLE_CLOUD_UNIVERSE_DOMAIN", "CODE_ASSIST_ENDPOINT", "NODE_TLS_REJECT_UNAUTHORIZED", "NO_BROWSER"]) {
      assert.equal(Object.hasOwn(environment, name), true, name);
      assert.equal(environment[name], GEMINI_NEUTRAL_ENVIRONMENT[name], name);
    }
    // Empty means false to the CLI's own tests; two variables are tested for absence and carry their default instead.
    assert.equal(environment.GOOGLE_GEMINI_BASE_URL, "");
    assert.equal(environment.GOOGLE_GENAI_USE_GCA, "");
    assert.equal(environment.GOOGLE_CLOUD_UNIVERSE_DOMAIN, "googleapis.com");
    assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, "1");
    assert.equal(environment.CODE_ASSIST_ENDPOINT, "http://127.0.0.1:9", "a closed local port: Code Assist is never reached");
    assert.equal(environment.NO_BROWSER, "true");
    assert.equal(Object.isFrozen(GEMINI_NEUTRAL_ENVIRONMENT), true);
    assert.equal(JSON.stringify(environment).includes("evil.invalid"), false);
  });

  it("switches the OpenViking guard block on and gives the Google variables no value but the neutral ones", () => {
    const environment = buildEngineEnvironment(GEMINI_ENVIRONMENT_POLICY, rich);
    assert.equal(environment.OPENVIKING_MEMORY_ENABLED, "0");
    assert.equal(environment.OPENVIKING_CONFIG_FILE, "/dev/null");
    assert.equal(environment.OPENVIKING_URL, "http://127.0.0.1:9");
    for (const key of Object.keys(environment).filter((name) => name.startsWith("GOOGLE_"))) {
      assert.equal(environment[key], GEMINI_NEUTRAL_ENVIRONMENT[key], key);
    }
    assert.deepEqual(Object.keys(GEMINI_ENVIRONMENT_POLICY.perSpawnKeys), ["GEMINI_API_KEY"]);
  });

  it("always includes the loopback in NO_PROXY, which the browser MCP server needs", () => {
    assert.equal(buildEngineEnvironment(GEMINI_ENVIRONMENT_POLICY, {}).NO_PROXY, "127.0.0.1,localhost");
    assert.equal(buildEngineEnvironment(GEMINI_ENVIRONMENT_POLICY, rich).NO_PROXY, "127.0.0.1,localhost,10.0.0.0/8");
  });

  it("gives the child the Guild-owned home as HOME and GEMINI_CLI_HOME, the key as GEMINI_API_KEY, and nothing else of Google's", () => {
    const plan = GEMINI_ENGINE_PROFILE.planLaunch(launch());
    const environment = plan.buildEnvironment(rich);
    assert.equal(environment.HOME, home, "never the owner's home");
    assert.equal(environment.GEMINI_CLI_HOME, home);
    assert.notEqual(environment.HOME, homedir());
    assert.equal(environment.GEMINI_API_KEY, KEY);
    assert.equal(environment.USER, "someone");
    assert.equal(plan.environmentPolicyVersion, GEMINI_ENVIRONMENT_POLICY_VERSION);
    assert.deepEqual(
      Object.keys(environment).filter((key) => /^(GEMINI_|GOOGLE_)/u.test(key) && !Object.hasOwn(GEMINI_NEUTRAL_ENVIRONMENT, key)).sort(),
      ["GEMINI_API_KEY", "GEMINI_CLI_HOME", "GEMINI_CLI_NO_RELAUNCH"],
    );
    assert.equal(JSON.stringify(plan.argv).includes(KEY), false);
  });

  it("redacts the key from every diagnostic", () => {
    const plan = GEMINI_ENGINE_PROFILE.planLaunch(launch());
    assert.deepEqual(plan.redactValues, [KEY]);
    assert.equal(typeof plan.verifyBeforeSpawn, "function");
  });

  it("refuses an environment that carries a forbidden variable, naming it but never a value", () => {
    assertGeminiEnvironment({ HOME: "/h", GEMINI_API_KEY: KEY, GEMINI_CLI_HOME: "/h", GEMINI_CLI_NO_RELAUNCH: "1", PATH: "/bin" });
    assertGeminiEnvironment({ PATH: "/bin", ...GEMINI_NEUTRAL_ENVIRONMENT });
    for (const key of ["GOOGLE_GENAI_USE_GCA", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_API_KEY", "GEMINI_MODEL", "GEMINI_SANDBOX", "GOOGLE_CLOUD_PROJECT", "google_cloud_project", "GOOGLE_NEW_THING"]) {
      assert.throws(
        () => assertGeminiEnvironment({ PATH: "/bin", [key]: "secret-value-123" }),
        (cause: unknown) => cause instanceof TypeError && cause.message.includes(key) && !cause.message.includes("secret-value-123"),
        key,
      );
    }
    // A neutral variable with any other value is refused too, wherever the value came from.
    for (const key of Object.keys(GEMINI_NEUTRAL_ENVIRONMENT)) {
      assert.throws(
        () => assertGeminiEnvironment({ PATH: "/bin", ...GEMINI_NEUTRAL_ENVIRONMENT, [key]: "https://evil.invalid/secret-value-123" }),
        (cause: unknown) => cause instanceof TypeError && cause.message.includes(key) && !cause.message.includes("secret-value-123"),
        key,
      );
    }
  });

  it("verifies the package before every spawn and says that it changed", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "guild-gemini-profile-")));
    roots.push(root);
    const packageRoot = join(root, "gemini-cli");
    await mkdir(join(packageRoot, "bundle"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@google/gemini-cli", version: "0.63.0" }));
    await writeFile(join(packageRoot, "bundle", "gemini.js"), "console.log(1);\n");
    const pinned = await pinGeminiCli(packageRoot);
    const plan = GEMINI_ENGINE_PROFILE.planLaunch({ engine: "gemini", adapter: pinned, homeDirectory: join(root, "home"), apiKey: KEY });
    await plan.verifyBeforeSpawn!();
    await writeFile(join(packageRoot, "bundle", "gemini.js"), "console.log('tampered');\n");
    await assert.rejects(plan.verifyBeforeSpawn!(), (cause: unknown) => cause instanceof AdapterPinError && cause.code === "adapter_changed");
    await writeFile(join(packageRoot, "bundle", "gemini.js"), "console.log(1);\n");
    await plan.verifyBeforeSpawn!();
  });
});
