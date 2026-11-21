/** Reads of live tasks shared by the task routes, recall's `relevant_on` filter, and ingest candidates. */

import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { addDays, dayStart } from "../local-time.js";
import type { TaskItem } from "../types/task.js";
import { PLAN_EDGE, type Hub } from "../types/planner.js";
import type { Db } from "./client.js";
import { edge, node, nodeHistory, taskDetail, type NodeRow } from "./schema.js";

/** Live tasks with their detail, narrowed by `where`. */
export function tasksWhere(db: Pick<Db, "select">, ...where: SQL[]) {
  return db
    .select({ node, detail: taskDetail })
    .from(node)
    .innerJoin(taskDetail, eq(taskDetail.nodeId, node.id))
    .where(and(eq(node.kind, "task"), or(isNull(node.expiresAt), gt(node.expiresAt, new Date())), ...where));
}

/** Not done and open by the local `date`: its open day has come, whether it is still open or already past due. */
export function relevantOn(date: string): SQL {
  return and(eq(taskDetail.done, false), isNotNull(taskDetail.opensOn), lte(taskDetail.opensOn, date))!;
}

/**
 * What a recall for a day finds: {@link relevantOn} tasks that have no close or closed no more
 * than {@link OPEN_TASK_PAST_DAYS} days before that local day. The day views keep every past-due task.
 */
export function relevantRecently(date: string): SQL {
  return and(
    relevantOn(date),
    or(isNull(taskDetail.closesAt), sql`${taskDetail.closesAt}::date >= ${date}::date - ${OPEN_TASK_PAST_DAYS}::int`),
  )!;
}

/**
 * Order for a recall for a day: tasks closing on or after it first, soonest first; then the
 * recently past due, latest close first; then those with no close.
 */
export function relevantOrder(date: string): SQL[] {
  const upcoming = sql`${taskDetail.closesAt}::date >= ${date}::date`;
  return [
    sql`CASE WHEN ${taskDetail.closesAt} IS NULL THEN 2 WHEN ${upcoming} THEN 0 ELSE 1 END`,
    sql`CASE WHEN ${upcoming} THEN extract(epoch FROM ${taskDetail.closesAt}) ELSE -extract(epoch FROM ${taskDetail.closesAt}) END`,
  ];
}

/** Not done and with no window: it is relevant on no particular day. */
export function isSomeday(): SQL {
  return and(eq(taskDetail.done, false), isNull(taskDetail.opensOn))!;
}

/** How far back from now (or from a recalled day) a task may have closed and still count as open. */
export const OPEN_TASK_PAST_DAYS = 14;
/** How far ahead of now an open task may close and still be settled by ingest. */
const OPEN_TASK_AHEAD_DAYS = 60;

/**
 * The tasks not done that ingest settles before creating anything new: those with no close, or
 * closing within {@link OPEN_TASK_PAST_DAYS} back and {@link OPEN_TASK_AHEAD_DAYS} ahead of `now`.
 */
export function openTasks(db: Pick<Db, "select">, now: Date) {
  const from = new Date(now.getTime() - OPEN_TASK_PAST_DAYS * 86_400_000);
  const to = new Date(now.getTime() + OPEN_TASK_AHEAD_DAYS * 86_400_000);
  return tasksWhere(
    db,
    eq(taskDetail.done, false),
    or(isNull(taskDetail.closesAt), and(gte(taskDetail.closesAt, from), lte(taskDetail.closesAt, to)))!,
  ).orderBy(asc(node.createdAt));
}

/**
 * The course hubs a text may be about: the hubs among `ids`, the hubs of the tasks among `ids`,
 * and every hub whose node `agentId` wrote (an agent's own courses).
 */
export async function touchedHubs(db: Pick<Db, "select">, ids: string[], agentId: string | null): Promise<Set<string>> {
  const owned = agentId === null ? sql`false` : sql`${edge.srcId} IN (SELECT id FROM node WHERE agent_id = ${agentId})`;
  const named = ids.length === 0 ? sql`false` : or(inArray(edge.srcId, ids), inArray(edge.dstId, ids))!;
  const links = await db
    .select({ hub: edge.srcId })
    .from(edge)
    .where(and(eq(edge.type, "HAS_ITEM"), isNull(edge.validTo), or(named, owned)));
  return new Set(links.map((link) => link.hub));
}

/** Stamps `verified_at` on the course hub of each task in `taskIds`: any task under a hub that changed makes the course fresh. */
export async function stampHubs(db: Pick<Db, "select" | "update">, taskIds: string[], at: Date): Promise<void> {
  const hubs = [...(await hubRowsOf(db, taskIds, "HAS_ITEM")).values()].map((hub) => hub.id);
  if (hubs.length > 0) {
    await db.update(node).set({ verifiedAt: at }).where(inArray(node.id, hubs));
  }
}

/** Restates `taskIds` as still true with no extraction: stamps the tasks' and their hubs' `verified_at` with `at`. */
export async function verifyTasks(db: Pick<Db, "select" | "update">, taskIds: string[], at: Date): Promise<void> {
  await db.update(taskDetail).set({ verifiedAt: at }).where(inArray(taskDetail.nodeId, taskIds));
  await stampHubs(db, taskIds, at);
}

/**
 * Tasks a day shows: those not done with an open day on or before it (open or past due), and
 * tasks done that day or whose window held it. Sorted by close time, then title.
 */
export async function tasksOn(db: Db, date: string, timeZone: string): Promise<TaskItem[]> {
  const start = dayStart(date, timeZone);
  const end = dayStart(addDays(date, 1), timeZone);
  const heldThatDay = and(
    isNotNull(taskDetail.opensOn),
    lte(taskDetail.opensOn, date),
    or(isNull(taskDetail.closesAt), sql`${taskDetail.closesAt} >= ${start.toISOString()}`),
  )!;
  const doneThatDay = sql`EXISTS (
    SELECT 1 FROM ${nodeHistory}
    WHERE ${nodeHistory.nodeId} = ${node.id} AND ${nodeHistory.field} = 'done' AND ${nodeHistory.newValue} = 'true'
      AND ${nodeHistory.changedAt} >= ${start.toISOString()} AND ${nodeHistory.changedAt} < ${end.toISOString()}
  )`;
  const rows = await tasksWhere(db, or(relevantOn(date), and(eq(taskDetail.done, true), or(heldThatDay, doneThatDay)))!);
  return toTaskItems(db, rows);
}

/** Tasks not done with no window. */
export async function somedayTasks(db: Db): Promise<TaskItem[]> {
  return toTaskItems(db, await tasksWhere(db, isSomeday()));
}

/** The task rows as items, with their hubs, sorted by close time (none last), then title. */
export async function toTaskItems(db: Pick<Db, "select">, rows: Awaited<ReturnType<typeof tasksWhere>>): Promise<TaskItem[]> {
  const hubs = await hubsOf(db, rows.map((row) => row.node.id), "HAS_ITEM");
  const now = new Date();
  const items = rows.map(({ node: task, detail }): TaskItem => ({
    id: task.id,
    title: task.title,
    body: task.body,
    opens_on: detail.opensOn,
    closes_at: detail.closesAt ? detail.closesAt.toISOString() : null,
    done: detail.done,
    verified_at: detail.verifiedAt ? detail.verifiedAt.toISOString() : null,
    created_at: task.createdAt.toISOString(),
    updated_at: task.updatedAt.toISOString(),
    past_due: !detail.done && detail.closesAt !== null && detail.closesAt < now,
    hub: hubs.get(task.id) ?? null,
    owner: task.agentId,
  }));
  return items.sort((a, b) => {
    if (a.closes_at === null || b.closes_at === null) {
      return a.closes_at === b.closes_at ? a.title.localeCompare(b.title) : a.closes_at === null ? 1 : -1;
    }
    return a.closes_at.localeCompare(b.closes_at) || a.title.localeCompare(b.title);
  });
}

/** The hub each node belongs to: the source of its current `type` edge (`HAS_ITEM` for tasks, `HAS_PLAN` for sessions). */
export async function hubsOf(
  db: Pick<Db, "select">,
  ids: string[],
  type: "HAS_ITEM" | typeof PLAN_EDGE,
): Promise<Map<string, Hub>> {
  const rows = await hubRowsOf(db, ids, type);
  return new Map([...rows].map(([id, hub]) => [id, { id: hub.id, title: hub.title }]));
}

/** {@link hubsOf} with the hubs' whole rows, which carry their `verified_at` and `agent_id`. */
export async function hubRowsOf(
  db: Pick<Db, "select">,
  ids: string[],
  type: "HAS_ITEM" | typeof PLAN_EDGE,
): Promise<Map<string, NodeRow>> {
  const hubs = new Map<string, NodeRow>();
  if (ids.length === 0) {
    return hubs;
  }
  const links = await db
    .select({ dst: edge.dstId, hub: node })
    .from(edge)
    .innerJoin(node, eq(node.id, edge.srcId))
    .where(and(inArray(edge.dstId, ids), eq(edge.type, type), isNull(edge.validTo), or(isNull(node.expiresAt), gt(node.expiresAt, new Date()))))
    .orderBy(asc(edge.createdAt));
  for (const link of links) {
    if (!hubs.has(link.dst)) {
      hubs.set(link.dst, link.hub);
    }
  }
  return hubs;
}
