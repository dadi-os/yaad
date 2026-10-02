import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildApp } from "../src/app.js";
import type { LintFinding } from "../src/types/domain.js";
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

const config = testConfig();
const dim = config.embedding.dimension;
const handle = await openTestDb();

before(async () => {
  await resetGraph(handle.sql);
});

after(async () => {
  await handle.close();
});

test("GET /lint flags snapshots, working notes, noon placeholders, dated hubs, duplicates, and unaliased people", async () => {
  await resetGraph(handle.sql);
  const memory = (title: string, axis: number, expiresAt: Date | null = null) =>
    insertMemory(handle.db, { title, embedding: axisVector(dim, axis), occurredAt: null, expiresAt });

  const snapshot = await memory("CSE 380 — D2L status as of Sept 29: no assignments posted", 0);
  await memory("CSE 380 — lab status as of Oct 1", 1, new Date(Date.now() + 86_400_000));
  const note = await memory("CSE 335 Step 4 is on branch feat/step-4 in /var/lib/dadi/code/cse-335", 2);
  const termA = await memory("CSE 300 — term: Fall 2026", 3);
  const termB = await memory("CSE 300 - term: Fall 2026 (fall)", 4);
  await memory("Ankur Desai likes chai", 5);

  const noon = await insertPlan(handle.db, {
    title: "IBIO 150 Exam 1",
    embedding: axisVector(dim, 6),
    occurredAt: new Date("2026-09-30T16:00:00.000Z"),
  });
  await insertPlan(handle.db, {
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
  for (const facet of [termA, termB, snapshot]) {
    await insertEdge(handle.db, { src: hub, dst: facet, type: "HAS_FACET" });
  }

  const ankur = await insertPerson(handle.db, { title: "Ankur Desai", embedding: axisVector(dim, 9) });
  await insertPerson(handle.db, { title: "Sparsh Yandooru", embedding: axisVector(dim, 10), aliases: ["Sparsh"] });

  const app = await buildApp(config, { db: handle.db, sql: handle.sql, dwar: mockDwar({ dimension: dim }) });
  const res = await app.inject({ method: "GET", url: "/lint" });
  assert.equal(res.statusCode, 200, res.body);
  const findings = (res.json() as { findings: LintFinding[] }).findings;
  const flagged = (rule: LintFinding["rule"]) =>
    findings.filter((finding) => finding.rule === rule).map((finding) => finding.node_ids);

  assert.deepEqual(flagged("status_snapshot"), [[snapshot]]);
  assert.deepEqual(flagged("working_note"), [[note]]);
  assert.deepEqual(flagged("noon_placeholder"), [[noon]]);
  assert.deepEqual(flagged("dated_hub"), [[hub]]);
  assert.deepEqual(
    flagged("duplicate").map((ids) => [...ids].sort()),
    [[termA, termB].sort()],
  );
  assert.deepEqual(flagged("unaliased_person"), [[ankur]]);
  await app.close();
});
