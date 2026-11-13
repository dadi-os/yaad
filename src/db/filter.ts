/**
 * Exact node filters shared by `POST /query` and filter-anchored `POST /recall`. A date-bounded
 * filter returns nodes whose time falls in the range, treating a plan with no end as an instant
 * at its start. `relevant_on` returns the tasks not done whose open day has come by that local
 * day, whether still open or past due.
 */

import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { YaadError } from "../errors.js";
import type { NodeKind } from "../types/domain.js";
import type { PlanStatus } from "../types/timeline.js";
import type { Db } from "./client.js";
import { node, personDetail, planDetail, taskDetail, type NodeRow } from "./schema.js";
import { relevantOn } from "./tasks.js";

/** Exact criteria over live nodes; unset fields do not constrain. */
export type NodeFilter = {
  kind?: NodeKind | undefined;
  /** Exact title, or a person alias, compared case-insensitively. */
  name?: string | undefined;
  occurred_from?: string | undefined;
  occurred_to?: string | undefined;
  status?: PlanStatus | undefined;
  /** A local date: the tasks relevant that day. */
  relevant_on?: string | undefined;
};

/** True when at least one filter field is set. */
export function hasFilter(filter: NodeFilter): boolean {
  return (
    filter.kind !== undefined ||
    filter.name !== undefined ||
    filter.occurred_from !== undefined ||
    filter.occurred_to !== undefined ||
    filter.status !== undefined ||
    filter.relevant_on !== undefined
  );
}

/** Reject a plan status filter combined with a non-plan kind, and `relevant_on` combined with a non-task kind. */
export function assertFilterCoherent(filter: NodeFilter): void {
  if (filter.status !== undefined && filter.kind !== undefined && filter.kind !== "plan") {
    throw new YaadError(422, "invalid_request", "status filter requires kind to be plan or unset");
  }
  if (filter.relevant_on !== undefined && filter.kind !== undefined && filter.kind !== "task") {
    throw new YaadError(422, "invalid_request", "relevant_on requires kind to be task or unset");
  }
}

/** Live nodes matching every set filter, ordered by occurred_at then created_at. */
export async function filterNodes(db: Db, filter: NodeFilter, limit: number, offset: number): Promise<NodeRow[]> {
  const needsPersonJoin = filter.name !== undefined && (filter.kind === undefined || filter.kind === "person");
  const conditions: SQL[] = [or(isNull(node.expiresAt), gt(node.expiresAt, new Date()))!];

  if (filter.kind !== undefined) {
    conditions.push(eq(node.kind, filter.kind));
  } else if (filter.status !== undefined) {
    conditions.push(eq(node.kind, "plan"));
  } else if (filter.relevant_on !== undefined) {
    conditions.push(eq(node.kind, "task"));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(planDetail.status, filter.status));
  }

  if (filter.relevant_on !== undefined) {
    conditions.push(relevantOn(filter.relevant_on));
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
    .orderBy(asc(node.occurredAt), asc(taskDetail.closesAt), asc(node.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => row.node);
}
