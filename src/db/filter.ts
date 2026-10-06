/**
 * Exact node filters shared by `POST /query` and filter-anchored `POST /recall`.
 * A date-bounded filter returns dated nodes plus every occurrence of a recurring plan
 * inside the range, expanded from its rule (occurrences are never stored), and treats a
 * null plan end_at as an instantaneous event at occurred_at.
 */

import { and, asc, eq, gt, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Config } from "../config.js";
import { YaadError } from "../errors.js";
import { occurrencesBetween, type Occurrence } from "../ingest/recurrence.js";
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

/** A node a filter matched; a recurring plan appears once per occurrence in a date range. */
export type FilteredNode = {
  row: NodeRow;
  /** The occurrence this recurring plan stands for; null for every other match. */
  occurrence: Occurrence | null;
};

/** How recurring plans expand: the box's zone, the open-ended range, and the per-range cap. */
export type SeriesExpansion = {
  timeZone: string;
  plan: Config["plan"];
};

/**
 * Live nodes matching every set filter, ordered by occurred_at then created_at. A
 * date-bounded filter merges each recurring plan's occurrences in the range with the dated
 * nodes before paging; an open end reaches `plan.recurrence_horizon_days` past the start.
 */
export async function filterNodes(
  db: Db,
  filter: NodeFilter,
  limit: number,
  offset: number,
  series: SeriesExpansion,
): Promise<FilteredNode[]> {
  const conditions = [];
  const dateBounded = filter.occurred_from !== undefined || filter.occurred_to !== undefined;
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

  const select = (where: SQL[]) => {
    let query = db
      .select({ node, endAt: planDetail.endAt, recurrence: planDetail.recurrence })
      .from(node)
      .leftJoin(planDetail, eq(planDetail.nodeId, node.id))
      .$dynamic();
    if (needsPersonJoin) {
      query = query.leftJoin(personDetail, eq(personDetail.nodeId, node.id));
    }
    return query.where(and(...where)).orderBy(asc(node.occurredAt), asc(node.createdAt));
  };

  if (!dateBounded) {
    const rows = await select(conditions).limit(limit).offset(offset);
    return rows.map((row) => ({ row: row.node, occurrence: null }));
  }

  const dated = [
    ...conditions,
    isNotNull(node.occurredAt),
    or(sql`${node.kind} <> 'plan'`, isNull(planDetail.recurrence))!,
  ];
  const effectiveEnd = sql`COALESCE(${planDetail.endAt}, ${node.occurredAt})`;
  if (filter.occurred_to !== undefined) {
    dated.push(sql`${node.occurredAt} <= ${filter.occurred_to}`);
  }
  if (filter.occurred_from !== undefined) {
    dated.push(sql`${effectiveEnd} >= ${filter.occurred_from}`);
  }
  const datedRows = await select(dated).limit(offset + limit);

  const recurring = [...conditions, isNotNull(node.occurredAt), isNotNull(planDetail.recurrence)];
  if (filter.occurred_to !== undefined) {
    recurring.push(sql`${node.occurredAt} <= ${filter.occurred_to}`);
  }
  const templates = await select(recurring);

  const horizonMs = series.plan.recurrence_horizon_days * 86_400_000;
  const timed: Array<{ match: FilteredNode; at: number }> = [];
  for (const { node: row } of datedRows) {
    if (!row.occurredAt) {
      throw new YaadError(500, "internal_error", `dated node ${row.id} has no occurred_at`);
    }
    timed.push({ match: { row, occurrence: null }, at: row.occurredAt.getTime() });
  }
  for (const template of templates) {
    const start = template.node.occurredAt;
    if (!start || !template.recurrence) {
      throw new YaadError(500, "internal_error", `recurring plan ${template.node.id} lost its start or rule`);
    }
    const from = filter.occurred_from !== undefined ? new Date(filter.occurred_from) : start;
    const to = filter.occurred_to !== undefined ? new Date(filter.occurred_to) : new Date(from.getTime() + horizonMs);
    for (const occurrence of occurrencesBetween({
      rule: template.recurrence,
      start,
      end: template.endAt,
      from,
      to,
      maxInstances: series.plan.max_instances_per_series,
      timeZone: series.timeZone,
    })) {
      timed.push({ match: { row: template.node, occurrence }, at: occurrence.occurredAt.getTime() });
    }
  }

  return timed
    .sort((a, b) => a.at - b.at || a.match.row.createdAt.getTime() - b.match.row.createdAt.getTime())
    .slice(offset, offset + limit)
    .map((item) => item.match);
}
