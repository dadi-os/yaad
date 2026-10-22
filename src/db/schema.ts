import {
  boolean,
  check,
  date,
  doublePrecision,
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
import { PLANNER_ICONS, PLANNER_KINDS } from "../types/planner.js";

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
    /** Hath agent that created the node; only set when source is agent. */
    agentId: text("agent_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("node_kind_check", sql`${table.kind} IN ('person', 'memory', 'plan', 'place')`),
    check("node_source_check", sql`${table.source} IN ('manual', 'agent', 'ingest')`),
    check("node_agent_id_check", sql`${table.agentId} IS NULL OR ${table.source} = 'agent'`),
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
    /**
     * The plan has a date but no time of day (an all-day event, or a deadline whose time
     * was never stated). Its occurred_at and end_at sit at local midnight of their dates.
     */
    allDay: boolean("all_day").notNull().default(false),
    status: text("status").notNull(),
    recurrence: text("recurrence"),
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
    /** Who made this change, which may differ from who created the node. */
    source: text("source").notNull(),
    /** Hath agent that made this change; only set when source is agent. */
    agentId: text("agent_id"),
  },
  (table) => [
    check("node_history_field_check", sql`${table.field} IN ('title', 'body', 'occurred_at', 'deleted')`),
    check("node_history_source_check", sql`${table.source} IN ('manual', 'agent', 'ingest')`),
    check("node_history_agent_id_check", sql`${table.agentId} IS NULL OR ${table.source} = 'agent'`),
    index("node_history_node_id_idx").on(table.nodeId),
    index("node_history_embedding_hnsw").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export type NodeRow = typeof node.$inferSelect;
/** A node row as served to clients, which never see its embedding. */
export type NodeRecordRow = Omit<NodeRow, "embedding">;
export type EdgeRow = typeof edge.$inferSelect;
export type PersonDetailRow = typeof personDetail.$inferSelect;
export type PlanDetailRow = typeof planDetail.$inferSelect;
export type PlaceDetailRow = typeof placeDetail.$inferSelect;
export type NodeHistoryRow = typeof nodeHistory.$inferSelect;
export type PlannerBlockRow = typeof plannerBlock.$inferSelect;
export type PlannerPlaceRow = typeof plannerPlace.$inferSelect;

const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

/**
 * A place the planner knows, by name, with coordinates. Blocks name where they happen so
 * the planner can work out the travel between them. Aliases are other names for it.
 */
export const plannerPlace = pgTable(
  "planner_place",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
  },
  (table) => [uniqueIndex("planner_place_name_idx").on(sql`lower(${table.name})`)],
);

/** A stored travel time from one place to another, in minutes, that replaces the distance estimate. */
export const plannerTravel = pgTable(
  "planner_travel",
  {
    fromPlace: uuid("from_place")
      .notNull()
      .references(() => plannerPlace.id, { onDelete: "cascade" }),
    toPlace: uuid("to_place")
      .notNull()
      .references(() => plannerPlace.id, { onDelete: "cascade" }),
    minutes: integer("minutes").notNull(),
  },
  (table) => [primaryKey({ columns: [table.fromPlace, table.toPlace] }), check("planner_travel_minutes_check", sql`${table.minutes} >= 0`)],
);

/**
 * The day planner's timed blocks. They are not graph memory: no embedding, no history, no
 * edges. `source` names the writer so a rewrite of a range replaces only that writer's blocks.
 */
export const plannerBlock = pgTable(
  "planner_block",
  {
    id: uuid("id").primaryKey(),
    startAt: timestamptz("start_at").notNull(),
    endAt: timestamptz("end_at").notNull(),
    title: text("title").notNull(),
    note: text("note"),
    /** Where the block happens; null when it has no fixed place. */
    placeId: uuid("place_id").references(() => plannerPlace.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    icon: text("icon").notNull(),
    fixed: boolean("fixed").notNull().default(true),
    overlapOk: boolean("overlap_ok").notNull().default(false),
    doneAt: timestamptz("done_at"),
    source: text("source").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("planner_block_span_check", sql`${table.endAt} > ${table.startAt}`),
    check("planner_block_kind_check", sql`${table.kind} IN (${inList(PLANNER_KINDS)})`),
    check("planner_block_icon_check", sql`${table.icon} IN (${inList(PLANNER_ICONS)})`),
    index("planner_block_start_idx").on(table.startAt),
  ],
);
