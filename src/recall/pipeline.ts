/** Graph recall: anchors (ids, filters, or ANN) → hop expand → rank → coverage gate. */

import { inArray, sql } from "drizzle-orm";
import { hubRowsOf } from "../db/tasks.js";
import { localDate, localTime, weekdayOf } from "../local-time.js";
import type { CourseFreshness, TaskBucket, TaskReading } from "../types/task.js";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { filterNodes, hasFilter, type NodeFilter } from "../db/filter.js";
import {
  getEdgesAmong,
  getIncidentEdgesForIds,
  getNodesByIds,
  getPersonDetail,
  getPlaceDetail,
  getPlanDetail,
  getTaskDetail,
  HUB_DEGREE,
} from "../db/read.js";
import { node, type EdgeRow, type NodeRow } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import { toEdgeRecord, toNodeRecord, toPersonDetail, toPlaceDetail, toPlanDetail, toTaskDetail } from "../serialize.js";
import type { EdgeRecord, NodeRecord, PersonDetail, PlaceDetail, PlanDetail, TaskDetail } from "../types/domain.js";
import { PLAN_EDGE } from "../types/planner.js";
import { findAnchors } from "./anchor.js";
import { expandOneHop, initialWalk, type WalkNode } from "./expand.js";
import { estimateTokens, shouldStop } from "./gate.js";
import { maxAccess, scoreNode, type ScoreParts } from "./score.js";

export type RecallNode = NodeRecord & {
  detail: PersonDetail | (PlanDetail & PlanReading) | PlaceDetail | (TaskDetail & TaskReading) | null;
  hops: number;
  /** Weighted relevance to `query`; null when the request had no query. */
  score: number | null;
  /** Present when the request asked for debug and had a query. */
  scores?: ScoreParts;
};

export type RecallResult = {
  nodes: RecallNode[];
  /** Current edges whose endpoints are both in `nodes`. */
  edges: EdgeRecord[];
  /** Mean score of the top results; null when the request had no query. */
  coverage: number | null;
  sufficient: boolean | null;
  hops_taken: number;
  anchors: string[];
  /** The course hub of each returned task, by title, with its freshness; empty when no task is returned. */
  courses: Record<string, CourseFreshness>;
};

/**
 * Retrieve a subgraph. Anchors come from `from`, else `filter`, else ANN on `query`.
 * A filter is a filter: the result is exactly the filtered rows, re-ranked by `query` when there is
 * one, and expanded only with explicit `hops`. Otherwise, with `hops` expansion runs exactly that
 * deep; without it, expansion is gated on relevance when `query` is set and skipped otherwise. With
 * a query, nodes are ranked by score; without one, by hop, then occurred_at, then created_at.
 */
export async function recall(opts: {
  db: Db;
  sql: Sql;
  dwar: DwarClient;
  config: Config;
  query?: string | undefined;
  from?: string[] | undefined;
  filter?: NodeFilter | undefined;
  hops?: number | undefined;
  limit: number;
  debug: boolean;
  now?: Date;
}): Promise<RecallResult> {
  const queryEmbedding = opts.query !== undefined ? await embedQuery(opts.dwar, opts.query) : null;
  const cfg = opts.config.recall;
  const now = opts.now ?? new Date();
  const anchors = await selectAnchorRows(opts, queryEmbedding, now);
  if (anchors.length === 0) {
    return {
      nodes: [],
      edges: [],
      coverage: queryEmbedding ? 0 : null,
      sufficient: queryEmbedding ? 0 >= cfg.coverage_floor : null,
      hops_taken: 0,
      anchors: [],
      courses: {},
    };
  }

  const walk = initialWalk(anchors.map((row) => row.id));
  const rows = new Map<string, NodeRow>(anchors.map((row) => [row.id, row]));
  const gated = opts.hops === undefined;
  const filtered = opts.from === undefined && opts.filter !== undefined && hasFilter(opts.filter);
  const hopLimit = opts.hops ?? (queryEmbedding && !filtered ? cfg.hop_cap : 0);
  let hopsTaken = 0;

  while (hopsTaken < hopLimit && walk.frontier.length > 0) {
    const incident = (await getIncidentEdgesForIds(opts.db, walk.frontier)).filter((edge) => edge.type !== PLAN_EDGE);
    const hubs = opts.from === undefined ? hubsAmong(walk.frontier, incident) : new Set<string>();
    const expanded = expandOneHop({ nodes: walk.nodes, frontier: walk.frontier.filter((id) => !hubs.has(id)) }, incident);
    hopsTaken += 1;
    if (expanded.newlyDiscovered.length > 0) {
      for (const row of await getNodesByIds(opts.db, expanded.newlyDiscovered)) {
        rows.set(row.id, row);
      }
    }
    walk.nodes = expanded.next.nodes;
    walk.frontier = expanded.next.frontier.filter((id) => rows.has(id));

    if (gated && queryEmbedding) {
      const scored = scoreAll(rows, walk.nodes, queryEmbedding, cfg, now);
      const relevant = new Set(
        scored.filter((item) => item.parts.total >= cfg.relevance_threshold).map((item) => item.row.id),
      );
      const gate = shouldStop({
        hopsTaken,
        hopCap: cfg.hop_cap,
        newRelevantCount: expanded.newlyDiscovered.filter((id) => relevant.has(id)).length,
        marginalYieldMinimum: cfg.marginal_yield_minimum,
        tokenEstimate: estimateTokens(scored.filter((item) => relevant.has(item.row.id)).map((item) => item.row)),
        tokenBudget: cfg.token_budget,
      });
      if (gate.stop) {
        break;
      }
    }
  }

  const ranked = queryEmbedding
    ? scoreAll(rows, walk.nodes, queryEmbedding, cfg, now).sort((a, b) => b.parts.total - a.parts.total)
    : orderWithoutQuery(rows, walk.nodes, filtered).map((row) => ({ row, parts: null }));
  const top = ranked.slice(0, opts.limit);

  const taskHubs = await hubRowsOf(opts.db, top.filter((item) => item.row.kind === "task").map((item) => item.row.id), "HAS_ITEM");
  const timeZone = opts.config.env.timezone;
  const day = opts.filter?.relevant_on ?? localDate(now, timeZone);
  const nodes: RecallNode[] = [];
  for (const item of top) {
    const hub = taskHubs.get(item.row.id);
    const detail = await loadDetail(opts.db, item.row);
    const record: RecallNode = {
      ...toNodeRecord(item.row),
      detail:
        detail !== null && "closes_at" in detail
          ? { ...detail, ...readTask(detail, hub?.agentId ?? null, day, timeZone) }
          : detail !== null && "all_day" in detail
            ? { ...detail, ...readPlan(item.row.occurredAt, detail, timeZone) }
            : detail,
      hops: requireWalkNode(walk.nodes, item.row.id).hop,
      score: item.parts ? item.parts.total : null,
    };
    if (opts.debug && item.parts) {
      record.scores = item.parts;
    }
    nodes.push(record);
  }

  const coverage = queryEmbedding
    ? coverageScore(
        top.map((item) => (item.parts ? item.parts.total : 0)),
        cfg.coverage_top_n,
      )
    : null;
  const edges = await getEdgesAmong(
    opts.db,
    nodes.map((item) => item.id),
  );

  const courses: Record<string, CourseFreshness> = {};
  for (const hub of new Set(taskHubs.values())) {
    courses[hub.title] = {
      verified_at: hub.verifiedAt ? hub.verifiedAt.toISOString() : null,
      verified_today: hub.verifiedAt !== null && localDate(hub.verifiedAt, timeZone) === localDate(now, timeZone),
      owner: hub.agentId,
    };
  }

  return {
    nodes,
    edges: edges.map(toEdgeRecord),
    coverage,
    sufficient: coverage === null ? null : coverage >= cfg.coverage_floor,
    hops_taken: hopsTaken,
    anchors: anchors.map((row) => row.id),
    courses,
  };
}

/** A task's local dates, bucket against the local `day`, and owner (see {@link TaskReading}). */
function readTask(detail: TaskDetail, owner: string | null, day: string, timeZone: string): TaskReading {
  const closes = detail.closes_at === null ? null : new Date(detail.closes_at);
  const closeDay = closes === null ? null : localDate(closes, timeZone);
  let bucket: TaskBucket | null = null;
  if (closeDay !== null) {
    bucket = closeDay === day ? "due_on_day" : closeDay > day ? "upcoming" : detail.done ? null : "past_due";
  }
  return {
    closes_local: closes === null || closeDay === null ? null : `${weekdayOf(closeDay)} ${closeDay} ${localTime(closes, timeZone)}`,
    opens_local: detail.opens_on === null ? null : `${weekdayOf(detail.opens_on)} ${detail.opens_on}`,
    bucket,
    owner,
  };
}

/** What recall adds to a plan's detail: its start and end in the plan's own time zone (the box's when it has none), with their weekday. */
export type PlanReading = {
  /** `Tue 2026-11-17 15:30`, or `Tue 2026-11-17` for an all-day plan; null with no start. */
  starts_local: string | null;
  /** The same for the end; null with no end. */
  ends_local: string | null;
};

/** A plan's local start and end (see {@link PlanReading}). */
function readPlan(startsAt: Date | null, detail: PlanDetail, boxZone: string): PlanReading {
  const zone = detail.time_zone ?? boxZone;
  const local = (instant: Date | null): string | null => {
    if (instant === null) {
      return null;
    }
    const day = localDate(instant, zone);
    return detail.all_day ? `${weekdayOf(day)} ${day}` : `${weekdayOf(day)} ${day} ${localTime(instant, zone)}`;
  };
  return { starts_local: local(startsAt), ends_local: local(detail.end_at === null ? null : new Date(detail.end_at)) };
}

/** The frontier nodes with more than {@link HUB_DEGREE} live edges in `incident`: returned when reached, never walked out of. */
function hubsAmong(frontier: string[], incident: EdgeRow[]): Set<string> {
  const degree = new Map<string, number>();
  for (const edge of incident) {
    degree.set(edge.srcId, (degree.get(edge.srcId) ?? 0) + 1);
    degree.set(edge.dstId, (degree.get(edge.dstId) ?? 0) + 1);
  }
  return new Set(frontier.filter((id) => (degree.get(id) ?? 0) > HUB_DEGREE));
}

/** Embed the recall query through Dwar; a missing vector is a 502. */
async function embedQuery(dwar: DwarClient, query: string): Promise<number[]> {
  const [embedding] = await dwar.embed([query], "yaad/recall");
  if (!embedding) {
    throw new YaadError(502, "dwar", "Dwar returned no embedding");
  }
  return embedding;
}

/**
 * Anchor rows for a request: every `from` id (404 when one is unknown or expired),
 * else every filter match (up to page.max_size when a query will re-rank them, `limit` otherwise), else the plans and tasks the query's title
 * words name followed by ANN hits above the floor (see findAnchors).
 */
async function selectAnchorRows(
  opts: {
    db: Db;
    sql: Sql;
    config: Config;
    query?: string | undefined;
    from?: string[] | undefined;
    filter?: NodeFilter | undefined;
    limit: number;
  },
  queryEmbedding: number[] | null,
  now: Date,
): Promise<NodeRow[]> {
  if (opts.from !== undefined) {
    const found = await getNodesByIds(opts.db, opts.from);
    const byId = new Map(found.map((row) => [row.id, row]));
    return opts.from.map((id) => {
      const row = byId.get(id);
      if (!row) {
        throw new YaadError(404, "not_found", `node ${id} not found`);
      }
      return row;
    });
  }
  if (opts.filter !== undefined && hasFilter(opts.filter)) {
    return filterNodes(opts.db, opts.filter, queryEmbedding ? opts.config.page.max_size : opts.limit, 0);
  }
  if (!queryEmbedding || opts.query === undefined) {
    throw new YaadError(422, "invalid_request", "query, from, or a filter is required");
  }
  return findAnchors({ db: opts.db, sql: opts.sql, config: opts.config, query: opts.query, embedding: queryEmbedding, now });
}

/** Walk entry for a node the walk must already hold; absence is an internal error. */
function requireWalkNode(walk: Map<string, WalkNode>, id: string): WalkNode {
  const walkNode = walk.get(id);
  if (!walkNode) {
    throw new YaadError(500, "internal_error", `walk missing node ${id}`);
  }
  return walkNode;
}

/** Live rows for every walked node; expired neighbors were never fetched and drop out. */
function presentRows(rows: Map<string, NodeRow>, walk: Map<string, WalkNode>): NodeRow[] {
  return [...walk.keys()]
    .map((id) => rows.get(id))
    .filter((row): row is NodeRow => row !== undefined);
}

function scoreAll(
  rows: Map<string, NodeRow>,
  walk: Map<string, WalkNode>,
  queryEmbedding: number[],
  cfg: Config["recall"],
  now: Date,
) {
  const present = presentRows(rows, walk);
  const ctx = {
    queryEmbedding,
    now,
    halfLifeDays: cfg.recency_half_life_days,
    weights: cfg.weights,
    kindPriors: cfg.kind_priors,
    maxAccessCount: maxAccess(present),
  };
  return present.map((row) => ({ row, parts: scoreNode(row, requireWalkNode(walk, row.id), ctx) }));
}

/** Query-less order: nearest hop first, then chronological, undated last; with `keepAnchorOrder`, anchors keep the order the filter gave them. */
function orderWithoutQuery(rows: Map<string, NodeRow>, walk: Map<string, WalkNode>, keepAnchorOrder: boolean): NodeRow[] {
  return presentRows(rows, walk).sort((a, b) => {
    const hopDelta = requireWalkNode(walk, a.id).hop - requireWalkNode(walk, b.id).hop;
    if (hopDelta !== 0) {
      return hopDelta;
    }
    if (keepAnchorOrder && requireWalkNode(walk, a.id).hop === 0) {
      return 0;
    }
    if (a.occurredAt && b.occurredAt) {
      const delta = a.occurredAt.getTime() - b.occurredAt.getTime();
      if (delta !== 0) {
        return delta;
      }
    } else if (a.occurredAt || b.occurredAt) {
      return a.occurredAt ? -1 : 1;
    }
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

function coverageScore(scores: number[], topN: number): number {
  if (scores.length === 0) {
    return 0;
  }
  const slice = scores.slice(0, topN);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

async function loadDetail(
  db: Db,
  row: NodeRow,
): Promise<PersonDetail | PlanDetail | PlaceDetail | TaskDetail | null> {
  if (row.kind === "task") {
    return toTaskDetail(await getTaskDetail(db, row.id));
  }
  if (row.kind === "person") {
    return toPersonDetail(await getPersonDetail(db, row.id));
  }
  if (row.kind === "plan") {
    return toPlanDetail(await getPlanDetail(db, row.id));
  }
  if (row.kind === "place") {
    return toPlaceDetail(await getPlaceDetail(db, row.id));
  }
  return null;
}

/** Bump access_count / last_accessed_at for returned recall nodes (fire-and-forget from the route). */
export async function recordAccess(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const at = new Date();
  await db
    .update(node)
    .set({
      accessCount: sql`${node.accessCount} + 1`,
      lastAccessedAt: at,
    })
    .where(inArray(node.id, ids));
}
