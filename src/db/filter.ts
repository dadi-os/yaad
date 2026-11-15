/**
 * Exact node filters shared by `POST /query` and filter-anchored `POST /recall`. A date-bounded
 * filter returns nodes whose time falls in the range, treating a plan with no end as an instant
 * at its start. `relevant_on` returns the tasks not done whose open day has come by that local
 * day and that have no close or closed within the last 14 days of it: closing on or after the day
 * first (soonest first), then the recently past due (latest first). `closes_from` and `closes_to`
 * (local dates, inclusive) return tasks by close day, done ones included, and `hub` (a node id, an
 * exact title, or a course label that starts a hub's normalized title) returns what the hub holds:
 * its tasks and sessions.
 */

import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { YaadError } from "../errors.js";
import type { NodeKind } from "../types/domain.js";
import type { Db } from "./client.js";
import { edge, node, personDetail, planDetail, taskDetail, type NodeRow } from "./schema.js";
import { normalizeTitle } from "../ingest/duplicates.js";
import { relevantOrder, relevantRecently } from "./tasks.js";

/** The most hub titles an unmatched `hub` filter names in its 422. */
const CLOSEST_HUB_LIMIT = 5;

/** Exact criteria over live nodes; unset fields do not constrain. */
export type NodeFilter = {
  kind?: NodeKind | undefined;
  /** Exact title, or a person alias, compared case-insensitively. */
  name?: string | undefined;
  occurred_from?: string | undefined;
  occurred_to?: string | undefined;
  /** A local date: the tasks relevant that day. */
  relevant_on?: string | undefined;
  /** A hub's id, exact title (case-insensitive), or course label that starts a hub's normalized title ("CSE 300" for "CSE 300 class"): the nodes it holds by `HAS_ITEM` or `HAS_SESSION`. */
  hub?: string | undefined;
  /** Local dates, inclusive: tasks whose close day falls in the range. */
  closes_from?: string | undefined;
  closes_to?: string | undefined;
};

/** True when at least one filter field is set. */
export function hasFilter(filter: NodeFilter): boolean {
  return (
    filter.kind !== undefined ||
    filter.name !== undefined ||
    filter.occurred_from !== undefined ||
    filter.occurred_to !== undefined ||
    filter.relevant_on !== undefined ||
    filter.hub !== undefined ||
    filter.closes_from !== undefined ||
    filter.closes_to !== undefined
  );
}

/** Reject a task-only filter combined with another kind, and `occurred_*` on tasks, which have no `occurred_at`. */
export function assertFilterCoherent(filter: NodeFilter): void {
  const taskOnly = filter.relevant_on !== undefined ? "relevant_on" : filter.closes_from !== undefined ? "closes_from" : filter.closes_to !== undefined ? "closes_to" : null;
  if (taskOnly !== null && filter.kind !== undefined && filter.kind !== "task") {
    throw new YaadError(422, "invalid_request", `${taskOnly} requires kind to be task or unset`);
  }
  if (filter.kind === "task" && (filter.occurred_from !== undefined || filter.occurred_to !== undefined)) {
    throw new YaadError(422, "invalid_request", "tasks have no occurred_at; use relevant_on or closes_from/closes_to");
  }
}

/**
 * The ids of the live hubs a `hub` filter names: the hub with that id or exact title, else every hub whose
 * normalized title is the label or starts with it as whole words. Throws a 422 naming the closest hub titles
 * when none matches, so a wrong label is never an empty result.
 */
export async function resolveHubIds(db: Db, hub: string): Promise<string[]> {
  const hubs = await db
    .selectDistinct({ id: node.id, title: node.title })
    .from(edge)
    .innerJoin(node, eq(node.id, edge.srcId))
    .where(and(isNull(edge.validTo), inArray(edge.type, ["HAS_ITEM", "HAS_SESSION"]), or(isNull(node.expiresAt), gt(node.expiresAt, new Date()))));
  const exact = hubs.filter((row) => row.id === hub || row.title.toLowerCase() === hub.toLowerCase());
  if (exact.length > 0) {
    return exact.map((row) => row.id);
  }
  const label = normalizeTitle(hub);
  const prefixed = hubs.filter((row) => {
    const title = normalizeTitle(row.title);
    return title === label || title.startsWith(`${label} `);
  });
  if (prefixed.length > 0) {
    return prefixed.map((row) => row.id);
  }
  const labelWords = new Set(label.split(" "));
  const closest = hubs
    .map((row) => ({ title: row.title, shared: normalizeTitle(row.title).split(" ").filter((word) => labelWords.has(word)).length }))
    .filter((row) => row.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.title.localeCompare(b.title))
    .slice(0, CLOSEST_HUB_LIMIT)
    .map((row) => row.title);
  const named = closest.length > 0 ? `closest hub titles: ${closest.join("; ")}` : "no hub shares a word with it";
  throw new YaadError(422, "invalid_request", `hub "${hub}" matches no hub title or id; ${named}`);
}

/** Live nodes matching every set filter, ordered by occurred_at then created_at (`relevant_on`: see {@link relevantOrder}). */
export async function filterNodes(db: Db, filter: NodeFilter, limit: number, offset: number): Promise<NodeRow[]> {
  const needsPersonJoin = filter.name !== undefined && (filter.kind === undefined || filter.kind === "person");
  const conditions: SQL[] = [or(isNull(node.expiresAt), gt(node.expiresAt, new Date()))!];

  if (filter.kind !== undefined) {
    conditions.push(eq(node.kind, filter.kind));
  } else if (filter.relevant_on !== undefined || filter.closes_from !== undefined || filter.closes_to !== undefined) {
    conditions.push(eq(node.kind, "task"));
  }

  if (filter.closes_from !== undefined) {
    conditions.push(sql`${taskDetail.closesAt}::date >= ${filter.closes_from}::date`);
  }
  if (filter.closes_to !== undefined) {
    conditions.push(sql`${taskDetail.closesAt}::date <= ${filter.closes_to}::date`);
  }

  if (filter.hub !== undefined) {
    const hubIds = await resolveHubIds(db, filter.hub);
    conditions.push(sql`${node.id} IN (
      SELECT e.dst_id FROM edge AS e
      WHERE e.valid_to IS NULL AND e.type IN ('HAS_ITEM', 'HAS_SESSION')
        AND e.src_id IN (${sql.join(hubIds.map((id) => sql`${id}::uuid`), sql`, `)})
    )`);
  }

  if (filter.relevant_on !== undefined) {
    conditions.push(relevantRecently(filter.relevant_on));
  }

  if (filter.name !== undefined) {
    const titleMatch = sql`lower(${node.title}) = lower(${filter.name})`;
    if (needsPersonJoin) {
      const aliasMatch = sql`EXISTS (
        SELECT 1 FROM unnest(${personDetail.aliases}) AS alias(val)
        WHERE lower(alias.val) = lower(${filter.name})
      )`;
      conditions.push(or(titleMatch, aliasMatch)!);
    } else {
      conditions.push(titleMatch);
    }
  }

  if (filter.occurred_from !== undefined || filter.occurred_to !== undefined) {
    const spanEnd = sql`COALESCE(${planDetail.endAt}, ${node.occurredAt})`;
    conditions.push(sql`${node.occurredAt} IS NOT NULL`);
    if (filter.occurred_to !== undefined) {
      conditions.push(sql`${node.occurredAt} <= ${filter.occurred_to}`);
    }
    if (filter.occurred_from !== undefined) {
      conditions.push(sql`${spanEnd} >= ${filter.occurred_from}`);
    }
  }

  let query = db
    .select({ node })
    .from(node)
    .leftJoin(planDetail, eq(planDetail.nodeId, node.id))
    .leftJoin(taskDetail, eq(taskDetail.nodeId, node.id))
    .$dynamic();
  if (needsPersonJoin) {
    query = query.leftJoin(personDetail, eq(personDetail.nodeId, node.id));
  }
  const rows = await query
    .where(and(...conditions))
    .orderBy(...(filter.relevant_on !== undefined ? relevantOrder(filter.relevant_on) : [asc(node.occurredAt), asc(taskDetail.closesAt)]), asc(node.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => row.node);
}
