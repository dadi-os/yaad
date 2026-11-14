import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtractionPrompt } from "../src/ingest/emit.js";

const prompt = loadExtractionPrompt(join(dirname(fileURLToPath(import.meta.url)), ".."));

test("the extraction prompt is the shared doctrine followed by the write-path rules", () => {
  assert.ok(prompt.startsWith("# Memory doctrine"));
  assert.ok(prompt.indexOf("# Memory extraction") > prompt.indexOf("## Freshness"));
});

test("the doctrine is stated once: extraction.md points at it instead of repeating it", () => {
  for (const sentence of ["**A venue is where, never whether.**", "**The open — the hardest call.**", "**Instructions to agents are not memory.**"]) {
    assert.equal(prompt.split(sentence).length - 1, 1, sentence);
  }
});
