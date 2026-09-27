import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import { shouldStop } from "../src/recall/gate.js";
import { recall } from "../src/recall/pipeline.js";
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

const base = testConfig();
const dim = base.embedding.dimension;
const handle = await openTestDb();

before(async () => {
  await resetGraph(handle.sql);
});

after(async () => {
  await handle.close();
});

test("recall with no anchors returns empty results and zero coverage", async () => {
  await resetGraph(handle.sql);
  await insertMemory(handle.db, {
    title: "orthogonal",
    embedding: axisVector(dim, 1),
  });
  const dwar = mockDwar({ dimension: dim, embedAxis: 0 });
  const result = await recall({
    db: handle.db,
    sql: handle.sql,
    dwar,
    config: {
      ...base,
      recall: {
        ...base.recall,
        anchor_similarity_floor: 0.4,
        hop_cap: 3,
      },
    },
    query: "book tickets to Cancun",
    limit: 20,
    debug: false,
  });
  assert.deepEqual(result.nodes, []);
  assert.equal(result.coverage, 0);
  assert.equal(result.sufficient, false);
  assert.equal(result.hops_taken, 0);
  assert.deepEqual(result.anchors, []);
});

test("recall gating stops before the hop cap when a hop yields nothing relevant", async () => {
  await resetGraph(handle.sql);
  const a = await insertMemory(handle.db, { title: "trip", embedding: axisVector(dim, 0) });
  const b = await insertMemory(handle.db, { title: "color", embedding: axisVector(dim, 1) });
  const c = await insertMemory(handle.db, { title: "tickets", embedding: axisVector(dim, 2) });
  await insertEdge(handle.db, { src: a, dst: b, type: "RELATED_TO" });
  await insertEdge(handle.db, { src: b, dst: c, type: "RELATED_TO" });

  const dwar = mockDwar({ dimension: dim, embedAxis: 0 });
  const result = await recall({
    db: handle.db,
    sql: handle.sql,
    dwar,
    config: {
      ...base,
      recall: {
        ...base.recall,
        hop_cap: 4,
        relevance_threshold: 0.85,
        marginal_yield_minimum: 1,
        token_budget: 100_000,
        anchor_similarity_floor: 0.5,
        anchor_limit: 8,
      },
    },
    query: "book the tickets",
    limit: 20,
    debug: true,
  });

  assert.ok(result.hops_taken < 4);
  assert.ok(result.hops_taken >= 1);
  assert.ok(result.anchors.includes(a));
  assert.equal(
    result.nodes.some((item) => item.id === c),
    false,
    "hop-2 node C should not be reached after a barren hop",
  );
});

test("shouldStop reports yield before hop cap when a hop adds nothing relevant", () => {
  const decision = shouldStop({
    hopsTaken: 1,
    hopCap: 4,
    newRelevantCount: 0,
    marginalYieldMinimum: 1,
    tokenEstimate: 10,
    tokenBudget: 4000,
  });
  assert.equal(decision.stop, true);
  assert.equal(decision.reason, "yield");
});

async function recallRoute(payload: Record<string, unknown>) {
  const app = await buildApp(base, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });
  const res = await app.inject({ method: "POST", url: "/recall", payload });
  await app.close();
  return res;
}

test("recall from a node with hops 1 returns it, its neighbors, and the edges among them", async () => {
  await resetGraph(handle.sql);
  const person = await insertPerson(handle.db, { title: "Oliver Chen", embedding: axisVector(dim, 0) });
  const plan = await insertPlan(handle.db, {
    title: "Wedge Health screening",
    embedding: axisVector(dim, 1),
    occurredAt: new Date("2026-09-25T19:00:00Z"),
  });
  const far = await insertMemory(handle.db, { title: "two hops out", embedding: axisVector(dim, 2) });
  const participant = await insertEdge(handle.db, { src: person, dst: plan, type: "PARTICIPANT" });
  await insertEdge(handle.db, { src: plan, dst: far, type: "RELATED_TO" });

  const res = await recallRoute({ from: [person], hops: 1 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.nodes.map((item: { id: string; hops: number }) => [item.id, item.hops]),
    [
      [person, 0],
      [plan, 1],
    ],
  );
  assert.deepEqual(
    body.edges.map((item: { id: string }) => item.id),
    [participant],
  );
  assert.equal(body.nodes[0].score, null);
  assert.equal(body.coverage, null);
  assert.equal(body.sufficient, null);
});

test("recall with only filters and no hops returns the matches in chronological order", async () => {
  await resetGraph(handle.sql);
  const later = await insertPlan(handle.db, {
    title: "later",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-09-26T15:00:00Z"),
  });
  const earlier = await insertPlan(handle.db, {
    title: "earlier",
    embedding: axisVector(dim, 1),
    occurredAt: new Date("2026-09-24T15:00:00Z"),
  });
  const neighbor = await insertMemory(handle.db, { title: "facet", embedding: axisVector(dim, 2) });
  await insertEdge(handle.db, { src: earlier, dst: neighbor, type: "HAS_FACET" });

  const res = await recallRoute({
    kind: "plan",
    occurred_from: "2026-09-21T00:00:00Z",
    occurred_to: "2026-09-27T23:59:59Z",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().nodes.map((item: { id: string }) => item.id),
    [earlier, later],
  );
  assert.equal(res.json().hops_taken, 0);
});

test("recall rejects from combined with filters", async () => {
  const res = await recallRoute({ from: [randomUUID()], kind: "plan" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.type, "invalid_request");
});

test("recall rejects hops above the configured hop cap", async () => {
  const res = await recallRoute({ query: "anything", hops: base.recall.hop_cap + 1 });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error.type, "invalid_request");
});

test("recall from an unknown node is not_found", async () => {
  await resetGraph(handle.sql);
  const res = await recallRoute({ from: [randomUUID()], hops: 1 });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.type, "not_found");
});
