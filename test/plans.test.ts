import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, asc, eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { edge, node, nodeHistory, planDetail } from "../src/db/schema.js";
import { applyOperations } from "../src/ingest/apply.js";
import { emitOperationsInput, type Operation } from "../src/ingest/operations.js";
import { validateOperations } from "../src/ingest/validate.js";
import type { Config } from "../src/config.js";
import { axisVector, insertMemory, insertPlace, mockDwar, openTestDb, resetGraph, testConfig } from "./helpers.js";

const config = testConfig();
const dim = config.embedding.dimension;
const handle = await openTestDb();

before(async () => {
  await resetGraph(handle.sql);
});

after(async () => {
  await handle.close();
});

async function writes(operations: Operation[], cfg: Config = config) {
  await validateOperations({ timeZone: cfg.env.timezone, db: handle.db, operations });
  return applyOperations({ db: handle.db, dwar: mockDwar({ dimension: dim }), operations, author: { source: "agent", agentId: "education-specialist" }, config: cfg });
}

/** The hub's sessions in start order with their details. */
async function sessionsOf(hub: string) {
  return handle.db
    .select({ node, detail: planDetail })
    .from(edge)
    .innerJoin(node, eq(node.id, edge.dstId))
    .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
    .where(and(eq(edge.srcId, hub), eq(edge.type, "HAS_PLAN"), isNull(edge.validTo)))
    .orderBy(asc(node.occurredAt));
}

async function lectureCourse(dates: string[], extra: Record<string, unknown> = {}) {
  const building = await insertPlace(handle.db, { title: "Engineering Building", embedding: axisVector(dim, 1), address: "428 S Shaw Ln, East Lansing, MI" });
  const result = await writes([
    { op: "create_node", temp_id: "course", kind: "memory", title: "CSE 380" },
    {
      op: "spawn_plans",
      temp_id: "lectures",
      hub: "course",
      title: "CSE 380 lecture",
      dates,
      start_time: "10:20",
      end_time: "11:40",
      place: building,
      room: "1345",
      ...extra,
    },
  ]);
  const hub = result.temp_ids.course;
  assert.ok(hub);
  return { hub, building, result };
}

test("spawn_plans stamps one plain plan per date at the local time, linked to the course and place, with no embedding", async () => {
  await resetGraph(handle.sql);
  const { hub, building, result } = await lectureCourse(["2026-10-27", "2026-11-03", "2026-10-29"]);
  const sessions = await sessionsOf(hub);
  assert.deepEqual(
    sessions.map((row) => [row.node.title, row.node.occurredAt?.toISOString(), row.detail.endAt?.toISOString(), row.node.embedding]),
    [
      ["CSE 380 lecture", "2026-10-27T14:20:00.000Z", "2026-10-27T15:40:00.000Z", null],
      ["CSE 380 lecture", "2026-10-29T14:20:00.000Z", "2026-10-29T15:40:00.000Z", null],
      ["CSE 380 lecture", "2026-11-03T15:20:00.000Z", "2026-11-03T16:40:00.000Z", null],
    ],
  );
  assert.deepEqual(result.spawned.lectures, sessions.map((row) => row.node.id));
  assert.equal(result.counts.spawn_plans, 1);
  const located = await handle.db
    .select()
    .from(edge)
    .where(and(eq(edge.type, "AT_LOCATION"), eq(edge.dstId, building), isNull(edge.validTo)));
  assert.equal(located.length, 3);
  assert.ok(located.every((row) => row.properties.room === "1345"));
});

test("spawn_plans rejects repeated dates, an end before the start, a room with no place, and a non-place place", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "CSE 380", embedding: axisVector(dim, 0) });
  const spawn = (extra: Record<string, unknown>): Operation =>
    ({ op: "spawn_plans", temp_id: "s", hub: course, title: "Lecture", dates: ["2026-10-27"], start_time: "10:20", ...extra }) as Operation;
  const rejects = (op: Operation) =>
    assert.rejects(
      () => validateOperations({ timeZone: config.env.timezone, db: handle.db, operations: [op] }),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 422,
    );
  await rejects(spawn({ dates: ["2026-10-27", "2026-10-27"] }));
  await rejects(spawn({ end_time: "09:00" }));
  await rejects(spawn({ room: "1345" }));
  await rejects(spawn({ place: course }));
});

test("update_plans moves a course's later sessions, keeping each date and length, and changes room and rsvp in bulk", async () => {
  await resetGraph(handle.sql);
  const { hub } = await lectureCourse(["2026-10-27", "2026-10-29", "2026-11-03"]);
  await writes([{ op: "update_plans", hub, from_date: "2026-10-29", set: { start_time: "11:00" } }]);
  let sessions = await sessionsOf(hub);
  assert.deepEqual(
    sessions.map((row) => [row.node.occurredAt?.toISOString(), row.detail.endAt?.toISOString()]),
    [
      ["2026-10-27T14:20:00.000Z", "2026-10-27T15:40:00.000Z"],
      ["2026-10-29T15:00:00.000Z", "2026-10-29T16:20:00.000Z"],
      ["2026-11-03T16:00:00.000Z", "2026-11-03T17:20:00.000Z"],
    ],
  );

  await writes([{ op: "update_plans", hub, from_date: "2026-11-03", set: { rsvp: "no", room: "2010" } }]);
  sessions = await sessionsOf(hub);
  assert.deepEqual(sessions.map((row) => row.detail.rsvp), [null, null, "no"]);
  const rooms = await handle.db.select().from(edge).where(and(eq(edge.type, "AT_LOCATION"), isNull(edge.validTo)));
  assert.deepEqual(rooms.map((row) => row.properties.room).sort(), ["1345", "1345", "2010"]);

  await writes([{ op: "update_plans", hub, from_date: "2026-10-27", to_date: "2026-10-27", set: { end_time: "11:50" } }]);
  assert.equal((await sessionsOf(hub))[0]?.detail.endAt?.toISOString(), "2026-10-27T15:50:00.000Z");

  await writes([{ op: "update_plans", hub, from_date: "2026-10-29", to_date: "2026-10-29", set: { attended: false } }]);
  sessions = await sessionsOf(hub);
  assert.deepEqual(sessions.map((row) => row.detail.attended), [null, false, null]);
});

test("update_plans close closes the matched sessions like close_node, keeping a history row, and leaves the rest", async () => {
  await resetGraph(handle.sql);
  const { hub, building } = await lectureCourse(["2026-10-27", "2026-10-29", "2026-11-03"]);
  const [, called] = await sessionsOf(hub);
  assert.ok(called);
  await writes([{ op: "update_plans", hub, from_date: "2026-10-29", to_date: "2026-10-29", set: { close: true } }]);
  assert.deepEqual((await sessionsOf(hub)).map((row) => row.node.occurredAt?.toISOString()), ["2026-10-27T14:20:00.000Z", "2026-11-03T15:20:00.000Z"]);
  assert.equal((await handle.db.select().from(node).where(eq(node.id, called.node.id))).length, 0);
  const history = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, called.node.id));
  assert.deepEqual(history.map((row) => [row.field, row.oldValue]), [["deleted", "CSE 380 lecture"]]);
  const located = await handle.db.select().from(edge).where(and(eq(edge.type, "AT_LOCATION"), eq(edge.dstId, building), isNull(edge.validTo)));
  assert.equal(located.length, 2);
});

test("update_plans set accepts close only on its own", () => {
  const hub = "00000000-0000-4000-8000-000000000000";
  const parse = (set: Record<string, unknown>) =>
    emitOperationsInput.safeParse({ operations: [{ op: "update_plans", hub, from_date: "2026-10-29", set }] }).success;
  assert.equal(parse({ close: true }), true);
  assert.equal(parse({ close: true, rsvp: "no" }), false);
  assert.equal(parse({ close: false }), false);
});

test("a new course hub whose only links are its spawned sessions is not an unlinked create", async () => {
  await resetGraph(handle.sql);
  const { hub } = await lectureCourse(["2026-10-27"]);
  assert.equal((await sessionsOf(hub)).length, 1);
});

test("update_plans that matches no session is a 422 and writes nothing", async () => {
  await resetGraph(handle.sql);
  const { hub } = await lectureCourse(["2026-10-27"]);
  await assert.rejects(
    () => writes([{ op: "update_plans", hub, from_date: "2027-01-01", set: { rsvp: "no" } }]),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 422,
  );
  assert.equal((await sessionsOf(hub))[0]?.detail.rsvp, null);
});

test("sessions stay out of the memory graph and recall's walk, and the course's timeline items name it", async () => {
  await resetGraph(handle.sql);
  const { hub } = await lectureCourse(["2026-10-27", "2026-10-29"]);
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const graph = await app.inject({ method: "POST", url: "/graph", payload: {} });
  const recall = await app.inject({ method: "POST", url: "/recall", payload: { from: [hub], hops: 2 } });
  const timeline = await app.inject({ method: "POST", url: "/timeline", payload: { from: "2026-10-26T04:00:00.000Z", to: "2026-11-01T04:00:00.000Z", view: "planner" } });
  await app.close();
  assert.deepEqual(graph.json().nodes.map((n: { title: string }) => n.title).sort(), ["CSE 380", "Engineering Building"]);
  assert.ok(recall.json().nodes.every((n: { kind: string }) => n.kind !== "plan"));
  assert.deepEqual(timeline.json().items.map((item: { hub: { title: string } | null }) => item.hub?.title), ["CSE 380", "CSE 380"]);
});
