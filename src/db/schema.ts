import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { loadFileConfig } from "../config.js";

const embeddingDimension = loadFileConfig().embedding.dimension;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Stable vertex identity. Edges and detail tables foreign-key this id so node
 * rows can version on (id, valid_from) without breaking the graph.
 */
export const nodeIdentity = pgTable("node_identity", {
  id: uuid("id").primaryKey(),
});

export const node = pgTable(
  "node",
  {
    id: uuid("id")
      .notNull()
      .references(() => nodeIdentity.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    embedding: vector("embedding", { dimensions: embeddingDimension }),
    occurredAt: timestamptz("occurred_at"),
    salience: real("salience").notNull().default(0),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: timestamptz("last_accessed_at"),
    source: text("source").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    validFrom: timestamptz("valid_from").notNull().defaultNow(),
    validTo: timestamptz("valid_to"),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.validFrom] }),
    check("node_kind_check", sql`${table.kind} IN ('person', 'memory', 'plan')`),
    check("node_source_check", sql`${table.source} IN ('manual', 'agent', 'ingest')`),
    index("node_kind_idx").on(table.kind),
    index("node_occurred_at_idx").on(table.occurredAt),
    index("node_kind_current_idx")
      .on(table.kind)
      .where(sql`${table.validTo} IS NULL`),
    uniqueIndex("node_id_current_idx")
      .on(table.id)
      .where(sql`${table.validTo} IS NULL`),
    index("node_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const edge = pgTable(
  "edge",
  {
    id: uuid("id").primaryKey(),
    srcId: uuid("src_id")
      .notNull()
      .references(() => nodeIdentity.id),
    dstId: uuid("dst_id")
      .notNull()
      .references(() => nodeIdentity.id),
    type: text("type").notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    confidence: real("confidence").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    validFrom: timestamptz("valid_from").notNull().defaultNow(),
    validTo: timestamptz("valid_to"),
  },
  (table) => [
    index("edge_src_id_idx").on(table.srcId),
    index("edge_dst_id_idx").on(table.dstId),
    index("edge_type_idx").on(table.type),
    index("edge_src_id_current_idx")
      .on(table.srcId)
      .where(sql`${table.validTo} IS NULL`),
  ],
);

export const personDetail = pgTable(
  "person_detail",
  {
    nodeId: uuid("node_id")
      .primaryKey()
      .references(() => nodeIdentity.id, { onDelete: "cascade" }),
    birthday: date("birthday", { mode: "string" }),
    aliases: text("aliases").array().notNull().default(sql`'{}'`),
  },
  (table) => [index("person_detail_aliases_gin").using("gin", table.aliases)],
);

export const planDetail = pgTable("plan_detail", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => nodeIdentity.id, { onDelete: "cascade" }),
  endAt: timestamptz("end_at"),
  status: text("status").notNull(),
  recurrence: text("recurrence"),
}, (table) => [
  check("plan_status_check", sql`${table.status} IN ('idea', 'tentative', 'confirmed')`),
]);

export type NodeRow = typeof node.$inferSelect;
export type EdgeRow = typeof edge.$inferSelect;
export type PersonDetailRow = typeof personDetail.$inferSelect;
export type PlanDetailRow = typeof planDetail.$inferSelect;
