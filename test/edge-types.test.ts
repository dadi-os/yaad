import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EDGE_TYPES, isEdgeType } from "../src/types/edges.js";

/** The backticked UPPER_SNAKE names that start a table row in the prompt's §2.3 edge vocabulary. */
function promptEdgeTypes(): Set<string> {
  const prompt = readFileSync(new URL("../prompts/extraction.md", import.meta.url), "utf8");
  const start = prompt.indexOf("### 2.3 Edge vocabulary");
  const end = prompt.indexOf("### 2.4", start);
  const rows = prompt.slice(start, end).matchAll(/^\| `([A-Z][A-Z_]+)` \|/gm);
  return new Set([...rows].map((row) => row[1] ?? ""));
}

test("the allowed edge types and the prompt's §2.3 tables list exactly the same types", () => {
  assert.deepEqual([...promptEdgeTypes()].sort(), [...EDGE_TYPES].sort());
});

test("isEdgeType accepts the allowed types and nothing else", () => {
  assert.equal(isEdgeType("HAS_PLAN"), true);
  assert.equal(isEdgeType("HAS_SESSION"), false);
  assert.equal(isEdgeType("has_plan"), false);
});
