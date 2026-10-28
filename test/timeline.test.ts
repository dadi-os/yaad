import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { applyOperations } from "../src/ingest/apply.js";
import type { Operation } from "../src/ingest/operations.js";
import { validateOperations } from "../src/ingest/validate.js";
import type { TimelineItem } from "../src/types/timeline.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
  insertPlace,
  insertPlan,
  mockDwar,
  openTestDb,
  resetGraph,
  testConfig,
} from "./helpers.js";

const config = testConfig();
const dim = config.embedding.dimension;
const handle = await openTestDb();

before(async () => {
  await resetGraph(handle.sql);
});

after(async () => {
  await handle.close();
});

async function call(method: "POST" | "PUT", url: string, payload: Record<string, unknown>) {
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const res = await app.inject({ method, url, payload });
  await app.close();
  return res;
}

async function view(name: string, from: string, to: string): Promise<TimelineItem[]> {
  const res = await call("POST", "/timeline", { from, to, view: name });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().items;
}

/** Apply operations an agent's ingest emitted, validated as ingest validates them. */
async function agentWrites(operations: Operation[]) {
  await validateOperations({ db: handle.db, operations });
  return applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    operations,
    author: { source: "agent", agentId: "efficiency-specialist" },
    config,
  });
}

const WEEK = { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" };
const titles = (items: TimelineItem[]) => items.map((item) => item.title);

test("each view filters the same plans: planner, due, month, tile and someday", async () => {
  await resetGraph(handle.sql);
  let axis = 0;
  const plan = (args: Omit<Parameters<typeof insertPlan>[1], "embedding">) =>
    insertPlan(handle.db, { embedding: axisVector(dim, axis++), ...args });

  const course = await plan({
    title: "CSE 431 lecture",
    occurredAt: new Date("2026-10-14T13:00:00.000Z"),
    endAt: new Date("2026-10-14T14:20:00.000Z"),
    recurrence: "FREQ=WEEKLY;BYDAY=WE",
    kind: "class",
    agentId: "cse-431-specialist",
  });
  await plan({ title: "Gym", occurredAt: new Date("2026-10-21T15:00:00.000Z"), endAt: new Date("2026-10-21T16:00:00.000Z"), kind: "gym" });
  await plan({ title: "Dinner at Ciccio Mio", occurredAt: new Date("2026-10-21T22:00:00.000Z"), endAt: new Date("2026-10-21T23:00:00.000Z"), kind: "reservation" });
  await plan({
    title: "CSE 431 office hours",
    occurredAt: new Date("2026-10-21T18:00:00.000Z"),
    endAt: new Date("2026-10-21T19:00:00.000Z"),
    kind: "meeting",
    hideFromPlanner: true,
  });
  await plan({ title: "CSE 431 — HW4 due", occurredAt: null, dueAt: new Date("2026-10-22T03:59:00.000Z"), kind: "task" });
  await plan({ title: "Capital One payment due", occurredAt: null, dueAt: new Date("2026-10-22T16:00:00.000Z"), kind: "bill" });
  await plan({ title: "Fall break", occurredAt: new Date("2026-10-20T04:00:00.000Z"), allDay: true });
  await plan({ title: "Try the climbing gym", occurredAt: null, status: "idea" });

  const room = await insertPlace(handle.db, {
    title: "Engineering Building",
    embedding: axisVector(dim, axis++),
    address: "428 S Shaw Ln, East Lansing, MI 48824",
  });
  await insertEdge(handle.db, { src: course, dst: room, type: "AT_LOCATION", properties: { room: "1345" } });
  const note = await insertMemory(handle.db, { title: "CSE 431 Oct 21 lecture covered BFS and DFS", embedding: axisVector(dim, axis++) });
  await insertEdge(handle.db, { src: course, dst: note, type: "HAS_NOTE", properties: { occurrence: "2026-10-21" } });

  const planner = await view("planner", WEEK.from, WEEK.to);
  assert.deepEqual(titles(planner), ["CSE 431 lecture", "Gym", "Dinner at Ciccio Mio"]);
  const [lecture] = planner;
  assert.ok(lecture);
  assert.equal(lecture.occurrence_date, "2026-10-21");
  assert.equal(lecture.start_at, "2026-10-21T13:00:00.000Z");
  assert.equal(lecture.recurrence, "every Wed");
  assert.deepEqual(lecture.place, { id: room, title: "Engineering Building", address: "428 S Shaw Ln, East Lansing, MI 48824", room: "1345" });
  assert.deepEqual(lecture.notes.map((n) => n.id), [note]);
  assert.equal(lecture.owner, "cse-431-specialist");
  assert.equal(lecture.state, "scheduled");
  assert.equal(lecture.outcome, null);

  assert.deepEqual(titles(await view("due", WEEK.from, WEEK.to)), ["CSE 431 — HW4 due", "Capital One payment due"]);
  assert.deepEqual(titles(await view("month", WEEK.from, WEEK.to)), [
    "Fall break",
    "Dinner at Ciccio Mio",
    "CSE 431 — HW4 due",
    "Capital One payment due",
  ]);
  assert.deepEqual(titles(await view("tile", WEEK.from, WEEK.to)), [
    "Fall break",
    "CSE 431 lecture",
    "Dinner at Ciccio Mio",
    "CSE 431 — HW4 due",
    "Capital One payment due",
  ]);
  const someday = await view("someday", WEEK.from, WEEK.to);
  assert.deepEqual(titles(someday), ["CSE 431 — HW4 due", "Try the climbing gym"]);
  assert.equal(someday[1]?.occurrence_date, null);
  assert.deepEqual(titles(await view("someday", "2026-10-23T04:00:00.000Z", WEEK.to)), ["Try the climbing gym"]);
});

test("needs a time leaves out milestones, a class's coursework and tasks that already have their time", async () => {
  await resetGraph(handle.sql);
  let axis = 0;
  const plan = (args: Omit<Parameters<typeof insertPlan>[1], "embedding">) =>
    insertPlan(handle.db, { embedding: axisVector(dim, axis++), ...args });
  const due = new Date("2026-10-30T03:59:00.000Z");

  const course = await plan({ title: "CSE 300 lecture", occurredAt: new Date("2026-10-14T13:00:00.000Z"), recurrence: "FREQ=WEEKLY;BYDAY=WE", kind: "class" });
  const quiz = await plan({ title: "CSE 300 — Patents Quiz due", occurredAt: null, dueAt: due, kind: "task" });
  await insertEdge(handle.db, { src: course, dst: quiz, type: "HAS_ITEM", properties: { item: "quiz" } });

  const term = await insertMemory(handle.db, { title: "Spring 2027 enrollment", embedding: axisVector(dim, axis++) });
  const opens = await plan({ title: "Spring 2027 enrollment begins", occurredAt: null, dueAt: due, kind: "task" });
  await insertEdge(handle.db, { src: term, dst: opens, type: "HAS_ITEM", properties: { item: "milestone" } });

  const visit = await plan({ title: "Michigan ID renewal visit", occurredAt: new Date("2026-10-29T14:20:00.000Z"), endAt: new Date("2026-10-29T15:20:00.000Z"), kind: "appointment" });
  const expires = await plan({ title: "Current Michigan license expires", occurredAt: null, dueAt: due, kind: "task" });
  await insertEdge(handle.db, { src: visit, dst: expires, type: "HAS_ITEM", properties: { item: "deadline" } });

  const essay = await plan({ title: "Lockheed Martin application due", occurredAt: null, dueAt: due, kind: "task" });
  const block = await plan({ title: "Write the Lockheed Martin essay", occurredAt: new Date("2026-10-28T18:00:00.000Z"), endAt: new Date("2026-10-28T20:00:00.000Z"), kind: "focus" });
  await insertEdge(handle.db, { src: block, dst: essay, type: "FOR" });

  const application = await insertMemory(handle.db, { title: "Applied to ZipRecruiter", embedding: axisVector(dim, axis++) });
  const assessment = await plan({ title: "ZipRecruiter coding assessment due", occurredAt: null, dueAt: due, kind: "task" });
  await insertEdge(handle.db, { src: application, dst: assessment, type: "HAS_ITEM", properties: { item: "assignment" } });
  await plan({ title: "Research participation form due", occurredAt: null, dueAt: due, kind: "task" });

  assert.deepEqual(titles(await view("someday", WEEK.from, WEEK.to)), ["Research participation form due", "ZipRecruiter coding assessment due"]);
  assert.equal((await view("due", "2026-10-29T04:00:00.000Z", "2026-10-31T04:00:00.000Z")).length, 6);
});

test("Completed marks one session and undoes it, agents move, cancel and miss sessions, and series counts follow", async () => {
  await resetGraph(handle.sql);
  const now = Date.now();
  const start = new Date(now - 21 * 86_400_000 - 3_600_000);
  const series = await insertPlan(handle.db, {
    title: "Gym · Lower",
    embedding: axisVector(dim, 1),
    occurredAt: start,
    endAt: new Date(start.getTime() + 3_600_000),
    recurrence: "FREQ=WEEKLY;COUNT=10",
    kind: "gym",
  });
  const range = { from: new Date(start.getTime() - 3_600_000).toISOString(), to: new Date(now + 3_600_000).toISOString() };
  const first = await view("planner", range.from, range.to);
  assert.equal(first.length, 4);
  assert.deepEqual(first[0]?.series, { completed: 0, total: 4 });
  const [one, two, three, four] = first.map((item) => item.occurrence_date);
  assert.ok(one && two && three && four);

  const done = await call("PUT", "/timeline/outcome", { plan_id: series, occurrence_date: one, outcome: "done" });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().outcome, "done");
  assert.notEqual(done.json().outcome_at, null);

  await agentWrites([
    { op: "edit_occurrence", node_id: series, occurrence_date: two, state: "cancelled" },
    { op: "edit_occurrence", node_id: series, occurrence_date: three, outcome: "missed" },
    { op: "edit_occurrence", node_id: series, occurrence_date: four, state: "moved", start_at: new Date(now - 1_800_000).toISOString() },
  ]);
  const after = await view("planner", range.from, range.to);
  const byDate = new Map(after.map((item) => [item.occurrence_date, item]));
  assert.equal(byDate.get(one)?.outcome, "done");
  assert.equal(byDate.get(two)?.state, "cancelled");
  assert.equal(byDate.get(three)?.outcome, "missed");
  assert.equal(byDate.get(four)?.state, "moved");
  assert.equal(byDate.get(four)?.start_at, new Date(now - 1_800_000).toISOString());
  assert.equal(byDate.get(four)?.end_at, new Date(now + 1_800_000).toISOString());
  assert.deepEqual(after[0]?.series, { completed: 1, total: 3 });

  const undone = await call("PUT", "/timeline/outcome", { plan_id: series, occurrence_date: one, outcome: null });
  assert.equal(undone.json().outcome, null);
  const rows = await handle.sql`SELECT occurrence_date::text AS date, source FROM plan_occurrence ORDER BY occurrence_date`;
  assert.deepEqual(rows.map((row) => row.date), [two, three, four]);
  assert.ok(rows.every((row) => row.source === "efficiency-specialist"));

  const noSession = await call("PUT", "/timeline/outcome", { plan_id: series, occurrence_date: "2020-01-01", outcome: "done" });
  assert.equal(noSession.statusCode, 422);
  const unknown = await call("PUT", "/timeline/outcome", { plan_id: crypto.randomUUID(), occurrence_date: one, outcome: "done" });
  assert.equal(unknown.statusCode, 404);
  const missedByHand = await call("PUT", "/timeline/outcome", { plan_id: series, occurrence_date: one, outcome: "missed" });
  assert.equal(missedByHand.statusCode, 422);
});

test("a session moved to another day shows on that day only, and a move needs state moved", async () => {
  await resetGraph(handle.sql);
  const study = await insertPlan(handle.db, {
    title: "Study · IBIO 150",
    embedding: axisVector(dim, 2),
    occurredAt: new Date("2026-10-21T23:00:00.000Z"),
    endAt: new Date("2026-10-22T01:00:00.000Z"),
    kind: "study",
  });
  await agentWrites([
    { op: "edit_occurrence", node_id: study, occurrence_date: "2026-10-21", state: "moved", start_at: "2026-10-22T22:00:00.000Z" },
  ]);
  assert.deepEqual(await view("planner", "2026-10-21T04:00:00.000Z", "2026-10-22T04:00:00.000Z"), []);
  const thursday = await view("planner", "2026-10-22T04:00:00.000Z", "2026-10-23T04:00:00.000Z");
  assert.deepEqual(
    thursday.map((item) => [item.occurrence_date, item.start_at, item.end_at]),
    [["2026-10-21", "2026-10-22T22:00:00.000Z", "2026-10-23T00:00:00.000Z"]],
  );

  await assert.rejects(
    () => agentWrites([{ op: "edit_occurrence", node_id: study, occurrence_date: "2026-10-21", start_at: "2026-10-22T20:00:00.000Z" }]),
    /send state "moved"/,
  );
  await assert.rejects(
    () => agentWrites([{ op: "edit_occurrence", node_id: study, occurrence_date: "2026-10-23", outcome: "done" }]),
    /has no session on 2026-10-23/,
  );
});
