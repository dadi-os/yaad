import assert from "node:assert/strict";
import { test } from "node:test";
import { titleWords } from "../src/recall/anchor.js";

test("title words drop short, generic, and person-name words", () => {
  const people = new Set(["ankur", "desai"]);
  assert.deepEqual(titleWords("when is Ankur advising appointment with the class", people), ["advising", "appointment"]);
});
