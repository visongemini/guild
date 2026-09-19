import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedGuildAppUrl, isTrustedGuildMediaUrl } from "./guild-url.js";

test("Guild custom URL policy admits only the exact privileged authority", () => {
  assert.equal(isTrustedGuildAppUrl("guild-app://app/index.html"), true);
  assert.equal(isTrustedGuildAppUrl("guild-app://app/assets/index.js"), true);
  assert.equal(isTrustedGuildAppUrl("guild-app://other/index.html"), false);
  assert.equal(isTrustedGuildAppUrl("guild-app://app.example/index.html"), false);
  assert.equal(isTrustedGuildAppUrl("guild-app://user@app/index.html"), false);
  assert.equal(isTrustedGuildAppUrl("guild-app://app:443/index.html"), false);
  assert.equal(isTrustedGuildAppUrl("https://app/index.html"), false);
  assert.equal(isTrustedGuildAppUrl("not a url"), false);
});

test("Guild media URL policy admits only the exact private media authority", () => {
  assert.equal(isTrustedGuildMediaUrl("guild-media://media/file.png"), true);
  assert.equal(isTrustedGuildMediaUrl("guild-media://other/file.png"), false);
  assert.equal(isTrustedGuildMediaUrl("guild-media://user@media/file.png"), false);
  assert.equal(isTrustedGuildMediaUrl("guild-media://media:443/file.png"), false);
  assert.equal(isTrustedGuildMediaUrl("file:///tmp/file.png"), false);
});
