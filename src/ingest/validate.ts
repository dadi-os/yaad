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
const COMPLETION_WORDS = /\b(?:submitted|turned in|handed in|sent in|done|completed|finished|paid|applied|(?:ankur|he|she|i)\s+(?:just\s+)?uploaded)\b/gi;

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
 * done (a title or body saying so, or `done_at` set) when `text` never reports that Ankur did it.
 * Where a thing is handed in, or what a page shows, is not a completion; the model sometimes
 * writes it as one anyway.
 */
export function statusClaims(operations: Operation[], text: string): Operation[] {
  if (says(text, COMPLETION_WORDS)) {
    return [];
  }
  return operations.filter((op) => {
    if (op.op !== "create_node" && op.op !== "update_node") {
      return false;
    }
    const detail = op.detail as Record<string, unknown> | undefined;
    const written = [op.title, op.body].filter((value): value is string => typeof value === "string").join("\n");
    return typeof detail?.done_at === "string" || says(written, SUBMISSION_WORDS);
  });
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
  const claims = statusClaims(opts.operations, opts.text);
  if (claims.length > 0) {
    throw new YaadError(
      422,
      "unsourced_status",
      `the utterance does not say Ankur submitted or finished anything, but the batch records it: ${claims.map((op) => JSON.stringify(op)).join(", ")}`,
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
