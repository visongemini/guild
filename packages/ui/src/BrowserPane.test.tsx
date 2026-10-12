import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GUILD_BROWSER_LIMITS, type BrowserPaneProjection, type BrowserTabProjection } from "@guild/contracts/browser-pane";
import { BrowserPane, normalizeBrowserAddress, type BrowserPaneMessageKey } from "./BrowserPane.js";
import { messagesFor } from "./locales.js";

const tab = (id: string, patch: Partial<BrowserTabProjection> = {}): BrowserTabProjection => ({
  id, url: `https://example.com/${id}`, title: `Title ${id}`, loading: false, canGoBack: false, canGoForward: false, ...patch,
});

function render(projection: Partial<BrowserPaneProjection> = {}, locale: "en-US" | "zh-CN" = "en-US", hidden = false): string {
  const messages = messagesFor(locale);
  const t = (key: BrowserPaneMessageKey) => messages[key];
  return renderToStaticMarkup(
    <BrowserPane
      projection={{ tabs: [tab("tab-1")], activeTabId: "tab-1", agentControl: "idle", ...projection }}
      onCommand={() => undefined}
      t={t}
      hidden={hidden}
    />,
  );
}

test("renders the tab strip with the active tab selected and a close button per tab", () => {
  const markup = render({ tabs: [tab("tab-1"), tab("tab-2", { loading: true })], activeTabId: "tab-2" });
  assert.match(markup, /<div class="guild-browser-tabs" role="tablist" aria-label="Browser tabs">/u);
  assert.equal(markup.match(/role="tab"/gu)?.length, 2);
  assert.match(markup, /<div class="guild-browser-tab"><button type="button" role="tab" class="guild-browser-tab-main" aria-selected="false" title="Title tab-1">/u);
  assert.match(markup, /<div class="guild-browser-tab selected"><button type="button" role="tab" class="guild-browser-tab-main" aria-selected="true"/u);
  assert.equal(markup.match(/aria-label="Close tab"/gu)?.length, 2);
  assert.equal(markup.match(/guild-spin/gu)?.length, 1);
  assert.match(markup, /<span>Title tab-1<\/span>/u);
});

test("a tab without a title shows its address, and a blank tab shows the placeholder name", () => {
  const markup = render({ tabs: [tab("tab-1", { title: "" }), tab("tab-2", { title: "", url: "about:blank" })], activeTabId: "tab-1" });
  assert.match(markup, /<span>https:\/\/example\.com\/tab-1<\/span>/u);
  assert.match(markup, /<span>New tab<\/span>/u);
});

test("the new-tab button is disabled at the five-tab limit", () => {
  const four = render({ tabs: ["a", "b", "c", "d"].map((id) => tab(id)), activeTabId: "a" });
  assert.doesNotMatch(four, /class="guild-browser-newtab"[^>]*disabled/u);
  const five = render({ tabs: ["a", "b", "c", "d", "e"].map((id) => tab(id)), activeTabId: "a" });
  assert.match(five, /class="guild-browser-newtab"[^>]*title="Up to 5 tabs can be open"[^>]*disabled/u);
  assert.equal(GUILD_BROWSER_LIMITS.maxTabs, 5);
});

test("back and forward follow the active tab; reload becomes stop while loading", () => {
  const idle = render({ tabs: [tab("tab-1", { canGoBack: true })] });
  assert.match(idle, /aria-label="Back"[^>]*title="Back"[^>]*><svg/u);
  assert.doesNotMatch(idle, /aria-label="Back"[^>]*disabled/u);
  assert.match(idle, /aria-label="Forward"[^>]*disabled/u);
  assert.match(idle, /aria-label="Reload"/u);
  assert.doesNotMatch(idle, /aria-label="Stop loading"/u);

  const loading = render({ tabs: [tab("tab-1", { loading: true })] });
  assert.match(loading, /aria-label="Stop loading"/u);
  assert.doesNotMatch(loading, /aria-label="Reload"/u);
});

test("the address bar shows the active address, and nothing for a blank page", () => {
  assert.match(render(), /<input class="guild-browser-address" type="text" inputMode="url"[^>]*aria-label="Address"[^>]*placeholder="Enter a web address, e\.g\. example\.com"[^>]*value="https:\/\/example\.com\/tab-1"/u);
  assert.match(render({ tabs: [tab("tab-1", { url: "about:blank" })] }), /value=""/u);
  assert.doesNotMatch(render(), /aria-invalid/u);
});

test("the agent badge shows idle, operating and paused, with Take over or Resume agent", () => {
  const idle = render({ agentControl: "idle" });
  assert.match(idle, /<div class="guild-browser-agent idle">/u);
  assert.match(idle, /role="status" aria-live="polite">Agent idle<\/span>/u);
  assert.match(idle, /Take over<\/button>/u);
  assert.doesNotMatch(idle, /Resume agent/u);

  const operating = render({ agentControl: "operating" });
  assert.match(operating, /<div class="guild-browser-agent operating">/u);
  assert.match(operating, />Agent operating<\/span>/u);
  assert.match(operating, /Take over<\/button>/u);

  const paused = render({ agentControl: "paused" });
  assert.match(paused, /<div class="guild-browser-agent paused">/u);
  assert.match(paused, />Agent paused, you have control<\/span>/u);
  assert.match(paused, /Resume agent<\/button>/u);
  assert.doesNotMatch(paused, /Take over/u);
});

test("the viewport placeholder is empty while a tab is open and explains itself when there is none", () => {
  assert.match(render(), /<div class="guild-browser-viewport"><\/div>/u);
  const none = render({ tabs: [], activeTabId: null });
  assert.match(none, /<div class="guild-browser-viewport"><p>Enter an address to open a page\. The agent can browse here too\.<\/p><\/div>/u);
  assert.match(none, /aria-label="Reload"[^>]*disabled/u);
});

test("Chinese strings come from the locale catalog", () => {
  const markup = render({ agentControl: "operating" }, "zh-CN");
  assert.match(markup, /aria-label="\u6d4f\u89c8\u5668"/u);
  assert.match(markup, />\u667a\u80fd\u4f53\u6b63\u5728\u64cd\u4f5c<\/span>/u);
  assert.match(markup, /\u63a5\u7ba1<\/button>/u);
  assert.match(markup, /aria-label="\u540e\u9000"/u);
  assert.match(render({ agentControl: "paused" }, "zh-CN"), /\u6062\u590d\u667a\u80fd\u4f53<\/button>/u);
});

test("both catalogs define every browser pane string", async () => {
  const text = await readFile(new URL("../src/BrowserPane.tsx", import.meta.url), "utf8");
  const used = [...text.matchAll(/t\("(browserPane[A-Za-z]+)"\)/gu)].map((match) => match[1]!);
  assert.equal(used.length > 15, true);
  for (const locale of ["en-US", "zh-CN"] as const) {
    const messages = messagesFor(locale) as unknown as Record<string, unknown>;
    const keys = Object.keys(messages).filter((key) => key.startsWith("browserPane"));
    assert.equal(keys.length, 20, locale);
    for (const key of keys) {
      const value = messages[key];
      assert.equal(typeof value === "string" && value.length > 0 && !value.includes("undefined"), true, `${locale}.${key}`);
    }
    for (const key of used) assert.ok(keys.includes(key), `${locale} lacks ${key}`);
  }
});

test("addresses are normalised to http(s) URLs and plain words are not searches", () => {
  const ok = (input: string) => {
    const result = normalizeBrowserAddress(input);
    assert.equal(result.ok, true, input);
    return result.ok ? result.url : "";
  };
  assert.equal(ok("example.com"), "https://example.com/");
  assert.equal(ok("  example.com/a  "), "https://example.com/a");
  assert.equal(ok("http://example.com/x?y=1"), "http://example.com/x?y=1");
  assert.equal(ok("https://example.com"), "https://example.com/");
  assert.equal(ok("sub.example.co.uk/path#frag"), "https://sub.example.co.uk/path#frag");
  assert.equal(ok("localhost:3000"), "http://localhost:3000/");
  assert.equal(ok("localhost"), "http://localhost/");
  assert.equal(ok("127.0.0.1:5173/app"), "http://127.0.0.1:5173/app");
  assert.equal(ok("[::1]:8080"), "http://[::1]:8080/");
  assert.equal(ok("app.localhost:4000"), "http://app.localhost:4000/");
  assert.equal(ok("192.168.1.5:3000"), "https://192.168.1.5:3000/");
  assert.equal(ok("about:blank"), "about:blank");
  assert.equal(ok("HTTPS://Example.COM/Path"), "https://example.com/Path");

  for (const input of [
    "", "   ", "hello", "hello world", "what is the weather", "1234", "claude", "foo bar.com",
    "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "mailto:a@b.com", "ftp://example.com/",
    "guild-app://app/index.html", "https://user:pw@example.com/", "http://", "https://exa mple.com", "about:srcdoc",
  ]) {
    assert.equal(normalizeBrowserAddress(input).ok, false, JSON.stringify(input));
  }
});

test("the component reports the placeholder rectangle and visibility to main", async () => {
  const source = await readFile(new URL("../src/BrowserPane.tsx", import.meta.url), "utf8");
  assert.match(source, /new ResizeObserver\(report\)/u);
  assert.match(source, /kind: "setBounds", \.\.\.bounds/u);
  assert.match(source, /kind: "setVisible", visible: !hidden/u);
  assert.match(source, /kind: "setVisible", visible: false/u);
  assert.match(render({}, "en-US", true), /class="guild-browser-viewport"/u);
});

test("the pane component and the controller use the contracts types and keep no local copies", async () => {
  const ui = await readFile(new URL("../src/BrowserPane.tsx", import.meta.url), "utf8");
  const main = await readFile(new URL("../../../apps/desktop/src/main/browser-pane.ts", import.meta.url), "utf8");
  assert.match(ui, /from "@guild\/contracts\/browser-pane"/u);
  assert.match(main, /from "@guild\/contracts"/u);
  for (const [name, source] of [["component", ui], ["controller", main]] as const) {
    assert.doesNotMatch(source, /export type BrowserPane(AgentControl|TabProjection|Projection|Command)\b/u, name);
    assert.doesNotMatch(source, /\btype: "(navigate|back|forward|reload|stop|newTab|closeTab|selectTab|setBounds|setVisible|takeOver|resumeAgent)"/u, name);
  }
});
