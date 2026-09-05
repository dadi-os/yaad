import type { Sql } from "./client.js";
import type { NodeHistoryRow, NodeRow } from "./schema.js";
import { YaadError } from "../errors.js";
import type { NodeKind } from "../types/domain.js";
import { cosineDistanceToSimilarity, toSqlVector } from "../vectors.js";

export type AnnHit = {
  row: NodeRow;
  distance: number;
  similarity: number;
};

type AnnRow = NodeRow & { distance: number };

export async function annSearch(opts: {
  sql: Sql;
  efSearch: number;
  embedding: number[];
  limit: number;
  kind?: NodeKind;
}): Promise<AnnHit[]> {
  const vec = toSqlVector(opts.embedding);
  const rows = await opts.sql.begin(async (tx) => {
    await tx`SELECT set_config('hnsw.ef_search', ${String(opts.efSearch)}, true)`;
    if (opts.kind) {
      return tx<AnnRow[]>`
        SELECT
          id, kind, title, body, embedding,
          occurred_at AS "occurredAt", salience, access_count AS "accessCount",
          last_accessed_at AS "lastAccessedAt", source,
          created_at AS "createdAt", updated_at AS "updatedAt",
          (embedding <=> ${vec}::vector) AS distance
        FROM node
        WHERE embedding IS NOT NULL
          AND kind = ${opts.kind}
        ORDER BY embedding <=> ${vec}::vector
        LIMIT ${opts.limit}
      `;
    }
    return tx<AnnRow[]>`
      SELECT
        id, kind, title, body, embedding,
        occurred_at AS "occurredAt", salience, access_count AS "accessCount",
        last_accessed_at AS "lastAccessedAt", source,
        created_at AS "createdAt", updated_at AS "updatedAt",
        (embedding <=> ${vec}::vector) AS distance
      FROM node
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${opts.limit}
    `;
  });

  return rows.map((row) => {
    const mapped = toNodeRow(row);
    const distance = Number(row.distance);
    return {
      row: mapped,
      distance,
      similarity: cosineDistanceToSimilarity(distance),
    };
  });
}

type HistoryAnnRow = NodeHistoryRow & { distance: number };

export async function searchNodeHistory(opts: {
  sql: Sql;
  efSearch: number;
  embedding: number[];
  limit: number;
}): Promise<NodeHistoryRow[]> {
  const vec = toSqlVector(opts.embedding);
  const rows = await opts.sql.begin(async (tx) => {
    await tx`SELECT set_config('hnsw.ef_search', ${String(opts.efSearch)}, true)`;
    return tx<HistoryAnnRow[]>`
      SELECT
        id, node_id AS "nodeId", field,
        old_value AS "oldValue", new_value AS "newValue",
        embedding, changed_at AS "changedAt", source,
        (embedding <=> ${vec}::vector) AS distance
      FROM node_history
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${opts.limit}
    `;
  });

  return rows.map((row) => ({
    id: row.id,
    nodeId: row.nodeId,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    embedding: row.embedding,
    changedAt: toDateRequired(row.changedAt),
    source: row.source,
  }));
}

function toNodeRow(row: AnnRow): NodeRow {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    embedding: row.embedding,
    occurredAt: toDate(row.occurredAt),
    salience: Number(row.salience),
    accessCount: Number(row.accessCount),
    lastAccessedAt: toDate(row.lastAccessedAt),
    source: row.source,
    createdAt: toDateRequired(row.createdAt),
    updatedAt: toDateRequired(row.updatedAt),
  };
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function toDateRequired(value: Date | string | null): Date {
  const parsed = toDate(value);
  if (!parsed) {
    throw new YaadError(500, "internal", "ann row missing timestamp");
  }
  return parsed;
}
