/**
 * Exact node filters shared by `POST /query` and filter-anchored `POST /recall`.
 * Date-bounded plan filters exclude recurrence templates (patterns, not dated events)
 * and treat null plan end_at as an instantaneous event at occurred_at.
 */

import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { YaadError } from "../errors.js";
import type { NodeKind, PlanStatus } from "../types/domain.js";
import type { Db } from "./client.js";
import { node, personDetail, planDetail, type NodeRow } from "./schema.js";

/** Exact criteria over live nodes; unset fields do not constrain. */
export type NodeFilter = {
  kind?: NodeKind | undefined;
  /** Exact title, or a person alias, compared case-insensitively. */
  name?: string | undefined;
  occurred_from?: string | undefined;
  occurred_to?: string | undefined;
  status?: PlanStatus | undefined;
};

/** True when at least one filter field is set. */
export function hasFilter(filter: NodeFilter): boolean {
  return (
    filter.kind !== undefined ||
    filter.name !== undefined ||
    filter.occurred_from !== undefined ||
    filter.occurred_to !== undefined ||
    filter.status !== undefined
  );
}

/** Reject a plan status filter combined with a non-plan kind. */
export function assertFilterCoherent(filter: NodeFilter): void {
  if (filter.status !== undefined && filter.kind !== undefined && filter.kind !== "plan") {
    throw new YaadError(422, "invalid_request", "status filter requires kind to be plan or unset");
  }
}

/** Live nodes matching every set filter, ordered by occurred_at then created_at. */
export async function filterNodes(
  db: Db,
  filter: NodeFilter,
  limit: number,
  offset: number,
): Promise<NodeRow[]> {
  const conditions = [];
  const dateBounded = filter.occurred_from !== undefined || filter.occurred_to !== undefined;
  const needsPlanJoin = dateBounded || filter.status !== undefined;
  const needsPersonJoin =
    filter.name !== undefined && (filter.kind === undefined || filter.kind === "person");

  conditions.push(or(isNull(node.expiresAt), gt(node.expiresAt, new Date()))!);

  if (filter.kind !== undefined) {
    conditions.push(eq(node.kind, filter.kind));
  } else if (filter.status !== undefined) {
    conditions.push(eq(node.kind, "plan"));
  }

  if (filter.status !== undefined) {
    conditions.push(eq(planDetail.status, filter.status));
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

  if (dateBounded) {
    conditions.push(isNotNull(node.occurredAt));
    conditions.push(or(sql`${node.kind} <> 'plan'`, isNull(planDetail.recurrence))!);

    const effectiveEnd = sql`COALESCE(${planDetail.endAt}, ${node.occurredAt})`;
    if (filter.occurred_to !== undefined) {
      conditions.push(sql`${node.occurredAt} <= ${filter.occurred_to}`);
    }
    if (filter.occurred_from !== undefined) {
      conditions.push(sql`${effectiveEnd} >= ${filter.occurred_from}`);
    }
  }

  let query = db.select({ node }).from(node).$dynamic();
  if (needsPlanJoin) {
    query = query.leftJoin(planDetail, eq(planDetail.nodeId, node.id));
  }
  if (needsPersonJoin) {
    query = query.leftJoin(personDetail, eq(personDetail.nodeId, node.id));
  }

  const rows = await query
    .where(and(...conditions))
    .orderBy(asc(node.occurredAt), asc(node.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => row.node);
}
