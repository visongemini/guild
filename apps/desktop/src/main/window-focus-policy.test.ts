import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { reloadRendererWithoutActivation } from "./window-focus-policy.js";

test("system resume refreshes an existing renderer without revealing or focusing Guild", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  const resumeHandler = source.match(
    /powerMonitor\.on\("resume", \(\) => \{([\s\S]*?)\n  \}\);/u,
  )?.[1];

  assert.ok(resumeHandler);
  assert.match(resumeHandler, /handleLifecycleEvent\("resume"\)/);
  assert.match(resumeHandler, /webContents\.invalidate\(\)/);
  assert.doesNotMatch(resumeHandler, /\.show\(|\.focus\(|\.restore\(|openWindow\(/);
});

test("automatic renderer recovery reloads the existing native window without activation", async () => {
  let reloads = 0;
  assert.equal(reloadRendererWithoutActivation({ isDestroyed: () => false, reload: () => { reloads += 1; } }), true);
  assert.equal(reloads, 1);
  assert.equal(reloadRendererWithoutActivation({ isDestroyed: () => true, reload: () => { reloads += 1; } }), false);
  assert.equal(reloads, 1);

  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  const recoveryHandler = source.match(
    /const recoverRenderer = \(\) => \{([\s\S]*?)\n  \};/u,
  )?.[1];

  assert.ok(recoveryHandler);
  assert.match(recoveryHandler, /reloadRendererWithoutActivation/u);
  assert.match(recoveryHandler, /rendererRecoveryErrorPending = true/u);
  assert.doesNotMatch(recoveryHandler, /dialog\.showErrorBox/u);
  assert.doesNotMatch(recoveryHandler, /window\.destroy\(\)|openWindow\(/u);
  assert.doesNotMatch(recoveryHandler, /window\.(?:show|showInactive|focus|restore)\(/);

  const openWindowBody = source.match(
    /async function openWindow\(activation:[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(openWindowBody);
  assert.doesNotMatch(openWindowBody, /showInactive\(\)|background-visible/u);
  assert.match(source, /webContents\.on\("unresponsive"/u);
  assert.match(source, /RENDERER_UNRESPONSIVE_RECOVERY_MS = 15_000/u);
});

test("a duplicate process launch is not treated as foreground user intent", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  const secondInstanceHandler = source.match(
    /app\.on\("second-instance", \(\) => \{([\s\S]*?)\n\}\);/u,
  )?.[1];

  assert.ok(secondInstanceHandler);
  assert.match(secondInstanceHandler, /openWindow\("background-hidden"\)/);
  assert.doesNotMatch(secondInstanceHandler, /\.show\(|\.focus\(|\.restore\(|showInactive\(/);
});

test("notification delivery does not contain a window activation call", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  const notificationDelivery = source.match(
    /function installTaskNotifications[\s\S]*?\n\}/u,
  )?.[0];

  assert.ok(notificationDelivery);
  assert.match(notificationDelivery, /deliverTaskNotification\(notification/u);
  assert.doesNotMatch(notificationDelivery, /revealTaskFromNotification[\s\S]*deliverTaskNotification/u);
  assert.doesNotMatch(notificationDelivery, /guildWindow\?\.(?:show|focus|restore)\(|openWindow\(/);
});
