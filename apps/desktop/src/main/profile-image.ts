/**
 * Local avatar inspection for Guild profile images.
 * Implements PC-SEC-003: renderer never reads arbitrary paths; main verifies bytes.
 */

export const GUILD_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const GUILD_AVATAR_MAX_EDGE = 8_192;
export const GUILD_DISPLAY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export type GuildAvatarFormat = "png" | "jpeg" | "webp";

export type GuildAvatarInspection = {
  readonly format: GuildAvatarFormat;
  readonly extension: "png" | "jpg" | "webp";
  readonly width: number;
  readonly height: number;
};

export type GuildDisplayImageInspection = {
  readonly format: GuildAvatarFormat | "gif";
  readonly extension: "gif" | "jpg" | "png" | "webp";
  readonly mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
};

export class GuildAvatarError extends Error {
  readonly code: "too_large" | "invalid_image" | "unsupported_type";

  constructor(code: "too_large" | "invalid_image" | "unsupported_type") {
    super(`guild_avatar_${code}`);
    this.name = "GuildAvatarError";
    this.code = code;
  }
}

export function inspectAvatarBytes(bytes: Uint8Array): GuildAvatarInspection {
  if (bytes.byteLength > GUILD_AVATAR_MAX_BYTES) {
    throw new GuildAvatarError("too_large");
  }
  if (bytes.byteLength < 16) {
    throw new GuildAvatarError("invalid_image");
  }
  const format = sniffAvatarFormat(bytes);
  if (format === undefined) {
    throw new GuildAvatarError("unsupported_type");
  }
  const size = readAvatarDimensions(bytes, format);
  if (
    size === undefined ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > GUILD_AVATAR_MAX_EDGE ||
    size.height > GUILD_AVATAR_MAX_EDGE
  ) {
    throw new GuildAvatarError("invalid_image");
  }
  return Object.freeze({
    format,
    extension: format === "jpeg" ? "jpg" : format,
    width: size.width,
    height: size.height,
  });
}

export function inspectDisplayImageBytes(bytes: Uint8Array): GuildDisplayImageInspection {
  if (bytes.byteLength > GUILD_DISPLAY_IMAGE_MAX_BYTES) {
    throw new GuildAvatarError("too_large");
  }
  if (bytes.byteLength < 10) throw new GuildAvatarError("invalid_image");
  const avatarFormat = sniffAvatarFormat(bytes);
  const format = avatarFormat ?? sniffGifFormat(bytes);
  if (format === undefined) throw new GuildAvatarError("unsupported_type");
  const size = format === "gif" ? readGifSize(bytes) : readAvatarDimensions(bytes, format);
  if (
    size === undefined ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > GUILD_AVATAR_MAX_EDGE ||
    size.height > GUILD_AVATAR_MAX_EDGE
  ) {
    throw new GuildAvatarError("invalid_image");
  }
  const mimeType = format === "gif"
    ? "image/gif"
    : format === "jpeg"
      ? "image/jpeg"
      : `image/${format}` as "image/png" | "image/webp";
  return Object.freeze({
    format,
    extension: format === "jpeg" ? "jpg" : format,
    mimeType,
    width: size.width,
    height: size.height,
  });
}

function sniffAvatarFormat(bytes: Uint8Array): GuildAvatarFormat | undefined {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return undefined;
}

function sniffGifFormat(bytes: Uint8Array): "gif" | undefined {
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  return signature === "GIF87a" || signature === "GIF89a" ? "gif" : undefined;
}

function readGifSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (bytes.byteLength < 10) return undefined;
  return {
    width: bytes[6]! | (bytes[7]! << 8),
    height: bytes[8]! | (bytes[9]! << 8),
  };
}

function readAvatarDimensions(
  bytes: Uint8Array,
  format: GuildAvatarFormat,
): { readonly width: number; readonly height: number } | undefined {
  if (format === "png") return readPngSize(bytes);
  if (format === "jpeg") return readJpegSize(bytes);
  return readWebpSize(bytes);
}

function readPngSize(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.byteLength < 24) return undefined;
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return undefined;
  }
  return {
    width: readUint32(bytes, 16),
    height: readUint32(bytes, 20),
  };
}

function readJpegSize(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === undefined) return undefined;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.byteLength) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return undefined;
    const sof =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3;
    if (sof && offset + 8 < bytes.byteLength) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebpSize(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes.byteLength < 30) return undefined;
  const fourcc = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (fourcc === "VP8X") {
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
  }
  if (fourcc === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes[26]! | (bytes[27]! << 8),
      height: bytes[28]! | (bytes[29]! << 8),
    };
  }
  if (fourcc === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return undefined;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}
