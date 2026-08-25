import type { Sql } from "./client.js";
import type { NodeRow } from "./schema.js";
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
  asOf?: Date;
}): Promise<AnnHit[]> {
  const vec = toSqlVector(opts.embedding);
  const rows = await opts.sql.begin(async (tx) => {
    await tx`SELECT set_config('hnsw.ef_search', ${String(opts.efSearch)}, true)`;
    if (opts.asOf) {
      if (opts.kind) {
        return tx<AnnRow[]>`
          SELECT
            id, kind, title, body, embedding,
            occurred_at AS "occurredAt", salience, access_count AS "accessCount",
            last_accessed_at AS "lastAccessedAt", source,
            created_at AS "createdAt", valid_from AS "validFrom", valid_to AS "validTo",
            (embedding <=> ${vec}::vector) AS distance
          FROM node
          WHERE embedding IS NOT NULL
            AND valid_from <= ${opts.asOf}
            AND (valid_to IS NULL OR valid_to > ${opts.asOf})
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
          created_at AS "createdAt", valid_from AS "validFrom", valid_to AS "validTo",
          (embedding <=> ${vec}::vector) AS distance
        FROM node
        WHERE embedding IS NOT NULL
          AND valid_from <= ${opts.asOf}
          AND (valid_to IS NULL OR valid_to > ${opts.asOf})
        ORDER BY embedding <=> ${vec}::vector
        LIMIT ${opts.limit}
      `;
    }
    if (opts.kind) {
      return tx<AnnRow[]>`
        SELECT
          id, kind, title, body, embedding,
          occurred_at AS "occurredAt", salience, access_count AS "accessCount",
          last_accessed_at AS "lastAccessedAt", source,
          created_at AS "createdAt", valid_from AS "validFrom", valid_to AS "validTo",
          (embedding <=> ${vec}::vector) AS distance
        FROM node
        WHERE valid_to IS NULL
          AND embedding IS NOT NULL
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
        created_at AS "createdAt", valid_from AS "validFrom", valid_to AS "validTo",
        (embedding <=> ${vec}::vector) AS distance
      FROM node
      WHERE valid_to IS NULL
        AND embedding IS NOT NULL
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
    validFrom: toDateRequired(row.validFrom),
    validTo: toDate(row.validTo),
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
