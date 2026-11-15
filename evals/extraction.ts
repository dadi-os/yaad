/**
 * Extraction eval: runs the current extraction prompt (`prompts/memory.md` and `prompts/extraction.md`) through Dwar on cases taken
 * from real ingests that went wrong (see `extraction-cases.json`) and checks what it
 * emits. It writes nothing; it needs Dwar reachable at its mesh address and `TZ` set to
 * the box's zone. `npm run eval:extraction -- --runs=3` repeats each case to expose
 * flaky choices; `--case=<name>,<name>` runs only those cases. A run fails when its
 * extraction is malformed, when Yaad would reject or re-extract the batch (see
 * {@link rejections}), or when any expectation fails. Exits 1 when any run fails.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadFileConfig } from "../src/config.js";
import { createDwarClient } from "../src/dwar/client.js";
import type { CandidateState } from "../src/ingest/candidates.js";
import { YaadError } from "../src/errors.js";
import { emitOperations } from "../src/ingest/emit.js";
import {
  personDetailBody,
  placeDetailBody,
  planDetailBody,
  taskDetailBody,
  type Operation,
} from "../src/ingest/operations.js";
import { clampWindows, normalizeQuote, pastCloses, unlinkedCreates } from "../src/ingest/validate.js";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const nodeKind = z.enum(["person", "memory", "plan", "place", "task"]);

const opName = z.enum(["create_node", "update_node", "close_node", "create_edge", "close_edge", "spawn_plans", "update_plans", "noop"]);

const localDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTimeString = z.string().regex(/^\d{2}:\d{2}$/);
const weekday = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

/**
 * Which emitted operations an expectation is about; `op` is one op or any of several,
 * and `title` and `text` (title and body) are case-insensitive regexes.
 */
const matcherSchema = z
  .object({
    op: z.union([opName, z.array(opName).min(1)]),
    kind: nodeKind.optional(),
    /** The node an operation changes, or a `noop` lists in `node_ids`. */
    node_id: z.string().uuid().optional(),
    /** The course a `spawn_plans` or `update_plans` is about. */
    hub: z.string().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    /** Edge type, on `create_edge`. */
    type: z.string().optional(),
    /** Destination node id, exactly, on `create_edge`. */
    dst: z.string().uuid().optional(),
    /** Only operations that set this field, at the top level or in `detail` (e.g. `done` on an update). */
    sets: z.string().optional(),
  })
  .strict();

/** What a matched operation must look like. Local dates and times are read in `TZ`. */
const checkSchema = z
  .object({
    all_day: z.boolean().optional(),
    /** Local date and time of `occurred_at` (a plan's start). */
    local_date: localDateString.optional(),
    local_time: localTimeString.optional(),
    not_local_time: localTimeString.optional(),
    occurred_at_null: z.literal(true).optional(),
    has_end_at: z.literal(true).optional(),
    ttl_days: z.literal(true).optional(),
    aliases_include: z.string().optional(),
    /** Local date and time of a task's `detail.closes_at`. */
    closes_local_date: localDateString.optional(),
    closes_local_time: localTimeString.optional(),
    /** A task's `detail.opens_on`, exactly. */
    opens_on: localDateString.optional(),
    /** `detail.closes_at` is after the utterance's `occurred_at`. */
    closes_after_utterance: z.literal(true).optional(),
    /** The task opens on or before its close day, at most this many days before it. */
    opens_within_days: z.number().int().min(0).optional(),
    /** The task opens on its close day. */
    one_day: z.literal(true).optional(),
    /** `detail.done` is absent or false. */
    not_done: z.literal(true).optional(),
    /** `detail.done` is true. */
    done_true: z.literal(true).optional(),
    /** `detail.done` is false (a cleared mark). */
    done_false: z.literal(true).optional(),
    /** `detail` keys that must be present and null. */
    nulls: z.array(z.string()).min(1).optional(),
    /** A `spawn_plans` date list. */
    dates: z
      .object({
        count: z.number().int().positive().optional(),
        include: z.array(localDateString).optional(),
        exclude: z.array(localDateString).optional(),
        first: localDateString.optional(),
        last: localDateString.optional(),
        weekdays: z.array(weekday).min(1).optional(),
      })
      .strict()
      .optional(),
    /** Case-insensitive regexes over fields the operation carries (a spawn's `start_time`, an update's `from_date`). */
    fields: z.record(z.string()).optional(),
    /** Case-insensitive regexes over the operation's `detail` (a plan's `rsvp`, a place's `address`). */
    detail: z.record(z.string()).optional(),
    /** Case-insensitive regexes over an `update_plans` change (`set`). */
    set: z.record(z.string()).optional(),
    /** Case-insensitive regexes over an edge's `properties` (a location's `room`). */
    properties: z.record(z.string()).optional(),
  })
  .strict();

/**
 * `none`: no operation matches. `some`: at least one matches and passes the check.
 * `each`: every match passes the check (none matching also passes). `varied`: at least two
 * match and they do not all carry the same `detail[field]` (syllabus deadlines that must not
 * all open on one day).
 */
const expectationSchema = z
  .object({
    expect: z.enum(["none", "some", "each", "varied"]),
    match: matcherSchema,
    check: checkSchema.optional(),
    field: z.string().optional(),
    /** The audit finding this guards against, in a sentence. */
    why: z.string().min(1),
  })
  .strict()
  .refine((expectation) => (expectation.expect === "varied") === (expectation.field !== undefined), "varied needs field, and only varied takes one");

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
          /** Audit finding ids or the source this case reproduces. */
          finding: z.string().min(1),
          occurred_at: z.string().datetime({ offset: true }),
          text: z.string().min(1),
          /** Ankur's own words, verbatim, as the caller would send them; absent when the case has none. */
          source_text: z.string().min(1).optional(),
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

/** The process zone (`TZ`), in which the box reads local dates. */
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

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

/** The operation's detail, whichever op carries it. */
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

/** Whole days from local date `from` to local date `to`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Three-letter weekday of a local date. */
function weekdayOf(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

/** True when `op` is one the matcher is about. */
function matches(op: Operation, match: Expectation["match"]): boolean {
  if (!(Array.isArray(match.op) ? match.op.includes(op.op) : op.op === match.op)) {
    return false;
  }
  if (match.kind !== undefined && !(op.op === "create_node" && op.kind === match.kind)) {
    return false;
  }
  if (match.node_id !== undefined && !("node_id" in op ? op.node_id === match.node_id : op.op === "noop" && op.node_ids?.includes(match.node_id) === true)) {
    return false;
  }
  if (match.hub !== undefined && !("hub" in op && op.hub === match.hub)) {
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
    const setBody = op.op === "update_plans" && typeof op.set.body === "string" ? op.set.body : "";
    if (!new RegExp(match.text, "i").test(`${title}\n${body}\n${setBody}`)) {
      return false;
    }
  }
  if (match.type !== undefined && !(op.op === "create_edge" && op.type === match.type)) {
    return false;
  }
  if (match.dst !== undefined && !(op.op === "create_edge" && op.dst === match.dst)) {
    return false;
  }
  if (match.sets !== undefined && !(match.sets in op || match.sets in detailOf(op))) {
    return false;
  }
  return true;
}

/** Why `op`'s `spawn_plans` dates fail `check`, or null when they pass. */
function datesFailure(op: Operation, check: NonNullable<NonNullable<Expectation["check"]>["dates"]>): string | null {
  if (op.op !== "spawn_plans") {
    return `${op.op} has no dates`;
  }
  const dates = [...op.dates].sort();
  if (check.count !== undefined && dates.length !== check.count) {
    return `${dates.length} dates, expected ${check.count}`;
  }
  const missing = (check.include ?? []).filter((date) => !dates.includes(date));
  if (missing.length > 0) {
    return `dates lack ${missing.join(", ")}`;
  }
  const extra = (check.exclude ?? []).filter((date) => dates.includes(date));
  if (extra.length > 0) {
    return `dates include ${extra.join(", ")}`;
  }
  if (check.first !== undefined && dates[0] !== check.first) {
    return `first date is ${dates[0]}`;
  }
  if (check.last !== undefined && dates.at(-1) !== check.last) {
    return `last date is ${dates.at(-1)}`;
  }
  const offDay = check.weekdays === undefined ? undefined : dates.find((date) => !check.weekdays?.includes(weekdayOf(date) as z.infer<typeof weekday>));
  if (offDay !== undefined) {
    return `${offDay} is a ${weekdayOf(offDay)}`;
  }
  return null;
}

/** Why `op` fails `check`, or null when it passes. */
function checkFailure(op: Operation, check: NonNullable<Expectation["check"]>, utteranceAt: string): string | null {
  const detail = detailOf(op);
  const occurredAt = "occurred_at" in op ? op.occurred_at : undefined;
  const local = typeof occurredAt === "string" ? localParts(occurredAt) : null;
  const closes = typeof detail.closes_at === "string" ? localParts(detail.closes_at) : null;
  const opensOn = typeof detail.opens_on === "string" ? detail.opens_on : null;
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
  if (check.closes_local_date !== undefined && closes?.date !== check.closes_local_date) {
    return `closes local date is ${closes?.date ?? "unset"}`;
  }
  if (check.closes_local_time !== undefined && closes?.time !== check.closes_local_time) {
    return `closes local time is ${closes?.time ?? "unset"}`;
  }
  if (check.closes_after_utterance && !(typeof detail.closes_at === "string" && Date.parse(detail.closes_at) > Date.parse(utteranceAt))) {
    return `closes_at ${String(detail.closes_at)} is not after the utterance time ${utteranceAt}`;
  }
  if (check.opens_on !== undefined && opensOn !== check.opens_on) {
    return `opens_on is ${opensOn ?? "unset"}`;
  }
  if (check.opens_within_days !== undefined) {
    if (opensOn === null || closes === null) {
      return `window is ${opensOn ?? "unset"} to ${closes?.date ?? "unset"}`;
    }
    const lead = daysBetween(opensOn, closes.date);
    if (lead < 0 || lead > check.opens_within_days) {
      return `opens ${lead} days before its close (${opensOn} to ${closes.date})`;
    }
  }
  if (check.one_day && (opensOn === null || opensOn !== closes?.date)) {
    return `window is ${opensOn ?? "unset"} to ${closes?.date ?? "unset"}`;
  }
  if (check.not_done && detail.done !== undefined && detail.done !== false) {
    return `done is ${String(detail.done)}`;
  }
  if (check.done_true && detail.done !== true) {
    return `done is ${String(detail.done)}`;
  }
  if (check.done_false && detail.done !== false) {
    return `done is ${String(detail.done)}`;
  }
  for (const key of check.nulls ?? []) {
    if (detail[key] !== null) {
      return `detail ${key} is ${JSON.stringify(detail[key])}, not null`;
    }
  }
  if (check.dates !== undefined) {
    const failure = datesFailure(op, check.dates);
    if (failure !== null) {
      return failure;
    }
  }
  const fields = op as Record<string, unknown>;
  const properties = op.op === "create_edge" ? (op.properties ?? {}) : {};
  const set = op.op === "update_plans" ? (op.set as Record<string, unknown>) : {};
  for (const [label, expected, actual] of [
    ["field", check.fields, fields],
    ["detail", check.detail, detail],
    ["set", check.set, set],
    ["property", check.properties, properties],
  ] as const) {
    for (const [key, value] of Object.entries(expected ?? {})) {
      if (actual[key] === undefined || !new RegExp(value, "i").test(String(actual[key]))) {
        return `${label} ${key} is ${JSON.stringify(actual[key])}`;
      }
    }
  }
  return null;
}

/** Failure messages for one expectation against one run's operations; empty when it holds. */
function evaluate(expectation: Expectation, operations: Operation[], utteranceAt: string): string[] {
  const matched = operations.filter((op) => matches(op, expectation.match));
  if (expectation.expect === "none") {
    return matched.map((op) => `unexpected ${JSON.stringify(op)}`);
  }
  if (expectation.expect === "varied") {
    const field = expectation.field ?? "";
    const values = new Set(matched.map((op) => JSON.stringify(detailOf(op)[field] ?? null)));
    return matched.length >= 2 && values.size >= 2
      ? []
      : [`${matched.length} matches share ${field} ${[...values].join(", ") || "none"}`];
  }
  const check = expectation.check ?? {};
  const failures = matched.flatMap((op) => {
    const failure = checkFailure(op, check, utteranceAt);
    return failure ? [`${failure}: ${JSON.stringify(op)}`] : [];
  });
  if (expectation.expect === "each") {
    return failures;
  }
  return matched.length > failures.length ? [] : [matched.length === 0 ? "no matching operation" : failures.join("; ")];
}

/**
 * What Yaad would do with this batch that the database is not needed to tell: reject it
 * (a detail it does not accept, a plan with no start, a task with an occurred_at or a close
 * and no open on or before its day, a session template that makes no sense, an id that is
 * neither a candidate nor a temp_id, a `close_node` whose evidence is not in the text) or
 * run extraction again (a created node with no edge). Duplicate checks need the database
 * and are left to `expectations`.
 */
function rejections(operations: Operation[], testCase: Case): string[] {
  const out: string[] = [];
  const nodeIds = new Set(testCase.candidates.nodes.map((candidate) => candidate.id));
  for (const candidate of testCase.candidates.edges) {
    nodeIds.add(candidate.src_id);
    nodeIds.add(candidate.dst_id);
  }
  const edgeIds = new Set(testCase.candidates.edges.map((candidate) => candidate.id));
  const tempIds = new Set(operations.flatMap((op) => (op.op === "create_node" ? [op.temp_id] : [])));
  const known = (id: string) => nodeIds.has(id) || tempIds.has(id);
  const text = normalizeQuote(testCase.text);
  for (const op of operations) {
    const label = JSON.stringify(op);
    if (op.op === "create_node") {
      const schema = { person: personDetailBody, plan: planDetailBody, task: taskDetailBody, place: placeDetailBody, memory: null }[op.kind];
      if (schema === null ? op.detail !== undefined : !schema.safeParse(op.detail ?? {}).success) {
        out.push(`detail Yaad rejects: ${label}`);
      }
      if (op.kind === "plan" && !op.occurred_at) {
        out.push(`a plan needs occurred_at: ${label}`);
      }
      if (op.kind === "task") {
        const detail = detailOf(op);
        if (op.occurred_at) {
          out.push(`a task has no occurred_at: ${label}`);
        }
      }
    }
    if ((op.op === "update_node" || op.op === "close_node") && !nodeIds.has(op.node_id)) {
      out.push(`unknown node_id: ${label}`);
    }
    if (op.op === "close_node" && !text.includes(normalizeQuote(op.evidence))) {
      out.push(`evidence not in the text: ${label}`);
    }
    if (op.op === "create_edge" && (!known(op.src) || !known(op.dst))) {
      out.push(`unknown edge endpoint: ${label}`);
    }
    if (op.op === "close_edge" && !edgeIds.has(op.edge_id)) {
      out.push(`unknown edge_id: ${label}`);
    }
    if (op.op === "spawn_plans") {
      if (!known(op.hub) || (op.place !== undefined && !known(op.place))) {
        out.push(`unknown hub or place: ${label}`);
      }
      if (new Set(op.dates).size !== op.dates.length || (op.end_time !== undefined && op.end_time <= op.start_time) || (op.room !== undefined && op.place === undefined)) {
        out.push(`malformed session template: ${label}`);
      }
    }
    if (op.op === "update_plans" && !nodeIds.has(op.hub)) {
      out.push(`unknown hub: ${label}`);
    }
  }
  for (const op of unlinkedCreates(operations)) {
    out.push(`created node has no edge (Yaad re-extracts): ${JSON.stringify(op)}`);
  }
  return out;
}

if (!process.env.TZ) {
  throw new Error("TZ is required: set it to the box's IANA zone so local dates read as the box reads them");
}
const runsArg = process.argv.find((arg) => arg.startsWith("--runs="));
const runs = runsArg ? Number(runsArg.slice("--runs=".length)) : 1;
if (!Number.isInteger(runs) || runs < 1) {
  throw new Error(`--runs must be a positive integer, got ${runsArg}`);
}
const caseArg = process.argv.find((arg) => arg.startsWith("--case="));
const only = caseArg ? new Set(caseArg.slice("--case=".length).split(",")) : null;

const fileConfig = loadFileConfig();
const dwar = createDwarClient(fileConfig);
const parsed = casesSchema.parse(JSON.parse(readFileSync(join(serviceRoot, "evals/extraction-cases.json"), "utf8")));
const unknownCases = only === null ? [] : [...only].filter((name) => !parsed.cases.some((testCase) => testCase.name === name));
if (unknownCases.length > 0) {
  throw new Error(`--case names no case: ${unknownCases.join(", ")}`);
}
const cases = parsed.cases.filter((testCase) => only === null || only.has(testCase.name));

let failedRuns = 0;
for (const testCase of cases) {
  for (let run = 1; run <= runs; run++) {
    const label = `${testCase.name} (${testCase.finding})${runs > 1 ? ` run ${run}/${runs}` : ""}`;
    let operations: Operation[];
    try {
      operations = await emitOperations({
        dwar,
        config: { serviceRoot },
        occurredAt: testCase.occurred_at,
        text: testCase.text,
        sourceText: testCase.source_text,
        candidates: expandCandidates(testCase.candidates),
        recheck: null,
      });
    } catch (err) {
      if (!(err instanceof YaadError && err.type === "extraction_failed")) {
        throw err;
      }
      failedRuns += 1;
      console.log(`FAIL ${label}\n  ✗ extraction failed: ${err.message}`);
      continue;
    }
    const stored = new Map(
      testCase.candidates.nodes.flatMap((candidate) => (candidate.kind === "task" ? [[candidate.id, (candidate.detail?.opens_on as string | null | undefined) ?? null] as const] : [])),
    );
    const settled = clampWindows(pastCloses(operations, testCase.occurred_at, testCase.source_text, zone).operations, {
      text: [testCase.text, testCase.source_text].filter((part) => part !== undefined).join("\n"),
      occurredAt: testCase.occurred_at,
      timeZone: zone,
      storedOpens: stored,
    }).operations;
    const failures = [
      ...rejections(operations, testCase).map((detail) => `  ✗ Yaad would not apply this batch\n      ${detail}`),
      ...testCase.expectations.flatMap((expectation) =>
        evaluate(expectation, settled, testCase.occurred_at).map((detail) => `  ✗ ${expectation.why}\n      ${detail}`),
      ),
    ];
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
