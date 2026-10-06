/** Graph recall: anchors (ids, filters, or ANN) → hop expand → rank → coverage gate. */

import { inArray, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { filterNodes, hasFilter, type FilteredNode, type NodeFilter } from "../db/filter.js";
import {
  getEdgesAmong,
  getIncidentEdgesForIds,
  getNodesByIds,
  getPersonDetail,
  getPlaceDetail,
  getPlanDetail,
} from "../db/read.js";
import { node, type NodeRow } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import { toEdgeRecord, toNodeRecord, toPersonDetail, toPlaceDetail, toPlanDetail } from "../serialize.js";
import type { EdgeRecord, NodeRecord, PersonDetail, PlaceDetail, PlanDetail } from "../types/domain.js";
import { findAnchors } from "./anchor.js";
import { expandOneHop, initialWalk, type WalkNode } from "./expand.js";
import { estimateTokens, shouldStop } from "./gate.js";
import { maxAccess, scoreNode, semanticScore, type ScoreParts } from "./score.js";

export type RecallNode = NodeRecord & {
  detail: PersonDetail | PlanDetail | PlaceDetail | null;
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
};

/**
 * Retrieve a subgraph. Anchors come from `from`, else `filter`, else ANN on `query`.
 * With `hops`, expansion runs exactly that deep; without it, expansion is gated on
 * relevance when `query` is set and skipped otherwise. With a query, nodes are ranked
 * by score; without one, by hop, then occurred_at, then created_at.
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
  const anchors = await selectAnchorRows(opts, queryEmbedding);
  if (anchors.length === 0) {
    return {
      nodes: [],
      edges: [],
      coverage: queryEmbedding ? 0 : null,
      sufficient: queryEmbedding ? 0 >= cfg.coverage_floor : null,
      hops_taken: 0,
      anchors: [],
    };
  }

  const walk = initialWalk(anchors.map((row) => row.id));
  const rows = new Map<string, NodeRow>(anchors.map((row) => [row.id, row]));
  const now = opts.now ?? new Date();
  const gated = opts.hops === undefined;
  const hopLimit = opts.hops ?? (queryEmbedding ? cfg.hop_cap : 0);
  let hopsTaken = 0;

  while (hopsTaken < hopLimit && walk.frontier.length > 0) {
    const incident = await getIncidentEdgesForIds(opts.db, walk.frontier);
    const expanded = expandOneHop(walk, incident);
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
    : orderWithoutQuery(rows, walk.nodes).map((row) => ({ row, parts: null }));
  const top = ranked.slice(0, opts.limit);

  const nodes: RecallNode[] = [];
  for (const item of top) {
    const record: RecallNode = {
      ...toNodeRecord(item.row),
      detail: await loadDetail(opts.db, item.row),
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

  return {
    nodes,
    edges: edges.map(toEdgeRecord),
    coverage,
    sufficient: coverage === null ? null : coverage >= cfg.coverage_floor,
    hops_taken: hopsTaken,
    anchors: anchors.map((row) => row.id),
  };
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
 * else the filter matches (ranked by similarity and capped at anchor_limit when a
 * query is set, capped at `limit` otherwise), else ANN hits above the floor.
 */
async function selectAnchorRows(
  opts: {
    db: Db;
    sql: Sql;
    config: Config;
    from?: string[] | undefined;
    filter?: NodeFilter | undefined;
    limit: number;
  },
  queryEmbedding: number[] | null,
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
    const series = { timeZone: opts.config.env.timezone, plan: opts.config.plan };
    if (!queryEmbedding) {
      return distinctRows(await filterNodes(opts.db, opts.filter, opts.limit, 0, series));
    }
    const matches = distinctRows(
      await filterNodes(opts.db, opts.filter, opts.config.page.max_size, 0, series),
    );
    return matches
      .map((row) => ({ row, similarity: semanticScore(queryEmbedding, row.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, opts.config.recall.anchor_limit)
      .map((item) => item.row);
  }
  if (!queryEmbedding) {
    throw new YaadError(422, "invalid_request", "query, from, or a filter is required");
  }
  const hits = await findAnchors({ sql: opts.sql, config: opts.config, embedding: queryEmbedding });
  return hits.map((hit) => hit.row);
}

/** Each matched node once: a recurring plan anchors recall as itself, not once per occurrence. */
function distinctRows(matches: FilteredNode[]): NodeRow[] {
  const byId = new Map<string, NodeRow>();
  for (const { row } of matches) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
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

/** Query-less order: nearest hop first, then chronological, undated last. */
function orderWithoutQuery(rows: Map<string, NodeRow>, walk: Map<string, WalkNode>): NodeRow[] {
  return presentRows(rows, walk).sort((a, b) => {
    const hopDelta = requireWalkNode(walk, a.id).hop - requireWalkNode(walk, b.id).hop;
    if (hopDelta !== 0) {
      return hopDelta;
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
): Promise<PersonDetail | PlanDetail | PlaceDetail | null> {
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
