import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DockIconSetting, dockIconForKey } from "./DockIconSetting.js";
import { messagesFor } from "./locales.js";

/*
 * PC-SET-002, docs/21 section 9: Settings > General > Dock icon. A radio group of the dark (default) and the light icon,
 * each with a 64 px preview and named by its text; choosing saves at once (App.tsx wiring is pinned in engines-wiring).
 */

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

function render(value: "dark" | "light" = "dark", messages = EN): string {
  return renderToStaticMarkup(<DockIconSetting messages={messages} value={value} onChange={() => undefined} />);
}

test("the Dock icon control is a labelled radio group a UI test can find, with one roving tab stop on the chosen icon", () => {
  const markup = render();
  assert.match(markup, /<div class="guild-setting-label" id="guild-dock-icon-label">Dock icon<\/div>/u);
  assert.match(markup, /<div class="guild-segmented guild-dock-icons" role="radiogroup" aria-labelledby="guild-dock-icon-label" aria-describedby="guild-dock-icon-help" data-guild-setting="dock-icon">/u);
  const radios = markup.match(/<button[^>]*role="radio"[^>]*>/gu) ?? [];
  assert.equal(radios.length, 2);
  assert.match(radios[0]!, /aria-checked="true" tabindex="0" class="selected" data-dock-icon="dark"/u);
  assert.match(radios[1]!, /aria-checked="false" tabindex="-1" class="" data-dock-icon="light"/u);
  assert.match(markup, /<span>Dark<\/span>/u);
  assert.match(markup, /<span>Light<\/span>/u);
  assert.match(markup, /<p class="guild-setting-help" id="guild-dock-icon-help">Takes effect at once and is kept after a restart\.<\/p>/u);
  // Light chosen: the tab stop follows it.
  const light = render("light").match(/<button[^>]*role="radio"[^>]*>/gu) ?? [];
  assert.match(light[0]!, /aria-checked="false" tabindex="-1"/u);
  assert.match(light[1]!, /aria-checked="true" tabindex="0" class="selected"/u);
});

test("each option shows a decorative 64 px preview of its icon, loaded like the mascot", async () => {
  const markup = render();
  const images = [...markup.matchAll(/<img src="([^"]+)" alt="" width="64" height="64" draggable="false"\/>/gu)].map((match) => match[1]!);
  assert.equal(images.length, 2);
  assert.match(images[0]!, /assets\/dock-icon-dark\.png$/u);
  assert.match(images[1]!, /assets\/dock-icon-light\.png$/u);
  // The option's name is its text; the picture adds nothing for a screen reader.
  assert.doesNotMatch(markup, /alt="[^"]+"/u);
  const source = await readFile(new URL("../src/DockIconSetting.tsx", import.meta.url), "utf8");
  assert.match(source, /new URL\("\.\/assets\/dock-icon-dark\.png", import\.meta\.url\)\.href/u);
  assert.match(source, /new URL\("\.\/assets\/dock-icon-light\.png", import\.meta\.url\)\.href/u);
  // Both previews are real 128 x 128 PNG files the build copies next to the bundle.
  for (const name of ["dock-icon-dark.png", "dock-icon-light.png"]) {
    const bytes = await readFile(new URL(`../src/assets/${name}`, import.meta.url));
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], name);
    assert.equal(bytes.readUInt32BE(16), 128, `${name} width`);
    assert.equal(bytes.readUInt32BE(20), 128, `${name} height`);
  }
});

test("arrow keys, Home and End move between the two icons like the other radio groups, wrapping around; other keys do nothing", () => {
  assert.equal(dockIconForKey("dark", "ArrowRight"), "light");
  assert.equal(dockIconForKey("dark", "ArrowDown"), "light");
  assert.equal(dockIconForKey("light", "ArrowRight"), "dark");
  assert.equal(dockIconForKey("light", "ArrowLeft"), "dark");
  assert.equal(dockIconForKey("dark", "ArrowUp"), "light");
  assert.equal(dockIconForKey("light", "Home"), "dark");
  assert.equal(dockIconForKey("dark", "End"), "light");
  for (const key of ["Enter", " ", "Tab", "a"]) assert.equal(dockIconForKey("dark", key), undefined, key);
});

test("the Chinese control says Dock 图标, 深色 and 浅色", () => {
  const markup = render("dark", ZH);
  assert.match(markup, /id="guild-dock-icon-label">Dock 图标<\/div>/u);
  assert.match(markup, /<span>深色<\/span>/u);
  assert.match(markup, /<span>浅色<\/span>/u);
  assert.match(markup, /id="guild-dock-icon-help">选好后立即生效，重启后也会保留。<\/p>/u);
});
