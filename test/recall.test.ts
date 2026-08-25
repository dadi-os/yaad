import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { shouldStop } from "../src/recall/gate.js";
import { recall } from "../src/recall/pipeline.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
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
    asOf: undefined,
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
    asOf: undefined,
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
