import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { GuildDockIcon } from "@guild/contracts";
import {
  createDockIconApplier,
  dockIconPath,
  type DockIconDependencies,
  type DockIconEvent,
} from "./dock-icon.js";

const DIRECTORY = join("/app", "Contents", "Resources");
const DARK = join(DIRECTORY, "icon.png");
const LIGHT = join(DIRECTORY, "icon-light.png");

function harness(overrides: Partial<DockIconDependencies> = {}) {
  const set: unknown[] = [];
  const loaded: string[] = [];
  const checked: string[] = [];
  const events: DockIconEvent[] = [];
  const deps: DockIconDependencies = {
    platform: "darwin",
    dock: { setIcon: (image) => void set.push(image) },
    iconDirectory: DIRECTORY,
    loadImage: (path) => {
      loaded.push(path);
      return { image: path };
    },
    fileExists: (path) => {
      checked.push(path);
      return true;
    },
    log: (event) => void events.push(event),
    ...overrides,
  };
  return { applier: createDockIconApplier(deps), set, loaded, checked, events };
}

test("dock icon path names the dark and the light artwork inside the directory", () => {
  assert.equal(dockIconPath("dark", DIRECTORY), DARK);
  assert.equal(dockIconPath("light", DIRECTORY), LIGHT);
});

test("dark and light each load only their own file and set that image", () => {
  for (const [choice, path] of [["dark", DARK], ["light", LIGHT]] as const) {
    const { applier, set, loaded, checked, events } = harness();
    assert.equal(applier.apply(choice), true);
    assert.deepEqual(checked, [path]);
    assert.deepEqual(loaded, [path]);
    assert.deepEqual(set, [{ image: path }]);
    assert.deepEqual(events, ["applied"]);
  }
});

test("the same choice twice and a switch back and forth all succeed", () => {
  const { applier, set, loaded } = harness();
  assert.equal(applier.apply("light"), true);
  assert.equal(applier.apply("light"), true);
  assert.equal(applier.apply("dark"), true);
  assert.equal(applier.apply("light"), true);
  assert.equal(applier.apply("dark"), true);
  assert.deepEqual(loaded, [LIGHT, LIGHT, DARK, LIGHT, DARK]);
  assert.deepEqual(set, loaded.map((image) => ({ image })));
});

test("non-darwin platforms are a quiet no-op that touches nothing", () => {
  for (const platform of ["linux", "win32"] as const) {
    const { applier, set, loaded, checked, events } = harness({ platform });
    assert.equal(applier.apply("light"), false);
    assert.deepEqual([set, loaded, checked], [[], [], []]);
    assert.deepEqual(events, ["unsupported-platform"]);
  }
});

test("a missing dock is a quiet no-op", () => {
  const { applier, loaded, checked, events } = harness({ dock: undefined });
  assert.equal(applier.apply("dark"), false);
  assert.deepEqual([loaded, checked], [[], []]);
  assert.deepEqual(events, ["no-dock"]);
});

test("a missing file is a quiet no-op and the image is never loaded", () => {
  const { applier, set, loaded, events } = harness({ fileExists: () => false });
  assert.equal(applier.apply("light"), false);
  assert.deepEqual([set, loaded], [[], []]);
  assert.deepEqual(events, ["file-missing"]);
});

test("an empty or absent image is a quiet no-op", () => {
  for (const image of [undefined, null]) {
    const { applier, set, events } = harness({ loadImage: () => image });
    assert.equal(applier.apply("dark"), false);
    assert.deepEqual(set, []);
    assert.deepEqual(events, ["image-empty"]);
  }
});

test("throwing seams never escape apply and do not poison the applier", () => {
  const boom = (): never => {
    throw new Error("boom /Users/someone/secret");
  };
  for (const overrides of [
    { fileExists: boom },
    { loadImage: boom },
    { dock: { setIcon: boom } },
  ] satisfies Partial<DockIconDependencies>[]) {
    const { applier, events } = harness(overrides);
    assert.equal(applier.apply("light"), false);
    assert.deepEqual(events, ["failed"]);
  }

  let broken = true;
  const set: unknown[] = [];
  const { applier } = harness({
    dock: {
      setIcon: (image) => {
        if (broken) throw new Error("dock not ready");
        set.push(image);
      },
    },
  });
  assert.equal(applier.apply("dark"), false);
  broken = false;
  assert.equal(applier.apply("dark"), true);
  assert.equal(set.length, 1);
});

test("a choice outside the contract fails quietly and loads nothing", () => {
  const { applier, set, loaded, events } = harness();
  assert.equal(applier.apply("sepia" as GuildDockIcon), false);
  assert.deepEqual([set, loaded], [[], []]);
  assert.deepEqual(events, ["failed"]);
});

test("events are fixed words that never carry a path, and a throwing log changes nothing", () => {
  const seen: string[] = [];
  const dock = { setIcon: () => undefined };
  const missing = harness({ fileExists: () => false, log: (event) => void seen.push(event) });
  const thrown = harness({ loadImage: () => { throw new Error(DIRECTORY); }, log: (event) => void seen.push(event) });
  missing.applier.apply("dark");
  thrown.applier.apply("light");
  for (const event of seen) {
    assert.match(event, /^[a-z]+(?:-[a-z]+)*$/u);
    assert.ok(!event.includes(DIRECTORY));
  }

  const loud = harness({ dock, log: () => { throw new Error("log sink closed"); } });
  assert.equal(loud.applier.apply("light"), true);
  const quiet = harness({ fileExists: () => false, log: () => { throw new Error("log sink closed"); } });
  assert.equal(quiet.applier.apply("light"), false);
});
