import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { planDetail } from "../src/db/schema.js";
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

test("recurrence materializes instances; template excluded from date query", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  const start = new Date("2026-09-07T15:00:00.000Z"); // Monday
  const result = await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
    config,
    operations: [
      {
        op: "create_node",
        temp_id: "class",
        kind: "plan",
        title: "CS 101",
        occurred_at: start.toISOString(),
        detail: {
          status: "confirmed",
          recurrence: "FREQ=WEEKLY;BYDAY=MO;COUNT=4",
          end_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
        },
      },
    ],
  });
  const templateId = result.temp_ids.class;
  assert.ok(templateId);

  const templateDetail = await handle.db
    .select()
    .from(planDetail)
    .where(eq(planDetail.nodeId, templateId));
  assert.equal(templateDetail[0]?.recurrence, "FREQ=WEEKLY;BYDAY=MO;COUNT=4");
  assert.equal(templateDetail[0]?.seriesId, null);

  const instances = await handle.db
    .select()
    .from(planDetail)
    .where(eq(planDetail.seriesId, templateId));
  assert.equal(instances.length, 4);
  assert.ok(instances.every((row) => row.recurrence === null));

  const bounded = await query({
    occurred_from: "2026-09-07T00:00:00.000Z",
    occurred_to: "2026-09-30T23:59:59.000Z",
    kind: "plan",
  });
  assert.equal(bounded.statusCode, 200);
  const ids: string[] = bounded.json().nodes.map((n: { id: string }) => n.id);
  assert.ok(!ids.includes(templateId));
  assert.equal(ids.length, 4);
});

test("recurrence exceeding max_instances_per_series throws 422 and writes nothing", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  await assert.rejects(
    () =>
      applyOperations({
        db: handle.db,
        dwar,
        source: "ingest",
        config: {
          ...config,
          plan: {
            recurrence_horizon_days: 365,
            max_instances_per_series: 3,
          },
        },
        operations: [
          {
            op: "create_node",
            temp_id: "daily",
            kind: "plan",
            title: "standup",
            occurred_at: "2026-09-05T15:00:00.000Z",
            detail: {
              status: "confirmed",
              recurrence: "FREQ=DAILY",
            },
          },
        ],
      }),
    (err: unknown) => {
      assert.ok(err instanceof YaadError);
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /max_instances_per_series/);
      return true;
    },
  );
  const open = await handle.db.select().from(planDetail).where(isNull(planDetail.seriesId));
  assert.equal(open.length, 0);
  const nodes = await handle.sql`SELECT count(*)::int AS n FROM node`;
  assert.equal(nodes[0]?.n, 0);
});

test("place ingest with AT_LOCATION edge; GET /nodes/:id shows the edge", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  const result = await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
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
  const dwar = mockDwar({ dimension: dim });
  const result = await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
    config,
    operations: [
      {
        op: "create_node",
        temp_id: "class",
        kind: "plan",
        title: "CSE 380",
        occurred_at: "2026-10-27T10:20:00-04:00",
        detail: {
          status: "confirmed",
          recurrence: "FREQ=WEEKLY;BYDAY=TU;COUNT=2",
          end_at: "2026-10-27T11:40:00-04:00",
        },
      },
    ],
  });
  const templateId = result.temp_ids.class;
  assert.ok(templateId);

  const instances = await handle.sql<{ occurred_at: string; end_at: string }[]>`
    SELECT n.occurred_at, d.end_at FROM plan_detail d JOIN node n ON n.id = d.node_id
    WHERE d.series_id = ${templateId} ORDER BY n.occurred_at`;
  assert.deepEqual(
    instances.map((row) => new Date(row.occurred_at).toISOString()),
    ["2026-10-27T14:20:00.000Z", "2026-11-03T15:20:00.000Z"],
  );
  assert.deepEqual(
    instances.map((row) => new Date(row.end_at).toISOString()),
    ["2026-10-27T15:40:00.000Z", "2026-11-03T16:40:00.000Z"],
  );
});

test("update_node that changes a plan schedule rematerializes its series", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  const created = await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
    config,
    operations: [
      {
        op: "create_node",
        temp_id: "class",
        kind: "plan",
        title: "CSE 380",
        detail: { status: "confirmed" },
      },
    ],
  });
  const templateId = created.temp_ids.class;
  assert.ok(templateId);

  async function currentInstanceCount(): Promise<number> {
    const rows = await handle.db
      .select()
      .from(planDetail)
      .where(eq(planDetail.seriesId, templateId as string));
    return rows.length;
  }
  assert.equal(await currentInstanceCount(), 0);

  async function update(detail: Record<string, unknown>, occurredAt?: string) {
    await applyOperations({
      db: handle.db,
      dwar,
      source: "ingest",
      config,
      operations: [
        {
          op: "update_node",
          node_id: templateId as string,
          ...(occurredAt !== undefined ? { occurred_at: occurredAt } : {}),
          detail,
        },
      ],
    });
  }

  await update(
    { recurrence: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4", end_at: "2026-08-31T16:20:00-04:00" },
    "2026-08-31T15:00:00-04:00",
  );
  assert.equal(await currentInstanceCount(), 4);

  await update({ recurrence: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2" });
  assert.equal(await currentInstanceCount(), 2);

  await update({ recurrence: null });
  assert.equal(await currentInstanceCount(), 0);

  const deleted = await handle.sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM node_history WHERE field = 'deleted'`;
  assert.equal(deleted[0]?.count, "6");
});
