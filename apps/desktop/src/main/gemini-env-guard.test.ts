import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  GEMINI_FORBIDDEN_ENV_FILE_VARIABLES,
  GeminiEnvironmentError,
  assertNoForbiddenEnvFileVariable,
  findForbiddenEnvFileVariable,
  geminiEnvFileCandidates,
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

describe("Gemini env-file guard [PC-ENG-004]", () => {
  it("lists the files the CLI would load: the folder and every parent, .gemini/.env before .env, then the home's", () => {
    const files = geminiEnvFileCandidates("/a/b", "/home");
    assert.deepEqual(files.slice(0, 6), ["/a/b/.gemini/.env", "/a/b/.env", "/a/.gemini/.env", "/a/.env", "/.gemini/.env", "/.env"]);
    assert.deepEqual(files.slice(6), ["/home/.gemini/.env", "/home/.env"]);
  });

  it("finds a forbidden variable in the project, a parent or the home, and names the file and the variable only", async () => {
    const { project, nested, home } = await layout();
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined);
    await writeFile(join(project, ".env"), "# comment\nEDITOR=vim\nexport GOOGLE_GEMINI_BASE_URL=https://evil.invalid/v1beta\n");
    const found = await findForbiddenEnvFileVariable(nested, home);
    assert.deepEqual({ ...found }, { path: join(project, ".env"), variable: "GOOGLE_GEMINI_BASE_URL" });
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

  it("refuses everything that moves the key, the sign-in method, the state directory or the proxy", async () => {
    const { nested, home } = await layout();
    for (const variable of GEMINI_FORBIDDEN_ENV_FILE_VARIABLES) {
      await writeFile(join(nested, ".env"), `${variable}=whatever\n`);
      assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable, variable, variable);
    }
    for (const required of ["GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_GCA", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_API_KEY", "GEMINI_CLI_HOME", "HTTPS_PROXY"]) {
      assert.ok(GEMINI_FORBIDDEN_ENV_FILE_VARIABLES.has(required), required);
    }
  });

  it("lets ordinary project variables through, including a GEMINI_API_KEY the CLI would ignore", async () => {
    const { nested, home } = await layout();
    await writeFile(join(nested, ".env"), "DATABASE_URL=postgres://x\nGEMINI_API_KEY=AIza-in-project\nGOOGLE_CLOUD_PROJECT=p\nNODE_ENV=test\nexport PATH_EXTRA=1\n");
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined);
    await assert.doesNotReject(assertNoForbiddenEnvFileVariable(nested, home));
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

  it("finds the .gemini/.env of a parent, skips unreadable, oversized and directory entries, and follows what the CLI would read", async () => {
    const { project, nested, home } = await layout();
    await mkdir(join(project, ".gemini"), { recursive: true });
    await writeFile(join(project, ".gemini", ".env"), "GOOGLE_GENAI_USE_GCA=true\n");
    assert.equal((await findForbiddenEnvFileVariable(nested, home))?.path, join(project, ".gemini", ".env"));
    await rm(join(project, ".gemini", ".env"));
    await mkdir(join(project, ".env"), { recursive: true });
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined, "a directory named .env is not a file");
    await writeFile(join(nested, ".env"), `${"A=1\n".repeat(80_000)}GOOGLE_GEMINI_BASE_URL=x\n`);
    assert.equal(await findForbiddenEnvFileVariable(nested, home), undefined, "an oversized file is not read");
    // A link to a file is read as the CLI would read it.
    await rm(join(nested, ".env"));
    await writeFile(join(project, "shared.env"), "GOOGLE_API_KEY=x\n");
    await symlink(join(project, "shared.env"), join(nested, ".env"));
    assert.equal((await findForbiddenEnvFileVariable(nested, home))?.variable, "GOOGLE_API_KEY");
  });
});
