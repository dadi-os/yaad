import {
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { loadFileConfig } from "../config.js";

const embeddingDimension = loadFileConfig().embedding.dimension;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const node = pgTable(
  "node",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    embedding: vector("embedding", { dimensions: embeddingDimension }),
    occurredAt: timestamptz("occurred_at"),
    expiresAt: timestamptz("expires_at"),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: timestamptz("last_accessed_at"),
    source: text("source").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("node_kind_check", sql`${table.kind} IN ('person', 'memory', 'plan', 'place')`),
    check("node_source_check", sql`${table.source} IN ('manual', 'agent', 'ingest')`),
    index("node_kind_idx").on(table.kind),
    index("node_occurred_at_idx").on(table.occurredAt),
    index("node_live_idx")
      .on(table.kind)
      .where(sql`${table.expiresAt} IS NULL`),
    index("node_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

/**
 * Edges keep soft-close versioning. src_id/dst_id are plain uuids (no FK to
 * node) so closed edge rows survive hard-delete of a node.
 */
export const edge = pgTable(
  "edge",
  {
    id: uuid("id").primaryKey(),
    srcId: uuid("src_id").notNull(),
    dstId: uuid("dst_id").notNull(),
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
      .references(() => node.id, { onDelete: "cascade" }),
    birthday: date("birthday", { mode: "string" }),
    aliases: text("aliases").array().notNull().default(sql`'{}'`),
  },
  (table) => [index("person_detail_aliases_gin").using("gin", table.aliases)],
);

export const planDetail = pgTable(
  "plan_detail",
  {
    nodeId: uuid("node_id")
      .primaryKey()
      .references(() => node.id, { onDelete: "cascade" }),
    endAt: timestamptz("end_at"),
    status: text("status").notNull(),
    recurrence: text("recurrence"),
    seriesId: uuid("series_id"),
  },
  (table) => [
    check("plan_status_check", sql`${table.status} IN ('idea', 'tentative', 'confirmed')`),
  ],
);

export const placeDetail = pgTable("place_detail", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => node.id, { onDelete: "cascade" }),
  address: text("address"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
});

export const nodeHistory = pgTable(
  "node_history",
  {
    id: uuid("id").primaryKey(),
    nodeId: uuid("node_id").notNull(),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    embedding: vector("embedding", { dimensions: embeddingDimension }),
    changedAt: timestamptz("changed_at").notNull().defaultNow(),
    source: text("source").notNull(),
  },
  (table) => [
    check("node_history_field_check", sql`${table.field} IN ('title', 'body', 'occurred_at', 'deleted')`),
    check("node_history_source_check", sql`${table.source} IN ('manual', 'agent', 'ingest')`),
    index("node_history_node_id_idx").on(table.nodeId),
    index("node_history_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export type NodeRow = typeof node.$inferSelect;
export type EdgeRow = typeof edge.$inferSelect;
export type PersonDetailRow = typeof personDetail.$inferSelect;
export type PlanDetailRow = typeof planDetail.$inferSelect;
export type PlaceDetailRow = typeof placeDetail.$inferSelect;
export type NodeHistoryRow = typeof nodeHistory.$inferSelect;
