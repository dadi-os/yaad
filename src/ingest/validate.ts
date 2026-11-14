/**
 * Pre-apply checks. {@link validateOperations} is structural and runs on every batch
 * (ingest and hand edits); {@link validateExtraction} adds the guards that only apply to
 * what extraction emitted from an utterance.
 */

import type { Db } from "../db/client.js";
import { getEdge, getNode, getTaskDetail } from "../db/read.js";
import { localDate } from "../local-time.js";
import { YaadError } from "../errors.js";
import { parse } from "../routers/v1/schemas.js";
import { rejectDuplicates } from "./duplicates.js";
import {
  patchPersonDetailBody,
  patchPlaceDetailBody,
  patchPlanDetailBody,
  patchTaskDetailBody,
  personDetailBody,
  placeDetailBody,
  planDetailBody,
  taskDetailBody,
  type Operation,
} from "./operations.js";

/** Shortest `close_node` evidence quote accepted, so a stray word cannot stand in for a retraction. */
const MIN_EVIDENCE_CHARS = 8;

/**
 * Validate op batch before apply: unique temp_ids, kind-appropriate details, plans that have
 * a start, tasks whose window is well formed (a close needs an open on or before its day), TTL
 * only on memory/plan, edge endpoints that resolve to temp or live nodes, and spawned or
 * bulk-edited sessions whose hub, place and times make sense (whether a bulk edit matches any
 * session is checked on apply, after the batch's own creates). `timeZone` is the box's zone, in
 * which a task's close day is read.
 */
export async function validateOperations(opts: {
  db: Db;
  operations: Operation[];
  timeZone: string;
}): Promise<void> {
  const tempIds = new Set<string>();
  const spawnIds = new Set<string>();

  for (const op of opts.operations) {
    if (op.op === "create_node") {
      if (tempIds.has(op.temp_id)) {
        throw new YaadError(422, "invalid_request", `temp_id ${op.temp_id} is defined twice`);
      }
      tempIds.add(op.temp_id);
      if (op.kind === "memory" && op.detail !== undefined) {
        throw new YaadError(422, "invalid_request", `create_node ${op.temp_id}: memory nodes have no detail`);
      }
      if (op.kind === "person") {
        parse(personDetailBody, op.detail ?? {});
      }
      if (op.kind === "plan") {
        parse(planDetailBody, op.detail ?? {});
        if (!op.occurred_at) {
          throw new YaadError(422, "invalid_request", `create_node ${op.temp_id}: a plan needs occurred_at; something with no time is a task`);
        }
      }
      if (op.kind === "task") {
        const detail = parse(taskDetailBody, op.detail ?? {});
        assertTaskWindow(detail, `create_node ${op.temp_id}`, opts.timeZone);
        if (op.occurred_at) {
          throw new YaadError(422, "invalid_request", `create_node ${op.temp_id}: a task has no occurred_at; its window is opens_on and closes_at`);
        }
      }
      if (op.kind === "place") {
        parse(placeDetailBody, op.detail ?? {});
      }
      rejectTtlOnEntity(op.kind, op.ttl_days, `create_node ${op.temp_id}`);
    }
  }

  for (const op of opts.operations) {
    if (op.op === "create_edge") {
      await resolveEndpoint(opts.db, op.src, tempIds, "src");
      await resolveEndpoint(opts.db, op.dst, tempIds, "dst");
      if (op.src === op.dst) {
        throw new YaadError(422, "invalid_request", "create_edge src must not equal dst");
      }
    }
    if (op.op === "update_node") {
      const current = await requireCurrent(opts.db, op.node_id, "node");
      if (op.detail !== undefined) {
        if (current.kind === "memory") {
          throw new YaadError(422, "invalid_request", `update_node ${op.node_id}: memory nodes have no detail`);
        }
        if (current.kind === "person") {
          parse(patchPersonDetailBody, op.detail);
        }
        if (current.kind === "place") {
          parse(patchPlaceDetailBody, op.detail);
        }
        if (current.kind === "plan") {
          parse(patchPlanDetailBody, op.detail);
        }
        if (current.kind === "task") {
          const patch = parse(patchTaskDetailBody, op.detail);
          const stored = await getTaskDetail(opts.db, op.node_id);
          assertTaskWindow(
            {
              opens_on: patch.opens_on !== undefined ? patch.opens_on : stored.opensOn,
              closes_at: patch.closes_at !== undefined ? patch.closes_at : (stored.closesAt?.toISOString() ?? null),
            },
            `update_node ${op.node_id}`,
            opts.timeZone,
          );
        }
      }
      if (current.kind === "plan" && op.occurred_at === null) {
        throw new YaadError(422, "invalid_request", `update_node ${op.node_id}: a plan needs occurred_at`);
      }
      rejectTtlOnEntity(current.kind, op.ttl_days, `update_node ${op.node_id}`);
    }
    if (op.op === "close_node") {
      await requireCurrent(opts.db, op.node_id, "node");
    }
    if (op.op === "noop") {
      for (const id of op.node_ids ?? []) {
        const current = await requireCurrent(opts.db, id, "node");
        if (current.kind !== "task") {
          throw new YaadError(422, "invalid_request", `noop node_ids: ${id} is not a task`);
        }
      }
    }
    if (op.op === "spawn_plans") {
      const label = `spawn_plans ${op.temp_id}`;
      await resolveEndpoint(opts.db, op.hub, tempIds, "hub");
      if (op.place !== undefined) {
        await resolveEndpoint(opts.db, op.place, tempIds, "place");
        if (!tempIds.has(op.place) && (await getNode(opts.db, op.place)).kind !== "place") {
          throw new YaadError(422, "invalid_request", `${label}: place ${op.place} is not a place node`);
        }
      }
      if (new Set(op.dates).size !== op.dates.length) {
        throw new YaadError(422, "invalid_request", `${label}: dates must not repeat`);
      }
      if (op.end_time !== undefined && op.end_time <= op.start_time) {
        throw new YaadError(422, "invalid_request", `${label}: end_time must be after start_time`);
      }
      if (op.room !== undefined && op.place === undefined) {
        throw new YaadError(422, "invalid_request", `${label}: room needs a place`);
      }
      if (tempIds.has(op.temp_id) || spawnIds.has(op.temp_id)) {
        throw new YaadError(422, "invalid_request", `temp_id ${op.temp_id} is defined twice`);
      }
      spawnIds.add(op.temp_id);
    }
    if (op.op === "update_plans") {
      const label = `update_plans ${op.hub}`;
      await requireCurrent(opts.db, op.hub, "node");
      if (op.to_date !== undefined && op.to_date < op.from_date) {
        throw new YaadError(422, "invalid_request", `${label}: to_date must not be before from_date`);
      }
      const { start_time: start, end_time: end } = op.set;
      if (start !== undefined && end !== undefined && end !== null && end <= start) {
        throw new YaadError(422, "invalid_request", `${label}: end_time must be after start_time`);
      }
    }
    if (op.op === "close_edge") {
      try {
        await getEdge(opts.db, op.edge_id);
      } catch (err) {
        if (err instanceof YaadError && err.statusCode === 404) {
          throw new YaadError(422, "invalid_request", `edge ${op.edge_id} does not exist or is not current`);
        }
        throw err;
      }
    }
  }
}

/**
 * unlinkedCreates returns the batch's `create_node` operations that no `create_edge` in
 * the batch touches and no `spawn_plans` names as its hub or place (spawning links them to
 * every session). Such a node would float in the graph with nothing leading to it.
 */
export function unlinkedCreates(operations: Operation[]): Extract<Operation, { op: "create_node" }>[] {
  const linked = new Set<string>();
  for (const op of operations) {
    if (op.op === "create_edge") {
      linked.add(op.src);
      linked.add(op.dst);
    }
    if (op.op === "spawn_plans") {
      linked.add(op.hub);
      if (op.place !== undefined) {
        linked.add(op.place);
      }
    }
  }
  return operations.filter(
    (op): op is Extract<Operation, { op: "create_node" }> => op.op === "create_node" && !linked.has(op.temp_id),
  );
}

/** Words that say work was handed in; a node's title or body must not use them unless the utterance reports it. */
const SUBMISSION_WORDS = /\b(?:submitted|uploaded|turned in|handed in)\b/gi;

/** Wording that reports Ankur finished something; `uploaded` counts only with Ankur as its subject. */
const COMPLETION_WORDS = /\b(?:submitted|turned in|handed in|sent in|done|completed|finished|paid|applied|found|registered|signed up|(?:ankur|he|she|i)\s+(?:just\s+)?uploaded)\b/gi;

/** True when `word` at `index` in `text` is not negated ("not submitted", "not yet done", "never paid"). */
function affirmed(text: string, index: number): boolean {
  return !/\b(?:not|never|no|yet to be|un)\s+(?:yet\s+)?$|n't\s+(?:yet\s+)?$/i.test(text.slice(Math.max(0, index - 16), index));
}

/** True when `text` contains a pattern match that is not negated. */
function says(text: string, words: RegExp): boolean {
  return [...text.matchAll(words)].some((match) => affirmed(text, match.index));
}

/**
 * statusClaims returns the batch's creates and updates that record something as submitted or
 * done when the sources never report that Ankur did it: a `done_at` needs `sourceText` (Ankur's
 * own words, verbatim) to say so, and a title or body saying submitted needs `text` or `sourceText`
 * to. Where a thing is handed in, what a page shows, and an agent's paraphrase are not a
 * completion; the model sometimes writes them as one anyway.
 */
export function statusClaims(operations: Operation[], text: string, sourceText?: string): Operation[] {
  const ankurFinished = says(sourceText ?? "", COMPLETION_WORDS);
  const reported = ankurFinished || says(text, COMPLETION_WORDS);
  return operations.filter((op) => {
    if (op.op !== "create_node" && op.op !== "update_node") {
      return false;
    }
    const detail = op.detail as Record<string, unknown> | undefined;
    if (typeof detail?.done_at === "string" && !ankurFinished) {
      return true;
    }
    const written = [op.title, op.body].filter((value): value is string => typeof value === "string").join("\n");
    return !reported && says(written, SUBMISSION_WORDS);
  });
}

/**
 * dropClosedTasks returns `operations` without the tasks they create whose close is before
 * `occurredAt` (a deadline already past when the text is from is never stored), and without the
 * edges that name them. A batch left empty becomes one `noop`. Updating or ticking an existing
 * task is not affected.
 */
export function dropClosedTasks(operations: Operation[], occurredAt: string): Operation[] {
  const closed = new Set(
    operations.flatMap((op) => {
      const closes = op.op === "create_node" && op.kind === "task" ? (op.detail as { closes_at?: unknown } | undefined)?.closes_at : undefined;
      return op.op === "create_node" && typeof closes === "string" && Date.parse(closes) < Date.parse(occurredAt) ? [op.temp_id] : [];
    }),
  );
  if (closed.size === 0) {
    return operations;
  }
  const kept = operations.filter(
    (op) => !(op.op === "create_node" && closed.has(op.temp_id)) && !(op.op === "create_edge" && (closed.has(op.src) || closed.has(op.dst))),
  );
  return kept.length > 0 ? kept : [{ op: "noop", reason: "every task in the text closed before it" }];
}

/** Longest task window (open day to close day), in days, unless the text states the open. */
const MAX_WINDOW_DAYS = 28;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** True when `text` names the date `day` (`YYYY-MM-DD`): ISO, `M/D`, `Nov 13`, `November 13th`, or `13 Nov`. */
export function statesDate(text: string, day: string): boolean {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const short = (MONTHS[month - 1] ?? "").slice(0, 3);
  const forms = [
    day,
    `(?<!\\d)0?${month}/0?${date}(?!\\d)`,
    `\\b${short}[a-z]*\\.?\\s+0?${date}(?:st|nd|rd|th)?(?!\\d)`,
    `(?<!\\d)0?${date}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${short}[a-z]*\\b`,
  ];
  return forms.some((form) => new RegExp(form, "i").test(text));
}

/**
 * windowClaims returns the batch's created tasks whose open `text` does not state and that fall
 * outside what an unstated open may be: before the local day the text is from (a deadline Ankur
 * gives opens the day he says it), or more than {@link MAX_WINDOW_DAYS} days before the close.
 */
export function windowClaims(operations: Operation[], text: string, occurredAt: string, timeZone: string): Operation[] {
  const today = localDate(new Date(occurredAt), timeZone);
  return operations.filter((op) => {
    if (op.op !== "create_node" || op.kind !== "task") {
      return false;
    }
    const { opens_on: opens, closes_at: closes } = (op.detail ?? {}) as { opens_on?: unknown; closes_at?: unknown };
    if (typeof opens !== "string" || typeof closes !== "string" || statesDate(text, opens)) {
      return false;
    }
    const lead = (Date.parse(`${localDate(new Date(closes), timeZone)}T00:00:00Z`) - Date.parse(`${opens}T00:00:00Z`)) / 86_400_000;
    return opens < today || lead > MAX_WINDOW_DAYS;
  });
}

/** Rejects a batch whose second pass still has an unstated open outside its bounds (see {@link windowClaims}). */
export function rejectWindowClaims(operations: Operation[], text: string, occurredAt: string, timeZone: string): void {
  const claims = windowClaims(operations, text, occurredAt, timeZone);
  if (claims.length > 0) {
    throw new YaadError(
      422,
      "unsourced_window",
      `the text does not state these tasks' open days, and they open before the text's day or more than ${MAX_WINDOW_DAYS} days before the close: ${claims.map((op) => JSON.stringify(op)).join(", ")}`,
    );
  }
}

/**
 * Checks on a batch extraction emitted for `text`: every `close_node` quotes the words
 * in the utterance that retract or contradict the node (a fact the utterance merely
 * leaves out is not a retraction), no node is recorded as submitted or done when the utterance
 * does not say so (see {@link statusClaims}), every created node has an edge in the batch, and no
 * create duplicates a live node or another create in the batch.
 */
export async function validateExtraction(opts: {
  db: Db;
  operations: Operation[];
  text: string;
  /** Ankur's own words, verbatim, when the caller has them: the only source of a `done_at`. */
  sourceText?: string | undefined;
  timeZone: string;
}): Promise<void> {
  const haystack = normalizeQuote(opts.text);
  for (const op of opts.operations) {
    if (op.op !== "close_node") {
      continue;
    }
    const quote = normalizeQuote(op.evidence);
    if (quote.length < MIN_EVIDENCE_CHARS || !haystack.includes(quote)) {
      throw new YaadError(
        422,
        "invalid_request",
        `close_node ${op.node_id}: evidence must quote the utterance words that retract it, got "${op.evidence}"`,
      );
    }
  }
  const claims = statusClaims(opts.operations, opts.text, opts.sourceText);
  if (claims.length > 0) {
    throw new YaadError(
      422,
      "unsourced_status",
      `neither the text nor Ankur's own words say he submitted or finished anything, but the batch records it: ${claims.map((op) => JSON.stringify(op)).join(", ")}`,
    );
  }
  await rejectDuplicates(opts.db, opts.operations, opts.timeZone);
  const unlinked = unlinkedCreates(opts.operations);
  if (unlinked.length > 0) {
    throw new YaadError(
      422,
      "unlinked_node",
      `created nodes have no edge in the batch: ${unlinked.map((op) => `${op.temp_id} "${op.title}"`).join(", ")}`,
    );
  }
}

/** Lower-cased text with curly quotes, dashes, and whitespace folded, so a faithful quote matches. */
export function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function rejectTtlOnEntity(
  kind: string,
  ttlDays: number | null | undefined,
  label: string,
): void {
  if (ttlDays === undefined || ttlDays === null) {
    return;
  }
  if (kind === "person" || kind === "place") {
    throw new YaadError(
      422,
      "invalid_request",
      `${label}: ttl_days is only valid on memory, plan and task nodes`,
    );
  }
}

async function requireCurrent(db: Db, id: string, kind: "node"): Promise<Awaited<ReturnType<typeof getNode>>> {
  try {
    return await getNode(db, id);
  } catch (err) {
    if (err instanceof YaadError && err.statusCode === 404) {
      throw new YaadError(422, "invalid_request", `${kind} ${id} does not exist or is not current`);
    }
    throw err;
  }
}

async function resolveEndpoint(db: Db, value: string, tempIds: Set<string>, label: string): Promise<void> {
  if (tempIds.has(value)) {
    return;
  }
  try {
    await getNode(db, value);
  } catch (err) {
    if (err instanceof YaadError && err.statusCode === 404) {
      throw new YaadError(
        422,
        "invalid_request",
        `create_edge ${label} ${value} is not a temp_id and is not a current node`,
      );
    }
    throw err;
  }
}

/** Rejects a task window with a close and no open, or a close on a day before its open day (read in `timeZone`). */
function assertTaskWindow(
  detail: { opens_on?: string | null | undefined; closes_at?: string | null | undefined },
  label: string,
  timeZone: string,
): void {
  if (!detail.closes_at) {
    return;
  }
  if (!detail.opens_on) {
    throw new YaadError(422, "invalid_request", `${label}: a task that closes needs opens_on`);
  }
  if (localDate(new Date(detail.closes_at), timeZone) < detail.opens_on) {
    throw new YaadError(422, "invalid_request", `${label}: closes_at is before opens_on`);
  }
}
