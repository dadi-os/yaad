import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import type { LintFinding } from "../src/types/domain.js";
import {
  axisVector,
  insertEdge,
  insertMemory,
  insertPerson,
  insertPlace,
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

test("GET /lint flags snapshots, working notes, agent instructions, noon placeholders, dated hubs, long spans, duplicate series, duplicates, unaliased people, places without an address, and floating nodes", async () => {
  await resetGraph(handle.sql);
  const memory = (title: string, axis: number, expiresAt: Date | null = null) =>
    insertMemory(handle.db, { title, embedding: axisVector(dim, axis), occurredAt: null, expiresAt });

  const snapshot = await memory("CSE 380 — D2L status as of Sept 29: no assignments posted", 0);
  const labStatus = await memory("CSE 380 — lab status as of Oct 1", 1, new Date(Date.now() + 86_400_000));
  const note = await memory("CSE 335 Step 4 is on branch feat/step-4 in /var/lib/dadi/code/cse-335", 2);
  const termA = await memory("CSE 300 — term: Fall 2026", 3);
  const termB = await memory("CSE 300 - term: Fall 2026 (fall)", 4);
  const chai = await memory("Ankur Desai likes chai", 5);
  const sourceNote = await memory("Chello — the parser lives in src/parse.ts at line 40", 12);
  const ibm = await memory("IBM Intern Data Specialist 2027 application (ref 137428)", 13);
  const instruction = await memory("Ankur wants agents to never place Hold blocks on his planner", 14);
  const dropPeriod = await insertPlan(handle.db, {
    title: "MSU Fall 2026 — drop with penalty period",
    embedding: axisVector(dim, 15),
    occurredAt: new Date("2026-10-20T04:00:00.000Z"),
    endAt: new Date("2026-12-18T05:00:00.000Z"),
    allDay: true,
  });
  const seriesA = await insertPlan(handle.db, {
    title: "CSE 300: Social, Ethical and Professional Issues in Computing (Fall 2026)",
    embedding: axisVector(dim, 16),
    occurredAt: new Date("2026-09-03T22:30:00.000Z"),
    endAt: new Date("2026-09-03T23:20:00.000Z"),
    recurrence: "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261210T235959Z",
  });
  const seriesB = await insertPlan(handle.db, {
    title: "CSE 300 — lecture (section 002), Wilson Hall C102",
    embedding: axisVector(dim, 17),
    occurredAt: new Date("2026-09-03T22:30:00.000Z"),
    endAt: new Date("2026-09-03T23:20:00.000Z"),
    recurrence: "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261210T235959Z",
  });
  const wilsonA = await insertPlace(handle.db, { title: "Wilson Hall C102", embedding: axisVector(dim, 18) });
  const wilsonB = await insertPlace(handle.db, { title: "Wilson Hall C102 (lecture room)", embedding: axisVector(dim, 19) });

  const noon = await insertPlan(handle.db, {
    title: "IBIO 150 Exam 1",
    embedding: axisVector(dim, 6),
    occurredAt: new Date("2026-09-30T16:00:00.000Z"),
  });
  const drop = await insertPlan(handle.db, {
    title: "CSE 335 — last day to drop",
    embedding: axisVector(dim, 7),
    occurredAt: new Date("2026-10-19T04:00:00.000Z"),
    allDay: true,
  });
  const hub = await insertPlan(handle.db, {
    title: "IBIO 150 (Fall 2026)",
    embedding: axisVector(dim, 8),
    occurredAt: new Date("2026-09-30T04:00:00.000Z"),
  });
  await insertEdge(handle.db, { src: hub, dst: noon, type: "HAS_ITEM" });
  const assignment = await insertPlan(handle.db, {
    title: "CSE 335 — Step 4 due",
    embedding: axisVector(dim, 11),
    occurredAt: new Date("2026-10-02T03:55:00.000Z"),
  });
  for (const facet of [termA, termB, snapshot]) {
    await insertEdge(handle.db, { src: assignment, dst: facet, type: "HAS_FACET" });
  }

  const room = await insertPlace(handle.db, { title: "Engineering Building 1345", embedding: axisVector(dim, 20) });
  const lecture = await insertPlan(handle.db, {
    title: "CSE 431 — graph review session",
    embedding: axisVector(dim, 21),
    occurredAt: new Date("2026-10-22T17:00:00.000Z"),
  });
  await insertEdge(handle.db, { src: lecture, dst: room, type: "AT_LOCATION", properties: { room: "1345" } });
  const holden = await insertPlace(handle.db, {
    title: "Holden Hall",
    embedding: axisVector(dim, 22),
    address: "234 W Circle Dr, East Lansing, MI 48824",
  });
  const lab = await insertPlan(handle.db, {
    title: "CSE 380 — lab make-up",
    embedding: axisVector(dim, 23),
    occurredAt: new Date("2026-10-23T13:10:00.000Z"),
  });
  await insertEdge(handle.db, { src: lab, dst: holden, type: "AT_LOCATION" });

  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 9) });
  const sparsh = await insertPerson(handle.db, { title: "Sparsh Yandooru", embedding: axisVector(dim, 10), aliases: ["Sparsh"] });

  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const res = await app.inject({ method: "GET", url: "/lint" });
  assert.equal(res.statusCode, 200, res.body);
  const findings = (res.json() as { findings: LintFinding[] }).findings;
  const flagged = (rule: LintFinding["rule"]) =>
    findings.filter((finding) => finding.rule === rule).map((finding) => finding.node_ids);

  assert.deepEqual(flagged("status_snapshot"), [[snapshot]]);
  assert.deepEqual(flagged("working_note").flat().sort(), [note, sourceNote].sort());
  assert.deepEqual(flagged("agent_instruction"), [[instruction]]);
  assert.deepEqual(flagged("noon_placeholder"), [[noon]]);
  assert.deepEqual(flagged("dated_hub"), [[hub]]);
  assert.deepEqual(flagged("long_span"), [[dropPeriod]]);
  assert.deepEqual(
    flagged("duplicate_series").map((ids) => [...ids].sort()),
    [[seriesA, seriesB].sort()],
  );
  assert.deepEqual(
    flagged("duplicate").map((ids) => [...ids].sort()).sort(),
    [[termA, termB].sort(), [wilsonA, wilsonB].sort()].sort(),
  );
  assert.deepEqual(flagged("unaliased_person"), [[ankur]]);
  assert.deepEqual(flagged("place_without_address"), [[room, lecture]]);
  assert.deepEqual(
    flagged("floating").flat().sort(),
    [labStatus, note, chai, drop, ankur, sparsh, sourceNote, ibm, instruction, dropPeriod, seriesA, seriesB, wilsonA, wilsonB].sort(),
  );
  await app.close();
});
