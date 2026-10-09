import assert from "node:assert/strict";
import test from "node:test";
import { checkpoint, entry, file, runId } from "./checkpoint.fixture.js";
import {
  cardAnchors,
  latestChangedRun,
  parseUnifiedDiff,
  rewindDisabledReason,
  runCardView,
  splitPath,
} from "./run-changes.js";

test("paths split into a dimmed directory and a base name", () => {
  assert.deepEqual(splitPath("Assets/Scripts/World/Foo.cs"), { dir: "Assets/Scripts/World/", base: "Foo.cs" });
  assert.deepEqual(splitPath("README.md"), { dir: "", base: "README.md" });
});

test("a finished run with changes gets a card with totals and one view per file", () => {
  const view = runCardView(checkpoint({ runId: runId("r1") }), false);
  assert.equal(view?.kind, "files");
  if (view?.kind !== "files") return;
  assert.equal(view.filesChanged, 3);
  assert.equal(view.adds, 142);
  assert.equal(view.dels, 58);
  assert.equal(view.rolledBack, false);
  assert.equal(view.filesTruncated, false);
  assert.deepEqual(view.files.map((entry) => [entry.status, entry.base, entry.dir.length > 0, entry.binary]), [
    ["M", "StylizedWorldMeshFactory.cs", true, false],
    ["M", "IslandLagoon.cs", true, false],
    ["A", "CoastlineRingTests.cs", true, false],
  ]);
});

test("a binary file has no line counts and a rename keeps its old path", () => {
  const view = runCardView(checkpoint({
    runId: runId("r1"),
    files: [file("art/logo.png", "M", null, null), file("src/new.ts", "R", 1, 1, "src/old.ts")],
  }), false);
  assert.equal(view?.kind, "files");
  if (view?.kind !== "files") return;
  assert.equal(view.files[0]?.binary, true);
  assert.equal(view.files[1]?.oldPath, "src/old.ts");
});

test("the list is flagged truncated when the projection capped it or listed fewer files than changed", () => {
  const capped = runCardView(checkpoint({ runId: runId("r1"), filesTruncated: true }), false);
  assert.equal(capped?.kind === "files" && capped.filesTruncated, true);
  const shorter = runCardView(checkpoint({ runId: runId("r1"), filesChanged: 450, files: [file("a.ts", "M", 1, 0)] }), false);
  assert.equal(shorter?.kind === "files" && shorter.filesTruncated, true);
});

test("capturing, unavailable, no changes and live runs each render the right thing", () => {
  assert.deepEqual(runCardView(checkpoint({ runId: runId("r1"), status: "capturing" }), false), { kind: "capturing" });
  assert.deepEqual(
    runCardView(checkpoint({ runId: runId("r1"), status: "unavailable", detail: "not_a_git_repo", files: [] }), false),
    { kind: "unavailable", reason: "not_a_git_repo" },
  );
  assert.deepEqual(
    runCardView(checkpoint({ runId: runId("r1"), status: "unavailable", files: [] }), false),
    { kind: "unavailable", reason: undefined },
  );
  assert.equal(runCardView(checkpoint({ runId: runId("r1"), files: [] }), false), undefined, "no changes renders nothing");
  assert.equal(runCardView(checkpoint({ runId: runId("r1") }), true), undefined, "a live run shows no card");
  assert.equal(runCardView(checkpoint({ runId: runId("r1"), status: "capturing" }), true), undefined);
});

test("a rewound run keeps its card, marked rolled back", () => {
  const byFlag = runCardView(checkpoint({ runId: runId("r1"), rolledBack: true }), false);
  const byStatus = runCardView(checkpoint({ runId: runId("r1"), status: "rolled_back" }), false);
  assert.equal(byFlag?.kind === "files" && byFlag.rolledBack, true);
  assert.equal(byStatus?.kind === "files" && byStatus.rolledBack, true);
});

test("the topbar points at the newest finished run that changed files and was not rewound", () => {
  const checkpoints = [
    checkpoint({ runId: runId("r1"), ordinal: 1 }),
    checkpoint({ runId: runId("r2"), ordinal: 2, files: [] }),
    checkpoint({ runId: runId("r3"), ordinal: 3, rolledBack: true }),
    checkpoint({ runId: runId("r4"), ordinal: 4, status: "capturing" }),
    checkpoint({ runId: runId("r5"), ordinal: 5, status: "unavailable", files: [] }),
  ];
  assert.equal(latestChangedRun(checkpoints)?.runId, "r1");
  assert.equal(latestChangedRun([checkpoints[1]!, checkpoints[2]!]), undefined);
  assert.equal(latestChangedRun(undefined), undefined);
  assert.equal(latestChangedRun([checkpoint({ runId: runId("a"), ordinal: 2 }), checkpoint({ runId: runId("b"), ordinal: 7 })])?.runId, "b");
});

test("a card hangs under the last answer of its run, or the last activity when the run has no answer", () => {
  const items = [
    entry("user", "u1", { runId: "r1", sequence: 1 }),
    entry("assistant", "a1", { runId: "r1", sequence: 2 }),
    entry("assistant", "a2", { runId: "r1", sequence: 3 }),
    entry("user", "u2", { runId: "r2", sequence: 4 }),
    entry("tool", "t1", { runId: "r2", sequence: 5 }),
    entry("thought", "th1", { runId: "r2", sequence: 6 }),
    entry("user", "u3", { runId: "r3", sequence: 7 }),
  ];
  const anchors = cardAnchors(items, [
    checkpoint({ runId: runId("r1") }), checkpoint({ runId: runId("r2"), ordinal: 2 }), checkpoint({ runId: runId("r3"), ordinal: 3 }),
  ]);
  assert.deepEqual([...anchors.keys()], ["a2", "th1"]);
  assert.equal(anchors.get("a2")?.runId, "r1");
  assert.equal(cardAnchors(items, undefined).size, 0);
});

test("rewind is disabled with the backend's own reason, and unknown availability counts as unavailable", () => {
  assert.equal(rewindDisabledReason({ available: true }), undefined);
  assert.equal(rewindDisabledReason({ available: false, reason: "run_active" }), "run_active");
  assert.equal(rewindDisabledReason({ available: false, reason: "queue_not_empty" }), "queue_not_empty");
  assert.equal(rewindDisabledReason(undefined), "runtime_unavailable");
});

test("a unified diff drops the path headers, colors the changes and keeps hunk lines apart", () => {
  const diff = [
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,3 @@ function f() {",
    " keep",
    "-old line",
    "+new line",
    "--- looks like a header but is a removed line",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff).map((line) => [line.kind, line.text]), [
    ["hunk", "@@ -1,3 +1,3 @@ function f() {"],
    ["ctx", " keep"],
    ["del", "-old line"],
    ["add", "+new line"],
    ["del", "--- looks like a header but is a removed line"],
    ["meta", "\\ No newline at end of file"],
  ]);
  const renamed = parseUnifiedDiff("diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n");
  assert.deepEqual(renamed.slice(0, 3).map((line) => line.kind), ["meta", "meta", "meta"]);
  assert.deepEqual(parseUnifiedDiff(""), []);
});
