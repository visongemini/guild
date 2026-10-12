import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readKeyFromEnvFile } from "./env-file.js";

let directory = "";
let counter = 0;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "guild-env-file-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function envFile(content: string): Promise<string> {
  counter += 1;
  const path = join(directory, `file-${counter}.env`);
  await writeFile(path, content, "utf8");
  return path;
}

describe("readKeyFromEnvFile", () => {
  it("reads plain KEY=VALUE lines", async () => {
    const path = await envFile("OTHER=1\nDEEPSEEK_API_KEY=sk-plain-123\nLAST=3\n");
    assert.equal(await readKeyFromEnvFile(path, "DEEPSEEK_API_KEY"), "sk-plain-123");
  });

  it("accepts an optional export prefix and spaces around the equals sign", async () => {
    assert.equal(await readKeyFromEnvFile(await envFile("export A_KEY=one\n"), "A_KEY"), "one");
    assert.equal(await readKeyFromEnvFile(await envFile("  export   A_KEY =  two  \n"), "A_KEY"), "two");
  });

  it("handles single and double quotes, escapes and hash characters inside quotes", async () => {
    assert.equal(await readKeyFromEnvFile(await envFile("K='a # b' # trailing\n"), "K"), "a # b");
    assert.equal(await readKeyFromEnvFile(await envFile('K="a # b" # trailing\n'), "K"), "a # b");
    assert.equal(await readKeyFromEnvFile(await envFile('K="say \\"hi\\"\\n"\n'), "K"), 'say "hi"\n');
    assert.equal(await readKeyFromEnvFile(await envFile("K='raw \\n stays'\n"), "K"), "raw \\n stays");
  });

  it("skips comment lines and strips trailing comments from unquoted values", async () => {
    const path = await envFile("# K=commented\nK=value # why\nK2=a#b\n");
    assert.equal(await readKeyFromEnvFile(path, "K"), "value");
    assert.equal(await readKeyFromEnvFile(path, "K2"), "a#b");
  });

  it("tolerates CRLF line endings and a byte order mark", async () => {
    assert.equal(await readKeyFromEnvFile(await envFile("\uFEFFFIRST=1\r\nSECOND=two\r\n"), "FIRST"), "1");
    assert.equal(await readKeyFromEnvFile(await envFile("\uFEFFFIRST=1\r\nSECOND=two\r\n"), "SECOND"), "two");
  });

  it("lets the last assignment win and matches the whole variable name", async () => {
    const path = await envFile("KEY=old\nMYKEY=other\nKEY_2=x\nKEY=new\n");
    assert.equal(await readKeyFromEnvFile(path, "KEY"), "new");
  });

  it("returns undefined for a missing variable, a missing file and empty values", async () => {
    assert.equal(await readKeyFromEnvFile(await envFile("A=1\n"), "B"), undefined);
    assert.equal(await readKeyFromEnvFile(join(directory, "does-not-exist.env"), "A"), undefined);
    assert.equal(await readKeyFromEnvFile(await envFile("A=\n"), "A"), undefined);
    assert.equal(await readKeyFromEnvFile(await envFile("A=old\nA=\n"), "A"), undefined);
  });

  it("does not expand variables", async () => {
    assert.equal(await readKeyFromEnvFile(await envFile("A=$HOME/x\n"), "A"), "$HOME/x");
  });

  it("rejects invalid variable names", async () => {
    await assert.rejects(readKeyFromEnvFile(await envFile("A=1\n"), "A B"), TypeError);
    await assert.rejects(readKeyFromEnvFile(await envFile("A=1\n"), ""), TypeError);
  });

  it("surfaces unreadable paths without leaking file content", async () => {
    await assert.rejects(readKeyFromEnvFile(directory, "A"), (error: unknown) => {
      assert.ok(error instanceof Error);
      return !error.message.includes("sk-");
    });
  });

  it("refuses oversized files", async () => {
    const path = await envFile(`A=1\n${"#".repeat(1024 * 1024 + 1)}`);
    await assert.rejects(readKeyFromEnvFile(path, "A"), /too large/u);
  });
});
