import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { BrowserWindow, Session, WebContents } from "electron";
import {
  createBrowserPaneRegistry,
  denyPermissions,
  hardenWebContents,
  isBrowserPaneContents,
  isPaneNavigationAllowed,
  isPaneUrlAllowed,
  isTrustedGuildSender,
} from "./window-guards.js";

type Listener = (event: { preventDefault: () => void }) => void;

function fakeContents(id = 1) {
  const listeners = new Map<string, Listener>();
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  const contents = {
    id,
    isDestroyed: () => false,
    on(name: string, listener: Listener) {
      listeners.set(name, listener);
    },
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      openHandler = handler;
    },
  };
  return {
    contents: contents as unknown as WebContents,
    fire(name: string): boolean {
      let prevented = false;
      const listener = listeners.get(name);
      assert.ok(listener, `no ${name} listener installed`);
      listener({ preventDefault: () => { prevented = true; } });
      return prevented;
    },
    open: (url: string) => openHandler?.({ url }),
  };
}

test("Guild's own window still denies navigation, frame navigation, webview attach and window.open", () => {
  const fake = fakeContents();
  hardenWebContents(fake.contents);
  assert.equal(fake.fire("will-navigate"), true);
  assert.equal(fake.fire("will-frame-navigate"), true);
  assert.equal(fake.fire("will-attach-webview"), true);
  assert.deepEqual(fake.open("https://example.com/"), { action: "deny" });
  assert.deepEqual(fake.open("guild-app://app/index.html"), { action: "deny" });
});

test("Guild's own session still denies every permission request and check", () => {
  let check: (() => boolean) | undefined;
  let request: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | undefined;
  denyPermissions({
    setPermissionCheckHandler: (handler: () => boolean) => { check = handler; },
    setPermissionRequestHandler: (handler: typeof request) => { request = handler; },
  } as unknown as Session);
  assert.equal(check?.(), false);
  for (const permission of ["media", "geolocation", "notifications", "clipboard-read"]) {
    let granted: boolean | undefined;
    request?.({}, permission, (value) => { granted = value; });
    assert.equal(granted, false, permission);
  }
});

test("a pane web contents in the registry gets the pane policy: http(s) and about:blank only", () => {
  const registry = createBrowserPaneRegistry();
  registry.register(7);
  for (const url of ["https://example.com/a?b=1", "http://localhost:5173/", "http://127.0.0.1:8080", "about:blank"]) {
    assert.equal(isPaneNavigationAllowed(7, url, registry), true, url);
  }
  for (const url of [
    "file:///etc/passwd", "data:text/html,hi", "blob:https://example.com/x", "javascript:alert(1)",
    "guild-app://app/index.html", "guild-media://media/x.png", "ftp://example.com/", "chrome://gpu",
    "about:srcdoc", "about:blank#x", "https://user:pw@example.com/", "https://", "not a url", "",
  ]) {
    assert.equal(isPaneNavigationAllowed(7, url, registry), false, url);
  }
  assert.equal(isPaneUrlAllowed(`https://example.com/${"a".repeat(9_000)}`), false);
});

test("an unregistered web contents never gets the pane policy, even for an http URL", () => {
  const registry = createBrowserPaneRegistry();
  registry.register(7);
  assert.equal(isPaneNavigationAllowed(8, "https://example.com/", registry), false);
  assert.equal(isPaneNavigationAllowed(8, "about:blank", registry), false);
  assert.equal(isBrowserPaneContents(8, registry), false);
  assert.equal(isBrowserPaneContents(7, registry), true);
});

test("unregistering removes the pane policy again", () => {
  const registry = createBrowserPaneRegistry();
  const unregister = registry.register(3);
  assert.equal(isPaneNavigationAllowed(3, "https://example.com/", registry), true);
  unregister();
  assert.equal(isPaneNavigationAllowed(3, "https://example.com/", registry), false);
  assert.equal(registry.size(), 0);
});

test("a pane contents is never a trusted Guild IPC sender, but the Guild window still is", async () => {
  const { browserPaneRegistry } = await import("./window-guards.js");
  const guild = { id: 1, isDestroyed: () => false } as unknown as WebContents;
  const window = { webContents: guild } as unknown as BrowserWindow;
  assert.equal(isTrustedGuildSender(window, guild, "guild-app://app/index.html"), true);
  assert.equal(isTrustedGuildSender(window, guild, "https://example.com/"), false);
  const pane = { id: 99, isDestroyed: () => false } as unknown as WebContents;
  const unregister = browserPaneRegistry.register(99);
  try {
    assert.equal(isTrustedGuildSender(window, pane, "guild-app://app/index.html"), false);
    // Even a window whose webContents is a registered pane id is refused.
    assert.equal(isTrustedGuildSender({ webContents: pane } as unknown as BrowserWindow, pane, "guild-app://app/index.html"), false);
  } finally {
    unregister();
  }
});

test("createGuildWindow keeps its guards and never mentions the browser pane", async () => {
  const source = await readFile(new URL("../../src/main/window-security.ts", import.meta.url), "utf8");
  const body = source.match(/export function createGuildWindow[\s\S]*?\n\}\n/u)?.[0];
  assert.ok(body);
  assert.match(body, /hardenWebContents\(window\.webContents\)/u);
  assert.match(body, /denyPermissions\(window\.webContents\.session\)/u);
  assert.match(body, /webviewTag: false/u);
  assert.match(body, /sandbox: true/u);
  assert.doesNotMatch(body, /browserPane|BrowserPane|persist:guild-browser|isPaneNavigationAllowed/u);
  // The guard bodies themselves are unchanged: deny everything.
  const guards = await readFile(new URL("../../src/main/window-guards.ts", import.meta.url), "utf8");
  const harden = guards.match(/export function hardenWebContents[\s\S]*?\n\}\n/u)?.[0];
  assert.ok(harden);
  assert.match(harden, /will-navigate", \(event\) => event\.preventDefault\(\)/u);
  assert.match(harden, /will-frame-navigate", \(event\) => event\.preventDefault\(\)/u);
  assert.match(harden, /will-attach-webview", \(event\) => event\.preventDefault\(\)/u);
  assert.match(harden, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/u);
  assert.doesNotMatch(harden, /registry|Registry|isPane/u);
});
