import { inArray, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { getIncidentEdgesForIds, getNodesByIds, getPersonDetail, getPlanDetail } from "../db/read.js";
import { node, type EdgeRow, type NodeRow } from "../db/schema.js";
import type { DwarClient } from "../dwar/client.js";
import { YaadError } from "../errors.js";
import { toEdgeRecord, toNodeRecord, toPersonDetail, toPlanDetail } from "../serialize.js";
import type { EdgeRecord, NodeRecord, PersonDetail, PlanDetail } from "../types/domain.js";
import { findAnchors } from "./anchor.js";
import { expandOneHop, initialWalk } from "./expand.js";
import { estimateTokens, shouldStop } from "./gate.js";
import { maxAccess, scoreNode, type ScoreParts } from "./score.js";

export type RecallNode = NodeRecord & {
  detail: PersonDetail | PlanDetail | null;
  hops: number;
  score: number;
  scores?: ScoreParts;
};

export type RecallResult = {
  nodes: RecallNode[];
  edges: EdgeRecord[];
  coverage: number;
  sufficient: boolean;
  hops_taken: number;
  anchors: string[];
};

export async function recall(opts: {
  db: Db;
  sql: Sql;
  dwar: DwarClient;
  config: Config;
  query: string;
  limit: number;
  debug: boolean;
  now?: Date;
}): Promise<RecallResult> {
  const [queryEmbedding] = await opts.dwar.embed([opts.query]);
  if (!queryEmbedding) {
    throw new YaadError(502, "dwar", "Dwar returned no embedding");
  }

  const anchors = await findAnchors({
    sql: opts.sql,
    config: opts.config,
    embedding: queryEmbedding,
  });
  if (anchors.length === 0) {
    return {
      nodes: [],
      edges: [],
      coverage: 0,
      sufficient: 0 >= opts.config.recall.coverage_floor,
      hops_taken: 0,
      anchors: [],
    };
  }

  const walk = initialWalk(anchors.map((hit) => hit.row.id));
  const rows = new Map<string, NodeRow>(anchors.map((hit) => [hit.row.id, hit.row]));
  let hopsTaken = 0;
  const cfg = opts.config.recall;
  const now = opts.now ?? new Date();

  while (true) {
    const incident = await getIncidentEdgesForIds(opts.db, walk.frontier);
    const expanded = expandOneHop(walk, incident);
    hopsTaken += 1;
    if (expanded.newlyDiscovered.length > 0) {
      const fetched = await getNodesByIds(opts.db, expanded.newlyDiscovered);
      for (const row of fetched) {
        rows.set(row.id, row);
      }
    }
    walk.nodes = expanded.next.nodes;
    walk.frontier = expanded.next.frontier;

    const scored = scoreAll(rows, walk.nodes, queryEmbedding, cfg, now);
    const relevant = new Set(
      scored.filter((item) => item.parts.total >= cfg.relevance_threshold).map((item) => item.row.id),
    );
    const newRelevantCount = expanded.newlyDiscovered.filter((id) => relevant.has(id)).length;
    const tokenEstimate = estimateTokens(
      scored.filter((item) => relevant.has(item.row.id)).map((item) => item.row),
    );
    const gate = shouldStop({
      hopsTaken,
      hopCap: cfg.hop_cap,
      newRelevantCount,
      marginalYieldMinimum: cfg.marginal_yield_minimum,
      tokenEstimate,
      tokenBudget: cfg.token_budget,
    });
    if (gate.stop) {
      break;
    }
    if (walk.frontier.length === 0) {
      break;
    }
  }

  const scored = scoreAll(rows, walk.nodes, queryEmbedding, cfg, now);
  scored.sort((a, b) => b.parts.total - a.parts.total);
  const top = scored.slice(0, opts.limit);
  const returnedIds = new Set(top.map((item) => item.row.id));
  const pathEdges = collectPathEdges(
    top.map((item) => walk.nodes.get(item.row.id)),
    returnedIds,
  );

  const coverage = coverageScore(
    top.map((item) => item.parts.total),
    cfg.coverage_top_n,
  );

  const nodes: RecallNode[] = [];
  for (const item of top) {
    const walkNode = walk.nodes.get(item.row.id);
    const record: RecallNode = {
      ...toNodeRecord(item.row),
      detail: await loadDetail(opts.db, item.row),
      hops: walkNode ? walkNode.hop : 0,
      score: item.parts.total,
    };
    if (opts.debug) {
      record.scores = item.parts;
    }
    nodes.push(record);
  }

  return {
    nodes,
    edges: pathEdges.map(toEdgeRecord),
    coverage,
    sufficient: coverage >= cfg.coverage_floor,
    hops_taken: hopsTaken,
    anchors: anchors.map((hit) => hit.row.id),
  };
}

function scoreAll(
  rows: Map<string, NodeRow>,
  walk: Map<string, { hop: number; path: EdgeRow[]; confidence: number }>,
  queryEmbedding: number[],
  cfg: Config["recall"],
  now: Date,
) {
  const present = [...walk.keys()]
    .map((id) => rows.get(id))
    .filter((row): row is NodeRow => row !== undefined);
  const ctx = {
    queryEmbedding,
    now,
    halfLifeDays: cfg.recency_half_life_days,
    weights: cfg.weights,
    kindPriors: cfg.kind_priors,
    maxAccessCount: maxAccess(present),
  };
  return present.map((row) => {
    const walkNode = walk.get(row.id);
    if (!walkNode) {
      throw new YaadError(500, "internal", `walk missing node ${row.id}`);
    }
    return { row, parts: scoreNode(row, walkNode, ctx) };
  });
}

function collectPathEdges(
  walks: Array<{ path: EdgeRow[] } | undefined>,
  returnedIds: Set<string>,
): EdgeRow[] {
  const byId = new Map<string, EdgeRow>();
  for (const walk of walks) {
    if (!walk) {
      continue;
    }
    for (const edge of walk.path) {
      if (returnedIds.has(edge.srcId) || returnedIds.has(edge.dstId)) {
        byId.set(edge.id, edge);
      }
    }
  }
  return [...byId.values()];
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
): Promise<PersonDetail | PlanDetail | null> {
  if (row.kind === "person") {
    return toPersonDetail(await getPersonDetail(db, row.id));
  }
  if (row.kind === "plan") {
    return toPlanDetail(await getPlanDetail(db, row.id));
  }
  return null;
}

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
