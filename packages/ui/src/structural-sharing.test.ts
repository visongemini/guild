import assert from "node:assert/strict";
import test from "node:test";
import { replaceEqualDeep } from "./structural-sharing.js";

test("an equal graph resolves to the previous object at every level", () => {
  const previous = { a: [{ id: 1, text: "x".repeat(50) }, { id: 2, text: "y" }], b: { c: null, d: true } };
  const next = JSON.parse(JSON.stringify(previous)) as typeof previous;
  assert.notEqual(next, previous);
  assert.equal(replaceEqualDeep(previous, next), previous);
});

test("a change replaces only the path to it and keeps untouched siblings by identity", () => {
  const previous = {
    workspaces: [{ id: "w1", tasks: [{ id: "t1", title: "one" }, { id: "t2", title: "two" }] }, { id: "w2", tasks: [] as unknown[] }],
    timeline: [{ id: "e1", text: "hello" }, { id: "e2", text: "wor" }],
    settings: { locale: "en-US" },
  };
  const next = JSON.parse(JSON.stringify(previous)) as typeof previous;
  next.timeline[1]!.text = "world";
  const shared = replaceEqualDeep(previous, next);
  assert.notEqual(shared, previous);
  assert.equal(shared.workspaces, previous.workspaces);
  assert.equal(shared.settings, previous.settings);
  assert.notEqual(shared.timeline, previous.timeline);
  assert.equal(shared.timeline[0], previous.timeline[0]);
  assert.notEqual(shared.timeline[1], previous.timeline[1]);
  assert.deepEqual(shared, next);
});

test("array growth, shrinkage, key addition and key removal are all detected", () => {
  const previous = { list: [1, 2, 3], keep: { a: 1 } };
  assert.deepEqual(replaceEqualDeep(previous, { list: [1, 2, 3, 4], keep: { a: 1 } }).list, [1, 2, 3, 4]);
  assert.equal(replaceEqualDeep(previous, { list: [1, 2, 3, 4], keep: { a: 1 } }).keep, previous.keep);
  assert.deepEqual(replaceEqualDeep(previous, { list: [1, 2], keep: { a: 1 } }).list, [1, 2]);
  const added = replaceEqualDeep(previous, { list: [1, 2, 3], keep: { a: 1 }, extra: 1 } as never) as Record<string, unknown>;
  assert.equal(added["extra"], 1);
  const removed = replaceEqualDeep(previous, { list: [1, 2, 3] } as never) as Record<string, unknown>;
  assert.equal("keep" in removed, false);
  const optional = replaceEqualDeep({ a: undefined } as Record<string, unknown>, {} as Record<string, unknown>);
  assert.equal(Object.hasOwn(optional, "a"), false, "a removed optional key is a change");
});

test("different shapes and primitives are returned as the new value", () => {
  assert.equal(replaceEqualDeep(undefined, 5), 5);
  assert.equal(replaceEqualDeep("a", "b"), "b");
  assert.equal(replaceEqualDeep(null, { a: 1 }).a, 1);
  assert.deepEqual(replaceEqualDeep({ a: 1 }, [1]), [1]);
  assert.deepEqual(replaceEqualDeep([1], { 0: 1 }), { 0: 1 });
  const nan = Number.NaN;
  assert.ok(Number.isNaN(replaceEqualDeep(nan, Number.NaN)));
  class Box { constructor(readonly value: number) {} }
  const previous = { box: new Box(1) };
  const next = { box: new Box(1) };
  assert.equal(replaceEqualDeep(previous, next).box, next.box, "non-plain objects are compared by identity");
});

test("neither input is mutated", () => {
  const previous = Object.freeze({ items: Object.freeze([Object.freeze({ id: 1 })]) });
  const next = { items: [{ id: 1 }, { id: 2 }] };
  const snapshot = JSON.stringify(next);
  const shared = replaceEqualDeep(previous, next);
  assert.equal(JSON.stringify(next), snapshot);
  assert.equal(shared.items[0], previous.items[0]);
  assert.equal(shared.items.length, 2);
});

test("a realistic 500-row timeline resolves in a few milliseconds", () => {
  const build = () => Array.from({ length: 500 }, (_, index) => ({
    entryId: `entry-${index}`,
    sequence: index + 1,
    status: "completed",
    kind: "tool",
    content: [{ type: "text", text: `line ${index}\n`.repeat(400) }],
    locations: [{ path: `/work/file-${index}.ts`, line: index }],
  }));
  const previous = build();
  const next = build();
  const started = performance.now();
  const shared = replaceEqualDeep(previous, next);
  const elapsed = performance.now() - started;
  assert.equal(shared, previous);
  assert.ok(elapsed < 250, `structural sharing took ${elapsed.toFixed(1)} ms`);
});
