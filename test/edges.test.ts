import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import {
  axisVector,
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

test("POST /edges rejects a self-loop", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, {
    title: "self",
    embedding: axisVector(dim, 0),
  });
  const app = await buildApp(config, {
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim }),
  });
  const res = await app.inject({
    method: "POST",
    url: "/edges",
    payload: { src_id: id, dst_id: id, type: "RELATED" },
  });
  assert.equal(res.statusCode, 422);
  await app.close();
});
