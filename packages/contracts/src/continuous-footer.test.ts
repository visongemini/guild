import assert from "node:assert/strict";
import test from "node:test";
import { parseContinuousFooter } from "./continuous-footer.js";

const valid = [
  "GUILD_CONTINUOUS_SUMMARY: Verified work",
  "GUILD_CONTINUOUS_REMAINING: NONE",
  "GUILD_CONTINUOUS_VERDICT: COMPLETE",
].join("\n");

test("accepts only a terminal continuous-task footer", () => {
  assert.deepEqual(parseContinuousFooter(`Result\n${valid}`), {
    body: "Result",
    summary: "Verified work",
    remaining: "NONE",
    verdict: "COMPLETE",
  });
  assert.equal(parseContinuousFooter(`${valid}\nCorrection: there is still work to do.`), undefined);
  assert.equal(parseContinuousFooter(valid.split("\n").map((line) => `    ${line}`).join("\n")), undefined);
});

test("does not treat a fenced protocol example as a control footer", () => {
  assert.equal(parseContinuousFooter(`\`\`\`text\n${valid}`), undefined);
  assert.equal(parseContinuousFooter(`\`\`\`text\n${valid}\n\`\`\``), undefined);
  assert.equal(parseContinuousFooter(`\`\`\`text\nexample\n\`\`\`\n${valid}`)?.verdict, "COMPLETE");
});
