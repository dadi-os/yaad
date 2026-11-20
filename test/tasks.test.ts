import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { node, nodeHistory, taskDetail } from "../src/db/schema.js";
import { randomUUID } from "node:crypto";
import { applyOperations } from "../src/ingest/apply.js";
import type { Operation } from "../src/ingest/operations.js";
import { validateOperations } from "../src/ingest/validate.js";
import { addDays, localDate } from "../src/local-time.js";
import type { TaskItem } from "../src/types/task.js";
import { axisVector, insertEdge, insertMemory, insertTask, mockDwar, openTestDb, resetGraph, testConfig } from "./helpers.js";

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

async function tasksOn(payload: Record<string, unknown>): Promise<TaskItem[]> {
  const res = await call("POST", "/planner/tasks", payload);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().items;
}

async function writes(operations: Operation[]) {
  await validateOperations({ timeZone: config.env.timezone, db: handle.db, operations });
  return applyOperations({ db: handle.db, dwar: mockDwar({ dimension: dim }), operations, author: { source: "ingest", agentId: null }, config });
}

test("a day shows the tasks open on it, past due, open-ended, and done that day; later and finished ones stay out", async () => {
  await resetGraph(handle.sql);
  let axis = 0;
  const task = (args: Omit<Parameters<typeof insertTask>[1], "embedding">) => insertTask(handle.db, { embedding: axisVector(dim, axis++), ...args });
  await task({ title: "Open", opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  await task({ title: "Opens tomorrow", opensOn: "2026-11-13", closesAt: new Date("2099-01-02T04:59:00.000Z") });
  await task({ title: "Past due", opensOn: "2020-01-01", closesAt: new Date("2020-01-05T04:59:00.000Z") });
  await task({ title: "Open-ended", opensOn: "2026-11-01" });
  const doneAt = (id: string, at: string) =>
    handle.db.insert(nodeHistory).values({ id: randomUUID(), nodeId: id, field: "done", oldValue: "false", newValue: "true", changedAt: new Date(at), source: "manual" });
  await doneAt(await task({ title: "Done today", opensOn: "2026-11-01", closesAt: new Date("2026-11-30T04:59:00.000Z"), done: true }), "2026-11-12T15:00:00.000Z");
  await doneAt(await task({ title: "Done last month", opensOn: "2026-10-01", closesAt: new Date("2026-10-05T04:59:00.000Z"), done: true }), "2026-10-04T15:00:00.000Z");
  await task({ title: "Someday idea" });

  const items = await tasksOn({ on: "2026-11-12" });
  assert.deepEqual(items.map((item) => item.title), ["Past due", "Done today", "Open", "Open-ended"]);
  const byTitle = new Map(items.map((item) => [item.title, item]));
  assert.equal(byTitle.get("Past due")?.past_due, true);
  assert.equal(byTitle.get("Open")?.past_due, false);
  assert.equal(byTitle.get("Open-ended")?.closes_at, null);
  assert.equal(byTitle.get("Done today")?.done, true);
  assert.equal(byTitle.get("Open")?.done, false);

  assert.deepEqual((await tasksOn({ someday: true })).map((item) => item.title), ["Someday idea"]);
});

test("POST /tasks needs exactly one of on or someday", async () => {
  assert.equal((await call("POST", "/planner/tasks", {})).statusCode, 422);
  assert.equal((await call("POST", "/planner/tasks", { on: "2026-11-12", someday: true })).statusCode, 422);
  assert.equal((await call("POST", "/planner/tasks", { on: "tomorrow" })).statusCode, 422);
});

test("a task carries the course it hangs off", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "CSE 431", embedding: axisVector(dim, 0) });
  const hw = await insertTask(handle.db, { title: "HW5 Q5", embedding: axisVector(dim, 1), opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  await insertEdge(handle.db, { src: course, dst: hw, type: "HAS_ITEM" });
  const [item] = await tasksOn({ on: "2026-11-12" });
  assert.deepEqual(item?.hub, { id: course, title: "CSE 431" });
});

test("PUT /tasks/done sets and unsets done as a plain boolean with a manual history row; an unknown id is 404 and a memory is 422", async () => {
  await resetGraph(handle.sql);
  const id = await insertTask(handle.db, { title: "HW", embedding: axisVector(dim, 0), opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  const done = await call("PUT", "/planner/tasks/done", { task_id: id, done: true });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json(), { task_id: id, done: true });
  const [row] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, id));
  assert.equal(row?.done, true);
  assert.ok(row?.verifiedAt);
  await call("PUT", "/planner/tasks/done", { task_id: id, done: true });

  const undone = await call("PUT", "/planner/tasks/done", { task_id: id, done: false });
  assert.deepEqual(undone.json(), { task_id: id, done: false });
  const history = (await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id))).filter((entry) => entry.field === "done");
  assert.deepEqual(history.map((entry) => [entry.oldValue, entry.newValue, entry.source]).sort(), [["false", "true", "manual"], ["true", "false", "manual"]]);
  assert.equal((await call("PUT", "/planner/tasks/done", { task_id: "00000000-0000-4000-8000-000000000000", done: true })).statusCode, 404);
  const memory = await insertMemory(handle.db, { title: "A fact", embedding: axisVector(dim, 1) });
  const wrongKind = await call("PUT", "/planner/tasks/done", { task_id: memory, done: true });
  assert.equal(wrongKind.statusCode, 422);
  assert.equal(wrongKind.json().error.type, "invalid_request");
});

test("a task marked done today shows on today's day and is hidden the next day, and relevant_on leaves it out", async () => {
  await resetGraph(handle.sql);
  const id = await insertTask(handle.db, { title: "Old HW", embedding: axisVector(dim, 0), opensOn: "2020-01-01", closesAt: new Date("2020-01-05T04:59:00.000Z") });
  assert.equal((await tasksOn({ on: localDate(new Date(), config.env.timezone) })).length, 1);
  await call("PUT", "/planner/tasks/done", { task_id: id, done: true });
  const today = localDate(new Date(), config.env.timezone);
  assert.deepEqual((await tasksOn({ on: today })).map((item) => item.title), ["Old HW"]);
  assert.deepEqual(await tasksOn({ on: addDays(today, 1) }), []);
});

test("POST /tasks/verify stamps the tasks and their course hub, and refuses a node that is not a task", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "CSE 300", embedding: axisVector(dim, 0) });
  const hw = await insertTask(handle.db, { title: "HW4", embedding: axisVector(dim, 1), opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  await insertEdge(handle.db, { src: course, dst: hw, type: "HAS_ITEM" });
  const res = await call("POST", "/planner/tasks/verify", { node_ids: [hw] });
  assert.equal(res.statusCode, 200, res.body);
  const [task] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, hw));
  const [hub] = await handle.db.select().from(node).where(eq(node.id, course));
  assert.ok(task?.verifiedAt && hub?.verifiedAt);
  assert.equal((await call("POST", "/planner/tasks/verify", { node_ids: [course] })).statusCode, 422);
});

test("ingest creates a task with its window and rejects a close with no open, a close before its open, and a task with a time", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "CSE 431", embedding: axisVector(dim, 0) });
  const created = await writes([
    { op: "create_node", temp_id: "hw", kind: "task", title: "HW5 Q1-Q4", detail: { opens_on: "2026-11-11", closes_at: "2026-11-18T23:59:00-05:00" } },
    { op: "create_edge", src: course, dst: "hw", type: "HAS_ITEM", confidence: 1 },
  ]);
  const [row] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, created.temp_ids.hw ?? ""));
  assert.equal(row?.opensOn, "2026-11-11");
  assert.equal(row?.closesAt?.toISOString(), "2026-11-19T04:59:00.000Z");
  assert.equal(row?.done, false);

  const rejects = (detail: Record<string, unknown>, occurredAt?: string) =>
    assert.rejects(
      () =>
        validateOperations({
          timeZone: config.env.timezone,
          db: handle.db,
          operations: [{ op: "create_node", temp_id: "t", kind: "task", title: "T", ...(occurredAt ? { occurred_at: occurredAt } : {}), detail }],
        }),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 422,
    );
  await rejects({ closes_at: "2026-11-18T23:59:00-05:00" });
  await rejects({ opens_on: "2026-11-20", closes_at: "2026-11-18T23:59:00-05:00" });
  await rejects({ opens_on: "2026-11-11" }, "2026-11-12T15:00:00.000Z");
});

test("update_node sets a task's done and validates a changed window against the stored one", async () => {
  await resetGraph(handle.sql);
  const id = await insertTask(handle.db, { title: "Quiz 4", embedding: axisVector(dim, 0), opensOn: "2026-11-19", closesAt: new Date("2026-11-20T04:59:00.000Z") });
  await writes([{ op: "update_node", node_id: id, detail: { done: true } }]);
  const [row] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, id));
  assert.equal(row?.done, true);
  await assert.rejects(
    () => validateOperations({ timeZone: config.env.timezone, db: handle.db, operations: [{ op: "update_node", node_id: id, detail: { opens_on: "2026-11-25" } }] }),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 422,
  );
});

test("the transitional /tasks and /tasks/done aliases serve what the apps called before the planner rename", async () => {
  await resetGraph(handle.sql);
  const id = await insertTask(handle.db, { title: "HW", embedding: axisVector(dim, 0), opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  const read = await call("POST", "/tasks", { on: "2026-11-12" });
  assert.deepEqual((read.json().items as TaskItem[]).map((item) => item.id), [id]);
  const done = await call("PUT", "/tasks/done", { task_id: id, done: true });
  assert.deepEqual(done.json(), { task_id: id, done: true });
});
