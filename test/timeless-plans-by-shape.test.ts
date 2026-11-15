import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { node, nodeHistory, planDetail, taskDetail } from "../src/db/schema.js";
import { axisVector, insertPlan, openTestDb, resetGraph, testConfig } from "./helpers.js";

const config = testConfig();
const dim = config.embedding.dimension;
const handle = await openTestDb();
const MIGRATION = await readFile(new URL("../drizzle/0012_timeless_plans_by_shape.sql", import.meta.url), "utf8");
const NEW_YORK = "America/New_York";

before(async () => {
  await resetGraph(handle.sql);
});

after(async () => {
  await handle.close();
});

async function plan(title: string, axis: number, args: { at: string; endAt?: string; allDay?: boolean }): Promise<string> {
  const id = await insertPlan(handle.db, {
    title,
    embedding: axisVector(dim, axis),
    occurredAt: new Date(args.at),
    endAt: args.endAt === undefined ? null : new Date(args.endAt),
    ...(args.allDay === undefined ? {} : { allDay: args.allDay }),
  });
  await handle.db.update(planDetail).set({ timeZone: NEW_YORK }).where(eq(planDetail.nodeId, id));
  return id;
}

test("a plan at local midnight with no end that is not all-day becomes a Someday task with a history row, other plans stay, and a second run changes nothing", async () => {
  await resetGraph(handle.sql);
  const split = await plan("Gym training split", 0, { at: "2026-11-16T05:00:00Z" });
  const timed = await plan("Dinner with Priya", 1, { at: "2026-11-18T22:00:00Z" });
  const ended = await plan("Reading day", 2, { at: "2026-11-19T05:00:00Z", endAt: "2026-11-20T05:00:00Z" });
  const allDay = await plan("Open house", 3, { at: "2026-11-22T05:00:00Z", allDay: true });

  await handle.sql.unsafe(MIGRATION);
  await handle.sql.unsafe(MIGRATION);

  const [row] = await handle.db.select().from(node).where(eq(node.id, split));
  assert.equal(row?.kind, "task");
  assert.equal(row?.occurredAt, null);
  const [detail] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, split));
  assert.deepEqual({ opensOn: detail?.opensOn, closesAt: detail?.closesAt, done: detail?.done }, { opensOn: null, closesAt: null, done: false });
  assert.equal((await handle.db.select().from(planDetail).where(eq(planDetail.nodeId, split))).length, 0);
  const history = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, split));
  assert.equal(history.length, 1);
  assert.equal(history[0]?.field, "occurred_at");
  assert.equal(history[0]?.oldValue, "2026-11-16T05:00:00.000Z");
  assert.equal(history[0]?.newValue, null);
  for (const id of [timed, ended, allDay]) {
    const [kept] = await handle.db.select().from(node).where(eq(node.id, id));
    assert.equal(kept?.kind, "plan");
    assert.equal((await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id))).length, 0);
  }
});
