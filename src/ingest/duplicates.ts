/**
 * Duplicate detection for node creation. Extraction only sees the candidates it was
 * shown, so a create can repeat something already stored; ingest re-extracts once with
 * any lookalikes it missed.
 */

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { edge, node, taskDetail } from "../db/schema.js";
import { addDays, dayStart, localDate, localInstant } from "../local-time.js";
import { parse, taskDetailBody } from "../routers/v1/schemas.js";
import type { Operation } from "./operations.js";

/** Plans this close in time to a created plan, and sharing a title word, are shown to extraction as possibly the same event. */
const LOOKALIKE_WINDOW_MS = 12 * 3_600_000;

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

/** Title words too common to tie two plans together. */
const GENERIC_TITLE_WORDS = new Set(["class", "session", "with", "meeting"]);

/** The words of a normalized title that identify it: four letters or more, and not a generic word. */
export function identifyingWords(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(" ").filter((word) => word.length >= 4 && !GENERIC_TITLE_WORDS.has(word)));
}

type CreateNodeOperation = Extract<Operation, { op: "create_node" }>;

/** Live (unexpired) node condition shared by the lookups below. */
const live = () => or(isNull(node.expiresAt), gt(node.expiresAt, new Date()));

/**
 * findLookalikes returns ids of live nodes that resemble the batch's creates but were not
 * shown to extraction (`shown`): any node of the same kind with the same normalized title,
 * any plan within {@link LOOKALIKE_WINDOW_MS} of a created plan's start that shares an
 * identifying title word with it, and any task closing the same local day (in `timeZone`) as a
 * created task under the same hub. Extraction is re-run with these added so it can reuse them
 * instead of creating a second copy.
 */
export async function findLookalikes(db: Db, operations: Operation[], shown: Set<string>, timeZone: string): Promise<string[]> {
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
    const when = timeOf(op);
    if (op.kind === "plan" && when !== null) {
      const at = when.getTime();
      const nearby = await db
        .select({ id: node.id, title: node.title })
        .from(node)
        .where(
          and(
            eq(node.kind, "plan"),
            live(),
            sql`${node.occurredAt} >= ${new Date(at - LOOKALIKE_WINDOW_MS).toISOString()}`,
            sql`${node.occurredAt} <= ${new Date(at + LOOKALIKE_WINDOW_MS).toISOString()}`,
          ),
        );
      const words = identifyingWords(op.title);
      for (const row of nearby) {
        if ([...identifyingWords(row.title)].some((word) => words.has(word))) {
          found.add(row.id);
        }
      }
    }
    const hubId = op.kind === "task" ? hubOf(operations, op.temp_id) : null;
    const closes = op.kind === "task" ? timeOf(op) : null;
    if (hubId !== null && closes !== null) {
      const day = localDate(closes, timeZone);
      const siblings = await db
        .select({ id: node.id })
        .from(node)
        .innerJoin(taskDetail, eq(taskDetail.nodeId, node.id))
        .innerJoin(edge, and(eq(edge.dstId, node.id), eq(edge.type, "HAS_ITEM"), isNull(edge.validTo)))
        .where(
          and(
            eq(node.kind, "task"),
            live(),
            eq(edge.srcId, hubId),
            sql`${taskDetail.closesAt} >= ${dayStart(day, timeZone).toISOString()}`,
            sql`${taskDetail.closesAt} < ${dayStart(addDays(day, 1), timeZone).toISOString()}`,
          ),
        );
      for (const row of siblings) {
        found.add(row.id);
      }
    }
  }
  return [...found].filter((id) => !shown.has(id)).sort();
}

/** The existing node the batch links to `tempId` with a `HAS_ITEM` edge, or null when there is none. */
function hubOf(operations: Operation[], tempId: string): string | null {
  const link = operations.find((op) => op.op === "create_edge" && op.type === "HAS_ITEM" && op.dst === tempId);
  return link?.op === "create_edge" && !operations.some((op) => op.op === "create_node" && op.temp_id === link.src) ? link.src : null;
}

/** When a created plan starts or a created task closes; null for anything else undated. */
function timeOf(op: CreateNodeOperation): Date | null {
  if (op.occurred_at) {
    return new Date(op.occurred_at);
  }
  if (op.kind !== "task") {
    return null;
  }
  const { closes_at } = parse(taskDetailBody, op.detail ?? {});
  return closes_at ? new Date(closes_at) : null;
}
