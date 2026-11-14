/**
 * Exact node filters shared by `POST /query` and filter-anchored `POST /recall`. A date-bounded
 * filter returns nodes whose time falls in the range, treating a plan with no end as an instant
 * at its start. `relevant_on` returns the tasks not done whose open day has come by that local
 * day and that have no close or closed within the last 14 days of it: closing on or after the day
 * first (soonest first), then the recently past due (latest first). `closes_from` and `closes_to`
 * (local dates, inclusive) return tasks by close day, done ones included, and `hub` (a node id or an
 * exact title) returns what that hub holds: its tasks and sessions.
 */

import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { YaadError } from "../errors.js";
import type { NodeKind } from "../types/domain.js";
import type { Db } from "./client.js";
import { node, personDetail, planDetail, taskDetail, type NodeRow } from "./schema.js";
import { relevantOrder, relevantRecently } from "./tasks.js";

/** Exact criteria over live nodes; unset fields do not constrain. */
export type NodeFilter = {
  kind?: NodeKind | undefined;
  /** Exact title, or a person alias, compared case-insensitively. */
  name?: string | undefined;
  occurred_from?: string | undefined;
  occurred_to?: string | undefined;
  /** A local date: the tasks relevant that day. */
  relevant_on?: string | undefined;
  /** A hub's id or exact title (compared case-insensitively): the nodes it holds by `HAS_ITEM` or `HAS_SESSION`. */
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
    conditions.push(sql`${node.id} IN (
      SELECT e.dst_id FROM edge AS e JOIN node AS h ON h.id = e.src_id
      WHERE e.valid_to IS NULL AND e.type IN ('HAS_ITEM', 'HAS_SESSION')
        AND (h.id::text = ${filter.hub} OR lower(h.title) = lower(${filter.hub}))
        AND (h.expires_at IS NULL OR h.expires_at > now())
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
