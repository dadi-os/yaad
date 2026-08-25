import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import { annSearch, type AnnHit } from "../db/ann.js";

/** Keep ANN hits above the similarity floor, capped at anchor_limit. Does not widen the floor. */
export function selectAnchors(hits: AnnHit[], floor: number, limit: number): AnnHit[] {
  return hits.filter((hit) => hit.similarity >= floor).slice(0, limit);
}

export async function findAnchors(opts: {
  sql: Sql;
  config: Config;
  embedding: number[];
  asOf: Date | undefined;
}): Promise<AnnHit[]> {
  const hits = await annSearch({
    sql: opts.sql,
    efSearch: opts.config.hnsw.ef_search,
    embedding: opts.embedding,
    limit: opts.config.recall.anchor_limit,
    ...(opts.asOf !== undefined ? { asOf: opts.asOf } : {}),
  });
  return selectAnchors(hits, opts.config.recall.anchor_similarity_floor, opts.config.recall.anchor_limit);
}
