import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the empty-task mascot is emitted as a real PNG asset", async () => {
  const bytes = await readFile(new URL("./assets/banny.png", import.meta.url));

  assert.ok(bytes.byteLength > 10_000);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
