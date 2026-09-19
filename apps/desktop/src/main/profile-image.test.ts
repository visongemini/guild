import assert from "node:assert/strict";
import test from "node:test";
import {
  GUILD_AVATAR_MAX_BYTES,
  GuildAvatarError,
  inspectAvatarBytes,
  inspectDisplayImageBytes,
} from "./profile-image.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const JPEG_1X1 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xdb, 0x00, 0x43, 0x00, ...Array.from({ length: 64 }, () => 0x01),
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xc4, 0x00, 0x14, 0x10, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb,
  0xff, 0xd9,
]);

const WEBP_1X1 = Buffer.from(
  "524946461600000057454250565038580a00000000000000000000000000",
  "hex",
);

const GIF_1X1 = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");

test("inspects real PNG JPEG and WebP bytes and rejects disguised files", () => {
  assert.deepEqual(inspectAvatarBytes(PNG_1X1), {
    format: "png",
    extension: "png",
    width: 1,
    height: 1,
  });
  assert.deepEqual(inspectAvatarBytes(JPEG_1X1), {
    format: "jpeg",
    extension: "jpg",
    width: 1,
    height: 1,
  });
  assert.deepEqual(inspectAvatarBytes(WEBP_1X1), {
    format: "webp",
    extension: "webp",
    width: 1,
    height: 1,
  });
  assert.throws(
    () => inspectAvatarBytes(Buffer.from("not-an-image-but.png")),
    (error: unknown) => error instanceof GuildAvatarError && error.code === "unsupported_type",
  );
  const disguised = Buffer.from(PNG_1X1);
  disguised[0] = 0x00;
  assert.throws(
    () => inspectAvatarBytes(disguised),
    (error: unknown) => error instanceof GuildAvatarError && error.code === "unsupported_type",
  );
  assert.throws(
    () => inspectAvatarBytes(Buffer.alloc(GUILD_AVATAR_MAX_BYTES + 1, 0x89)),
    (error: unknown) => error instanceof GuildAvatarError && error.code === "too_large",
  );
});

test("inspects all displayable timeline image formats including GIF", () => {
  assert.deepEqual(inspectDisplayImageBytes(PNG_1X1), {
    format: "png",
    extension: "png",
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  assert.deepEqual(inspectDisplayImageBytes(GIF_1X1), {
    format: "gif",
    extension: "gif",
    mimeType: "image/gif",
    width: 1,
    height: 1,
  });
});
