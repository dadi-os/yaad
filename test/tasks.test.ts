import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { taskDetail } from "../src/db/schema.js";
import { applyOperations } from "../src/ingest/apply.js";
import type { Operation } from "../src/ingest/operations.js";
import { validateOperations } from "../src/ingest/validate.js";
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
  const res = await call("POST", "/tasks", payload);
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
  await task({ title: "Done today", opensOn: "2026-11-01", closesAt: new Date("2026-11-30T04:59:00.000Z"), doneAt: new Date("2026-11-12T15:00:00.000Z") });
  await task({ title: "Done last month", opensOn: "2026-10-01", closesAt: new Date("2026-10-05T04:59:00.000Z"), doneAt: new Date("2026-10-04T15:00:00.000Z") });
  await task({ title: "Someday idea" });

  const items = await tasksOn({ on: "2026-11-12" });
  assert.deepEqual(items.map((item) => item.title), ["Past due", "Done today", "Open", "Open-ended"]);
  const byTitle = new Map(items.map((item) => [item.title, item]));
  assert.equal(byTitle.get("Past due")?.past_due, true);
  assert.equal(byTitle.get("Open")?.past_due, false);
  assert.equal(byTitle.get("Open-ended")?.closes_at, null);
  assert.ok(byTitle.get("Done today")?.done_at);

  assert.deepEqual((await tasksOn({ someday: true })).map((item) => item.title), ["Someday idea"]);
});

test("POST /tasks needs exactly one of on or someday", async () => {
  assert.equal((await call("POST", "/tasks", {})).statusCode, 422);
  assert.equal((await call("POST", "/tasks", { on: "2026-11-12", someday: true })).statusCode, 422);
  assert.equal((await call("POST", "/tasks", { on: "tomorrow" })).statusCode, 422);
});

test("a task carries the course it hangs off", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "CSE 431", embedding: axisVector(dim, 0) });
  const hw = await insertTask(handle.db, { title: "HW5 Q5", embedding: axisVector(dim, 1), opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  await insertEdge(handle.db, { src: course, dst: hw, type: "HAS_ITEM" });
  const [item] = await tasksOn({ on: "2026-11-12" });
  assert.deepEqual(item?.hub, { id: course, title: "CSE 431" });
});

test("PUT /tasks/done ticks a task and takes the tick back; an unknown id is 404 and a plan is 422", async () => {
  await resetGraph(handle.sql);
  const id = await insertTask(handle.db, { title: "HW", embedding: axisVector(dim, 0), opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  const ticked = await call("PUT", "/tasks/done", { task_id: id, done: true });
  assert.equal(ticked.statusCode, 200, ticked.body);
  assert.ok(ticked.json().done_at);
  const [row] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, id));
  assert.ok(row?.doneAt);

  const cleared = await call("PUT", "/tasks/done", { task_id: id, done: false });
  assert.equal(cleared.json().done_at, null);
  assert.equal((await call("PUT", "/tasks/done", { task_id: "00000000-0000-4000-8000-000000000000", done: true })).statusCode, 404);
  const memory = await insertMemory(handle.db, { title: "A fact", embedding: axisVector(dim, 1) });
  const wrongKind = await call("PUT", "/tasks/done", { task_id: memory, done: true });
  assert.equal(wrongKind.statusCode, 422);
  assert.equal(wrongKind.json().error.type, "invalid_request");
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
  assert.equal(row?.doneAt, null);

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

test("update_node ticks a task through done_at and validates a changed window against the stored one", async () => {
  await resetGraph(handle.sql);
  const id = await insertTask(handle.db, { title: "Quiz 4", embedding: axisVector(dim, 0), opensOn: "2026-11-19", closesAt: new Date("2026-11-20T04:59:00.000Z") });
  await writes([{ op: "update_node", node_id: id, detail: { done_at: "2026-11-19T20:00:00.000Z" } }]);
  const [row] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, id));
  assert.equal(row?.doneAt?.toISOString(), "2026-11-19T20:00:00.000Z");
  await assert.rejects(
    () => validateOperations({ timeZone: config.env.timezone, db: handle.db, operations: [{ op: "update_node", node_id: id, detail: { opens_on: "2026-11-25" } }] }),
    (err: unknown) => (err as { statusCode?: number }).statusCode === 422,
  );
});

test("recall filtered by relevant_on anchors on the tasks relevant that day", async () => {
  await resetGraph(handle.sql);
  const open = await insertTask(handle.db, { title: "HW 3", embedding: axisVector(dim, 0), opensOn: "2026-11-10", closesAt: new Date("2099-01-01T04:59:00.000Z") });
  await insertTask(handle.db, { title: "HW 4", embedding: axisVector(dim, 1), opensOn: "2026-11-20", closesAt: new Date("2099-01-02T04:59:00.000Z") });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const res = await app.inject({ method: "POST", url: "/recall", payload: { relevant_on: "2026-11-12" } });
  await app.close();
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().nodes.map((n: { id: string }) => n.id), [open]);
});
