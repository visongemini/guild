import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isRequirementPhase,
  isRequirementSeverity,
  parseProductRequirementId,
  PRODUCT_REQUIREMENT_ID_PATTERN,
} from "./ids.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const FIRST_SLICE_REQUIREMENTS = [
  "PC-TRACE-001",
  "PC-RUN-001",
  "PC-RUN-002",
  "PC-RUN-003",
  "PC-SESS-001",
  "PC-SESS-003",
  "PC-TRN-002",
  "PC-EVENT-001",
  "PC-PERM-001",
  "PC-PERM-002",
] as const;

describe("PC-TRACE-001 requirement catalog", () => {
  it("has unique IDs matching the published format", () => {
    const catalog = loadCatalog();
    const ids = catalog.requirements.map((req) => req.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.equal(PRODUCT_REQUIREMENT_ID_PATTERN.test(id), true);
      assert.equal(parseProductRequirementId(id).ok, true);
    }
    assert.equal(catalog.idPolicy.format, PRODUCT_REQUIREMENT_ID_PATTERN.source);
  });

  it("uses only allowed severities and phases", () => {
    const catalog = loadCatalog();
    for (const req of catalog.requirements) {
      assert.equal(isRequirementSeverity(req.severity), true, req.id);
      assert.equal(isRequirementPhase(req.phase), true, req.id);
    }
  });

  it("has closed acceptance-story and acceptance-test references", () => {
    const catalog = loadCatalog();
    for (const req of catalog.requirements) {
      assert.equal(typeof req.title, "string");
      assert.ok(req.title.length > 0, req.id);
      assert.equal(typeof req.statement, "string");
      assert.ok(req.statement.length > 0, req.id);
      assert.equal(Array.isArray(req.acceptanceStories), true, req.id);
      assert.equal(Array.isArray(req.acceptanceTests), true, req.id);
      assert.equal(Array.isArray(req.implementationCommits), true, req.id);
      assert.equal(Array.isArray(req.sources), true, req.id);
      for (const story of req.acceptanceStories) {
        assert.ok(
          catalog.acceptanceStories.has(story),
          `${req.id} references unknown story ${story}`,
        );
      }
      for (const testId of req.acceptanceTests) {
        assert.ok(
          catalog.acceptanceTests.has(testId),
          `${req.id} references unknown test ${testId}`,
        );
      }
    }
  });

  it("includes the first production-slice requirement IDs", () => {
    const catalog = loadCatalog();
    const ids = new Set(catalog.requirements.map((req) => req.id));
    for (const id of FIRST_SLICE_REQUIREMENTS) {
      assert.ok(ids.has(id), id);
    }
  });

  it("maps every first-slice requirement to well-formed provenance commit IDs", () => {
    const catalog = loadCatalog();
    const requirementsById = new Map(
      catalog.requirements.map((requirement) => [requirement.id, requirement]),
    );
    for (const id of FIRST_SLICE_REQUIREMENTS) {
      const requirement = requirementsById.get(id);
      assert.notEqual(requirement, undefined, id);
      if (requirement === undefined) continue;
      assert.ok(requirement.implementationCommits.length > 0, id);
      for (const commit of requirement.implementationCommits) {
        assert.match(commit, /^[0-9a-f]{40}$/u, `${id}: ${commit}`);
      }
    }
  });
});

type RawRequirement = {
  id: string;
  title: string;
  statement: string;
  severity: string;
  phase: number;
  acceptanceStories: string[];
  acceptanceTests: string[];
  implementationCommits: string[];
  sources: string[];
};

type Catalog = {
  idPolicy: { format: string };
  acceptanceStories: Set<string>;
  acceptanceTests: Set<string>;
  requirements: RawRequirement[];
};

function loadCatalog(): Catalog {
  const text = readFileSync(
    path.join(repoRoot, "requirements", "requirements.yml"),
    "utf8",
  );
  const doc = parseYamlDocument(text) as Record<string, unknown>;
  const idPolicy = asRecord(doc["id_policy"]);
  const stories = asRecord(doc["acceptance_stories"]);
  const tests = asRecord(doc["acceptance_tests"]);
  const rawReqs = doc["requirements"];
  assert.equal(Array.isArray(rawReqs), true);
  const requirements: RawRequirement[] = [];
  for (const item of rawReqs as unknown[]) {
    const rec = asRecord(item);
    requirements.push({
      id: asString(rec["id"]),
      title: asString(rec["title"]),
      statement: asString(rec["statement"]),
      severity: asString(rec["severity"]),
      phase: asNumber(rec["phase"]),
      acceptanceStories: asStringArray(rec["acceptance_stories"]),
      acceptanceTests: asStringArray(rec["acceptance_tests"]),
      implementationCommits: asStringArray(rec["implementation_commits"]),
      sources: asStringArray(rec["sources"]),
    });
  }
  return {
    idPolicy: { format: asString(idPolicy["format"]) },
    acceptanceStories: new Set(Object.keys(stories)),
    acceptanceTests: new Set(Object.keys(tests)),
    requirements,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(value !== null && typeof value === "object", true);
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function asNumber(value: unknown): number {
  assert.equal(typeof value, "number");
  return value as number;
}

function asStringArray(value: unknown): string[] {
  assert.equal(Array.isArray(value), true);
  const items = value as unknown[];
  return items.map((item) => asString(item));
}

function parseYamlDocument(text: string): unknown {
  const folded = foldBlockScalars(text);
  const lines: { indent: number; text: string }[] = [];
  for (const line of folded.split("\n")) {
    const trimmed = line.replace(/[ \t]+$/, "");
    if (!trimmed.trim() || trimmed.trimStart().startsWith("#")) {
      continue;
    }
    const indent = trimmed.length - trimmed.trimStart().length;
    lines.push({ indent, text: trimmed.trimStart() });
  }
  const parsed = parseValue(lines, 0, -1);
  return parsed.value;
}

function foldBlockScalars(text: string): string {
  const src = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const line = src[i] ?? "";
    const match = /^( *[^\n:]+:)[ \t]*>(-)?[ \t]*$/.exec(line);
    if (match === null) {
      out.push(line);
      continue;
    }
    const baseIndent = line.length - line.trimStart().length;
    const chunks: string[] = [];
    let j = i + 1;
    while (j < src.length) {
      const next = src[j] ?? "";
      if (!next.trim()) {
        j += 1;
        continue;
      }
      const indent = next.length - next.trimStart().length;
      if (indent <= baseIndent) {
        break;
      }
      chunks.push(next.trim());
      j += 1;
    }
    out.push(`${match[1]} ${chunks.join(" ")}`);
    i = j - 1;
  }
  return out.join("\n");
}

function parseValue(
  lines: readonly { indent: number; text: string }[],
  index: number,
  parentIndent: number,
): { value: unknown; next: number } {
  const first = lines[index];
  if (first === undefined || first.indent <= parentIndent) {
    return { value: null, next: index };
  }
  if (first.text.startsWith("- ")) {
    return parseList(lines, index, first.indent);
  }
  return parseMap(lines, index, first.indent);
}

function parseMap(
  lines: readonly { indent: number; text: string }[],
  index: number,
  indent: number,
): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {};
  let i = index;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent || line.text.startsWith("- ")) {
      break;
    }
    const colon = line.text.indexOf(":");
    assert.ok(colon > 0, line.text);
    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    if (rest.length > 0) {
      obj[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    const child = lines[i + 1];
    if (child === undefined || child.indent <= indent) {
      obj[key] = {};
      i += 1;
      continue;
    }
    const nested = parseValue(lines, i + 1, indent);
    obj[key] = nested.value;
    i = nested.next;
  }
  return { value: obj, next: i };
}

function parseList(
  lines: readonly { indent: number; text: string }[],
  index: number,
  indent: number,
): { value: unknown[]; next: number } {
  const arr: unknown[] = [];
  let i = index;
  while (i < lines.length) {
    const line = lines[i];
    if (
      line === undefined ||
      line.indent !== indent ||
      !line.text.startsWith("- ")
    ) {
      break;
    }
    const rest = line.text.slice(2).trim();
    if (rest.length === 0) {
      const nested = parseValue(lines, i + 1, indent);
      arr.push(nested.value);
      i = nested.next;
      continue;
    }
    if (rest.includes(":") && !rest.startsWith("[")) {
      const mapLines: { indent: number; text: string }[] = [
        { indent: indent + 2, text: rest },
      ];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next === undefined || next.indent <= indent) {
          break;
        }
        mapLines.push({ indent: next.indent, text: next.text });
        j += 1;
      }
      const parsed = parseMap(mapLines, 0, indent + 2);
      arr.push(parsed.value);
      i = j;
      continue;
    }
    arr.push(parseScalar(rest));
    i += 1;
  }
  return { value: arr, next: i };
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === "[]") {
    return [];
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }
    return inner.split(",").map((part) => {
      const item = parseScalar(part.trim());
      return item;
    });
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
