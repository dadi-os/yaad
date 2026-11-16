/**
 * Duplicate detection for node creation. Extraction only sees the candidates it was
 * shown, so a create can repeat something already stored; ingest re-extracts once with
 * any lookalikes it missed and then merges what still duplicates a live node into an update of
 * it, while a creation by hand is rejected.
 */

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { edge, node, taskDetail } from "../db/schema.js";
import { YaadError } from "../errors.js";
import { addDays, dayStart, localDate, localInstant } from "../local-time.js";
import { parse, taskDetailBody } from "../routers/v1/schemas.js";
import type { Operation } from "./operations.js";

/** Plans this close in time to a created plan, and sharing a title word, are shown to extraction as possibly the same event. */
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

/** True when two times are both unset, or within {@link DUPLICATE_WINDOW_MS}. */
function sameStart(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Math.abs(left.getTime() - right.getTime()) <= DUPLICATE_WINDOW_MS;
}

type SpawnPlansOperation = Extract<Operation, { op: "spawn_plans" }>;

/** A create that repeats another create in the batch (`into` is that create's temp_id) or a live node (`into` is its id). */
type CreateTwin = { op: CreateNodeOperation; message: string; into: string };

/** A session a `spawn_plans` would stamp on a date that a live plan (`into`) already holds. */
type SpawnTwin = { op: SpawnPlansOperation; date: string; message: string; into: string };

/**
 * findDuplicates returns the batch's memory, plan and task creates that repeat another create in
 * the batch or a live node (same kind and normalized title, and for plans a start, for tasks a
 * close, within {@link DUPLICATE_WINDOW_MS}), and the sessions each `spawn_plans` would create that
 * a live plan already holds. A live node the same batch closes does not count, so a close-and-replace
 * still works. People and places are left to extraction, since two of them can share a name.
 * `timeZone` is the box's zone, in which a spawn's local times are read.
 */
async function findDuplicates(db: Db, operations: Operation[], timeZone: string): Promise<{ creates: CreateTwin[]; spawns: SpawnTwin[] }> {
  const closing = new Set(
    operations.flatMap((op) => (op.op === "close_node" ? [op.node_id] : [])),
  );
  const creates = operations.filter(
    (op): op is CreateNodeOperation =>
      op.op === "create_node" && (op.kind === "memory" || op.kind === "plan" || op.kind === "task"),
  );
  const seen: Array<{ op: CreateNodeOperation; title: string; start: Date | null }> = [];
  const createTwins: CreateTwin[] = [];
  for (const op of creates) {
    const title = normalizeTitle(op.title);
    const start = timeOf(op);
    const twin = seen.find(
      (other) =>
        other.op.kind === op.kind &&
        other.title === title &&
        (op.kind === "memory" || sameStart(other.start, start)),
    );
    seen.push({ op, title, start });
    if (twin) {
      createTwins.push({
        op,
        message: `create_node ${op.temp_id} "${op.title}" repeats create_node ${twin.op.temp_id} in the same batch`,
        into: twin.op.temp_id,
      });
      continue;
    }
    const existing = await db
      .select({ id: node.id, title: node.title, occurredAt: node.occurredAt, closesAt: taskDetail.closesAt })
      .from(node)
      .leftJoin(taskDetail, eq(taskDetail.nodeId, node.id))
      .where(and(eq(node.kind, op.kind), live(), sql`${normalizedTitleSql} = ${title}`));
    const duplicate = existing.find(
      (row) => !closing.has(row.id) && (op.kind === "memory" || sameStart(row.occurredAt ?? row.closesAt, start)),
    );
    if (duplicate) {
      createTwins.push({
        op,
        message: `create_node ${op.temp_id} "${op.title}" duplicates live node ${duplicate.id} "${duplicate.title}"; update that node instead`,
        into: duplicate.id,
      });
    }
  }
  const spawnTwins: SpawnTwin[] = [];
  for (const op of operations) {
    if (op.op !== "spawn_plans") {
      continue;
    }
    const zone = op.time_zone ?? timeZone;
    for (const date of op.dates) {
      const at = localInstant(date, op.start_time, zone);
      const existing = await db
        .select({ id: node.id, title: node.title })
        .from(node)
        .where(
          and(
            eq(node.kind, "plan"),
            live(),
            sql`${normalizedTitleSql} = ${normalizeTitle(op.title)}`,
            sql`abs(extract(epoch from ${node.occurredAt}) - ${at.getTime() / 1000}) <= ${DUPLICATE_WINDOW_MS / 1000}`,
          ),
        )
        .limit(1);
      const duplicate = existing[0];
      if (duplicate) {
        spawnTwins.push({
          op,
          date,
          message: `spawn_plans ${op.temp_id} "${op.title}" on ${date} duplicates live plan ${duplicate.id} "${duplicate.title}"`,
          into: duplicate.id,
        });
      }
    }
  }
  return { creates: createTwins, spawns: spawnTwins };
}

/**
 * rejectDuplicates fails the batch with `422 duplicate_node` on the first create or spawned session
 * that {@link findDuplicates} finds. It is for a person creating by hand, who should be told; ingest
 * instead runs extraction again with the lookalike shown ({@link findLookalikes}).
 */
export async function rejectDuplicates(db: Db, operations: Operation[], timeZone: string): Promise<void> {
  const { creates, spawns } = await findDuplicates(db, operations, timeZone);
  const first = creates[0] ?? spawns[0];
  if (first) {
    throw new YaadError(422, "duplicate_node", first.message);
  }
}
