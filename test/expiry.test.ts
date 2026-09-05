import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { node } from "../src/db/schema.js";
import { YaadError } from "../src/errors.js";
import { applyOperations } from "../src/ingest/apply.js";
import { assembleCandidates } from "../src/ingest/candidates.js";
import { computeExpiresAt } from "../src/ingest/expiry.js";
import { validateOperations } from "../src/ingest/validate.js";
import { operationSchema, type Operation } from "../src/ingest/operations.js";
import { recall } from "../src/recall/pipeline.js";
import type { DwarChatResponse, DwarClient } from "../src/dwar/client.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
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

test("computeExpiresAt anchors and crosses a month boundary", () => {
  const withOccurred = computeExpiresAt(new Date("2026-01-15T12:00:00.000Z"), 31);
  assert.equal(withOccurred.toISOString(), "2026-02-15T12:00:00.000Z");

  const fromCreated = computeExpiresAt(new Date("2026-03-01T00:00:00.000Z"), 1);
  assert.equal(fromCreated.toISOString(), "2026-03-02T00:00:00.000Z");
});

test("create_node with ttl_days sets expires_at; without it stays null", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  const occurred = "2026-09-01T12:00:00.000Z";
  const result = await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
    config,
    operations: [
      {
        op: "create_node",
        temp_id: "hood",
        kind: "memory",
        title: "black hoodie",
        occurred_at: occurred,
        ttl_days: 3,
      },
      {
        op: "create_node",
        temp_id: "color",
        kind: "memory",
        title: "favorite color is green",
      },
    ],
  });
  const hood = await handle.db.select().from(node).where(eq(node.id, result.temp_ids.hood!));
  const color = await handle.db.select().from(node).where(eq(node.id, result.temp_ids.color!));
  assert.equal(hood[0]?.expiresAt?.toISOString(), computeExpiresAt(new Date(occurred), 3).toISOString());
  assert.equal(color[0]?.expiresAt, null);
});

test("ttl_days on person or place is 422 and writes nothing", async () => {
  await resetGraph(handle.sql);
  for (const kind of ["person", "place"] as const) {
    const operations: Operation[] = [
      {
        op: "create_node",
        temp_id: "x",
        kind,
        title: "entity",
        ttl_days: 3,
        detail: {},
      },
    ];
    await assert.rejects(
      () => validateOperations({ db: handle.db, operations }),
      (err: unknown) => {
        assert.ok(err instanceof YaadError);
        assert.equal(err.statusCode, 422);
        assert.match(err.message, /ttl_days is only valid on memory and plan/);
        return true;
      },
    );
  }
  const count = await handle.sql`SELECT count(*)::int AS n FROM node`;
  assert.equal(count[0]?.n, 0);
});

test("ttl_days zero or negative fails validation", () => {
  for (const ttl_days of [0, -1]) {
    const parsed = operationSchema.safeParse({
      op: "create_node",
      temp_id: "x",
      kind: "memory",
      title: "bad",
      ttl_days,
    });
    assert.equal(parsed.success, false);
  }
});

test("expired node is not an anchor and is absent from recall results", async () => {
  await resetGraph(handle.sql);
  const past = new Date(Date.now() - 86_400_000);
  await insertMemory(handle.db, {
    title: "old hoodie",
    embedding: axisVector(dim, 0),
    expiresAt: past,
  });
  const result = await recall({
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim, embedAxis: 0 }),
    config: {
      ...config,
      recall: { ...config.recall, anchor_similarity_floor: 0.1 },
    },
    query: "hoodie",
    limit: 20,
    debug: false,
  });
  assert.deepEqual(result.anchors, []);
  assert.equal(result.nodes.length, 0);
});

test("expired node is not a bridge in graph expansion", async () => {
  await resetGraph(handle.sql);
  const past = new Date(Date.now() - 86_400_000);
  const a = await insertMemory(handle.db, {
    title: "anchor live",
    embedding: axisVector(dim, 0),
  });
  const b = await insertMemory(handle.db, {
    title: "expired middle",
    embedding: axisVector(dim, 1),
    expiresAt: past,
  });
  const c = await insertMemory(handle.db, {
    title: "beyond bridge",
    embedding: axisVector(dim, 2),
  });
  await insertEdge(handle.db, { src: a, dst: b, type: "RELATED_TO" });
  await insertEdge(handle.db, { src: b, dst: c, type: "RELATED_TO" });

  const result = await recall({
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim, embedAxis: 0 }),
    config: {
      ...config,
      recall: {
        ...config.recall,
        anchor_similarity_floor: 0.5,
        hop_cap: 4,
        relevance_threshold: 0.01,
        marginal_yield_minimum: 1,
        token_budget: 100_000,
      },
    },
    query: "anchor",
    limit: 20,
    debug: false,
  });
  const ids = result.nodes.map((n) => n.id);
  assert.ok(ids.includes(a));
  assert.equal(ids.includes(b), false);
  assert.equal(ids.includes(c), false);
});

test("expired node is excluded from ingest candidate payload", async () => {
  await resetGraph(handle.sql);
  const past = new Date(Date.now() - 86_400_000);
  const expiredId = await insertMemory(handle.db, {
    title: "stale observation",
    embedding: axisVector(dim, 0),
    expiresAt: past,
  });
  const liveId = await insertMemory(handle.db, {
    title: "fresh fact",
    embedding: axisVector(dim, 0),
  });

  let capturedCandidates: unknown;
  const dwar: DwarClient = {
    async embed(texts) {
      return texts.map(() => axisVector(dim, 0));
    },
    async reason(opts): Promise<DwarChatResponse> {
      capturedCandidates = JSON.parse(opts.user).candidates;
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "emit_operations",
            input: { operations: [{ op: "noop", reason: "check" }] },
          },
        ],
      };
    },
  };

  const { ingest } = await import("../src/ingest/pipeline.js");
  await ingest({
    db: handle.db,
    sql: handle.sql,
    dwar,
    config,
    text: "stale observation fresh fact",
    occurredAt: "2026-09-05T12:00:00.000Z",
    participantIds: [],
    source: "agent",
  });

  const candidateIds = (capturedCandidates as { nodes: Array<{ id: string }> }).nodes.map(
    (n) => n.id,
  );
  assert.equal(candidateIds.includes(expiredId), false);
  assert.ok(candidateIds.includes(liveId));
});

test("POST /query excludes expired nodes", async () => {
  await resetGraph(handle.sql);
  const past = new Date(Date.now() - 86_400_000);
  const live = await insertMemory(handle.db, {
    title: "live memory",
    embedding: axisVector(dim, 0),
  });
  await insertMemory(handle.db, {
    title: "dead memory",
    embedding: axisVector(dim, 1),
    expiresAt: past,
  });

  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });
  const res = await app.inject({
    method: "POST",
    url: "/query",
    payload: { kind: "memory" },
  });
  assert.equal(res.statusCode, 200);
  const ids = res.json().nodes.map((n: { id: string }) => n.id);
  assert.deepEqual(ids, [live]);
  await app.close();
});

test("GET /nodes/:id returns expired node with expires_at", async () => {
  await resetGraph(handle.sql);
  const past = new Date("2020-01-01T00:00:00.000Z");
  const id = await insertMemory(handle.db, {
    title: "expired but fetchable",
    embedding: axisVector(dim, 0),
    expiresAt: past,
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });
  const res = await app.inject({ method: "GET", url: `/nodes/${id}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().expires_at, past.toISOString());
  await app.close();
});

test("update_node ttl_days refreshes, null clears, omit leaves untouched", async () => {
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
        temp_id: "m",
        kind: "memory",
        title: "hoodie",
        occurred_at: "2026-09-01T12:00:00.000Z",
        ttl_days: 3,
      },
    ],
  });
  const id = created.temp_ids.m!;
  const before = (await handle.db.select().from(node).where(eq(node.id, id)))[0]!;
  assert.ok(before.expiresAt);

  const beforeRefresh = Date.now();
  await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
    config,
    operations: [{ op: "update_node", node_id: id, ttl_days: 7 }],
  });
  const refreshed = (await handle.db.select().from(node).where(eq(node.id, id)))[0]!;
  assert.ok(refreshed.expiresAt);
  assert.ok(refreshed.expiresAt!.getTime() > before.expiresAt!.getTime());
  assert.ok(refreshed.expiresAt!.getTime() >= beforeRefresh + 7 * 86_400_000 - 5_000);

  await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
    config,
    operations: [{ op: "update_node", node_id: id, title: "hoodie again" }],
  });
  const unchanged = (await handle.db.select().from(node).where(eq(node.id, id)))[0]!;
  assert.equal(unchanged.expiresAt?.toISOString(), refreshed.expiresAt?.toISOString());

  await applyOperations({
    db: handle.db,
    dwar,
    source: "ingest",
    config,
    operations: [{ op: "update_node", node_id: id, ttl_days: null }],
  });
  const cleared = (await handle.db.select().from(node).where(eq(node.id, id)))[0]!;
  assert.equal(cleared.expiresAt, null);
});

test("history/search still finds corrections for a node that later expired", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, {
    title: "favorite color is blue",
    embedding: axisVector(dim, 0),
  });
  const dwar = mockDwar({
    dimension: dim,
    embedByText: [
      { match: "→", axis: 7 },
      { match: "color disparity", axis: 7 },
    ],
  });
  await applyOperations({
    db: handle.db,
    dwar,
    source: "agent",
    config,
    operations: [{ op: "update_node", node_id: id, title: "favorite color is green" }],
  });
  await handle.db
    .update(node)
    .set({ expiresAt: new Date(Date.now() - 86_400_000) })
    .where(eq(node.id, id));

  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
  });
  const search = await app.inject({
    method: "POST",
    url: "/history/search",
    payload: { query: "color disparity" },
  });
  assert.equal(search.statusCode, 200);
  assert.ok(search.json().results.some((r: { node_id: string }) => r.node_id === id));
  await app.close();
});

test("assembleCandidates rejects expired participant_ids with 422", async () => {
  await resetGraph(handle.sql);
  const past = new Date(Date.now() - 86_400_000);
  const id = await insertMemory(handle.db, {
    title: "expired participant",
    embedding: axisVector(dim, 0),
    expiresAt: past,
  });
  await assert.rejects(
    () =>
      assembleCandidates({
        db: handle.db,
        sql: handle.sql,
        config,
        text: "hello",
        embedding: axisVector(dim, 0),
        participantIds: [id],
      }),
    (err: unknown) => {
      assert.ok(err instanceof YaadError);
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /has expired/);
      return true;
    },
  );
});
