import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import type { PlanItem } from "../src/types/planner.js";
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

async function plans(from: string, to: string): Promise<PlanItem[]> {
  const res = await call("POST", "/planner/plans", { from, to });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().items;
}

/** The transitional `POST /timeline`, which still applies the view the apps used to ask for. */
async function view(name: string, from: string, to: string): Promise<PlanItem[]> {
  const res = await call("POST", "/timeline", { from, to, view: name });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().items;
}

const WEEK = { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" };
const titles = (items: PlanItem[]) => items.map((item) => item.title);

test("POST /planner/plans returns every plan touching the range, and the transitional /timeline aliases still apply the old views", async () => {
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
  await insertEdge(handle.db, { src: course, dst: lecture, type: "HAS_PLAN" });
  const hours = await plan({
    title: "CSE 431 office hours",
    occurredAt: new Date("2026-10-21T18:00:00.000Z"),
    endAt: new Date("2026-10-21T19:00:00.000Z"),
    rsvp: "no",
  });
  await insertEdge(handle.db, { src: course, dst: hours, type: "HAS_PLAN" });
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
  assert.equal(new Set([lecture, hours, dinner, allDay, trip, reminder]).size, 6);

  assert.deepEqual(titles(await view("planner", WEEK.from, WEEK.to)), [
    "CSE 431 lecture",
    "CSE 431 office hours",
    "Dinner at Ciccio Mio",
    "Chicago trip",
  ]);
  assert.deepEqual(titles(await view("month", WEEK.from, WEEK.to)), [
    "Dinner at Ciccio Mio",
    "Call the bank",
    "Career fair",
    "Chicago trip",
  ]);
  assert.deepEqual(titles(await view("tile", WEEK.from, WEEK.to)), [
    "CSE 431 lecture",
    "CSE 431 office hours",
    "Dinner at Ciccio Mio",
    "Call the bank",
    "Career fair",
    "Chicago trip",
  ]);

  const tile = await view("tile", WEEK.from, WEEK.to);
  const byTitle = new Map(tile.map((item) => [item.title, item]));
  assert.equal(byTitle.get("CSE 431 office hours")?.rsvp, "no");
  assert.equal(byTitle.get("CSE 431 lecture")?.rsvp, null);
  assert.deepEqual(byTitle.get("CSE 431 lecture")?.hub, { id: course, title: "CSE 431" });
  assert.equal(byTitle.get("Dinner at Ciccio Mio")?.hub, null);

  const all = await plans(WEEK.from, WEEK.to);
  assert.deepEqual(titles(all), titles(tile));
  assert.equal((await call("POST", "/planner/plans", { from: WEEK.from, to: WEEK.to, view: "month" })).statusCode, 422);
  assert.equal((await call("POST", "/planner/plans", { from: WEEK.to, to: WEEK.from })).statusCode, 422);
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

  const [item] = await plans(WEEK.from, WEEK.to);
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
  assert.deepEqual(titles(await plans("2026-10-23T04:00:00.000Z", "2026-10-24T04:00:00.000Z")), ["Career fair"]);
  assert.deepEqual(await plans("2026-10-24T04:00:00.000Z", "2026-10-25T04:00:00.000Z"), []);
});

test("PUT /planner/plans/attended says whether he was there and takes the mark back, and refuses an unknown or non-plan id", async () => {
  await resetGraph(handle.sql);
  const id = await insertPlan(handle.db, {
    title: "Gym",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-10-21T15:00:00.000Z"),
    endAt: new Date("2026-10-21T16:00:00.000Z"),
  });
  const went = await call("PUT", "/planner/plans/attended", { plan_id: id, attended: true });
  assert.equal(went.statusCode, 200, went.body);
  assert.deepEqual(went.json(), { plan_id: id, attended: true });
  const [marked] = await plans(WEEK.from, WEEK.to);
  assert.equal(marked?.attended, true);

  assert.equal((await call("PUT", "/planner/plans/attended", { plan_id: id, attended: false })).json().attended, false);
  const cleared = await call("PUT", "/planner/plans/attended", { plan_id: id, attended: null });
  assert.equal(cleared.json().attended, null);
  const [after] = await plans(WEEK.from, WEEK.to);
  assert.equal(after?.attended, null);

  assert.equal((await call("PUT", "/timeline/attended", { plan_id: id, attended: true })).json().attended, true);
  const unknown = await call("PUT", "/planner/plans/attended", { plan_id: "00000000-0000-4000-8000-000000000000", attended: true });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.type, "not_found");
  const task = await insertTask(handle.db, { title: "HW", embedding: axisVector(dim, 1) });
  const wrongKind = await call("PUT", "/planner/plans/attended", { plan_id: task, attended: true });
  assert.equal(wrongKind.statusCode, 422);
  assert.equal(wrongKind.json().error.type, "invalid_request");
});

test("a plan's RSVP and every other node write have no route: only task done and plan attended are hand writes", async () => {
  const id = await insertPlan(handle.db, { title: "Talk", embedding: axisVector(dim, 0), occurredAt: new Date("2026-10-21T15:00:00.000Z"), endAt: new Date("2026-10-21T16:00:00.000Z") });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const attempts: Array<[string, string]> = [
    ["PUT", "/planner/plans/rsvp"],
    ["PUT", "/timeline/rsvp"],
    ["POST", "/nodes"],
    ["PATCH", `/nodes/${id}`],
    ["DELETE", `/nodes/${id}`],
    ["POST", "/edges"],
    ["POST", `/edges/${id}/close`],
  ];
  for (const [method, url] of attempts) {
    const res = await app.inject({ method: method as "POST", url, payload: {} });
    assert.equal(res.statusCode, 404, `${method} ${url}`);
  }
  await app.close();
});
