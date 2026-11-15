import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { node, nodeHistory, planDetail, taskDetail } from "../src/db/schema.js";
import { axisVector, insertPlan, openTestDb, resetGraph, testConfig } from "./helpers.js";

const config = testConfig();
const dim = config.embedding.dimension;
const handle = await openTestDb();
const MIGRATION = await readFile(new URL("../drizzle/0011_timeless_plans_to_tasks.sql", import.meta.url), "utf8");
const NEW_YORK = "America/New_York";

before(async () => {
  await resetGraph(handle.sql);
  await handle.sql`DROP TABLE IF EXISTS plan_detail_evals0_v3`;
});

after(async () => {
  await handle.sql`DROP TABLE IF EXISTS plan_detail_evals0_v3`;
  await handle.close();
});

async function plan(title: string, axis: number, args: { at: string; endAt?: string }): Promise<string> {
  const id = await insertPlan(handle.db, { title, embedding: axisVector(dim, axis), occurredAt: new Date(args.at), endAt: args.endAt === undefined ? null : new Date(args.endAt) });
  await handle.db.update(planDetail).set({ timeZone: NEW_YORK }).where(eq(planDetail.nodeId, id));
  return id;
}

test("the migration changes nothing when no archive of the former status exists", async () => {
  await resetGraph(handle.sql);
  const id = await plan("Gym training split", 0, { at: "2026-11-16T05:00:00Z" });
  await handle.sql.unsafe(MIGRATION);
  const [row] = await handle.db.select().from(node).where(eq(node.id, id));
  assert.equal(row?.kind, "plan");
});

test("a former tentative plan at local midnight with no end becomes a Someday task with a history row, and a second run changes nothing", async () => {
  await resetGraph(handle.sql);
  const split = await plan("Gym training split", 0, { at: "2026-11-16T05:00:00Z" });
  const weighIn = await plan("weekly average weigh-in", 1, { at: "2026-11-17T05:00:00Z" });
  const timed = await plan("Dinner with Priya", 2, { at: "2026-11-18T22:00:00Z" });
  const ended = await plan("Reading day", 3, { at: "2026-11-19T05:00:00Z", endAt: "2026-11-20T05:00:00Z" });
  const confirmed = await plan("Advising", 4, { at: "2026-11-21T05:00:00Z" });
  const allDay = await plan("Open house", 5, { at: "2026-11-22T05:00:00Z" });
  await handle.db.update(planDetail).set({ allDay: true }).where(eq(planDetail.nodeId, allDay));
  await handle.sql`CREATE TABLE plan_detail_evals0_v3 (node_id uuid PRIMARY KEY, status text NOT NULL)`;
  await handle.sql`INSERT INTO plan_detail_evals0_v3 (node_id, status) VALUES
    (${split}, 'tentative'), (${weighIn}, 'tentative'), (${timed}, 'tentative'), (${ended}, 'tentative'), (${confirmed}, 'confirmed'), (${allDay}, 'tentative')`;

  await handle.sql.unsafe(MIGRATION);
  await handle.sql.unsafe(MIGRATION);

  for (const id of [split, weighIn]) {
    const [row] = await handle.db.select().from(node).where(eq(node.id, id));
    assert.equal(row?.kind, "task");
    assert.equal(row?.occurredAt, null);
    const [detail] = await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, id));
    assert.deepEqual({ opensOn: detail?.opensOn, closesAt: detail?.closesAt, done: detail?.done }, { opensOn: null, closesAt: null, done: false });
    assert.equal((await handle.db.select().from(planDetail).where(eq(planDetail.nodeId, id))).length, 0);
    const history = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id));
    assert.equal(history.length, 1);
    assert.equal(history[0]?.field, "occurred_at");
    assert.equal(history[0]?.newValue, null);
  }
  const [splitHistory] = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, split));
  assert.equal(splitHistory?.oldValue, "2026-11-16T05:00:00.000Z");
  for (const id of [timed, ended, confirmed, allDay]) {
    const [row] = await handle.db.select().from(node).where(eq(node.id, id));
    assert.equal(row?.kind, "plan");
    assert.equal((await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id))).length, 0);
  }
});
