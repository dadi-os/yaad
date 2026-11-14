import assert from "node:assert/strict";
import { test } from "node:test";
import type { Operation } from "../src/ingest/operations.js";
import { dropClosedTasks, rejectWindowClaims, statesDate, windowClaims } from "../src/ingest/validate.js";

const ZONE = "America/New_York";
const AT = "2026-11-13T23:34:00-05:00";
const hub = "00000000-0000-4000-8000-000000000001";

const task = (temp_id: string, opens_on: string, closes_at: string): Operation => ({
  op: "create_node",
  temp_id,
  kind: "task",
  title: temp_id,
  detail: { opens_on, closes_at },
});
const link = (dst: string): Operation => ({ op: "create_edge", src: hub, dst, type: "HAS_ITEM", confidence: 1 });

test("a task whose close is before the text is dropped with its edges; the rest stays", () => {
  const ops = [task("old", "2026-09-01", "2026-09-04T23:59:00-04:00"), link("old"), task("new", "2026-11-13", "2026-11-16T12:00:00-05:00"), link("new")];
  assert.deepEqual(dropClosedTasks(ops, AT), [ops[2], ops[3]]);
  assert.equal(dropClosedTasks([ops[2] as Operation], AT).length, 1);
});

test("a task closing later tonight is kept, and a batch of only closed tasks becomes one noop", () => {
  const tonight = task("tonight", "2026-11-13", "2026-11-13T23:59:00-05:00");
  assert.deepEqual(dropClosedTasks([tonight, link("tonight")], AT), [tonight, link("tonight")]);
  assert.deepEqual(dropClosedTasks([task("old", "2026-09-01", "2026-09-04T23:59:00-04:00"), link("old")], AT), [
    { op: "noop", reason: "every task in the text closed before it" },
  ]);
});

test("an existing task's update is never dropped", () => {
  const update: Operation = { op: "update_node", node_id: hub, detail: { closes_at: "2026-09-04T23:59:00-04:00" } };
  assert.deepEqual(dropClosedTasks([update], AT), [update]);
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

test("an unstated open before the text's day, or over 28 days before the close, is a claim", () => {
  const text = "Ankur says the essay is due Mon noon.";
  const early = task("early", "2026-11-02", "2026-11-16T12:00:00-05:00");
  const ok = task("ok", "2026-11-13", "2026-11-16T12:00:00-05:00");
  const long = task("long", "2026-11-13", "2026-12-14T23:59:00-05:00");
  const edge28 = task("edge", "2026-11-16", "2026-12-14T23:59:00-05:00");
  assert.deepEqual(windowClaims([early, ok, long, edge28], text, AT, ZONE), [early, long]);
});

test("a stated open is never a claim, however early or long", () => {
  const stated = task("stated", "2026-09-01", "2026-12-14T23:59:00-05:00");
  assert.deepEqual(windowClaims([stated], "Final report opens Sep 1 and is due Dec 14.", AT, ZONE), []);
  assert.throws(() => rejectWindowClaims([stated], "Final report is due Dec 14.", AT, ZONE), (err: unknown) => (err as { type?: string }).type === "unsourced_window");
});

test("updates and non-task creates are not window claims", () => {
  const update: Operation = { op: "update_node", node_id: hub, detail: { opens_on: "2026-01-01", closes_at: "2026-12-14T23:59:00-05:00" } };
  assert.deepEqual(windowClaims([update], "x", AT, ZONE), []);
});
