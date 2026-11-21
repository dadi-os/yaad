import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { applyOperations } from "../src/ingest/apply.js";
import {
  axisVector,
  insertMemory,
  insertPerson,
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

async function query(payload: Record<string, unknown>) {
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });
  const res = await app.inject({
    method: "POST",
    url: "/query",
    payload,
  });
  await app.close();
  return res;
}

test("query overlap: multi-day plan appears when range intersects the middle", async () => {
  await resetGraph(handle.sql);
  const id = await insertPlan(handle.db, {
    title: "trip",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-11-03T12:00:00.000Z"),
    endAt: new Date("2026-11-08T12:00:00.000Z"),
  });
  const res = await query({
    occurred_from: "2026-11-05T00:00:00.000Z",
    occurred_to: "2026-11-06T23:59:59.000Z",
  });
  assert.equal(res.statusCode, 200);
  const ids = res.json().nodes.map((n: { id: string }) => n.id);
  assert.deepEqual(ids, [id]);
});

test("query instantaneous: null end_at only matches when occurred_at is in range", async () => {
  await resetGraph(handle.sql);
  const inside = await insertPlan(handle.db, {
    title: "lunch",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-11-05T12:00:00.000Z"),
    endAt: null,
  });
  await insertPlan(handle.db, {
    title: "dinner yesterday",
    embedding: axisVector(dim, 1),
    occurredAt: new Date("2026-11-04T12:00:00.000Z"),
    endAt: null,
  });
  const res = await query({
    occurred_from: "2026-11-05T00:00:00.000Z",
    occurred_to: "2026-11-05T23:59:59.000Z",
  });
  assert.equal(res.statusCode, 200);
  const ids = res.json().nodes.map((n: { id: string }) => n.id);
  assert.deepEqual(ids, [inside]);
});

test("query undated: excluded with date bound, included without", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, { title: "someday trip", embedding: axisVector(dim, 0), occurredAt: null });

  const bounded = await query({
    kind: "memory",
    occurred_from: "2026-11-05T00:00:00.000Z",
    occurred_to: "2026-11-06T00:00:00.000Z",
  });
  assert.equal(bounded.statusCode, 200);
  assert.equal(bounded.json().nodes.length, 0);

  const open = await query({ kind: "memory" });
  assert.equal(open.statusCode, 200);
  assert.deepEqual(
    open.json().nodes.map((n: { id: string }) => n.id),
    [id],
  );
});

test("query relevant_on lists the tasks not done whose open day has come, and rejects a non-task kind", async () => {
  await resetGraph(handle.sql);
  const open = await insertTask(handle.db, { title: "HW 3", embedding: axisVector(dim, 0), opensOn: "2026-11-10", closesAt: new Date("2026-11-14T04:59:00.000Z") });
  await insertTask(handle.db, { title: "HW 4", embedding: axisVector(dim, 1), opensOn: "2026-11-13", closesAt: new Date("2026-11-20T04:59:00.000Z") });
  await insertTask(handle.db, { title: "HW 2", embedding: axisVector(dim, 2), opensOn: "2026-11-01", closesAt: new Date("2026-11-05T04:59:00.000Z"), done: true });
  const res = await query({ relevant_on: "2026-11-12" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().nodes.map((n: { id: string }) => n.id), [open]);
  assert.equal((await query({ relevant_on: "2026-11-12", kind: "plan" })).statusCode, 422);
});

test("query name: exact title and alias hit case-insensitively; substring does not", async () => {
  await resetGraph(handle.sql);
  const byTitle = await insertPerson(handle.db, {
    title: "Marcus",
    embedding: axisVector(dim, 0),
  });
  const byAlias = await insertPerson(handle.db, {
    title: "M. Chen",
    embedding: axisVector(dim, 1),
    aliases: ["marc"],
  });
  await insertPerson(handle.db, {
    title: "Marcia",
    embedding: axisVector(dim, 2),
  });

  const titleHit = await query({ name: "marcus" });
  assert.equal(titleHit.statusCode, 200);
  assert.deepEqual(
    titleHit.json().nodes.map((n: { id: string }) => n.id),
    [byTitle],
  );

  const aliasHit = await query({ name: "MARC" });
  assert.equal(aliasHit.statusCode, 200);
  assert.deepEqual(
    aliasHit.json().nodes.map((n: { id: string }) => n.id),
    [byAlias],
  );

  const partial = await query({ name: "Mar" });
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.json().nodes.length, 0);
});

test("query empty body is 422", async () => {
  await resetGraph(handle.sql);
  const res = await query({});
  assert.equal(res.statusCode, 422);
});

test("query rejects the removed status filter", async () => {
  await resetGraph(handle.sql);
  const res = await query({ kind: "plan", status: "confirmed" });
  assert.equal(res.statusCode, 422);
});

test("place ingest with AT_LOCATION edge; GET /nodes/:id shows the edge", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  const result = await applyOperations({
    db: handle.db,
    dwar,
    author: { source: "agent", agentId: "test-agent" },
    config,
    operations: [
      {
        op: "create_node",
        temp_id: "cafe",
        kind: "place",
        title: "coffee shop on Grand River",
        detail: {},
      },
      {
        op: "create_node",
        temp_id: "meet",
        kind: "plan",
        title: "coffee with Vedant",
        occurred_at: "2026-09-05T18:00:00.000Z",
        detail: { rsvp: "yes" },
      },
      {
        op: "create_edge",
        src: "meet",
        dst: "cafe",
        type: "AT_LOCATION",
        confidence: 1,
      },
    ],
  });
  const planId = result.temp_ids.meet;
  assert.ok(planId);

  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
  });
  const res = await app.inject({ method: "GET", url: `/nodes/${planId}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.kind, "plan");
  assert.equal(body.edges.outgoing.length, 1);
  assert.equal(body.edges.outgoing[0].type, "AT_LOCATION");
  assert.equal(body.edges.outgoing[0].dst_id, result.temp_ids.cafe);
  await app.close();
});

test("GET /counts counts live nodes of each kind and the total, leaving out expired ones", async () => {
  await resetGraph(handle.sql);
  await insertPerson(handle.db, { title: "Riya", embedding: axisVector(dim, 0) });
  await insertMemory(handle.db, { title: "A fact", embedding: axisVector(dim, 1) });
  await insertMemory(handle.db, { title: "Old fact", embedding: axisVector(dim, 2), expiresAt: new Date(Date.now() - 1000) });
  await insertPlan(handle.db, { title: "Dinner", embedding: axisVector(dim, 3), occurredAt: new Date("2026-10-21T22:00:00.000Z") });
  await insertTask(handle.db, { title: "HW", embedding: axisVector(dim, 4) });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const res = await app.inject({ method: "GET", url: "/counts" });
  await app.close();
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { total: 4, kinds: { person: 1, memory: 1, place: 0, plan: 1, task: 1 } });
});
