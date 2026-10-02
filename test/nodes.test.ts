import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { edge, node, nodeHistory } from "../src/db/schema.js";
import { applyOperations } from "../src/ingest/apply.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
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

test("update_node title writes one node_history row; unchanged fields write none", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, {
    title: "blue dresser",
    embedding: axisVector(dim, 0),
  });
  const dwar = mockDwar({ dimension: dim });

  await applyOperations({
    db: handle.db,
    dwar,
    author: { source: "agent", agentId: "test-agent" },
    config,
    operations: [{ op: "update_node", node_id: id, title: "green dresser" }],
  });

  const rows = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.field, "title");
  assert.equal(rows[0]?.oldValue, "blue dresser");
  assert.equal(rows[0]?.newValue, "green dresser");

  await applyOperations({
    db: handle.db,
    dwar,
    author: { source: "agent", agentId: "test-agent" },
    config,
    operations: [{ op: "update_node", node_id: id, title: "green dresser" }],
  });
  const afterNoop = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id));
  assert.equal(afterNoop.length, 1);
});

test("close_node writes a deleted history row and closes incident edges", async () => {
  await resetGraph(handle.sql);
  const a = await insertMemory(handle.db, { title: "keep", embedding: axisVector(dim, 0) });
  const b = await insertMemory(handle.db, { title: "gone", embedding: axisVector(dim, 1) });
  const edgeId = await insertEdge(handle.db, { src: a, dst: b, type: "RELATED" });

  const dwar = mockDwar({ dimension: dim });
  await applyOperations({
    db: handle.db,
    dwar,
    author: { source: "agent", agentId: "test-agent" },
    config,
    operations: [{ op: "close_node", node_id: b, reason: "retracted", evidence: "forget that" }],
  });

  const history = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, b));
  assert.equal(history.length, 1);
  assert.equal(history[0]?.field, "deleted");
  assert.equal(history[0]?.oldValue, "gone");
  assert.equal(history[0]?.newValue, null);

  const edges = await handle.db.select().from(edge).where(eq(edge.id, edgeId));
  assert.equal(edges.length, 1);
  assert.ok(edges[0]?.validTo);
  const open = await handle.db.select().from(edge).where(isNull(edge.validTo));
  assert.equal(open.length, 0);

  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
  });
  const histRes = await app.inject({ method: "GET", url: `/nodes/${b}/history` });
  assert.equal(histRes.statusCode, 200);
  assert.equal(histRes.json().history.length, 1);
  assert.equal(histRes.json().history[0].field, "deleted");
  await app.close();
});

test("POST /history/search finds a correction by meaning", async () => {
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
      { match: "favorite color", axis: 0 },
    ],
  });

  await applyOperations({
    db: handle.db,
    dwar,
    author: { source: "agent", agentId: "test-agent" },
    config,
    operations: [{ op: "update_node", node_id: id, title: "favorite color is green" }],
  });

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
  const results = search.json().results;
  assert.ok(results.length >= 1);
  assert.equal(results[0].node_id, id);
  assert.equal(results[0].field, "title");
  assert.equal(results[0].old_value, "favorite color is blue");
  assert.equal(results[0].new_value, "favorite color is green");

  await app.close();
});

test("PATCH /nodes/:id edits a plan's title and status and records history", async () => {
  await resetGraph(handle.sql);
  const id = await insertPlan(handle.db, {
    title: "lunch with Riya",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-10-03T17:00:00.000Z"),
    status: "tentative",
  });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });

  const res = await app.inject({
    method: "PATCH",
    url: `/nodes/${id}`,
    payload: { title: "lunch with Riya at Sultan's", detail: { status: "confirmed" } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().title, "lunch with Riya at Sultan's");
  assert.equal(res.json().detail.status, "confirmed");
  const history = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id));
  assert.deepEqual(history.map((row) => row.field), ["title"]);
  await app.close();
});

test("PATCH /nodes/:id rejects an empty body, detail on a memory, and an unknown id", async () => {
  await resetGraph(handle.sql);
  const memory = await insertMemory(handle.db, { title: "likes chai", embedding: axisVector(dim, 0) });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });

  const empty = await app.inject({ method: "PATCH", url: `/nodes/${memory}`, payload: {} });
  assert.equal(empty.statusCode, 422);
  assert.equal(empty.json().error.type, "invalid_request");

  const detail = await app.inject({
    method: "PATCH",
    url: `/nodes/${memory}`,
    payload: { detail: { status: "confirmed" } },
  });
  assert.equal(detail.statusCode, 422);

  const missing = await app.inject({
    method: "PATCH",
    url: "/nodes/00000000-0000-4000-8000-000000000000",
    payload: { title: "ghost" },
  });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test("DELETE /nodes/:id sweeps neighbors it strands but keeps linked nodes and dated plans", async () => {
  await resetGraph(handle.sql);
  const hub = await insertPlan(handle.db, {
    title: "CSE 380",
    embedding: axisVector(dim, 0),
    occurredAt: null,
  });
  const facet = await insertMemory(handle.db, { title: "CSE 380 uses AWS", embedding: axisVector(dim, 1) });
  const person = await insertPerson(handle.db, { title: "Riya", embedding: axisVector(dim, 2) });
  const friend = await insertPerson(handle.db, { title: "Ankur", embedding: axisVector(dim, 3) });
  const exam = await insertPlan(handle.db, {
    title: "CSE 380 midterm",
    embedding: axisVector(dim, 4),
    occurredAt: new Date("2026-10-15T14:00:00.000Z"),
  });
  await insertEdge(handle.db, { src: hub, dst: facet, type: "HAS_FACET" });
  await insertEdge(handle.db, { src: person, dst: hub, type: "ENROLLED_IN" });
  await insertEdge(handle.db, { src: friend, dst: person, type: "KNOWS" });
  await insertEdge(handle.db, { src: exam, dst: hub, type: "RELATED_TO" });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });

  const res = await app.inject({ method: "DELETE", url: `/nodes/${hub}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: hub, orphans: [facet] });

  const left = await handle.db.select({ id: node.id }).from(node);
  assert.deepEqual(new Set(left.map((row) => row.id)), new Set([person, friend, exam]));
  const history = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, facet));
  assert.equal(history[0]?.field, "deleted");

  const again = await app.inject({ method: "DELETE", url: `/nodes/${hub}` });
  assert.equal(again.statusCode, 404);
  await app.close();
});

test("close_edge that strands a memory deletes it and reports it as an orphan", async () => {
  await resetGraph(handle.sql);
  const person = await insertPerson(handle.db, { title: "Riya", embedding: axisVector(dim, 0) });
  const friend = await insertPerson(handle.db, { title: "Ankur", embedding: axisVector(dim, 2) });
  const fact = await insertMemory(handle.db, { title: "Riya likes pottery", embedding: axisVector(dim, 1) });
  const edgeId = await insertEdge(handle.db, { src: fact, dst: person, type: "ABOUT" });
  await insertEdge(handle.db, { src: friend, dst: person, type: "KNOWS" });

  const result = await applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    author: { source: "agent", agentId: "test-agent" },
    config,
    operations: [{ op: "close_edge", edge_id: edgeId, reason: "retracted" }],
  });

  assert.deepEqual(result.orphans, [fact]);
  const left = await handle.db.select({ id: node.id }).from(node);
  assert.deepEqual(new Set(left.map((row) => row.id)), new Set([person, friend]));
});

test("POST /nodes creates a node by hand, anchors an all-day plan, and rejects a duplicate", async () => {
  await resetGraph(handle.sql);
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const payload = {
    kind: "plan",
    title: "CSE 335 — Design 5 peer reviews due",
    occurred_at: "2026-10-09T23:55:00-04:00",
    detail: { status: "confirmed" },
  };

  const created = await app.inject({ method: "POST", url: "/nodes", payload });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().occurred_at, "2026-10-10T03:55:00.000Z");
  assert.equal(created.json().source, "manual");

  const again = await app.inject({ method: "POST", url: "/nodes", payload });
  assert.equal(again.statusCode, 422);
  assert.equal(again.json().error.type, "duplicate_node");

  const allDay = await app.inject({
    method: "POST",
    url: "/nodes",
    payload: {
      kind: "plan",
      title: "CSE 335 — last day to drop",
      occurred_at: "2026-10-19T09:00:00-04:00",
      detail: { status: "confirmed", all_day: true },
    },
  });
  assert.equal(allDay.statusCode, 201, allDay.body);
  assert.equal(allDay.json().occurred_at, "2026-10-19T04:00:00.000Z");
  assert.equal(allDay.json().detail.all_day, true);
  await app.close();
});

test("PATCH /nodes/:id sets and clears expiry with ttl_days, and rejects it on a person", async () => {
  await resetGraph(handle.sql);
  const memory = await insertMemory(handle.db, { title: "CSE 300 gradebook as of Sep 29", embedding: axisVector(dim, 0) });
  const person = await insertPerson(handle.db, { title: "Riya", embedding: axisVector(dim, 1) });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });

  const set = await app.inject({ method: "PATCH", url: `/nodes/${memory}`, payload: { ttl_days: 14 } });
  assert.equal(set.statusCode, 200, set.body);
  const expires = new Date(set.json().expires_at).getTime();
  assert.ok(Math.abs(expires - (Date.now() + 14 * 86_400_000)) < 60_000);

  const cleared = await app.inject({ method: "PATCH", url: `/nodes/${memory}`, payload: { ttl_days: null } });
  assert.equal(cleared.json().expires_at, null);

  const onPerson = await app.inject({ method: "PATCH", url: `/nodes/${person}`, payload: { ttl_days: 3 } });
  assert.equal(onPerson.statusCode, 422);
  await app.close();
});

test("POST /edges draws an edge by hand and POST /edges/:id/close closes it, sweeping what it strands", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0) });
  const sparsh = await insertPerson(handle.db, { title: "Sparsh Yandooru", embedding: axisVector(dim, 2) });
  await insertEdge(handle.db, { src: sparsh, dst: ankur, type: "ROOMMATE_OF" });
  const seafood = await insertMemory(handle.db, { title: "Ankur Desai doesn't like other seafood", embedding: axisVector(dim, 1) });
  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });

  const badType = await app.inject({
    method: "POST",
    url: "/edges",
    payload: { src_id: ankur, dst_id: seafood, type: "dislikes", confidence: 1 },
  });
  assert.equal(badType.statusCode, 422);
  const missing = await app.inject({
    method: "POST",
    url: "/edges",
    payload: { src_id: ankur, dst_id: "00000000-0000-4000-8000-000000000000", type: "DISLIKES", confidence: 1 },
  });
  assert.equal(missing.statusCode, 422);

  const created = await app.inject({
    method: "POST",
    url: "/edges",
    payload: { src_id: ankur, dst_id: seafood, type: "DISLIKES", properties: { category: "food" }, confidence: 1 },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().type, "DISLIKES");
  assert.deepEqual(created.json().properties, { category: "food" });

  const closed = await app.inject({ method: "POST", url: `/edges/${created.json().id}/close` });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.deepEqual(closed.json().orphans, [seafood]);
  const [row] = await handle.db.select().from(edge).where(eq(edge.id, created.json().id));
  assert.ok(row?.validTo);

  const again = await app.inject({ method: "POST", url: `/edges/${created.json().id}/close` });
  assert.equal(again.statusCode, 422);
  await app.close();
});
