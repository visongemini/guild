import assert from "node:assert/strict";
import { it } from "node:test";
import {
  isAllowedMessageImageUrl,
  isAllowedTimelineMediaUrl,
} from "./message-image.js";

it("admits only bounded inline images, credential-free HTTPS, and private Guild media", () => {
  const grant = "guild-media://media/123e4567-e89b-42d3-a456-426614174000.png";
  assert.equal(isAllowedMessageImageUrl("data:image/png;base64,iVBORw0KGgo="), true);
  assert.equal(isAllowedMessageImageUrl("data:image/svg+xml;base64,PHN2Zz4="), false);
  assert.equal(isAllowedMessageImageUrl("data:image/png,not-base64"), false);
  assert.equal(isAllowedMessageImageUrl("https://images.example.test/a.png"), true);
  assert.equal(isAllowedMessageImageUrl("https://user:secret@images.example.test/a.png"), false);
  assert.equal(isAllowedMessageImageUrl("http://images.example.test/a.png"), false);
  assert.equal(isAllowedMessageImageUrl(grant), true);
  assert.equal(isAllowedMessageImageUrl("guild-media://media/a.png"), false);
  assert.equal(isAllowedMessageImageUrl("guild-media://other/a.png"), false);
  assert.equal(isAllowedMessageImageUrl("guild-media://user@media/a.png"), false);
  assert.equal(isAllowedMessageImageUrl("file:///tmp/a.png"), false);
  assert.equal(isAllowedMessageImageUrl(undefined), false);
});

it("admits only exact private Guild media grants for timeline attachments", () => {
  const grant = "guild-media://media/123e4567-e89b-42d3-a456-426614174000.png";
  assert.equal(isAllowedTimelineMediaUrl(grant), true);
  assert.equal(isAllowedTimelineMediaUrl("guild-media://media/a.png"), false);
  assert.equal(isAllowedTimelineMediaUrl("guild-media://media/"), false);
  assert.equal(isAllowedTimelineMediaUrl(`${grant}?token=1`), false);
  assert.equal(isAllowedTimelineMediaUrl(`${grant}#part`), false);
  assert.equal(isAllowedTimelineMediaUrl("guild-media://other/a.png"), false);
  assert.equal(isAllowedTimelineMediaUrl("https://images.example.test/a.png"), false);
  assert.equal(isAllowedTimelineMediaUrl(undefined), false);
});
