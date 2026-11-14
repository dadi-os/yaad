import assert from "node:assert/strict";
import { test } from "node:test";
import { titleWords } from "../src/recall/anchor.js";
import type { Operation } from "../src/ingest/operations.js";
import { statusClaims } from "../src/ingest/validate.js";

const task = "00000000-0000-4000-8000-000000000001";
const done: Operation = { op: "update_node", node_id: task, detail: { done_at: "2026-11-12T23:50:00-05:00" } };
const bodyOf = (body: string): Operation => ({ op: "update_node", node_id: task, body });

test("a done_at or a submitted body is a claim when the text does not report Ankur finishing", () => {
  const text = "The course site shows desaia11.zip uploaded before the deadline. Questions 1 to 4 are due Nov 18 on Gradescope.";
  assert.deepEqual(statusClaims([done], text), [done]);
  assert.deepEqual(statusClaims([bodyOf("Questions 1 to 4, submitted on Gradescope.")], text).length, 1);
  assert.deepEqual(statusClaims([bodyOf("Submit on Gradescope.")], text), []);
});

test("nothing is a claim when the text reports Ankur finishing", () => {
  assert.deepEqual(statusClaims([done], "Ankur sent in the scholarship essay."), []);
  assert.deepEqual(statusClaims([done], "Ankur uploaded the zip."), []);
  assert.deepEqual(statusClaims([bodyOf("Submitted.")], "Ankur submitted HW3 last night."), []);
});

test("a negated completion word does not report finishing, and a negated body is not a claim", () => {
  assert.equal(statusClaims([done], "HW3 is not yet submitted and not done.").length, 1);
  assert.deepEqual(statusClaims([bodyOf("Not yet submitted.")], "HW3 is due Friday."), []);
});

test("title words drop short, generic, and person-name words", () => {
  const people = new Set(["ankur", "desai"]);
  assert.deepEqual(titleWords("when is Ankur advising appointment with the class", people), ["advising", "appointment"]);
});
