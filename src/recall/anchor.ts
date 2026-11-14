import { and, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { annSearch, type AnnHit } from "../db/ann.js";
import { getCurrentPersons } from "../db/read.js";
import { node, taskDetail, type NodeRow } from "../db/schema.js";
import { personNames } from "../ingest/candidates.js";

/** Most plans and tasks a query's title words may add as anchors. */
const TITLE_ANCHOR_LIMIT = 4;

/** Query words too common to name a plan or task. */
const GENERIC_QUERY_WORDS = new Set(["about", "class", "does", "from", "have", "know", "meeting", "session", "tell", "that", "this", "what", "when", "where", "which", "with", "your"]);

/** Keep ANN hits above the similarity floor, capped at anchor_limit. Does not widen the floor. */
export function selectAnchors(hits: AnnHit[], floor: number, limit: number): AnnHit[] {
  return hits.filter((hit) => hit.similarity >= floor).slice(0, limit);
}

/**
 * The words of `query` that can name a plan or task: four letters or more, not generic, and not
 * part of a person's name or alias (Ankur's name says nothing about which event is meant).
 */
export function titleWords(query: string, personWords: Set<string>): string[] {
  const words = query.toLowerCase().match(/\p{L}{4,}/gu) ?? [];
  return [...new Set(words)].filter((word) => !GENERIC_QUERY_WORDS.has(word) && !personWords.has(word));
}

/**
 * Live plans and tasks whose title contains a {@link titleWords} word of `query`, nearest in time
 * to `now` first (undated last), at most {@link TITLE_ANCHOR_LIMIT}. An event embeds as its bare
 * title, so a query naming it ("advising") can sit nearer a person or memory than the event itself.
 */
export async function findTitleAnchors(opts: { db: Db; query: string; now: Date }): Promise<NodeRow[]> {
  const personWords = new Set(
    (await getCurrentPersons(opts.db)).flatMap((person) =>
      personNames(person.node.title, person.detail.aliases).flatMap((name) => name.toLowerCase().split(/\s+/)),
    ),
  );
  const words = titleWords(opts.query, personWords);
  if (words.length === 0) {
    return [];
  }
  const at = sql`coalesce(${node.occurredAt}, ${taskDetail.closesAt})`;
  const rows = await opts.db
    .select({ row: node })
    .from(node)
    .leftJoin(taskDetail, eq(taskDetail.nodeId, node.id))
    .where(
      and(
        inArray(node.kind, ["plan", "task"]),
        or(isNull(node.expiresAt), gt(node.expiresAt, opts.now)),
        or(...words.map((word) => ilike(node.title, `%${word}%`))),
      ),
    )
    .orderBy(sql`abs(extract(epoch from ${at}) - ${opts.now.getTime() / 1000}) asc nulls last`)
    .limit(TITLE_ANCHOR_LIMIT);
  return rows.map((item) => item.row);
}

/**
 * Anchors for a query: plans and tasks its title words name, then the nearest nodes to the
 * query embedding by HNSW search above the similarity floor, together capped at anchor_limit.
 */
export async function findAnchors(opts: {
  db: Db;
  sql: Sql;
  config: Config;
  query: string;
  embedding: number[];
  now: Date;
}): Promise<NodeRow[]> {
  const hits = await annSearch({
    sql: opts.sql,
    efSearch: opts.config.hnsw.ef_search,
    embedding: opts.embedding,
    limit: opts.config.recall.anchor_limit,
  });
  const named = await findTitleAnchors({ db: opts.db, query: opts.query, now: opts.now });
  const nearest = selectAnchors(hits, opts.config.recall.anchor_similarity_floor, opts.config.recall.anchor_limit).map((hit) => hit.row);
  const seen = new Set<string>();
  return [...named, ...nearest]
    .filter((row) => !seen.has(row.id) && seen.add(row.id))
    .slice(0, opts.config.recall.anchor_limit);
}
