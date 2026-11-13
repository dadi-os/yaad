import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import type { TimelineItem } from "../src/types/timeline.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
  insertPlace,
  insertPlan,
  insertTask,
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

const WEEK = { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" };
const titles = (items: TimelineItem[]) => items.map((item) => item.title);

test("each view filters the same stored plans: planner, month and tile, with declined and cancelled plans kept", async () => {
  await resetGraph(handle.sql);
  let axis = 0;
  const plan = (args: Omit<Parameters<typeof insertPlan>[1], "embedding">) =>
    insertPlan(handle.db, { embedding: axisVector(dim, axis++), ...args });

  const course = await insertMemory(handle.db, { title: "CSE 431", embedding: axisVector(dim, 90) });
  const lecture = await plan({
    title: "CSE 431 lecture",
    occurredAt: new Date("2026-10-21T13:00:00.000Z"),
    endAt: new Date("2026-10-21T14:20:00.000Z"),
  });
  await insertEdge(handle.db, { src: course, dst: lecture, type: "HAS_SESSION" });
  const hours = await plan({
    title: "CSE 431 office hours",
    occurredAt: new Date("2026-10-21T18:00:00.000Z"),
    endAt: new Date("2026-10-21T19:00:00.000Z"),
    rsvp: "no",
  });
  await insertEdge(handle.db, { src: course, dst: hours, type: "HAS_SESSION" });
  const cancelled = await plan({
    title: "Study group",
    occurredAt: new Date("2026-10-22T15:00:00.000Z"),
    endAt: new Date("2026-10-22T16:00:00.000Z"),
    status: "cancelled",
  });
  const dinner = await plan({
    title: "Dinner at Ciccio Mio",
    occurredAt: new Date("2026-10-21T22:00:00.000Z"),
    endAt: new Date("2026-10-21T23:00:00.000Z"),
  });
  const allDay = await plan({
    title: "Career fair",
    occurredAt: new Date("2026-10-23T04:00:00.000Z"),
    endAt: new Date("2026-10-23T04:00:00.000Z"),
    allDay: true,
  });
  const trip = await plan({
    title: "Chicago trip",
    occurredAt: new Date("2026-10-23T14:00:00.000Z"),
    endAt: new Date("2026-10-25T20:00:00.000Z"),
  });
  const reminder = await plan({ title: "Call the bank", occurredAt: new Date("2026-10-22T19:00:00.000Z") });
  assert.equal(new Set([lecture, hours, cancelled, dinner, allDay, trip, reminder]).size, 7);

  assert.deepEqual(titles(await view("planner", WEEK.from, WEEK.to)), [
    "CSE 431 lecture",
    "CSE 431 office hours",
    "Dinner at Ciccio Mio",
    "Study group",
    "Chicago trip",
  ]);
  assert.deepEqual(titles(await view("month", WEEK.from, WEEK.to)), [
    "Dinner at Ciccio Mio",
    "Study group",
    "Call the bank",
    "Career fair",
    "Chicago trip",
  ]);
  assert.deepEqual(titles(await view("tile", WEEK.from, WEEK.to)), [
    "CSE 431 lecture",
    "CSE 431 office hours",
    "Dinner at Ciccio Mio",
    "Study group",
    "Call the bank",
    "Career fair",
    "Chicago trip",
  ]);

  const tile = await view("tile", WEEK.from, WEEK.to);
  const byTitle = new Map(tile.map((item) => [item.title, item]));
  assert.equal(byTitle.get("CSE 431 office hours")?.rsvp, "no");
  assert.equal(byTitle.get("CSE 431 lecture")?.rsvp, null);
  assert.equal(byTitle.get("Study group")?.status, "cancelled");
  assert.deepEqual(byTitle.get("CSE 431 lecture")?.hub, { id: course, title: "CSE 431" });
  assert.equal(byTitle.get("Dinner at Ciccio Mio")?.hub, null);
});

test("a plan carries its place with the room from the edge, and its notes", async () => {
  await resetGraph(handle.sql);
  const room = await insertPlace(handle.db, { title: "Engineering Building", embedding: axisVector(dim, 0), address: "428 S Shaw Ln, East Lansing, MI" });
  const lecture = await insertPlan(handle.db, {
    title: "CSE 380 lab",
    embedding: axisVector(dim, 1),
    occurredAt: new Date("2026-10-21T13:00:00.000Z"),
    endAt: new Date("2026-10-21T14:50:00.000Z"),
  });
  await insertEdge(handle.db, { src: lecture, dst: room, type: "AT_LOCATION", properties: { room: "1345" } });
  const note = await insertMemory(handle.db, { title: "Covered pipes", embedding: axisVector(dim, 2) });
  await insertEdge(handle.db, { src: lecture, dst: note, type: "HAS_NOTE" });

  const [item] = await view("planner", WEEK.from, WEEK.to);
  assert.deepEqual(item?.place, { id: room, title: "Engineering Building", address: "428 S Shaw Ln, East Lansing, MI", room: "1345" });
  assert.deepEqual(item?.notes.map((n) => n.title), ["Covered pipes"]);
});

test("an all-day plan covers its day and not the next one", async () => {
  await resetGraph(handle.sql);
  await insertPlan(handle.db, {
    title: "Career fair",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-10-23T04:00:00.000Z"),
    endAt: new Date("2026-10-23T04:00:00.000Z"),
    allDay: true,
  });
  assert.deepEqual(titles(await view("month", "2026-10-23T04:00:00.000Z", "2026-10-24T04:00:00.000Z")), ["Career fair"]);
  assert.deepEqual(await view("month", "2026-10-24T04:00:00.000Z", "2026-10-25T04:00:00.000Z"), []);
});

test("PUT /timeline/outcome marks a plan done or missed and takes the mark back", async () => {
  await resetGraph(handle.sql);
  const id = await insertPlan(handle.db, {
    title: "Gym",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-10-21T15:00:00.000Z"),
    endAt: new Date("2026-10-21T16:00:00.000Z"),
  });
  const done = await call("PUT", "/timeline/outcome", { plan_id: id, outcome: "done" });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().outcome, "done");
  assert.ok(done.json().outcome_at);
  const [marked] = await view("planner", WEEK.from, WEEK.to);
  assert.equal(marked?.outcome, "done");

  const cleared = await call("PUT", "/timeline/outcome", { plan_id: id, outcome: null });
  assert.equal(cleared.json().outcome_at, null);
  const [after] = await view("planner", WEEK.from, WEEK.to);
  assert.equal(after?.outcome, null);
});

test("PUT /timeline/rsvp sets yes or no and clears the answer; an unknown id is 404 and a task is 422", async () => {
  await resetGraph(handle.sql);
  const id = await insertPlan(handle.db, {
    title: "Talk",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-10-21T15:00:00.000Z"),
    endAt: new Date("2026-10-21T16:00:00.000Z"),
  });
  assert.equal((await call("PUT", "/timeline/rsvp", { plan_id: id, rsvp: "no" })).statusCode, 200);
  assert.equal((await view("planner", WEEK.from, WEEK.to))[0]?.rsvp, "no");
  assert.equal((await call("PUT", "/timeline/rsvp", { plan_id: id, rsvp: null })).statusCode, 200);
  assert.equal((await view("planner", WEEK.from, WEEK.to))[0]?.rsvp, null);

  assert.equal((await call("PUT", "/timeline/rsvp", { plan_id: "00000000-0000-4000-8000-000000000000", rsvp: "yes" })).statusCode, 404);
  const task = await insertTask(handle.db, { title: "HW", embedding: axisVector(dim, 1) });
  const wrongKind = await call("PUT", "/timeline/rsvp", { plan_id: task, rsvp: "yes" });
  assert.equal(wrongKind.statusCode, 422);
  assert.equal(wrongKind.json().error.type, "invalid_request");
  assert.equal((await call("PUT", "/timeline/rsvp", { plan_id: id, rsvp: "maybe" })).statusCode, 422);
});
