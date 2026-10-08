import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { edge, node } from "../src/db/schema.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
  insertPerson,
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

async function graph(payload: Record<string, unknown>) {
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });
  const res = await app.inject({ method: "POST", url: "/graph", payload });
  await app.close();
  return res;
}

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

test("graph returns live nodes and only current edges among them", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur", embedding: axisVector(dim, 0) });
  const hike = await insertMemory(handle.db, { title: "hike", embedding: axisVector(dim, 1) });
  const stale = await insertMemory(handle.db, {
    title: "stale",
    embedding: axisVector(dim, 2),
    expiresAt: new Date(Date.now() - 60_000),
  });
  const current = await insertEdge(handle.db, { src: ankur, dst: hike, type: "attended" });
  await insertEdge(handle.db, { src: ankur, dst: stale, type: "attended" });
  const closed = await insertEdge(handle.db, { src: hike, dst: ankur, type: "with" });
  await handle.db.update(edge).set({ validTo: new Date() }).where(eq(edge.id, closed));

  const res = await graph({});
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(ids(body.nodes), [ankur, hike].sort());
  assert.deepEqual(ids(body.edges), [current]);
});

test("graph returns every live node and edge, not only the most accessed", async () => {
  await resetGraph(handle.sql);
  const hub = await insertPerson(handle.db, { title: "hub", embedding: axisVector(dim, 0) });
  await handle.db.update(node).set({ accessCount: 9 }).where(eq(node.id, hub));
  const leaves = [];
  for (let i = 1; i <= 5; i++) {
    leaves.push(await insertMemory(handle.db, { title: `leaf ${i}`, embedding: axisVector(dim, i) }));
  }
  const edges = [];
  for (const leaf of leaves) {
    edges.push(await insertEdge(handle.db, { src: hub, dst: leaf, type: "HAS_FACET" }));
  }

  const res = await graph({});
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(ids(body.nodes), [hub, ...leaves].sort());
  assert.deepEqual(ids(body.edges), edges.sort());
  assert.equal("embedding" in body.nodes[0], false);
});

test("graph seed_ids returns seeds plus one-hop neighbors, not two hops", async () => {
  await resetGraph(handle.sql);
  const seed = await insertPerson(handle.db, { title: "seed", embedding: axisVector(dim, 0) });
  const one = await insertMemory(handle.db, { title: "one", embedding: axisVector(dim, 1) });
  const other = await insertMemory(handle.db, { title: "other", embedding: axisVector(dim, 2) });
  const two = await insertMemory(handle.db, { title: "two", embedding: axisVector(dim, 3) });
  const e1 = await insertEdge(handle.db, { src: seed, dst: one, type: "attended" });
  const e2 = await insertEdge(handle.db, { src: other, dst: seed, type: "with" });
  const between = await insertEdge(handle.db, { src: one, dst: other, type: "near" });
  await insertEdge(handle.db, { src: one, dst: two, type: "near" });

  const res = await graph({ seed_ids: [seed] });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.nodes[0].id, seed);
  assert.deepEqual(ids(body.nodes), [seed, one, other].sort());
  assert.deepEqual(ids(body.edges), [e1, e2, between].sort());
});

test("graph rejects a limit and reports unknown seeds", async () => {
  await resetGraph(handle.sql);
  const limited = await graph({ limit: 2 });
  assert.equal(limited.statusCode, 422);
  assert.equal(limited.json().error.type, "invalid_request");

  const missing = await graph({ seed_ids: [randomUUID()] });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.type, "not_found");
});
