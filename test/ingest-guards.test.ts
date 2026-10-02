import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { node, nodeHistory, planDetail } from "../src/db/schema.js";
import { YaadError } from "../src/errors.js";
import { applyOperations } from "../src/ingest/apply.js";
import { assembleCandidates } from "../src/ingest/candidates.js";
import type { Operation } from "../src/ingest/operations.js";
import { ingest } from "../src/ingest/pipeline.js";
import { validateExtraction, validateOperations } from "../src/ingest/validate.js";
import type { NodeAuthor } from "../src/types/domain.js";
import {
  axisVector,
  countCurrentNodes,
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
async function rejectsWith(run: () => Promise<unknown>, status: number, type: string, message?: RegExp) {
  await assert.rejects(run, (err: unknown) => {
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
        detail: { status: "confirmed", all_day: true },
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

test("turning all_day on moves the existing start to midnight, and an all-day plan needs a date", async () => {
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
    () => validateOperations({ db: handle.db, operations: [{ op: "update_node", node_id: id, occurred_at: null }] }),
    422,
    "invalid_request",
    /all-day plan needs occurred_at/,
  );
  await rejectsWith(
    () =>
      validateOperations({
        db: handle.db,
        operations: [
          { op: "create_node", temp_id: "p", kind: "plan", title: "Someday", detail: { status: "idea", all_day: true } },
        ],
      }),
    422,
    "invalid_request",
    /all-day plan needs occurred_at/,
  );
});

test("close_node must quote the utterance words that retract the node", async () => {
  await resetGraph(handle.sql);
  const id = await insertMemory(handle.db, { title: "Vedant likes orange juice", embedding: axisVector(dim, 0) });
  const close = (evidence: string): Operation[] => [{ op: "close_node", node_id: id, reason: "retracted", evidence }];

  await rejectsWith(
    () => validateExtraction({ db: handle.db, text: "Design 5 is due Monday.", operations: close("Design 5 peer reviews were cancelled") }),
    422,
    "invalid_request",
    /evidence must quote/,
  );
  await rejectsWith(
    () => validateExtraction({ db: handle.db, text: "Forget that, Vedant moved.", operations: close("forget") }),
    422,
    "invalid_request",
    /evidence must quote/,
  );
  await validateExtraction({
    db: handle.db,
    text: "Forget that — Vedant doesn’t   actually like orange juice.",
    operations: close("Vedant doesn't actually like orange juice"),
  });
});

test("a created plan or memory that repeats a live one is rejected unless the batch closes it", async () => {
  await resetGraph(handle.sql);
  const quiz = await insertPlan(handle.db, { title: QUIZ, embedding: axisVector(dim, 0), occurredAt: new Date(QUIZ_AT) });
  await insertMemory(handle.db, { title: "CSE 300 — term: Fall 2026", embedding: axisVector(dim, 1), occurredAt: null });
  const createQuiz = (title: string, occurredAt: string): Operation => ({
    op: "create_node",
    temp_id: "quiz",
    kind: "plan",
    title,
    occurred_at: occurredAt,
    detail: { status: "confirmed" },
  });

  await rejectsWith(
    () =>
      validateExtraction({
        db: handle.db,
        text: "quiz",
        operations: [createQuiz("CSE 300 - Quiz: Source Citations (Kritik) due", "2026-10-03T00:30:00-04:00")],
      }),
    422,
    "duplicate_node",
    new RegExp(quiz),
  );
  await rejectsWith(
    () =>
      validateExtraction({
        db: handle.db,
        text: "term",
        operations: [{ op: "create_node", temp_id: "term", kind: "memory", title: "CSE 300 — term: Fall 2026" }],
      }),
    422,
    "duplicate_node",
  );
  await rejectsWith(
    () =>
      validateExtraction({
        db: handle.db,
        text: "two",
        operations: [
          { op: "create_node", temp_id: "a", kind: "memory", title: "Ankur Desai likes chai" },
          { op: "create_node", temp_id: "b", kind: "memory", title: "Ankur Desai likes chai." },
        ],
      }),
    422,
    "duplicate_node",
    /same batch/,
  );

  await validateExtraction({ db: handle.db, text: "next week", operations: [createQuiz(QUIZ, "2026-10-09T23:59:00-04:00")] });
  await validateExtraction({
    db: handle.db,
    text: "Correction: the Source Citations quiz is replaced.",
    operations: [
      { op: "close_node", node_id: quiz, reason: "replaced", evidence: "the Source Citations quiz is replaced" },
      createQuiz(QUIZ, QUIZ_AT),
    ],
  });
});

test("ingest re-extracts once with a lookalike it was not shown, and fails if the second pass still duplicates it", async () => {
  await resetGraph(handle.sql);
  const quiz = await insertPlan(handle.db, { title: QUIZ, embedding: axisVector(dim, 2), occurredAt: new Date(QUIZ_AT) });
  const create: Operation = {
    op: "create_node",
    temp_id: "quiz",
    kind: "plan",
    title: QUIZ,
    occurred_at: QUIZ_AT,
    detail: { status: "confirmed" },
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

  await rejectsWith(() => run([[create], [create]], []), 422, "duplicate_node");
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
      extraIds: [],
    });
    return candidates.nodes.map((candidate) => candidate.id);
  };

  assert.deepEqual(await candidateIds("Ankur has a quiz on Friday."), [ankur]);
  assert.deepEqual(await candidateIds("Ankurbhai called about it."), []);
  assert.ok(!(await candidateIds("Ankur and Shahid met.")).includes(riya));
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
