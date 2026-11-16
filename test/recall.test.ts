import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { node } from "../src/db/schema.js";
import { shouldStop } from "../src/recall/gate.js";
import { recall } from "../src/recall/pipeline.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
  insertPerson,
  insertPlan,
  insertTask,
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

test("a query naming an event's title anchors that event even when the embedding is nearer someone else", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0), aliases: ["Ankur"] });
  const advising = await insertPlan(handle.db, {
    title: "Advising with Dr. Okafor",
    embedding: axisVector(dim, 2),
    occurredAt: new Date("2026-11-16T20:30:00Z"),
  });
  const result = await recall({
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({ dimension: dim, embedAxis: 0 }),
    config: base,
    query: "Ankur advising appointment",
    limit: 20,
    debug: false,
    now: new Date("2026-11-13T12:00:00Z"),
  });
  assert.ok(result.anchors.includes(advising));
  assert.ok(result.anchors.includes(ankur));
  assert.equal(result.nodes.find((item) => item.id === advising)?.hops, 0);
});

test("a query walk does not expand out of a node with over 100 edges, but an explicit from does", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0) });
  for (let i = 0; i < 101; i++) {
    const fact = await insertMemory(handle.db, { title: `fact ${i}`, embedding: axisVector(dim, 10 + i) });
    await insertEdge(handle.db, { src: ankur, dst: fact, type: "RELATED_TO" });
  }
  const dwar = mockDwar({ dimension: dim, embedAxis: 0 });
  const asked = await recall({ db: handle.db, sql: handle.sql, dwar, config: base, query: "Ankur", limit: 200, debug: false });
  assert.deepEqual(asked.nodes.map((item) => item.id), [ankur]);
  const from = await recall({ db: handle.db, sql: handle.sql, dwar, config: base, from: [ankur], hops: 1, limit: 200, debug: false });
  assert.equal(from.nodes.length, 102);
});

async function recallCall(payload: Record<string, unknown>) {
  const app = await buildApp(base, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim, embedAxis: 0 }) });
  const res = await app.inject({ method: "POST", url: "/recall", payload });
  await app.close();
  return res;
}

/** Two courses, each with open tasks, plus a task of the first that is done. */
async function seedCourses() {
  await resetGraph(handle.sql);
  const cse = await insertMemory(handle.db, { title: "CSE 300", embedding: axisVector(dim, 1), agentId: "cse-300-specialist" });
  const ibio = await insertMemory(handle.db, { title: "IBIO 150", embedding: axisVector(dim, 2) });
  const hw = await insertTask(handle.db, { title: "HW4", embedding: axisVector(dim, 3), opensOn: "2026-11-10", closesAt: new Date("2026-11-19T04:59:00.000Z") });
  const essay = await insertTask(handle.db, { title: "Essay", embedding: axisVector(dim, 4), opensOn: "2026-11-10", closesAt: new Date("2026-11-27T17:00:00.000Z"), done: true });
  const lab = await insertTask(handle.db, { title: "Lab 9", embedding: axisVector(dim, 5), opensOn: "2026-11-10", closesAt: new Date("2026-11-21T04:59:00.000Z") });
  await insertEdge(handle.db, { src: cse, dst: hw, type: "HAS_ITEM" });
  await insertEdge(handle.db, { src: cse, dst: essay, type: "HAS_ITEM" });
  await insertEdge(handle.db, { src: ibio, dst: lab, type: "HAS_ITEM" });
  return { cse, ibio, hw, essay, lab };
}

test("a filtered recall returns exactly the filtered rows, even with a query, and expands only with hops", async () => {
  const { cse, hw, lab } = await seedCourses();
  const titles = async (payload: Record<string, unknown>) => ((await recallCall(payload)).json().nodes as Array<{ title: string }>).map((item) => item.title).sort();
  assert.deepEqual(await titles({ query: "what is due", relevant_on: "2026-11-12" }), ["HW4", "Lab 9"]);
  assert.deepEqual(await titles({ query: "what is due", relevant_on: "2026-11-12", hops: 1 }), ["CSE 300", "HW4", "IBIO 150", "Lab 9"]);
  assert.equal((await recallCall({ query: "x", relevant_on: "2026-11-12" })).json().hops_taken, 0);
  assert.ok(cse && hw && lab);
});

test("hub scopes a recall by id or exact title, and closes_from/closes_to return done tasks too", async () => {
  const { cse } = await seedCourses();
  const titles = async (payload: Record<string, unknown>) => ((await recallCall(payload)).json().nodes as Array<{ title: string }>).map((item) => item.title).sort();
  assert.deepEqual(await titles({ hub: "CSE 300" }), ["Essay", "HW4"]);
  assert.deepEqual(await titles({ hub: "cse 300", relevant_on: "2026-11-12" }), ["HW4"]);
  assert.deepEqual(await titles({ hub: cse }), ["Essay", "HW4"]);
  const range = (await recallCall({ closes_from: "2026-11-20", closes_to: "2026-11-24" })).json().nodes as Array<{ title: string; detail: { done: boolean } }>;
  assert.deepEqual(range.map((item) => item.title), ["Lab 9"]);
  const done = (await recallCall({ closes_from: "2026-11-26", closes_to: "2026-11-30" })).json().nodes as Array<{ title: string; detail: { done: boolean } }>;
  assert.deepEqual(done.map((item) => [item.title, item.detail.done]), [["Essay", true]]);
});

test("hub resolves a course label by normalized-title prefix, and an unmatched label is a 422 naming the closest hubs", async () => {
  await resetGraph(handle.sql);
  const cse300 = await insertMemory(handle.db, { title: "CSE 300 class", embedding: axisVector(dim, 1) });
  const cse380 = await insertMemory(handle.db, { title: "CSE 380 lecture", embedding: axisVector(dim, 2) });
  const hw = await insertTask(handle.db, { title: "HW4", embedding: axisVector(dim, 3), opensOn: "2026-11-10", closesAt: new Date("2026-11-19T04:59:00.000Z") });
  const quiz = await insertTask(handle.db, { title: "Quiz 2", embedding: axisVector(dim, 4), opensOn: "2026-11-10", closesAt: new Date("2026-11-20T04:59:00.000Z") });
  await insertEdge(handle.db, { src: cse300, dst: hw, type: "HAS_ITEM" });
  await insertEdge(handle.db, { src: cse380, dst: quiz, type: "HAS_ITEM" });
  const titles = async (payload: Record<string, unknown>) => ((await recallCall(payload)).json().nodes as Array<{ title: string }>).map((item) => item.title);
  assert.deepEqual(await titles({ hub: "CSE 300" }), ["HW4"]);
  assert.deepEqual(await titles({ hub: "cse-380" }), ["Quiz 2"]);
  assert.deepEqual(await titles({ hub: "CSE 300 class" }), ["HW4"]);
  assert.deepEqual(await titles({ hub: cse380 }), ["Quiz 2"]);

  for (const label of ["CSE 30", "CSE 431"]) {
    const res = await recallCall({ hub: label });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.type, "invalid_request");
    assert.match(res.json().error.message, /closest hub titles: CSE 300 class; CSE 380 lecture/);
  }
  const none = await recallCall({ hub: "Zebra" });
  assert.equal(none.statusCode, 422);
  assert.match(none.json().error.message, /no hub shares a word/);
});

test("returned plans carry their start and end in local time with the weekday, the date alone for an all-day plan", async () => {
  await resetGraph(handle.sql);
  await insertPlan(handle.db, { title: "Advising", embedding: axisVector(dim, 0), occurredAt: new Date("2026-11-17T20:30:00Z"), endAt: new Date("2026-11-17T21:30:00Z") });
  await insertPlan(handle.db, { title: "Open house", embedding: axisVector(dim, 1), occurredAt: new Date("2026-11-22T05:00:00Z"), allDay: true });
  const plans = (await recallCall({ kind: "plan" })).json().nodes;
  const detail = (title: string) => plans.find((row: { title: string }) => row.title === title).detail;
  assert.deepEqual([detail("Advising").starts_local, detail("Advising").ends_local], ["Tue 2026-11-17 15:30", "Tue 2026-11-17 16:30"]);
  assert.deepEqual([detail("Open house").starts_local, detail("Open house").ends_local], ["Sun 2026-11-22", null]);
});

test("a task recall with occurred_* is a 422 that points at relevant_on and closes_from", async () => {
  const res = await recallCall({ kind: "task", occurred_from: "2026-11-01T00:00:00Z" });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error.message, /use relevant_on or closes_from/);
});

test("returned tasks carry local dates, a bucket against the asked day, an owner, and their course's freshness", async () => {
  const { cse, hw } = await seedCourses();
  const first = (await recallCall({ hub: "CSE 300", relevant_on: "2026-11-18" })).json();
  const task = first.nodes[0];
  assert.equal(task.title, "HW4");
  assert.equal(task.detail.closes_local, "Wed 2026-11-18 23:59");
  assert.equal(task.detail.opens_local, "Tue 2026-11-10");
  assert.equal(task.detail.bucket, "due_on_day");
  assert.equal(task.detail.owner, "cse-300-specialist");
  assert.deepEqual(first.courses, { "CSE 300": { verified_at: null, verified_today: false, owner: "cse-300-specialist" } });
  assert.equal((await recallCall({ hub: "CSE 300", relevant_on: "2026-11-12" })).json().nodes[0].detail.bucket, "upcoming");
  assert.equal((await recallCall({ hub: "CSE 300", relevant_on: "2026-12-10" })).json().nodes.find((item: { title: string }) => item.title === "HW4"), undefined);

  const now = new Date();
  await handle.db.update(node).set({ verifiedAt: now }).where(eq(node.id, cse));
  const fresh = (await recallCall({ hub: "CSE 300" })).json().courses["CSE 300"];
  assert.equal(fresh.verified_today, true);
  const yesterday = new Date(now.getTime() - 36 * 3_600_000);
  await handle.db.update(node).set({ verifiedAt: yesterday }).where(eq(node.id, cse));
  assert.equal((await recallCall({ hub: "CSE 300" })).json().courses["CSE 300"].verified_today, false);
  assert.ok(hw);
});
