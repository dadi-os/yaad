/**
 * Pre-apply checks. {@link validateOperations} is structural and runs on every batch
 * (ingest and hand edits); {@link validateExtraction} adds the guards that only apply to
 * what extraction emitted from an utterance.
 */

import type { Db } from "../db/client.js";
import { getEdge, getNode, getPlanDetail } from "../db/read.js";
import { YaadError } from "../errors.js";
import { parse } from "../routers/v1/schemas.js";
import { rejectDuplicates } from "./duplicates.js";
import {
  patchPersonDetailBody,
  patchPlaceDetailBody,
  patchPlanDetailBody,
  personDetailBody,
  placeDetailBody,
  planDetailBody,
  type Operation,
} from "./operations.js";

/** Shortest `close_node` evidence quote accepted, so a stray word cannot stand in for a retraction. */
const MIN_EVIDENCE_CHARS = 8;

/**
 * Validate op batch before apply: unique temp_ids, kind-appropriate details, all-day
 * plans that have a date, TTL only on memory/plan, and edge endpoints that resolve to
 * temp or live nodes.
 */
export async function validateOperations(opts: {
  db: Db;
  operations: Operation[];
}): Promise<void> {
  const tempIds = new Set<string>();

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
        const detail = parse(planDetailBody, op.detail ?? {});
        if (detail.all_day === true && !op.occurred_at) {
          throw new YaadError(422, "invalid_request", `create_node ${op.temp_id}: an all-day plan needs occurred_at`);
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
      }
      if (current.kind === "plan") {
        const patch = op.detail !== undefined ? parse(patchPlanDetailBody, op.detail) : {};
        const allDay = patch.all_day ?? (await getPlanDetail(opts.db, op.node_id)).allDay;
        const occurredAt = op.occurred_at !== undefined ? op.occurred_at : current.occurredAt;
        if (allDay && !occurredAt) {
          throw new YaadError(422, "invalid_request", `update_node ${op.node_id}: an all-day plan needs occurred_at`);
        }
      }
      rejectTtlOnEntity(current.kind, op.ttl_days, `update_node ${op.node_id}`);
    }
    if (op.op === "close_node") {
      await requireCurrent(opts.db, op.node_id, "node");
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
 * the batch touches. Such a node would float in the graph with nothing leading to it.
 */
export function unlinkedCreates(operations: Operation[]): Extract<Operation, { op: "create_node" }>[] {
  const linked = new Set<string>();
  for (const op of operations) {
    if (op.op === "create_edge") {
      linked.add(op.src);
      linked.add(op.dst);
    }
  }
  return operations.filter(
    (op): op is Extract<Operation, { op: "create_node" }> => op.op === "create_node" && !linked.has(op.temp_id),
  );
}

/**
 * Checks on a batch extraction emitted for `text`: every `close_node` quotes the words
 * in the utterance that retract or contradict the node (a fact the utterance merely
 * leaves out is not a retraction), every created node has an edge in the batch, and no
 * create duplicates a live node or another create in the batch.
 */
export async function validateExtraction(opts: {
  db: Db;
  operations: Operation[];
  text: string;
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
  await rejectDuplicates(opts.db, opts.operations);
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
function normalizeQuote(text: string): string {
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
      `${label}: ttl_days is only valid on memory and plan nodes`,
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
