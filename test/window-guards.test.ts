import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation } from "../src/ingest/operations.js";
import { clampWindows, pastCloses, statesDate, statesPastDay } from "../src/ingest/validate.js";

const ZONE = "America/New_York";
const AT = "2026-11-13T23:34:00-05:00";
const hub = "00000000-0000-4000-8000-000000000001";

const task = (temp_id: string, detail: Record<string, unknown>): Operation => ({ op: "create_node", temp_id, kind: "task", title: temp_id, detail });
const link = (dst: string): Operation => ({ op: "create_edge", src: hub, dst, type: "HAS_ITEM", confidence: 1 });
const clamp = (operations: Operation[], text: string, storedOpens = new Map<string, string | null>()) =>
  clampWindows(operations, { text, occurredAt: AT, timeZone: ZONE, storedOpens });

test("a task whose close is before the text's day is skipped with its edges and reported; the rest stays", () => {
  const ops = [task("old", { opens_on: "2026-09-01", closes_at: "2026-09-04T23:59:00-04:00" }), link("old"), task("new", { opens_on: "2026-11-13", closes_at: "2026-11-16T12:00:00-05:00" }), link("new")];
  const result = pastCloses(ops, AT, undefined, ZONE);
  assert.deepEqual(result.operations, [ops[2], ops[3]]);
  assert.deepEqual(result.skipped, [{ title: "old", closes_at: "2026-09-04T23:59:00-04:00", reason: "closed before the text and not stated by Ankur" }]);
});

test("a task closing earlier today is kept, and a batch of only closed tasks becomes one noop", () => {
  const today = task("today", { opens_on: "2026-11-10", closes_at: "2026-11-13T09:00:00-05:00" });
  assert.deepEqual(pastCloses([today, link("today")], AT, undefined, ZONE).operations, [today, link("today")]);
  const old = [task("old", { opens_on: "2026-09-01", closes_at: "2026-09-04T23:59:00-04:00" }), link("old")];
  assert.deepEqual(pastCloses(old, AT, undefined, ZONE).operations, [{ op: "noop", reason: "every task in the text closed before it" }]);
});

test("a past close Ankur's words state is kept, and an existing task's update is never skipped", () => {
  const missed = [task("hw3", { opens_on: "2026-11-01", closes_at: "2026-11-12T23:59:00-05:00" }), link("hw3")];
  const kept = pastCloses(missed, AT, "I missed HW3, it was due yesterday", ZONE);
  assert.deepEqual(kept.operations, missed);
  assert.deepEqual(kept.skipped, []);
  assert.equal(pastCloses(missed, AT, "I turned in the essay", ZONE).skipped.length, 1);
  const update: Operation = { op: "update_node", node_id: hub, detail: { closes_at: "2026-09-04T23:59:00-04:00" } };
  assert.deepEqual(pastCloses([update], AT, undefined, ZONE).operations, [update]);
});

test("statesDate reads ISO, M/D, month-name and day-first forms, and not another day", () => {
  assert.equal(statesDate("opens Nov 18, 8:00 AM", "2026-11-18"), true);
  assert.equal(statesDate("opens November 2nd", "2026-11-02"), true);
  assert.equal(statesDate("posted 11/9", "2026-11-09"), true);
  assert.equal(statesDate("posted 2026-11-09", "2026-11-09"), true);
  assert.equal(statesDate("opened 9 Nov", "2026-11-09"), true);
  assert.equal(statesDate("opens Nov 18", "2026-11-01"), false);
  assert.equal(statesDate("due Dec 14", "2026-11-14"), false);
  assert.equal(statesDate("week of 11/19", "2026-11-09"), false);
});

test("statesPastDay reads yesterday, last night, and a weekday within the week before", () => {
  assert.equal(statesPastDay("it was due yesterday", "2026-11-12", "2026-11-13"), true);
  assert.equal(statesPastDay("it was due yesterday", "2026-11-10", "2026-11-13"), false);
  assert.equal(statesPastDay("due last Tuesday", "2026-11-10", "2026-11-13"), true);
  assert.equal(statesPastDay("due Tuesday", "2026-10-06", "2026-11-13"), false);
  assert.equal(statesPastDay("due Nov 12", "2026-11-12", "2026-11-13"), true);
});

test("an unstated open over 28 days before the close is moved to 28 days and reported", () => {
  const long = task("long", { opens_on: "2026-11-13", closes_at: "2026-12-14T23:59:00-05:00" });
  const ok = task("ok", { opens_on: "2026-11-13", closes_at: "2026-11-16T12:00:00-05:00" });
  const edge28 = task("edge", { opens_on: "2026-11-16", closes_at: "2026-12-14T23:59:00-05:00" });
  const result = clamp([long, ok, edge28], "Ankur says the essay is due Mon noon.");
  assert.deepEqual(result.operations, [task("long", { opens_on: "2026-11-16", closes_at: "2026-12-14T23:59:00-05:00" }), ok, edge28]);
  assert.deepEqual(result.clamped, [{ node: "long", from: "2026-11-13", to: "2026-11-16", rule: "open_over_28_days" }]);
});

test("an unstated open before the text's day moves to it, or to the close day when that is past", () => {
  const early = task("early", { opens_on: "2026-11-02", closes_at: "2026-11-16T12:00:00-05:00" });
  const past = task("past", { opens_on: "2026-11-01", closes_at: "2026-11-12T23:59:00-05:00" });
  const result = clamp([early, past], "x");
  assert.deepEqual(result.clamped, [
    { node: "early", from: "2026-11-02", to: "2026-11-13", rule: "open_before_text" },
    { node: "past", from: "2026-11-01", to: "2026-11-12", rule: "open_before_text" },
  ]);
});

test("a stated open is never clamped, however early or long", () => {
  const stated = task("stated", { opens_on: "2026-09-01", closes_at: "2026-12-14T23:59:00-05:00" });
  const kritik = task("kritik", { opens_on: "2026-10-14", closes_at: "2026-11-14T23:59:00-05:00" });
  const result = clamp([stated, kritik], "Final report opens Sep 1 and is due Dec 14. Kritik runs Oct 14 to Nov 14.");
  assert.deepEqual(result.operations, [stated, kritik]);
  assert.deepEqual(result.clamped, []);
});

test("a close with no open gets one: the text's day, bounded by 28 days before the close", () => {
  const near = task("near", { closes_at: "2026-11-16T12:00:00-05:00" });
  const far = task("far", { closes_at: "2027-01-29T17:00:00-05:00" });
  const result = clamp([near, far], "x");
  assert.deepEqual(result.operations, [task("near", { closes_at: "2026-11-16T12:00:00-05:00", opens_on: "2026-11-13" }), task("far", { closes_at: "2027-01-29T17:00:00-05:00", opens_on: "2027-01-01" })]);
  assert.deepEqual(result.clamped.map((entry) => entry.rule), ["open_missing", "open_missing"]);
});

test("an update that adds a close to a task with no open gets one, and one on a task with an open does not", () => {
  const give: Operation = { op: "update_node", node_id: "a", detail: { closes_at: "2026-11-16T12:00:00-05:00" } };
  const keep: Operation = { op: "update_node", node_id: "b", detail: { closes_at: "2026-11-16T12:00:00-05:00" } };
  const memory: Operation = { op: "update_node", node_id: "c", detail: { closes_at: "2026-11-16T12:00:00-05:00" } };
  const result = clamp([give, keep, memory], "x", new Map([["a", null], ["b", "2026-11-01"]]));
  assert.deepEqual(result.operations, [{ ...give, detail: { closes_at: "2026-11-16T12:00:00-05:00", opens_on: "2026-11-13" } }, keep, memory]);
});

test("an update that moves only the close of a task with a stored open keeps the 28-day bound unless the text states that open", () => {
  const move: Operation = { op: "update_node", node_id: "k", detail: { closes_at: "2026-11-15T04:59:00Z" } };
  const stored = new Map([["k", "2026-10-16"]]);
  const result = clamp([move], "Kritik Essay 3 closes Sat Nov 14, 11:59 PM", stored);
  assert.deepEqual(result.operations, [{ ...move, detail: { closes_at: "2026-11-15T04:59:00Z", opens_on: "2026-10-18" } }]);
  assert.deepEqual(result.clamped, [{ node: "k", from: "2026-10-16", to: "2026-10-18", rule: "open_over_28_days" }]);
  const stated = clamp([move], "Kritik runs Oct 16 to Nov 14", stored);
  assert.deepEqual(stated.operations, [move]);
  assert.deepEqual(stated.clamped, []);
  const near = clamp([move], "x", new Map([["k", "2026-10-20"]]));
  assert.deepEqual(near.operations, [move]);
});

test("an unstated open on the text's day after a close already past is moved to the close day", () => {
  const result = clamp([task("late", { opens_on: "2026-11-13", closes_at: "2026-11-12T23:59:00-05:00" })], "Class 2 Homework closed Nov 12.");
  assert.deepEqual(result.clamped, [{ node: "late", from: "2026-11-13", to: "2026-11-12", rule: "open_before_text" }]);
  assert.deepEqual((result.operations[0] as { detail: unknown }).detail, { opens_on: "2026-11-12", closes_at: "2026-11-12T23:59:00-05:00" });
});
