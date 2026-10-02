/**
 * Duplicate detection for node creation. Extraction only sees the candidates it was
 * shown, so a create can repeat something already stored; ingest re-extracts once with
 * any lookalikes it missed, and every creation (ingest or by hand) is rejected when it
 * still duplicates a live node.
 */

import { and, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { node, planDetail } from "../db/schema.js";
import { YaadError } from "../errors.js";
import type { Operation } from "./operations.js";

/** Plans this close in time to a created plan are shown to extraction as possibly the same event. */
const LOOKALIKE_WINDOW_MS = 12 * 3_600_000;
/** A created plan this close in time to a live plan with the same normalized title is a duplicate. */
const DUPLICATE_WINDOW_MS = 3_600_000;

/**
 * normalizeTitle reduces a title to the words that identify it: lower case, parenthetical
 * asides dropped, punctuation folded to single spaces. "CSE 300 — Milestone One (Create) due"
 * and "CSE 300 - Milestone One due" both become "cse 300 milestone one due".
 * {@link normalizedTitleSql} must stay the exact SQL mirror of this.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The node title column normalized in SQL exactly as {@link normalizeTitle} does in code. */
export const normalizedTitleSql = sql<string>`trim(regexp_replace(regexp_replace(lower(${node.title}), '\\([^)]*\\)', ' ', 'g'), '[^a-z0-9]+', ' ', 'g'))`;

type CreateNodeOperation = Extract<Operation, { op: "create_node" }>;

/** Live (unexpired) node condition shared by the lookups below. */
const live = () => or(isNull(node.expiresAt), gt(node.expiresAt, new Date()));

/**
 * findLookalikes returns ids of live nodes that resemble the batch's creates but were not
 * shown to extraction (`shown`): any node of the same kind with the same normalized title,
 * and any dated plan within {@link LOOKALIKE_WINDOW_MS} of a created plan. Extraction is
 * re-run with these added so it can reuse them instead of creating a second copy.
 */
export async function findLookalikes(db: Db, operations: Operation[], shown: Set<string>): Promise<string[]> {
  const creates = operations.filter((op): op is CreateNodeOperation => op.op === "create_node");
  const found = new Set<string>();
  for (const op of creates) {
    const sameTitle = await db
      .select({ id: node.id })
      .from(node)
      .where(and(eq(node.kind, op.kind), live(), sql`${normalizedTitleSql} = ${normalizeTitle(op.title)}`));
    for (const row of sameTitle) {
      found.add(row.id);
    }
    if (op.kind === "plan" && op.occurred_at) {
      const at = new Date(op.occurred_at).getTime();
      const nearby = await db
        .select({ id: node.id })
        .from(node)
        .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
        .where(
          and(
            eq(node.kind, "plan"),
            live(),
            isNull(planDetail.recurrence),
            gte(node.occurredAt, new Date(at - LOOKALIKE_WINDOW_MS)),
            lte(node.occurredAt, new Date(at + LOOKALIKE_WINDOW_MS)),
          ),
        );
      for (const row of nearby) {
        found.add(row.id);
      }
    }
  }
  return [...found].filter((id) => !shown.has(id)).sort();
}

/** True when two plan start times are both unset, or within {@link DUPLICATE_WINDOW_MS}. */
function sameStart(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Math.abs(left.getTime() - right.getTime()) <= DUPLICATE_WINDOW_MS;
}

/**
 * rejectDuplicates fails the batch with `422 duplicate_node` when a created memory or plan
 * repeats another create in the batch or a live node: same kind and normalized title, and
 * for plans a start within {@link DUPLICATE_WINDOW_MS}. A live node the same batch closes
 * does not count, so a close-and-replace still works. People and places are left to
 * extraction, since two of them can share a name.
 */
export async function rejectDuplicates(db: Db, operations: Operation[]): Promise<void> {
  const closing = new Set(
    operations.flatMap((op) => (op.op === "close_node" ? [op.node_id] : [])),
  );
  const creates = operations.filter(
    (op): op is CreateNodeOperation =>
      op.op === "create_node" && (op.kind === "memory" || op.kind === "plan"),
  );
  const seen: Array<{ op: CreateNodeOperation; title: string; start: Date | null }> = [];
  for (const op of creates) {
    const title = normalizeTitle(op.title);
    const start = op.occurred_at ? new Date(op.occurred_at) : null;
    const twin = seen.find(
      (other) =>
        other.op.kind === op.kind &&
        other.title === title &&
        (op.kind === "memory" || sameStart(other.start, start)),
    );
    if (twin) {
      throw new YaadError(
        422,
        "duplicate_node",
        `create_node ${op.temp_id} "${op.title}" repeats create_node ${twin.op.temp_id} in the same batch`,
      );
    }
    seen.push({ op, title, start });

    const existing = await db
      .select({ id: node.id, title: node.title, occurredAt: node.occurredAt })
      .from(node)
      .where(and(eq(node.kind, op.kind), live(), sql`${normalizedTitleSql} = ${title}`));
    const duplicate = existing.find(
      (row) => !closing.has(row.id) && (op.kind === "memory" || sameStart(row.occurredAt, start)),
    );
    if (duplicate) {
      throw new YaadError(
        422,
        "duplicate_node",
        `create_node ${op.temp_id} "${op.title}" duplicates live node ${duplicate.id} "${duplicate.title}"; update that node instead`,
      );
    }
  }
}
