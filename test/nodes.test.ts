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

test("close_node ends the node's edges but keeps the people and places that were linked to it", async () => {
  await resetGraph(handle.sql);
  const group = await insertMemory(handle.db, { title: "Study group Wed", embedding: axisVector(dim, 0) });
  const priya = await insertPerson(handle.db, { title: "Priya", embedding: axisVector(dim, 1) });
  await insertEdge(handle.db, { src: group, dst: priya, type: "RELATED" });

  const result = await applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    author: { source: "agent", agentId: "test-agent" },
    config,
    operations: [{ op: "close_node", node_id: group, reason: "called off", evidence: "study group Wed is off" }],
  });

  assert.deepEqual(result.orphans, []);
  assert.equal((await handle.db.select().from(node).where(eq(node.id, priya))).length, 1);
  assert.equal((await handle.db.select().from(node).where(eq(node.id, group))).length, 0);
});
