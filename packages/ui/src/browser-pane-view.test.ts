import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BROWSER_OVERLAY_SELECTOR,
  EMPTY_BROWSER_PANE,
  browserPaneHidden,
  modalOverlayPresent,
  revealsBrowserTab,
  type BrowserPaneVisibility,
} from "./browser-pane-view.js";

const showing: BrowserPaneVisibility = { workbenchOpen: true, hasTask: true, tab: "browser", overlayOpen: false };

test("the native view is shown only on the Browser tab of an open workbench with nothing drawn over it", () => {
  assert.equal(browserPaneHidden(showing), false);
  assert.equal(browserPaneHidden({ ...showing, workbenchOpen: false }), true, "workbench column collapsed");
  assert.equal(browserPaneHidden({ ...showing, hasTask: false }), true, "no task, no workbench");
  assert.equal(browserPaneHidden({ ...showing, tab: "files" }), true, "another tab");
  assert.equal(browserPaneHidden({ ...showing, tab: "review" }), true, "another tab");
  assert.equal(browserPaneHidden({ ...showing, overlayOpen: true }), true, "a menu, dialog or popover is open");
});

test("every way of hiding it is independent: any single reason is enough", () => {
  const reasons: readonly Partial<BrowserPaneVisibility>[] = [
    { workbenchOpen: false }, { hasTask: false }, { tab: "files" }, { tab: "review" }, { overlayOpen: true },
  ];
  for (const reason of reasons) assert.equal(browserPaneHidden({ ...showing, ...reason }), true, JSON.stringify(reason));
});

test("an agent that starts operating brings the Browser tab forward once, and only then", () => {
  assert.equal(revealsBrowserTab("idle", "operating"), true);
  assert.equal(revealsBrowserTab("paused", "operating"), true, "after a person gave control back");
  assert.equal(revealsBrowserTab("operating", "operating"), false, "already operating: do not fight a person who looked away");
  assert.equal(revealsBrowserTab("operating", "paused"), false);
  assert.equal(revealsBrowserTab("operating", "idle"), false);
  assert.equal(revealsBrowserTab("idle", "paused"), false);
  assert.equal(revealsBrowserTab("idle", "idle"), false);
});

test("before main pushes anything the pane is empty and nobody is in control", () => {
  assert.deepEqual(EMPTY_BROWSER_PANE, { tabs: [], activeTabId: null, agentControl: "idle" });
  assert.equal(Object.isFrozen(EMPTY_BROWSER_PANE), true);
});

test("the DOM safety net finds modal dialogs and menus but not the workbench's own narrow-window modal", () => {
  const seen: string[] = [];
  const root = { querySelector: (selector: string) => { seen.push(selector); return null; } };
  assert.equal(modalOverlayPresent(root), false);
  assert.deepEqual(seen, [BROWSER_OVERLAY_SELECTOR]);
  assert.equal(modalOverlayPresent({ querySelector: () => ({}) as never }), true);
  assert.match(BROWSER_OVERLAY_SELECTOR, /\[aria-modal="true"\]:not\(\.guild-workbench\)/u);
  assert.match(BROWSER_OVERLAY_SELECTOR, /\[role="menu"\]/u);
});

test("App wires the Browser tab: third workbench tab, the pane in a box of its own, pushes, first snapshot, reveal", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  // A third tab next to Files and Review, labelled by the browser pane's own key.
  const tabs = app.slice(app.indexOf('<div className="guild-workbench-tabs" role="tablist">'), app.indexOf('{workbenchTab === "browser" ? ('));
  assert.deepEqual([...tabs.matchAll(/aria-selected=\{workbenchTab === "(\w+)"\}/gu)].map((match) => match[1]), ["files", "review", "browser"]);
  assert.match(tabs, /onClick=\{\(\) => setWorkbenchTab\("browser"\)\}><Globe size=\{15\} \/>\{messages\.browserPaneWorkbenchTab\}<\/button>/u);
  assert.match(css, /\.guild-workbench-tabs \{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/u);
  // The pane gets the projection, the command bridge, the message lookup and the hidden decision.
  assert.match(app, /<BrowserPane\s*\n\s*projection=\{browserPane\}\s*\n\s*onCommand=\{sendBrowserCommand\}\s*\n\s*t=\{\(key\) => messages\[key\]\}\s*\n\s*hidden=\{browserHidden\}\s*\n\s*\/>/u);
  assert.match(app, /<div className="guild-workbench-body guild-workbench-browser">/u);
  assert.match(css, /\.guild-workbench-browser \{[^}]*overflow:\s*hidden/u);
  // Commands go to main and the answer is the new snapshot; pushes update the same state.
  assert.match(app, /void api\.browserCommand\(command\)\.then\(\s*\n\s*\(next\) => setBrowserPane\(\(current\) => replaceEqualDeep\(current, next\)\),/u);
  assert.match(app, /useEffect\(\(\) => api\.onBrowserPaneChanged\(\(next\) => \{\s*\n\s*setBrowserPane\(\(current\) => replaceEqualDeep\(current, next\)\);\s*\n\s*\}\), \[api\]\);/u);
  // Operating: the tab is selected and the workbench opened, on the transition only.
  assert.match(app, /if \(!revealsBrowserTab\(previous, browserPane\.agentControl\)\) return;\s*\n\s*setWorkbenchTab\("browser"\);\s*\n\s*setWorkbenchOpen\(true\);/u);
});

test("App hides the native view under every overlay it owns", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const decision = app.slice(app.indexOf("const browserHidden = browserPaneHidden({"), app.indexOf("const permissionPill"));
  assert.match(decision, /workbenchOpen,\s*\n\s*hasTask: activeTask !== undefined,\s*\n\s*tab: workbenchTab,/u);
  for (const flag of [
    "domOverlayOpen", "accountOpen", "settingsOpen", "profileOpen", "workspacePickerOpen", "commandPaletteOpen",
    "grokControlOpen", "contextMenu !== undefined", "rewindTarget !== undefined", "onlineReminder !== undefined",
    "discardConfirm", "contextUsageOpen",
  ]) assert.ok(decision.includes(flag), `${flag} hides the browser view`);
  // The DOM check runs before the loading guard (hooks keep their order) and only while the tab is showing.
  const hook = app.indexOf("const domOverlayOpen = useModalOverlayPresent(");
  assert.ok(hook > 0 && hook < app.indexOf("if (projection === undefined) {\n    const loadingMessages"));
  assert.match(app, /workbenchOpen && projection\?\.activeTask !== undefined && workbenchTab === "browser"/u);
});

test("the pane's grid has one track per section so the placeholder takes the rest of the column", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const pane = await readFile(new URL("../src/BrowserPane.tsx", import.meta.url), "utf8");
  const rows = /\.guild-browser \{[^}]*grid-template-rows:\s*([^;]+);/u.exec(css)?.[1]?.trim();
  // Tab strip, toolbar, agent status, placeholder: the last one is the only flexible track.
  assert.equal(rows, "auto auto auto minmax(0,1fr)");
  const sections = pane.slice(pane.indexOf('<section className="guild-browser"'), pane.indexOf("</section>"));
  const children = [...sections.matchAll(/^      <(div|form) className=(?:"|\{`)(guild-browser-[a-z]+)/gmu)].map((match) => match[2]);
  assert.deepEqual(children, ["guild-browser-tabs", "guild-browser-toolbar", "guild-browser-agent", "guild-browser-viewport"]);
});
