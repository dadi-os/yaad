/**
 * Extraction eval: runs the current `prompts/extraction.md` through Dwar on cases taken
 * from real ingests that went wrong (see `extraction-cases.json`) and checks what it
 * emits. It writes nothing; it needs Dwar reachable at its mesh address and `TZ` set to
 * the box's zone. `npm run eval:extraction -- --runs=3` repeats each case to expose
 * flaky choices. Exits 1 when any expectation fails in any run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadFileConfig } from "../src/config.js";
import { createDwarClient } from "../src/dwar/client.js";
import type { CandidateState } from "../src/ingest/candidates.js";
import { emitOperations } from "../src/ingest/emit.js";
import type { Operation } from "../src/ingest/operations.js";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const nodeKind = z.enum(["person", "memory", "plan", "place"]);

/** Which emitted operations an expectation is about; `title` and `text` (title and body) are case-insensitive regexes. */
const matcherSchema = z
  .object({
    op: z.enum(["create_node", "update_node", "close_node", "create_edge", "close_edge", "noop"]),
    kind: nodeKind.optional(),
    node_id: z.string().uuid().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    /** Only operations that set this field (e.g. `occurred_at` on an update). */
    sets: z.string().optional(),
  })
  .strict();

/** What a matched operation must look like. Local dates and times are read in `TZ`. */
const checkSchema = z
  .object({
    all_day: z.boolean().optional(),
    local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    local_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    not_local_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    occurred_at_null: z.literal(true).optional(),
    has_end_at: z.literal(true).optional(),
    ttl_days: z.literal(true).optional(),
    aliases_include: z.string().optional(),
    recurrence_includes: z.string().optional(),
  })
  .strict();

/**
 * `none`: no operation matches. `some`: at least one matches and passes the check.
 * `each`: every match passes the check (none matching also passes).
 */
const expectationSchema = z
  .object({
    expect: z.enum(["none", "some", "each"]),
    match: matcherSchema,
    check: checkSchema.optional(),
    /** The audit finding this guards against, in a sentence. */
    why: z.string().min(1),
  })
  .strict();

/** Candidate node shorthand: the fields extraction reads; the runner fills fixed metadata. */
const candidateNodeSchema = z
  .object({
    id: z.string().uuid(),
    kind: nodeKind,
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    occurred_at: z.string().nullable().optional(),
    detail: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

const candidateEdgeSchema = z
  .object({
    id: z.string().uuid(),
    src_id: z.string().uuid(),
    dst_id: z.string().uuid(),
    type: z.string().min(1),
    properties: z.record(z.unknown()),
  })
  .strict();

const casesSchema = z
  .object({
    cases: z.array(
      z
        .object({
          name: z.string().min(1),
          /** Audit finding ids this case reproduces. */
          finding: z.string().min(1),
          occurred_at: z.string().datetime({ offset: true }),
          text: z.string().min(1),
          candidates: z.object({ nodes: z.array(candidateNodeSchema), edges: z.array(candidateEdgeSchema) }).strict(),
          expectations: z.array(expectationSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();

type Expectation = z.infer<typeof expectationSchema>;
type Case = z.infer<typeof casesSchema>["cases"][number];

/** Fixed metadata for candidate records; extraction decides from ids, titles, dates, and details. */
const FIXTURE_AT = "2026-09-30T00:00:00.000Z";

/** The case's candidate shorthand as the full records ingest hands extraction. */
function expandCandidates(candidates: Case["candidates"]): CandidateState {
  return {
    nodes: candidates.nodes.map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      title: candidate.title,
      body: candidate.body ?? null,
      occurred_at: candidate.occurred_at ?? null,
      expires_at: null,
      access_count: 0,
      last_accessed_at: null,
      source: "agent" as const,
      agent_id: null,
      created_at: FIXTURE_AT,
      updated_at: FIXTURE_AT,
      detail: (candidate.detail ?? null) as CandidateState["nodes"][number]["detail"],
    })),
    edges: candidates.edges.map((candidate) => ({
      ...candidate,
      confidence: 1,
      created_at: FIXTURE_AT,
      valid_from: FIXTURE_AT,
      valid_to: null,
    })),
  };
}

/** The operation's plan detail, whichever op carries it. */
function detailOf(op: Operation): Record<string, unknown> {
  return "detail" in op && op.detail !== null && typeof op.detail === "object"
    ? (op.detail as Record<string, unknown>)
    : {};
}

/** Local `YYYY-MM-DD` and `HH:MM` of an ISO instant, in the process zone (`TZ`). */
function localParts(iso: string): { date: string; time: string } {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

/** True when `op` is one the matcher is about. */
function matches(op: Operation, match: Expectation["match"]): boolean {
  if (op.op !== match.op) {
    return false;
  }
  if (match.kind !== undefined && !(op.op === "create_node" && op.kind === match.kind)) {
    return false;
  }
  if (match.node_id !== undefined && !("node_id" in op && op.node_id === match.node_id)) {
    return false;
  }
  if (match.title !== undefined) {
    const title = "title" in op && typeof op.title === "string" ? op.title : "";
    if (!new RegExp(match.title, "i").test(title)) {
      return false;
    }
  }
  if (match.text !== undefined) {
    const title = "title" in op && typeof op.title === "string" ? op.title : "";
    const body = "body" in op && typeof op.body === "string" ? op.body : "";
    if (!new RegExp(match.text, "i").test(`${title}\n${body}`)) {
      return false;
    }
  }
  if (match.sets !== undefined && !(match.sets in op || match.sets in detailOf(op))) {
    return false;
  }
  return true;
}

/** Why `op` fails `check`, or null when it passes. */
function checkFailure(op: Operation, check: NonNullable<Expectation["check"]>): string | null {
  const detail = detailOf(op);
  const occurredAt = "occurred_at" in op ? op.occurred_at : undefined;
  const local = typeof occurredAt === "string" ? localParts(occurredAt) : null;
  if (check.all_day !== undefined && (detail.all_day === true) !== check.all_day) {
    return `all_day is ${String(detail.all_day)}`;
  }
  if (check.local_date !== undefined && local?.date !== check.local_date) {
    return `local date is ${local?.date ?? "unset"}`;
  }
  if (check.local_time !== undefined && local?.time !== check.local_time) {
    return `local time is ${local?.time ?? "unset"}`;
  }
  if (check.not_local_time !== undefined && local?.time === check.not_local_time) {
    return `local time is ${check.not_local_time}`;
  }
  if (check.occurred_at_null && occurredAt) {
    return `occurred_at is ${occurredAt}`;
  }
  if (check.has_end_at && !detail.end_at) {
    return "no end_at";
  }
  if (check.ttl_days && !("ttl_days" in op && typeof op.ttl_days === "number")) {
    return "no ttl_days";
  }
  if (check.aliases_include !== undefined) {
    const aliases = Array.isArray(detail.aliases) ? detail.aliases : [];
    if (!aliases.includes(check.aliases_include)) {
      return `aliases are ${JSON.stringify(aliases)}`;
    }
  }
  if (check.recurrence_includes !== undefined) {
    const recurrence = typeof detail.recurrence === "string" ? detail.recurrence : "";
    if (!recurrence.includes(check.recurrence_includes)) {
      return `recurrence is ${recurrence || "unset"}`;
    }
  }
  return null;
}

/** Failure messages for one expectation against one run's operations; empty when it holds. */
function evaluate(expectation: Expectation, operations: Operation[]): string[] {
  const matched = operations.filter((op) => matches(op, expectation.match));
  if (expectation.expect === "none") {
    return matched.map((op) => `unexpected ${JSON.stringify(op)}`);
  }
  const check = expectation.check ?? {};
  const failures = matched.flatMap((op) => {
    const failure = checkFailure(op, check);
    return failure ? [`${failure}: ${JSON.stringify(op)}`] : [];
  });
  if (expectation.expect === "each") {
    return failures;
  }
  return matched.length > failures.length ? [] : [matched.length === 0 ? "no matching operation" : failures.join("; ")];
}

if (!process.env.TZ) {
  throw new Error("TZ is required: set it to the box's IANA zone so local dates read as the box reads them");
}
const runsArg = process.argv.find((arg) => arg.startsWith("--runs="));
const runs = runsArg ? Number(runsArg.slice("--runs=".length)) : 1;
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error(`--runs must be a positive integer, got ${runsArg}`);
}

const fileConfig = loadFileConfig();
const dwar = createDwarClient(fileConfig);
const { cases } = casesSchema.parse(JSON.parse(readFileSync(join(serviceRoot, "evals/extraction-cases.json"), "utf8")));

let failedRuns = 0;
for (const testCase of cases) {
  for (let run = 1; run <= runs; run++) {
    const operations = await emitOperations({
      dwar,
      config: { serviceRoot },
      occurredAt: testCase.occurred_at,
      text: testCase.text,
      candidates: expandCandidates(testCase.candidates),
      recheck: false,
    });
    const failures = testCase.expectations.flatMap((expectation) =>
      evaluate(expectation, operations).map((detail) => `  ✗ ${expectation.why}\n      ${detail}`),
    );
    const label = `${testCase.name} (${testCase.finding})${runs > 1 ? ` run ${run}/${runs}` : ""}`;
    if (failures.length === 0) {
      console.log(`PASS ${label}`);
    } else {
      failedRuns += 1;
      const emitted = operations.map((op) => `      ${JSON.stringify(op)}`).join("\n");
      console.log(`FAIL ${label}\n${failures.join("\n")}\n    emitted:\n${emitted}`);
    }
  }
}
console.log(`\n${cases.length * runs - failedRuns}/${cases.length * runs} runs passed`);
process.exitCode = failedRuns > 0 ? 1 : 0;
