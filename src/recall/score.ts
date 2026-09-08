/** Multi-signal scoring for recall ranking (semantic, hop, recency, etc.). */

import type { Config } from "../config.js";
import type { NodeRow } from "../db/schema.js";
import { cosineSimilarity, parseVector } from "../vectors.js";
import type { WalkNode } from "./expand.js";

export type ScoreParts = {
  semantic: number;
  proximity: number;
  recency: number;
  frequency: number;
  edge_confidence: number;
  kind_prior: number;
  total: number;
};

export type ScoreContext = {
  queryEmbedding: number[];
  now: Date;
  halfLifeDays: number;
  weights: Config["recall"]["weights"];
  kindPriors: Config["recall"]["kind_priors"];
  maxAccessCount: number;
};

/** Decay with hop distance: `1 / (1 + hop)`. */
export function proximityScore(hop: number): number {
  return 1 / (1 + hop);
}

/** Exponential recency using occurred_at (or created_at) and a half-life in days. */
export function recencyScore(occurredAt: Date | null, createdAt: Date, now: Date, halfLifeDays: number): number {
  const when = occurredAt ?? createdAt;
  const ageDays = Math.max(0, (now.getTime() - when.getTime()) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

/** Log-normalized access frequency relative to the walk's max access_count. */
export function frequencyScore(accessCount: number, maxAccessCount: number): number {
  if (maxAccessCount <= 0) {
    return 0;
  }
  return Math.log(1 + accessCount) / Math.log(1 + maxAccessCount);
}

/** Cosine similarity between the query embedding and the node's stored vector. */
export function semanticScore(queryEmbedding: number[], nodeEmbedding: unknown): number {
  const vector = parseVector(nodeEmbedding);
  if (!vector) {
    return 0;
  }
  return cosineSimilarity(queryEmbedding, vector);
}

/** Kind multiplier from config; throws on unexpected kind strings. */
export function kindPrior(kind: string, priors: Config["recall"]["kind_priors"]): number {
  if (kind === "person" || kind === "memory" || kind === "plan" || kind === "place") {
    return priors[kind];
  }
  throw new Error(`invalid node kind: ${kind}`);
}

/** Weighted total score for one walk node; `total = weightedSum * kind_prior`. */
export function scoreNode(row: NodeRow, walk: WalkNode, ctx: ScoreContext): ScoreParts {
  const semantic = semanticScore(ctx.queryEmbedding, row.embedding);
  const proximity = proximityScore(walk.hop);
  const recency = recencyScore(row.occurredAt, row.createdAt, ctx.now, ctx.halfLifeDays);
  const frequency = frequencyScore(row.accessCount, ctx.maxAccessCount);
  const edge_confidence = walk.confidence;
  const kind_prior = kindPrior(row.kind, ctx.kindPriors);
  const weighted =
    ctx.weights.semantic * semantic +
    ctx.weights.proximity * proximity +
    ctx.weights.recency * recency +
    ctx.weights.frequency * frequency +
    ctx.weights.edge_confidence * edge_confidence;
  return {
    semantic,
    proximity,
    recency,
    frequency,
    edge_confidence,
    kind_prior,
    total: weighted * kind_prior,
  };
}

/** Max access_count among rows (denominator for frequencyScore). */
export function maxAccess(rows: NodeRow[]): number {
  return rows.reduce((max, row) => (row.accessCount > max ? row.accessCount : max), 0);
}
