import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { edge, nodeHistory } from "../src/db/schema.js";
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

test("PATCH title writes one node_history row; unchanged fields write none", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, {
    title: "blue dresser",
    embedding: axisVector(dim, 0),
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });

  const patch = await app.inject({
    method: "PATCH",
    url: `/nodes/${id}`,
    payload: { title: "green dresser" },
  });
  assert.equal(patch.statusCode, 200);
  const body = patch.json();
  assert.equal(body.title, "green dresser");
  assert.ok(body.updated_at);
  assert.equal(body.valid_from, undefined);

  const rows = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.field, "title");
  assert.equal(rows[0]?.oldValue, "blue dresser");
  assert.equal(rows[0]?.newValue, "green dresser");

  const noop = await app.inject({
    method: "PATCH",
    url: `/nodes/${id}`,
    payload: { title: "green dresser" },
  });
  assert.equal(noop.statusCode, 200);
  const afterNoop = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id));
  assert.equal(afterNoop.length, 1);

  await app.close();
});

test("DELETE writes a deleted history row and closes incident edges", async () => {
  await resetGraph(handle.sql);
  const a = await insertMemory(handle.db, { title: "keep", embedding: axisVector(dim, 0) });
  const b = await insertMemory(handle.db, { title: "gone", embedding: axisVector(dim, 1) });
  const edgeId = await insertEdge(handle.db, { src: a, dst: b, type: "RELATED" });

  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });
  const res = await app.inject({ method: "DELETE", url: `/nodes/${b}` });
  assert.equal(res.statusCode, 204);

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
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar,
  });

  const patch = await app.inject({
    method: "PATCH",
    url: `/nodes/${id}`,
    payload: { title: "favorite color is green" },
  });
  assert.equal(patch.statusCode, 200);

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
