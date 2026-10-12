import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * The stylesheet contract of the 2026-10 UI refresh: every color lives in the two token blocks at the top, and the
 * text tokens stay readable (WCAG AA, 4.5:1) on every surface they are used on, in both themes.
 */

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

function blockAfter(source: string, selector: string): { body: string; start: number; end: number } {
  const start = source.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing ${selector} block`);
  const open = source.indexOf("{", start);
  const end = source.indexOf("\n}", open) + 2;
  return { body: source.slice(open + 1, end - 2), start, end };
}

const light = blockAfter(css, "\n:root");
const dark = blockAfter(css, ':root[data-theme="dark"]');

/** Brand art and fixed OS colors that may stay outside the tokens. Empty on purpose: the default avatar gradient is a token. */
const COLOR_LITERAL_ALLOWLIST: readonly string[] = [];

test("no color literal appears outside the token blocks", () => {
  const outside = css.slice(0, light.start) + css.slice(light.end, dark.start) + css.slice(dark.end);
  const withoutComments = outside.replace(/\/\*[^]*?\*\//gu, "");
  const literals = withoutComments.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/gu) ?? [];
  const unexpected = literals.filter((literal) => !COLOR_LITERAL_ALLOWLIST.includes(literal));
  assert.deepEqual(unexpected, [], "move these into the token blocks");
});

test("every variable the stylesheet reads is defined in a token block or set by the app", () => {
  const defined = new Set([...(light.body + dark.body).matchAll(/(--guild-[a-z0-9-]+)\s*:/gu)].map((match) => match[1]!));
  // Set per element, not in the token blocks.
  const local = new Set([
    "--sidebar-width", "--workbench-width", "--effective-sidebar-width", "--effective-workbench-width",
    "--guild-content-width", "--guild-content-gutter", "--guild-context-percent", "--guild-row-bg",
  ]);
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/gu)].map((match) => match[1]!));
  const missing = [...used].filter((name) => !defined.has(name) && !local.has(name));
  assert.deepEqual(missing, []);
});

type Rgb = readonly [number, number, number];

function tokenValue(body: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`, "u").exec(body);
  assert.ok(match?.[1], `missing ${name}`);
  return match[1].trim();
}

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-fA-F]{6})$/u.exec(value);
  if (hex !== null) {
    const n = Number.parseInt(hex[1]!, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const functional = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/u.exec(value);
  assert.ok(functional !== null, `unsupported color ${value}`);
  return { rgb: [Number(functional[1]), Number(functional[2]), Number(functional[3])], alpha: Number(functional[4] ?? 1) };
}

function composite(top: { rgb: Rgb; alpha: number }, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(top.rgb[i]! * top.alpha + bottom[i]! * (1 - top.alpha))) as unknown as Rgb;
}

/** `color-mix(in srgb, text N%, panel)`: `percent` of `top` over `bottom`. */
function mixInto(top: Rgb, bottom: Rgb, percent: string): Rgb {
  const share = Number.parseFloat(percent) / 100;
  return [0, 1, 2].map((i) => Math.round(top[i]! * share + bottom[i]! * (1 - share))) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
  test(`text tokens meet WCAG AA on every surface in the ${theme} theme`, () => {
    // The dark block only overrides; anything it leaves out comes from the light block.
    const get = (name: string) => {
      try { return tokenValue(block.body, name); } catch { return tokenValue(light.body, name); }
    };
    const solid = (name: string) => parseColor(get(name)).rgb;
    const panel = solid("--guild-panel");
    const surfaces: Record<string, Rgb> = {
      canvas: solid("--guild-canvas"),
      panel,
      surface: solid("--guild-surface"),
      soft: solid("--guild-soft"),
      bubble: solid("--guild-bubble"),
      code: solid("--guild-code-bg"),
      accentSoft: solid("--guild-accent-soft"),
      hoverOnPanel: composite(parseColor(get("--guild-hover")), panel),
      selectedOnPanel: composite(parseColor(get("--guild-selected")), panel),
      selectedOnCanvas: composite(parseColor(get("--guild-selected")), solid("--guild-canvas")),
      // The sidebar rows: text mixed into the panel by the row percentages (hover is lighter than selected).
      rowHover: mixInto(solid("--guild-text"), panel, get("--guild-row-hover-pct")),
      rowSelected: mixInto(solid("--guild-text"), panel, get("--guild-row-selected-pct")),
    };
    const texts = ["--guild-text", "--guild-muted", "--guild-faint", "--guild-accent-text", "--guild-wait-text", "--guild-error-text", "--guild-ok-text"];
    for (const token of texts) {
      for (const [surface, background] of Object.entries(surfaces)) {
        const ratio = contrast(solid(token), background);
        assert.ok(ratio >= 4.5, `${theme}: ${token} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
    const onAccent = contrast(solid("--guild-on-accent"), solid("--guild-accent"));
    assert.ok(onAccent >= 4.5, `${theme}: text on the accent fill is ${onAccent.toFixed(2)}:1`);
    for (const dot of ["--guild-accent", "--guild-wait", "--guild-error", "--guild-fresh"]) {
      const ratio = contrast(solid(dot), panel);
      assert.ok(ratio >= 3, `${theme}: ${dot} marker on the sidebar is ${ratio.toFixed(2)}:1`);
    }
  });
}

test("the type scale and radii follow the approved tokens", () => {
  for (const [name, value] of [
    ["--guild-r-xs", "5px"], ["--guild-r-sm", "7px"], ["--guild-r-md", "10px"], ["--guild-r-lg", "14px"],
    ["--guild-fs-ui", "13px"], ["--guild-fs-side", "13.5px"], ["--guild-fs-title", "14px"], ["--guild-fs-meta", "11.5px"],
    ["--guild-lh-message", "1.78"], ["--guild-lh-bubble", "1.65"],
  ] as const) assert.equal(tokenValue(light.body, name), value, name);
  assert.equal(tokenValue(light.body, "--guild-message-size"), "15px");
});

test("motion is limited to 120 to 180 ms and honors reduced motion", () => {
  assert.equal(tokenValue(light.body, "--guild-dur-1"), "120ms");
  assert.equal(tokenValue(light.body, "--guild-dur-2"), "180ms");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^]*animation-duration: 0\.001ms/u);
  // No transition or animation longer than the slow token (spin and pulse loops are infinite by design).
  const durations = [...css.matchAll(/transition:[^;]*?(\d+(?:\.\d+)?)(ms|s)\b/gu)]
    .map((match) => Number(match[1]) * (match[2] === "s" ? 1000 : 1));
  assert.ok(durations.every((ms) => ms <= 180), `transitions: ${durations.join(",")}`);
});

test("interactive controls are at least 28 px tall", () => {
  for (const selector of [".guild-icon-button", ".guild-pill", ".guild-ghost-button", ".guild-task-hover-action", ".guild-model-picker-trigger"]) {
    const rule = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{[^}]*?height:\\s*(\\d+)px`, "u").exec(css);
    assert.ok(rule !== null && Number(rule[1]) >= 28, `${selector} height`);
  }
});
