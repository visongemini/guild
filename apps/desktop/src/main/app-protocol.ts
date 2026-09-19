import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { protocol } from "electron";
import { isTrustedGuildAppUrl, isTrustedGuildMediaUrl } from "./guild-url.js";

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' guild-media: data: https:; media-src guild-media:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'self'";

const MIME = Object.freeze<Record<string, string>>({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

const MEDIA_MIME = Object.freeze<Record<string, string>>({
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".webp": "image/webp",
});

const MEDIA_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/;
const MAX_MEDIA_FILE_BYTES = 8 * 1024 * 1024;

export function registerGuildScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "guild-app",
      privileges: { standard: true, secure: true },
    },
    {
      scheme: "guild-media",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

export async function installGuildAppProtocol(rendererRoot: string): Promise<void> {
  const canonicalRoot = resolve(rendererRoot);
  const assets = await collectAssets(canonicalRoot);
  await protocol.handle("guild-app", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!isTrustedGuildAppUrl(url) || url.search !== "" || url.hash !== "") {
      return new Response(null, { status: 403 });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    const key = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
    const path = assets.get(key);
    if (path === undefined) return new Response(null, { status: 404 });
    const headers = new Headers({
      "Content-Security-Policy": CSP,
      "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": key === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    return new Response(await readFile(path), { status: 200, headers });
  });
}

export async function installGuildMediaProtocol(mediaRoot: string): Promise<void> {
  const canonicalRoot = resolve(mediaRoot);
  await mkdir(canonicalRoot, { recursive: true, mode: 0o700 });
  await protocol.handle("guild-media", async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 });
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!isTrustedGuildMediaUrl(url) || url.search !== "" || url.hash !== "") {
      return new Response(null, { status: 403 });
    }
    let filename: string;
    try {
      filename = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {
      return new Response(null, { status: 400 });
    }
    const contentType = MEDIA_MIME[extname(filename).toLowerCase()];
    if (!MEDIA_FILENAME.test(filename) || contentType === undefined) {
      return new Response(null, { status: 404 });
    }
    const path = join(canonicalRoot, filename);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const fileStat = await file.stat();
      if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_MEDIA_FILE_BYTES) {
        return new Response(null, { status: 404 });
      }
      const headers = new Headers({
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": "inline",
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(await file.readFile(), { status: 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    } finally {
      await file?.close().catch(() => undefined);
    }
  });
}

async function collectAssets(root: string): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await stat(candidate);
      if (!fileStat.isFile()) continue;
      const key = relative(root, candidate).split(sep).join("/");
      if (key.startsWith("../") || key.includes("\0") || !Object.hasOwn(MIME, extname(key).toLowerCase())) {
        continue;
      }
      result.set(key, candidate);
    }
  }
  await visit(root);
  if (!result.has("index.html")) throw new Error("renderer_index_missing");
  return result;
}
