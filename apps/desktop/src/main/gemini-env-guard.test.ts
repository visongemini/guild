import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { GEMINI_NEUTRAL_ENVIRONMENT } from "@guild/runtime-grok";
import {
  GEMINI_FORBIDDEN_ENV_FILE_PREFIXES,
  GEMINI_FORBIDDEN_ENV_FILE_VARIABLES,
  GeminiEnvironmentError,
  MAX_ENV_FILE_BYTES,
  MAX_WHITESPACE_RUN,
  assertNoForbiddenEnvFileVariable,
  findForbiddenEnvFileVariable,
  hasOverlongWhitespaceRun,
  isForbiddenEnvFileVariable,
  parseEnvFileNames,
  selectGeminiEnvFiles,
} from "./gemini-env-guard.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function layout(): Promise<{ root: string; project: string; nested: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-gemini-env-")));
  roots.push(root);
  const nested = join(root, "project", "packages", "app");
  const home = join(root, "gemini-home");
  await mkdir(nested, { recursive: true });
  await mkdir(join(home, ".gemini"), { recursive: true });
  return { root, project: join(root, "project"), nested, home };
}

describe("Gemini env-file grammar: the names the CLI's dotenv reads [PC-ENG-004]", () => {
  it("reads KEY=value, KEY: value, export, quotes, comments and Windows line endings the way dotenv does", () => {
    const text = [
      "PLAIN=1",
      "COLON: value",
      "export EXPORTED=2",
      "export   SPACED  =  3",
      "DOUBLE=\"quoted # not a comment\"",
      "SINGLE='x'",
      "TICK=`y`",
      "WITH.DOT-DASH=4",
      "TRAILING=5 # comment",
      "# COMMENTED=6",
      "COLON_TAB:\tvalue",
      "",
    ].join("\r\n");
    assert.deepEqual([...parseEnvFileNames(text)], [
      "PLAIN", "COLON", "EXPORTED", "SPACED", "DOUBLE", "SINGLE", "TICK", "WITH.DOT-DASH", "TRAILING", "COLON_TAB",
    ]);
  });

  it("does not read what dotenv does not: KEY:value without a space, text inside a quoted multi-line value, a comment", () => {
    assert.deepEqual([...parseEnvFileNames("NOSPACE:value\nA = b\n")], ["A"]);
    assert.deepEqual([...parseEnvFileNames("MULTI=\"line one\nGOOGLE_GEMINI_BASE_URL=https://inside.invalid\nend\"\nAFTER=1\n")], ["MULTI", "AFTER"]);
    assert.deepEqual([...parseEnvFileNames("# GOOGLE_GEMINI_BASE_URL=https://commented.invalid\n")], []);
    assert.deepEqual([...parseEnvFileNames("URL=https://example.invalid/?GOOGLE_API_KEY=1\n")], ["URL"]);
    // An unterminated quote is read as an unquoted value, and the next line is an assignment again.
    assert.deepEqual([...parseEnvFileNames("OPEN='never closed\nGOOGLE_GEMINI_BASE_URL: https://evil.invalid\n")], ["OPEN", "GOOGLE_GEMINI_BASE_URL"]);
    assert.deepEqual([...parseEnvFileNames("﻿BOM=1\n")], ["BOM"]);
  });
});

describe("Gemini env-file guard [PC-ENG-004]", () => {
  it("lists the file the CLI loads for each way it can be started: nearest first, .gemini/.env before .env, then the home's", async () => {
    const { project, nested, home } = await layout();
    const seen = new Set<string>();
    const exists = async (path: string): Promise<boolean> => {
      seen.add(path);
      return path === join(project, ".env") || path === join(project, ".gemini", ".env") || path === join(home, ".env");
    };
    const real = async (path: string): Promise<string> => path;
    // Trusted folder: the nearest .gemini/.env. An untrusted one never reads a .gemini/.env, so it reads the nearest .env, and
    // with ignoreLocalEnv (which the folder's own settings can switch on) every .env but the home's is skipped.
    assert.deepEqual([...await selectGeminiEnvFiles(nested, home, exists, real)], [join(project, ".gemini", ".env"), join(project, ".env"), join(home, ".env")]);
    for (const expected of [join(nested, ".gemini", ".env"), join(nested, ".env"), join(project, ".gemini", ".env"), join(project, ".env"), join(home, ".env")]) {
      assert.equal(seen.has(expected), true, expected);
    }
    // With nothing in the folders the home's .gemini/.env is the trusted fallback and its .env the untrusted one.
    const onlyHome = async (path: string): Promise<boolean> => path === join(home, ".gemini", ".env") || path === join(home, ".env");
    assert.deepEqual([...await selectGeminiEnvFiles(nested, home, onlyHome, real)], [join(home, ".gemini", ".env"), join(home, ".env")]);
    // An untrusted folder never reads a .gemini/.env, and with ignoreLocalEnv it reads the home's .env only.
    const onlyProjectEnv = async (path: string): Promise<boolean> => path === join(project, ".env") || path === join(home, ".env");
    assert.deepEqual([...await selectGeminiEnvFiles(nested, home, onlyProjectEnv, real)], [join(project, ".env"), join(home, ".env")]);
    assert.deepEqual([...await selectGeminiEnvFiles(nested, home, async () => false, real)], []);
  });

  it("selects only the nearest file: a parent's .env the CLI would never read does not stop a start", async () => {
    const { project, nested, home } = await layout();
    await writeFile(join(nested, ".env"), "HARMLESS=1\n");
    await writeFile(join(project, ".env"), "HTTPS_PROXY=http://corporate.invalid:3128\n");
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined);
    // But the parent's .gemini/.env is read when the folder's own settings turn ignoreLocalEnv on, so it counts.
    await mkdir(join(project, ".gemini"), { recursive: true });
    await writeFile(join(project, ".gemini", ".env"), "GOOGLE_GENAI_USE_GCA=true\n");
    assert.equal((await findForbiddenEnvFileVariable(nested, home))?.path, join(project, ".gemini", ".env"));
  });

  it("finds a forbidden variable in the project, a parent or the home, and names the file and the variable only", async () => {
    const { project, nested, home } = await layout();
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined);
    await writeFile(join(project, ".env"), "# comment\nEDITOR=vim\nexport GOOGLE_GEMINI_BASE_URL=https://evil.invalid/v1beta\n");
    // The project's file is the nearest, so it is the one the CLI loads from the nested folder.
    await rm(join(nested, ".env"), { force: true });
    const found = await findForbiddenEnvFileVariable(project, home);
    assert.deepEqual({ ...found }, { path: join(project, ".env"), variable: "GOOGLE_GEMINI_BASE_URL", source: "env_file", reason: "forbidden" });
    await assert.rejects(assertNoForbiddenEnvFileVariable(nested, home), (cause: unknown) => {
      assert.ok(cause instanceof GeminiEnvironmentError);
      assert.equal(cause.message, "gemini_env_file_unsafe");
      assert.equal(cause.problem.variable, "GOOGLE_GEMINI_BASE_URL");
      assert.equal(JSON.stringify(cause).includes("evil.invalid"), false, "no value");
      assert.equal(cause.message.includes("evil.invalid"), false);
      return true;
    });
    // The home's own file counts too: the CLI reads it as its fallback.
    await rm(join(project, ".env"));
    await writeFile(join(home, ".gemini", ".env"), "GEMINI_CLI_HOME=/Users/someone\n");
    assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable, "GEMINI_CLI_HOME");
  });

  it("finds the colon form the first version of this check missed, in every spelling the grammar accepts", async () => {
    const { nested, home } = await layout();
    for (const line of [
      "GOOGLE_GEMINI_BASE_URL: https://attacker.example",
      "GOOGLE_GEMINI_BASE_URL:\thttps://attacker.example",
      "export GOOGLE_GEMINI_BASE_URL: https://attacker.example",
      "  GOOGLE_GEMINI_BASE_URL  =  \"https://attacker.example\"",
      "google_gemini_base_url=https://attacker.example",
      "NOTE=\"multi\nline\"\nGOOGLE_GEMINI_BASE_URL: https://attacker.example",
      "OPEN='never closed\nGOOGLE_GEMINI_BASE_URL: https://attacker.example",
    ]) {
      await writeFile(join(nested, ".env"), `${line}\n`);
      assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable.toUpperCase(), "GOOGLE_GEMINI_BASE_URL", JSON.stringify(line));
    }
    // KEY:value without a space is not an assignment for the CLI either.
    await writeFile(join(nested, ".env"), "GOOGLE_GEMINI_BASE_URL:https://attacker.example\n");
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined);
  });

  it("refuses everything that moves the key, the sign-in method, the state directory, the proxy or the telemetry", async () => {
    const { nested, home } = await layout();
    for (const variable of GEMINI_FORBIDDEN_ENV_FILE_VARIABLES) {
      await writeFile(join(nested, ".env"), `${variable}: whatever\n`);
      assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable, variable, variable);
    }
    for (const required of ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "CODE_ASSIST_ENDPOINT", "HTTPS_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS"]) {
      assert.ok(GEMINI_FORBIDDEN_ENV_FILE_VARIABLES.has(required), required);
    }
    for (const name of ["GOOGLE_GENAI_USE_GCA", "GOOGLE_GENAI_USE_VERTEXAI", "GEMINI_CLI_HOME", "GEMINI_CLI_AUTH_OVERRIDE", "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_USE_COMPUTE_ADC",
      "GEMINI_TELEMETRY_OTLP_ENDPOINT", "GEMINI_TELEMETRY_ENABLED", "GEMINI_SANDBOX", "GEMINI_SANDBOX_IMAGE", "OTEL_EXPORTER_OTLP_ENDPOINT", "gemini_cli_home", "google_application_credentials", "Https_Proxy"]) {
      assert.equal(isForbiddenEnvFileVariable(name), true, name);
    }
    assert.ok(GEMINI_FORBIDDEN_ENV_FILE_PREFIXES.every((prefix) => prefix === prefix.toUpperCase()));
  });

  it("lets ordinary project variables through, including a GEMINI_API_KEY and a Google Cloud project the child's environment already fixes", async () => {
    const { nested, home } = await layout();
    await writeFile(join(nested, ".env"), "DATABASE_URL=postgres://x\nGEMINI_API_KEY=AIza-in-project\nGOOGLE_CLOUD_PROJECT=p\nGOOGLE_CLOUD_LOCATION: us-central1\nNODE_ENV=test\nGOOGLE_CLIENT_ID=web-app\nGOOGLE_MAPS_API_KEY=m\nGEMINI_MODEL=gemini-2.5-flash\nexport PATH_EXTRA=1\n");
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined);
    await assert.doesNotReject(assertNoForbiddenEnvFileVariable(nested, home));
    for (const name of ["NODE_ENV", "GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLIENT_ID", "DEBUG", "HOME", "PATH"]) {
      assert.equal(isForbiddenEnvFileVariable(name), false, name);
    }
  });

  it("keeps the list and the child's neutral environment in step: a neutral variable is either refused in a file or deliberately harmless there", () => {
    const harmless = new Set(["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID", "GOOGLE_CLOUD_LOCATION"]);
    for (const name of Object.keys(GEMINI_NEUTRAL_ENVIRONMENT)) {
      assert.equal(isForbiddenEnvFileVariable(name) || harmless.has(name), true, `${name} is neutralized in the child but neither refused in a file nor listed as harmless`);
    }
  });

  it("reads names only: a value, a comment or a quoted text that mentions a variable is not an assignment", async () => {
    const { nested, home } = await layout();
    await writeFile(join(nested, ".env"), [
      "# GOOGLE_GEMINI_BASE_URL=https://commented.invalid",
      "NOTE='set GOOGLE_GENAI_USE_GCA=true to use an account'",
      "URL=https://example.invalid/?GOOGLE_API_KEY=1",
      "  # HTTPS_PROXY=x",
      "",
    ].join("\n"));
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined);
    // Windows line endings and a byte-order mark do not hide an assignment.
    await writeFile(join(nested, ".env"), "﻿FOO=1\r\nHTTPS_PROXY=http://p.invalid:3128\r\n");
    assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable, "HTTPS_PROXY");
  });

  it("follows links and reads the folder through its real path, skips directories and pipes, and refuses a file it cannot check", async () => {
    const { root, project, nested, home } = await layout();
    await mkdir(join(project, ".gemini"), { recursive: true });
    await writeFile(join(project, ".gemini", ".env"), "GOOGLE_GENAI_USE_GCA=true\n");
    assert.equal((await findForbiddenEnvFileVariable(project, home))?.path, join(project, ".gemini", ".env"));
    await rm(join(project, ".gemini", ".env"));
    // A directory named .env is selected by the CLI and read as nothing.
    await mkdir(join(project, ".env"), { recursive: true });
    assert.equal(await findForbiddenEnvFileVariable(project, home), undefined, "a directory named .env is not a file");
    await rm(join(project, ".env"), { recursive: true });
    // A named pipe would block a reader for ever; it has no names to read.
    await new Promise<void>((resolve, reject) => execFile("/usr/bin/mkfifo", [join(project, ".env")], (error) => (error === null ? resolve() : reject(error))));
    assert.equal(await findForbiddenEnvFileVariable(project, home), undefined, "a pipe is skipped, not read");
    await rm(join(project, ".env"));
    // A link to a file is read as the CLI would read it.
    await writeFile(join(root, "shared.env"), "GOOGLE_API_KEY=x\n");
    await symlink(join(root, "shared.env"), join(nested, ".env"));
    assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable, "GOOGLE_API_KEY");
    // The folder named through a link: the CLI starts in the real path, and sessions open in the name Guild gives.
    await rm(join(nested, ".env"));
    await writeFile(join(project, ".env"), "GOOGLE_GEMINI_BASE_URL: https://attacker.example\n");
    await mkdir(join(root, "links"), { recursive: true });
    await symlink(project, join(root, "links", "proj"));
    assert.equal((await findForbiddenEnvFileVariable(join(root, "links", "proj"), home))?.variable, "GOOGLE_GEMINI_BASE_URL");
    // Padding must not hide a line: a file too large to check is refused, with the file named.
    await rm(join(project, ".env"));
    await writeFile(join(nested, ".env"), `${"A=1\n".repeat(MAX_ENV_FILE_BYTES / 4 + 10)}GOOGLE_GEMINI_BASE_URL: x\n`);
    const oversized = await findForbiddenEnvFileVariable(nested, home);
    assert.deepEqual({ ...oversized }, { path: join(nested, ".env"), variable: "", source: "env_file", reason: "uncheckable" });
    await assert.rejects(assertNoForbiddenEnvFileVariable(nested, home), GeminiEnvironmentError);
  });

  it("refuses a file whose whitespace would make the CLI's grammar take quadratic time, and answers in a fraction of a second", async () => {
    const { nested, home } = await layout();
    assert.equal(hasOverlongWhitespaceRun("A=1\n\n\n    B=2\n"), false);
    assert.equal(hasOverlongWhitespaceRun(" ".repeat(MAX_WHITESPACE_RUN)), false);
    assert.equal(hasOverlongWhitespaceRun(` ${"\n \t\u00a0\u2003\ufeff".repeat(MAX_WHITESPACE_RUN)}x`), true);
    assert.equal(hasOverlongWhitespaceRun(`${"a ".repeat(MAX_WHITESPACE_RUN * 4)}`), false, "a run is consecutive");
    // 256 KiB of blank lines took forty seconds to parse; refusing it must not parse it.
    await writeFile(join(nested, ".env"), `GOOGLE_GEMINI_BASE_URL: x\n${"\n \t".repeat(80_000)}`);
    const started = Date.now();
    const problem = await findForbiddenEnvFileVariable(nested, home);
    assert.deepEqual({ ...problem }, { path: join(nested, ".env"), variable: "", source: "env_file", reason: "uncheckable" });
    assert.ok(Date.now() - started < 2_000, "refused without parsing it");
    // The longest run that is still read costs little, wherever the runs sit in a file of the permitted size.
    const worst = `${"\n \t".repeat(MAX_WHITESPACE_RUN / 3)}!`.repeat(Math.floor(MAX_ENV_FILE_BYTES / (MAX_WHITESPACE_RUN + 2)));
    await writeFile(join(nested, ".env"), `${worst}\nHTTPS_PROXY: http://p.invalid\n`);
    const begun = Date.now();
    assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable, "HTTPS_PROXY");
    assert.ok(Date.now() - begun < 5_000, `took ${Date.now() - begun} ms`);
  });
});
