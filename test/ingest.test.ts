import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { YaadError } from "../src/errors.js";
import { applyOperations } from "../src/ingest/apply.js";
import { ingest } from "../src/ingest/pipeline.js";
import { validateOperations } from "../src/ingest/validate.js";
import type { Operation } from "../src/ingest/operations.js";
import {
  countCurrentNodes,
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

test("ingest apply creates a node and an edge via temp_id", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({ dimension: dim });
  const operations: Operation[] = [
    {
      op: "create_node",
      temp_id: "p1",
      kind: "person",
      title: "Vedant",
      detail: { aliases: ["Ved"] },
    },
    {
      op: "create_node",
      temp_id: "m1",
      kind: "memory",
      title: "Dinner",
      body: "Ate together",
    },
    {
      op: "create_edge",
      src: "m1",
      dst: "p1",
      type: "PARTICIPANT",
      confidence: 1,
    },
  ];
  const result = await applyOperations({
    db: handle.db,
    dwar,
    operations,
    source: "ingest",
    config,
  });
  assert.equal(result.counts.create_node, 2);
  assert.equal(result.counts.create_edge, 1);
  assert.ok(result.temp_ids.p1);
  assert.ok(result.temp_ids.m1);
  const edgeOp = result.operations.find((op) => op.op === "create_edge");
  assert.ok(edgeOp);
  assert.equal(edgeOp.op, "create_edge");
  if (edgeOp.op === "create_edge") {
    assert.equal(edgeOp.src, "m1");
    assert.equal(edgeOp.dst, "p1");
    assert.ok(edgeOp.id);
  }
  assert.equal(await countCurrentNodes(handle.sql), 2);
});

test("ingest pipeline emits noop and writes nothing", async () => {
  await resetGraph(handle.sql);
  const dwar = mockDwar({
    dimension: dim,
    operations: [{ op: "noop", reason: "greeting only" }],
  });
  const result = await ingest({
    db: handle.db,
    sql: handle.sql,
    dwar,
    config,
    text: "hello",
    occurredAt: "2026-08-25T13:00:00.000Z",
    participantIds: [],
    source: "agent",
  });
  assert.equal(result.counts.noop, 1);
  assert.equal(result.counts.create_node, 0);
  assert.equal(await countCurrentNodes(handle.sql), 0);
});

test("ingest rejects a batch with an invalid node reference and writes nothing", async () => {
  await resetGraph(handle.sql);
  const missing = randomUUID();
  const operations: Operation[] = [
    {
      op: "update_node",
      node_id: missing,
      title: "nope",
    },
  ];
  await assert.rejects(
    () => validateOperations({ db: handle.db, operations }),
    (err: unknown) => {
      assert.ok(err instanceof YaadError);
      assert.equal(err.statusCode, 422);
      assert.match(err.message, /does not exist or is not current/);
      return true;
    },
  );
  assert.equal(await countCurrentNodes(handle.sql), 0);
});
