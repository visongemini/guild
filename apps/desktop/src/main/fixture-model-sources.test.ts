import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFixtureModelSources } from "./fixture-model-sources.js";

describe("fixture model sources", () => {
  it("serves a confirmed Online and Local source and lets the UI add, confirm and delete", async () => {
    const service = createFixtureModelSources();
    const initial = (await service.list()).sources;
    assert.deepEqual(initial.map((source) => [source.id, source.kind, source.confirmedHost]), [
      ["deepseek", "online", "api.deepseek.com"],
      ["workstation", "local", "127.0.0.1:8081"],
    ]);
    const added = await service.upsert({
      id: "extra", kind: "local", label: "Extra", baseUrl: "http://127.0.0.1:9000", keyFile: null, keyVariable: null,
      models: [{ id: "extra-model", label: "Extra" }], enabled: true,
    });
    assert.equal(added.needsConfirmation, true);
    assert.equal((await service.confirm("extra")).source.confirmedHost, "127.0.0.1:9000");
    await service.remove("extra");
    assert.equal((await service.list()).sources.length, 2);
  });
});
