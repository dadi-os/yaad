import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { node, nodeHistory, planDetail, taskDetail } from "../src/db/schema.js";
import { YaadError } from "../src/errors.js";
import { applyOperations } from "../src/ingest/apply.js";
import { assembleCandidates } from "../src/ingest/candidates.js";
import { findLookalikes } from "../src/ingest/duplicates.js";
import type { Operation } from "../src/ingest/operations.js";
import { ingest } from "../src/ingest/pipeline.js";
import { validateExtraction, validateOperations } from "../src/ingest/validate.js";
const ZONE = "America/New_York";
import type { NodeAuthor } from "../src/types/domain.js";
import {
  axisVector,
  countCurrentNodes,
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

const config = testConfig();
const dim = config.embedding.dimension;
const handle = await openTestDb();
const INGEST: NodeAuthor = { source: "ingest", agentId: null };
const QUIZ = "CSE 300 — Quiz: Source Citations due";
const QUIZ_AT = "2026-10-02T23:59:00-04:00";

before(async () => {
  await resetGraph(handle.sql);
});

after(async () => {
  await handle.close();
});

/** Asserts that `run` rejects with a YaadError of this status and type. */
async function rejectsWith(run: () => unknown, status: number, type: string, message?: RegExp) {
  await assert.rejects(async () => run(), (err: unknown) => {
    assert.ok(err instanceof YaadError);
    assert.equal(err.statusCode, status);
    assert.equal(err.type, type);
    if (message) {
      assert.match(err.message, message);
    }
    return true;
  });
}

test("an all-day plan is stored at local midnight of its date and keeps the flag", async () => {
  await resetGraph(handle.sql);
  const result = await applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    author: INGEST,
    config,
    operations: [
      {
        op: "create_node",
        temp_id: "drop",
        kind: "plan",
        title: "CSE 335 — last day to drop",
        occurred_at: "2026-10-19T12:00:00-04:00",
        detail: { all_day: true },
      },
    ],
  });
  const id = result.temp_ids.drop;
  assert.ok(id);
  const [row] = await handle.db.select().from(node).where(eq(node.id, id));
  assert.equal(row?.occurredAt?.toISOString(), "2026-10-19T04:00:00.000Z");
  const [detail] = await handle.db.select().from(planDetail).where(eq(planDetail.nodeId, id));
  assert.equal(detail?.allDay, true);
});

test("turning all_day on moves the existing start to midnight, and a plan needs a start", async () => {
  await resetGraph(handle.sql);
  const id = await insertPlan(handle.db, {
    title: "IBIO 150 Exam 1",
    embedding: axisVector(dim, 0),
    occurredAt: new Date("2026-09-30T16:00:00.000Z"),
  });
  await applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    author: INGEST,
    config,
    operations: [{ op: "update_node", node_id: id, detail: { all_day: true } }],
  });
  const [row] = await handle.db.select().from(node).where(eq(node.id, id));
  assert.equal(row?.occurredAt?.toISOString(), "2026-09-30T04:00:00.000Z");

  await rejectsWith(
    () => validateOperations({ timeZone: config.env.timezone, db: handle.db, operations: [{ op: "update_node", node_id: id, occurred_at: null }] }),
    422,
    "invalid_request",
    /a plan needs occurred_at/,
  );
  await rejectsWith(
    () =>
      validateOperations({
        timeZone: config.env.timezone,
        db: handle.db,
        operations: [{ op: "create_node", temp_id: "p", kind: "plan", title: "Someday", detail: { all_day: true } }],
      }),
    422,
    "invalid_request",
    /a plan needs occurred_at/,
  );
});

test("close_node must quote the utterance words that retract the node", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, { title: "Vedant likes orange juice", embedding: axisVector(dim, 0) });
  const close = (evidence: string): Operation[] => [{ op: "close_node", node_id: id, reason: "retracted", evidence }];

  await rejectsWith(
    () => validateExtraction({ text: "Design 5 is due Monday.", operations: close("Design 5 peer reviews were cancelled") }),
    422,
    "invalid_request",
    /evidence must quote/,
  );
  await rejectsWith(
    () => validateExtraction({ text: "Forget that, Vedant moved.", operations: close("forget") }),
    422,
    "invalid_request",
    /evidence must quote/,
  );
  await validateExtraction({ text: "Forget that — Vedant doesn’t   actually like orange juice.",
    operations: close("Vedant doesn't actually like orange juice"),
  });
});

test("close_node evidence may quote the requester's verbatim source_text instead of the agent's paraphrase", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, { title: "Study group Wed", embedding: axisVector(dim, 0) });
  const operations: Operation[] = [{ op: "close_node", node_id: id, reason: "called off", evidence: "study group Wed is off" }];
  const text = "Correction: the study group with Priya on Wed Nov 18 is cancelled.";
  await rejectsWith(() => validateExtraction({ text, operations }), 422, "invalid_request", /evidence must quote/);
  await validateExtraction({ text, sourceText: "Study group Wed is off", operations });
  await rejectsWith(() => validateExtraction({ text, sourceText: "Study group is on", operations }), 422, "invalid_request", /evidence must quote/);
});

test("every created node needs an edge in the batch; ingest re-extracts once naming the unlinked ones, then rejects", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0) });
  const lesson: Operation = { op: "create_node", temp_id: "lesson", kind: "memory", title: "LinkedIn checkpoints need a phone tap" };
  const link: Operation = {
    op: "create_edge",
    src: ankur,
    dst: "lesson",
    type: "ABOUT",
    properties: { category: "how-to" },
    confidence: 1,
  };
  await rejectsWith(
    () => validateExtraction({ text: "lesson", operations: [lesson] }),
    422,
    "unlinked_node",
    /LinkedIn checkpoints need a phone tap/,
  );
  await validateExtraction({ text: "lesson", operations: [lesson, link] });

  const run = (rounds: Operation[][], users: string[]) =>
    ingest({
      db: handle.db,
      sql: handle.sql,
      dwar: mockDwar({ dimension: dim, embedAxis: 1, rounds, reasonUsers: users }),
      config,
      text: "LinkedIn checkpoints need a phone tap.",
      occurredAt: "2026-10-08T09:00:00-04:00",
      participantIds: [],
      author: INGEST,
    });
  const users: string[] = [];
  const result = await run([[lesson], [lesson, link]], users);
  assert.equal(users.length, 2);
  assert.ok(!users[0]?.includes('"recheck"'));
  assert.ok(users[1]?.includes("A first pass created nodes with no edge"));
  assert.equal(result.counts.create_edge, 1);

  await resetGraph(handle.sql);
  await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0) });
  await rejectsWith(() => run([[lesson], [lesson]], []), 422, "unlinked_node");
  assert.equal(await countCurrentNodes(handle.sql), 1);
});

test("an edge type outside the allowed list is a 422, and ingest re-extracts once naming it before it rejects", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0) });
  const lesson: Operation = { op: "create_node", temp_id: "lesson", kind: "memory", title: "LinkedIn checkpoints need a phone tap" };
  const edge = (type: string): Operation => ({ op: "create_edge", src: ankur, dst: "lesson", type, confidence: 1 });
  await rejectsWith(
    () => validateOperations({ timeZone: config.env.timezone, db: handle.db, operations: [lesson, edge("LEARNED_FROM")] }),
    422,
    "invalid_request",
    /LEARNED_FROM is not allowed/,
  );
  await validateOperations({ timeZone: config.env.timezone, db: handle.db, operations: [lesson, edge("ABOUT")] });

  const run = (rounds: Operation[][], users: string[]) =>
    ingest({
      db: handle.db,
      sql: handle.sql,
      dwar: mockDwar({ dimension: dim, embedAxis: 1, rounds, reasonUsers: users }),
      config,
      text: "LinkedIn checkpoints need a phone tap.",
      occurredAt: "2026-10-08T09:00:00-04:00",
      participantIds: [],
      author: { source: "agent", agentId: "networking-specialist" },
    });
  const users: string[] = [];
  const result = await run([[lesson, edge("LEARNED_FROM")], [lesson, edge("ABOUT")]], users);
  assert.equal(users.length, 2);
  assert.ok(users[1]?.includes("edge types that are not allowed: LEARNED_FROM"));
  assert.equal(result.counts.create_edge, 1);

  await resetGraph(handle.sql);
  await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0) });
  await rejectsWith(() => run([[lesson, edge("LEARNED_FROM")], [lesson, edge("LEARNED_FROM")]], []), 422, "invalid_request");
});

test("ingest re-extracts once with a lookalike it was not shown", async () => {
  await resetGraph(handle.sql);
  const quiz = await insertPlan(handle.db, { title: QUIZ, embedding: axisVector(dim, 2), occurredAt: new Date(QUIZ_AT) });
  const create: Operation = {
    op: "create_node",
    temp_id: "quiz",
    kind: "plan",
    title: QUIZ,
    occurred_at: QUIZ_AT,
    detail: {},
  };
  const run = (rounds: Operation[][], users: string[]) =>
    ingest({
      db: handle.db,
      sql: handle.sql,
      dwar: mockDwar({ dimension: dim, embedAxis: 1, rounds, reasonUsers: users }),
      config,
      text: "Quiz: Source Citations is due Friday Oct 2 at 11:59 PM.",
      occurredAt: "2026-10-01T09:00:00-04:00",
      participantIds: [],
      author: INGEST,
    });

  const users: string[] = [];
  const result = await run([[create], [{ op: "noop", reason: "already stored" }]], users);
  assert.equal(users.length, 2);
  assert.ok(!users[0]?.includes(quiz));
  assert.ok(users[1]?.includes(quiz));
  assert.ok(users[1]?.includes('"recheck"'));
  assert.equal(result.counts.noop, 1);
  assert.equal(await countCurrentNodes(handle.sql), 1);
});

test("candidates include a person the text names by first name only, as a whole word", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 2) });
  const riya = await insertPerson(handle.db, { title: "Riya Shah", embedding: axisVector(dim, 3) });
  const candidateIds = async (text: string) => {
    const candidates = await assembleCandidates({
      db: handle.db,
      sql: handle.sql,
      config,
      text,
      embedding: axisVector(dim, 1),
      segmentEmbeddings: [],
      participantIds: [],
      author: INGEST,
      extraIds: [],
    });
    return candidates.nodes.map((candidate) => candidate.id);
  };

  assert.deepEqual(await candidateIds("Ankur has a quiz on Friday."), [ankur]);
  assert.deepEqual(await candidateIds("Ankurbhai called about it."), []);
  assert.ok(!(await candidateIds("Ankur and Shahid met.")).includes(riya));
});

test("candidates include every task not done under a touched course that is open now or closes within the horizon, however far its title is from the text", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "Primary care", embedding: axisVector(dim, 1) });
  const idea = await insertTask(handle.db, { title: "Find a doctor", embedding: axisVector(dim, 5) });
  const untimed = await insertTask(handle.db, {
    title: "Renew the lease",
    embedding: axisVector(dim, 6),
    opensOn: "2026-01-01",
    closesAt: new Date(Date.now() + 30 * 86_400_000),
  });
  const faraway = await insertTask(handle.db, {
    title: "Renew the passport",
    embedding: axisVector(dim, 9),
    opensOn: "2098-12-01",
    closesAt: new Date("2099-01-01T15:00:00Z"),
  });
  const finished = await insertTask(handle.db, {
    title: "Finished errand",
    embedding: axisVector(dim, 8),
    opensOn: "2026-01-01",
    closesAt: new Date("2026-01-02T15:00:00Z"),
    done: true,
  });
  for (const task of [idea, untimed, faraway, finished]) {
    await insertEdge(handle.db, { src: course, dst: task, type: "HAS_ITEM" });
  }
  const scheduled = await insertPlan(handle.db, {
    title: "Dentist",
    embedding: axisVector(dim, 7),
    occurredAt: new Date("2099-01-02T15:00:00Z"),
  });
  const candidates = await assembleCandidates({
    db: handle.db,
    sql: handle.sql,
    config,
    text: "Found a primary care doctor in Lansing.",
    embedding: axisVector(dim, 1),
    segmentEmbeddings: [],
    participantIds: [],
    author: INGEST,
    extraIds: [],
  });
  const ids = candidates.nodes.map((candidate) => candidate.id);
  assert.ok(ids.includes(idea) && ids.includes(untimed));
  assert.ok(!ids.includes(scheduled) && !ids.includes(faraway));
  assert.equal(candidates.nodes.filter((candidate) => candidate.title === "Finished errand").length, 0);
});

test("history attributes a change to whoever made it, not to the node's creator", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, { title: "CSE 335 uses pugixml", embedding: axisVector(dim, 0) });
  await applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    author: { source: "agent", agentId: "cse-335-specialist" },
    config,
    operations: [{ op: "update_node", node_id: id, title: "CSE 335 uses wxXmlDocument" }],
  });
  const [history] = await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, id));
  assert.equal(history?.source, "agent");
  assert.equal(history?.agentId, "cse-335-specialist");
  const [row] = await handle.db.select().from(node).where(eq(node.id, id));
  assert.equal(row?.source, "manual");
});

test("open tasks are candidates only under a course the text touches, an author's course, or by a shared title word", async () => {
  await resetGraph(handle.sql);
  const touched = await insertMemory(handle.db, { title: "CSE 300 class", embedding: axisVector(dim, 1) });
  const other = await insertMemory(handle.db, { title: "IBIO 150 class", embedding: axisVector(dim, 2) });
  const owned = await insertMemory(handle.db, { title: "IAH 241 class", embedding: axisVector(dim, 3), agentId: "iah-241-specialist" });
  const inTouched = await insertTask(handle.db, { title: "Quiz one", embedding: axisVector(dim, 4) });
  const inOther = await insertTask(handle.db, { title: "Lab report", embedding: axisVector(dim, 5) });
  const inOwned = await insertTask(handle.db, { title: "Reading", embedding: axisVector(dim, 6) });
  const byWord = await insertTask(handle.db, { title: "Lease renewal", embedding: axisVector(dim, 7) });
  await insertEdge(handle.db, { src: touched, dst: inTouched, type: "HAS_ITEM" });
  await insertEdge(handle.db, { src: other, dst: inOther, type: "HAS_ITEM" });
  await insertEdge(handle.db, { src: owned, dst: inOwned, type: "HAS_ITEM" });
  const candidateIds = async (text: string, author: NodeAuthor, embedAxisIndex: number) =>
    (
      await assembleCandidates({
        db: handle.db,
        sql: handle.sql,
        config: { ...config, ingest: { ...config.ingest, candidate_similarity_floor: 0.9 } },
        text,
        embedding: axisVector(dim, embedAxisIndex),
        segmentEmbeddings: [],
        participantIds: [],
        author,
        extraIds: [],
      })
    ).nodes.map((candidate) => candidate.id);

  const advising = await candidateIds("Advising appointment moved.", INGEST, 20);
  assert.ok(!advising.includes(inTouched) && !advising.includes(inOther) && !advising.includes(inOwned) && !advising.includes(byWord));
  const course = await candidateIds("CSE 300 update.", INGEST, 1);
  assert.ok(course.includes(inTouched) && !course.includes(inOther));
  const agent = await candidateIds("Something unrelated.", { source: "agent", agentId: "iah-241-specialist" }, 20);
  assert.ok(agent.includes(inOwned) && !agent.includes(inOther));
  assert.ok((await candidateIds("The lease renewal is due.", INGEST, 20)).includes(byWord));
});

test("a task's HAS_ITEM edge is always shown, ahead of the edges of a hub with over 100", async () => {
  await resetGraph(handle.sql);
  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 0), aliases: ["Ankur"] });
  const course = await insertMemory(handle.db, { title: "CSE 431", embedding: axisVector(dim, 1) });
  const task = await insertTask(handle.db, { title: "CSE 431 — HW5", embedding: axisVector(dim, 2) });
  for (let i = 0; i < 101; i++) {
    const other = await insertMemory(handle.db, { title: `fact ${i}`, embedding: axisVector(dim, 10 + i) });
    await insertEdge(handle.db, { src: ankur, dst: other, type: "RELATED_TO" });
  }
  const itemEdge = await insertEdge(handle.db, { src: course, dst: task, type: "HAS_ITEM" });
  const candidates = await assembleCandidates({
    db: handle.db,
    sql: handle.sql,
    config: { ...config, ingest: { ...config.ingest, edge_context_limit: 1 } },
    text: "Ankur has HW5.",
    embedding: axisVector(dim, 1),
    segmentEmbeddings: [],
    participantIds: [],
    author: INGEST,
    extraIds: [],
  });
  assert.ok(candidates.edges.some((edge) => edge.id === itemEdge));
  assert.equal(candidates.edges.length, 2);
});

test("a create_edge the graph already holds is skipped and counted; one with new properties is inserted", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "CSE 431", embedding: axisVector(dim, 1) });
  const task = await insertTask(handle.db, { title: "CSE 431 — HW5", embedding: axisVector(dim, 2) });
  await insertEdge(handle.db, { src: course, dst: task, type: "HAS_ITEM", properties: { item: "assignment" } });
  const run = (properties: Record<string, unknown>) =>
    applyOperations({
      db: handle.db,
      dwar: mockDwar({ dimension: dim }),
      author: INGEST,
      config,
      operations: [{ op: "create_edge", src: course, dst: task, type: "HAS_ITEM", properties, confidence: 1 }],
    });
  const same = await run({ item: "assignment" });
  assert.equal(same.counts.edge_exists, 1);
  assert.equal(same.counts.create_edge, 0);
  const richer = await run({ item: "assignment", weight: "10%" });
  assert.equal(richer.counts.edge_exists, 0);
  assert.equal(richer.counts.create_edge, 1);
  const rows = await handle.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM edge WHERE valid_to IS NULL`;
  assert.equal(rows[0]?.n, "2");
});

test("lookalike plans need a shared title word; lookalike tasks close the same day under the same hub", async () => {
  await resetGraph(handle.sql);
  const at = new Date("2026-11-20T15:00:00Z");
  const dentist = await insertPlan(handle.db, { title: "Dentist appointment", embedding: axisVector(dim, 1), occurredAt: at });
  const createPlan = (title: string): Operation => ({
    op: "create_node",
    temp_id: "p",
    kind: "plan",
    title,
    occurred_at: new Date(at.getTime() + 3_600_000).toISOString(),
    detail: {},
  });
  assert.deepEqual(await findLookalikes(handle.db, [createPlan("Dentist cleaning")], new Set(), "America/New_York"), [dentist]);
  assert.deepEqual(await findLookalikes(handle.db, [createPlan("Graduate info session")], new Set(), "America/New_York"), []);

  const hub = await insertMemory(handle.db, { title: "CSE 300 class", embedding: axisVector(dim, 2) });
  const stored = await insertTask(handle.db, {
    title: "CSE 300 — Feedback",
    embedding: axisVector(dim, 3),
    opensOn: "2026-11-18",
    closesAt: new Date("2026-11-20T04:59:00Z"),
  });
  await insertEdge(handle.db, { src: hub, dst: stored, type: "HAS_ITEM" });
  const createTask = (closesAt: string): Operation[] => [
    { op: "create_node", temp_id: "t", kind: "task", title: "CSE 300 — Grading", detail: { opens_on: "2026-11-18", closes_at: closesAt } },
    { op: "create_edge", src: hub, dst: "t", type: "HAS_ITEM", confidence: 1 },
  ];
  assert.deepEqual(await findLookalikes(handle.db, createTask("2026-11-19T23:59:00-05:00"), new Set(), "America/New_York"), [stored]);
  assert.deepEqual(await findLookalikes(handle.db, createTask("2026-11-24T23:59:00-05:00"), new Set(), "America/New_York"), []);
});

test("done is applied as given, with a history row, and a restating noop never resets it", async () => {
  await resetGraph(handle.sql);
  const task = await insertTask(handle.db, {
    title: "Engineering scholarship essay",
    embedding: axisVector(dim, 2),
    opensOn: "2026-11-13",
    closesAt: new Date("2026-11-16T17:00:00Z"),
  });
  const run = (operations: Operation[], users: string[]) =>
    ingest({
      db: handle.db,
      sql: handle.sql,
      dwar: mockDwar({ dimension: dim, embedAxis: 1, operations, reasonUsers: users }),
      config,
      text: "Ankur says he sent in the scholarship essay.",
      occurredAt: "2026-11-13T23:34:57-05:00",
      participantIds: [],
      author: INGEST,
    });
  const doneOf = async () => (await handle.db.select().from(taskDetail).where(eq(taskDetail.nodeId, task)))[0]?.done;
  const history = async () =>
    (await handle.db.select().from(nodeHistory).where(eq(nodeHistory.nodeId, task))).filter((row) => row.field === "done").map((row) => [row.oldValue, row.newValue]);

  const users: string[] = [];
  await run([{ op: "update_node", node_id: task, detail: { done: true } }], users);
  assert.equal(users.length, 1);
  assert.equal(await doneOf(), true);
  assert.deepEqual(await history(), [["false", "true"]]);

  await run([{ op: "noop", reason: "restated", node_ids: [task] }], []);
  await run([{ op: "update_node", node_id: task, body: "Submit on the portal." }], []);
  assert.equal(await doneOf(), true);
  assert.deepEqual(await history(), [["false", "true"]]);

  await run([{ op: "update_node", node_id: task, detail: { done: false } }], []);
  assert.equal(await doneOf(), false);
  assert.deepEqual(await history(), [["false", "true"], ["true", "false"]]);
});

test("a created task is not done unless the batch says so, and one that is stored done gets a history row", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "CSE 431 class", embedding: axisVector(dim, 0) });
  const make = (temp_id: string, detail: Record<string, unknown>): Operation[] => [
    { op: "create_node", temp_id, kind: "task", title: temp_id, detail: { opens_on: "2026-11-13", closes_at: "2026-11-16T12:00:00-05:00", ...detail } },
    { op: "create_edge", src: course, dst: temp_id, type: "HAS_ITEM", confidence: 1 },
  ];
  const result = await applyOperations({
    db: handle.db,
    dwar: mockDwar({ dimension: dim }),
    author: INGEST,
    config,
    operations: [...make("plain", {}), ...make("finished", { done: true })],
  });
  const rows = await handle.db.select().from(taskDetail);
  assert.deepEqual(rows.map((row) => row.done).sort(), [false, true]);
  assert.equal((await handle.db.select().from(nodeHistory)).filter((row) => row.field === "done").length, 1);
  assert.equal(result.counts.create_node, 2);
});

test("task windows are stored exactly as extracted: a past close, an early or long open, and a stated open are not moved", async () => {
  await resetGraph(handle.sql);
  const course = await insertMemory(handle.db, { title: "IAH class", embedding: axisVector(dim, 0) });
  const make = (temp_id: string, detail: Record<string, unknown>): Operation[] => [
    { op: "create_node", temp_id, kind: "task", title: temp_id, detail },
    { op: "create_edge", src: course, dst: temp_id, type: "HAS_ITEM", confidence: 1 },
  ];
  const result = await ingest({
    db: handle.db,
    sql: handle.sql,
    dwar: mockDwar({
      dimension: dim,
      embedAxis: 1,
      operations: [
        ...make("past", { opens_on: "2026-11-02", closes_at: "2026-11-12T23:59:00-05:00" }),
        ...make("long", { opens_on: "2026-10-01", closes_at: "2026-12-14T23:59:00-05:00" }),
        ...make("early", { opens_on: "2026-11-02", closes_at: "2026-11-16T12:00:00-05:00" }),
      ],
    }),
    config,
    text: "Past is closed. Long is due Dec 14. Early is due Nov 16.",
    occurredAt: "2026-11-13T23:07:46-05:00",
    participantIds: [],
    author: INGEST,
  });
  assert.equal(result.counts.create_node, 3);
  assert.deepEqual(
    result.operations.flatMap((op) => (op.op === "create_node" ? [[op.title, (op.detail as { opens_on: string }).opens_on]] : [])),
    [["past", "2026-11-02"], ["long", "2026-10-01"], ["early", "2026-11-02"]],
  );
  const opens = await handle.db.select({ title: node.title, opensOn: taskDetail.opensOn, closesAt: taskDetail.closesAt }).from(taskDetail).innerJoin(node, eq(node.id, taskDetail.nodeId));
  assert.deepEqual(
    opens.map((row) => [row.title, row.opensOn, row.closesAt?.toISOString()]).sort(),
    [
      ["early", "2026-11-02", "2026-11-16T17:00:00.000Z"],
      ["long", "2026-10-01", "2026-12-15T04:59:00.000Z"],
      ["past", "2026-11-02", "2026-11-13T04:59:00.000Z"],
    ],
  );
});
