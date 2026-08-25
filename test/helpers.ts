import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db, type Sql } from "../src/db/client.js";
import { edge, node, nodeIdentity } from "../src/db/schema.js";
import type { DwarChatResponse, DwarClient } from "../src/dwar/client.js";
import type { Operation } from "../src/ingest/operations.js";

export function axisVector(dimension: number, axis: number): number[] {
  const values = Array.from({ length: dimension }, () => 0);
  const index = axis % dimension;
  values[index] = 1;
  return values;
}

export function testConfig(): Config {
  return loadConfig();
}

export function mockDwar(opts: {
  dimension: number;
  operations?: Operation[];
  embedAxis?: number;
}): DwarClient {
  const axis = opts.embedAxis ?? 0;
  return {
    async embed(texts: string[]) {
      return texts.map(() => axisVector(opts.dimension, axis));
    },
    async reason(): Promise<DwarChatResponse> {
      const operations = opts.operations ?? [{ op: "noop", reason: "nothing to store" }];
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "emit_operations",
            input: { operations },
          },
        ],
      };
    },
  };
}

export async function openTestDb(): Promise<{ db: Db; sql: Sql; close: () => Promise<void> }> {
  const config = loadConfig();
  const { client, db } = createDb(config.env.databaseUrl);
  return {
    db,
    sql: client,
    close: () => client.end(),
  };
}

export async function resetGraph(sql: Sql): Promise<void> {
  await sql`TRUNCATE node_identity CASCADE`;
}

export async function insertMemory(
  db: Db,
  args: { title: string; embedding: number[] },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(nodeIdentity).values({ id });
  await db.insert(node).values({
    id,
    kind: "memory",
    title: args.title,
    body: null,
    embedding: args.embedding,
    occurredAt: now,
    source: "manual",
    createdAt: now,
    validFrom: now,
    validTo: null,
  });
  return id;
}

export async function insertEdge(
  db: Db,
  args: { src: string; dst: string; type: string },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(edge).values({
    id,
    srcId: args.src,
    dstId: args.dst,
    type: args.type,
    properties: {},
    confidence: 1,
    createdAt: now,
    validFrom: now,
    validTo: null,
  });
  return id;
}

export async function countCurrentNodes(sql: Sql): Promise<number> {
  const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM node WHERE valid_to IS NULL`;
  const row = rows[0];
  return row ? Number(row.n) : 0;
}
