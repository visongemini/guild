import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { removeLegacyBannyPlacement } from "./banny-legacy.js";

describe("Banny mascot", () => {
  it("removes the stale placement keys and leaves every other key alone", () => {
    const values = new Map<string, string>([
      ["guild:banny-placement-v1", JSON.stringify({ kind: "free", x: 0.3, y: 0.7 })],
      ["guild:banny-seat-task-id", "task-legacy"],
      ["guild:v1:workbench-width", "340"],
    ]);
    removeLegacyBannyPlacement({ removeItem: (key) => void values.delete(key) });
    assert.deepEqual([...values.keys()], ["guild:v1:workbench-width"]);
  });

  it("treats blocked storage as harmless", () => {
    assert.doesNotThrow(() => removeLegacyBannyPlacement({
      removeItem: () => { throw new Error("blocked"); },
    }));
  });

  it("shows the mascot in the empty-task slot only, not draggable, never in the header or on a task row", async () => {
    const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
    const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
    assert.equal(app.match(/BANNY_ASSET_URL/gu)?.length, 2, "one definition and one use");
    assert.match(app, /<div className="guild-empty-task">\s*<img className="guild-banny" src=\{BANNY_ASSET_URL\} alt="" draggable=\{false\} \/>\s*<h1 className="guild-acronym" aria-label=\{messages\.starterTitle\}>/u);
    assert.doesNotMatch(app, /BANNY_DRAG_MIME|guild-banny-floating|guild-task-banny|banny-seated/u);
    assert.doesNotMatch(css, /guild-banny-floating|guild-banny-home-target|guild-task-banny|banny-dragging|banny-drop-target/u);
  });
});
