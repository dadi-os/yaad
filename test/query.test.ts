import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { YaadError } from "../src/errors.js";
import { applyOperations } from "../src/ingest/apply.js";
import {
  axisVector,
  insertPerson,
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
  const id = await insertPlan(handle.db, {
    title: "someday trip",
    embedding: axisVector(dim, 0),
    occurredAt: null,
    status: "idea",
  });

  const bounded = await query({
    kind: "plan",
    occurred_from: "2026-11-05T00:00:00.000Z",
    occurred_to: "2026-11-06T00:00:00.000Z",
  });
  assert.equal(bounded.statusCode, 200);
  assert.equal(bounded.json().nodes.length, 0);

  const open = await query({ kind: "plan", status: "idea" });
  assert.equal(open.statusCode, 200);
  assert.deepEqual(
    open.json().nodes.map((n: { id: string }) => n.id),
    [id],
  );
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

test("query status with conflicting kind is 422", async () => {
  await resetGraph(handle.sql);
  const res = await query({ kind: "person", status: "confirmed" });
  assert.equal(res.statusCode, 422);
});

async function createClass(detail: Record<string, unknown>, occurredAt?: string): Promise<string> {
  const result = await applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    author: { source: "ingest", agentId: null },
    config,
    operations: [
      {
        op: "create_node",
        temp_id: "class",
        kind: "plan",
        title: "CS 101",
        ...(occurredAt !== undefined ? { occurred_at: occurredAt } : {}),
        detail: { status: "confirmed", ...detail },
      },
    ],
  });
  const id = result.temp_ids.class;
  assert.ok(id);
  return id;
}

type QueriedNode = { id: string; occurred_at: string; detail: { end_at: string | null; series_id: string | null } };

test("a recurring plan is stored once and a date range lists each occurrence", async () => {
  await resetGraph(handle.sql);
  const templateId = await createClass(
    { recurrence: "FREQ=WEEKLY;BYDAY=MO;COUNT=4", end_at: "2026-09-07T16:30:00.000Z" },
    "2026-09-07T15:00:00.000Z",
  );

  const plans = await handle.sql`SELECT count(*)::int AS n FROM plan_detail`;
  assert.equal(plans[0]?.n, 1);

  const bounded = await query({
    occurred_from: "2026-09-07T00:00:00.000Z",
    occurred_to: "2026-09-30T23:59:59.000Z",
    kind: "plan",
  });
  assert.equal(bounded.statusCode, 200);
  const nodes: QueriedNode[] = bounded.json().nodes;
  assert.deepEqual(
    nodes.map((n) => n.occurred_at),
    ["2026-09-07T15:00:00.000Z", "2026-09-14T15:00:00.000Z", "2026-09-21T15:00:00.000Z", "2026-09-28T15:00:00.000Z"],
  );
  assert.ok(nodes.every((n) => n.id === templateId && n.detail.series_id === templateId));
  assert.equal(nodes[1]?.detail.end_at, "2026-09-14T16:30:00.000Z");

  const midClass = await query({
    occurred_from: "2026-09-14T16:00:00.000Z",
    occurred_to: "2026-09-20T00:00:00.000Z",
  });
  assert.deepEqual(
    midClass.json().nodes.map((n: QueriedNode) => n.occurred_at),
    ["2026-09-14T15:00:00.000Z"],
  );

  const undated = await query({ kind: "plan" });
  const listed: QueriedNode[] = undated.json().nodes;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.detail.series_id, null);
});

test("a date range holding more occurrences than max_instances_per_series is 422", async () => {
  await resetGraph(handle.sql);
  await createClass({ recurrence: "FREQ=DAILY" }, "2026-09-05T15:00:00.000Z");
  const app = await buildApp(
    { ...config, plan: { recurrence_horizon_days: 365, max_instances_per_series: 3 } },
    { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) },
  );
  const res = await app.inject({
    method: "POST",
    url: "/query",
    payload: { occurred_from: "2026-09-05T00:00:00.000Z", occurred_to: "2026-09-15T00:00:00.000Z" },
  });
  await app.close();
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error.message, /narrow the date range/);
});

test("a recurring plan with an invalid rule or no start is rejected and writes nothing", async () => {
  await resetGraph(handle.sql);
  for (const attempt of [
    () => createClass({ recurrence: "FREQ=NEVER" }, "2026-09-05T15:00:00.000Z"),
    () => createClass({ recurrence: "FREQ=WEEKLY;BYDAY=MO" }),
  ]) {
    await assert.rejects(attempt, (err: unknown) => {
      assert.ok(err instanceof YaadError);
      assert.equal(err.statusCode, 422);
      return true;
    });
  }
  const nodes = await handle.sql`SELECT count(*)::int AS n FROM node`;
  assert.equal(nodes[0]?.n, 0);
});

test("place ingest with AT_LOCATION edge; GET /nodes/:id shows the edge", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  const result = await applyOperations({
    db: handle.db,
    dwar,
    author: { source: "ingest", agentId: null },
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
        detail: { status: "confirmed" },
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

test("recurrence keeps local wall-clock time across a daylight-saving change", async () => {
  await resetGraph(handle.sql);
  await createClass(
    { recurrence: "FREQ=WEEKLY;BYDAY=TU;COUNT=2", end_at: "2026-10-27T11:40:00-04:00" },
    "2026-10-27T10:20:00-04:00",
  );
  const res = await query({ occurred_from: "2026-10-26T00:00:00.000Z", occurred_to: "2026-11-10T00:00:00.000Z" });
  const nodes: QueriedNode[] = res.json().nodes;
  assert.deepEqual(
    nodes.map((n) => n.occurred_at),
    ["2026-10-27T14:20:00.000Z", "2026-11-03T15:20:00.000Z"],
  );
  assert.deepEqual(
    nodes.map((n) => n.detail.end_at),
    ["2026-10-27T15:40:00.000Z", "2026-11-03T16:40:00.000Z"],
  );
});

test("update_node that changes a plan schedule changes the occurrences a date range lists", async () => {
  await resetGraph(handle.sql);
  const templateId = await createClass({});

  async function update(detail: Record<string, unknown>, occurredAt?: string) {
    await applyOperations({
      db: handle.db,
      dwar: mockDwar({ dimension: dim }),
      author: { source: "ingest", agentId: null },
      config,
      operations: [
        {
          op: "update_node",
          node_id: templateId,
          ...(occurredAt !== undefined ? { occurred_at: occurredAt } : {}),
          detail,
        },
      ],
    });
  }
  async function listed(): Promise<QueriedNode[]> {
    const res = await query({ occurred_from: "2026-08-30T00:00:00.000Z", occurred_to: "2026-09-30T00:00:00.000Z" });
    return res.json().nodes;
  }

  await update(
    { recurrence: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", end_at: "2026-08-31T16:20:00-04:00" },
    "2026-08-31T15:00:00-04:00",
  );
  assert.equal((await listed()).length, 4);

  await update({ recurrence: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2" });
  assert.equal((await listed()).length, 2);

  await update({ recurrence: null });
  const single = await listed();
  assert.equal(single.length, 1);
  assert.equal(single[0]?.detail.series_id, null);

  await assert.rejects(() => update({ recurrence: "FREQ=NEVER" }), (err: unknown) => {
    assert.ok(err instanceof YaadError);
    assert.equal(err.statusCode, 422);
    return true;
  });
});
