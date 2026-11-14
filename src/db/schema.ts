import {
  boolean,
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
import { OUTCOMES, RSVPS } from "../types/timeline.js";

const embeddingDimension = loadFileConfig().embedding.dimension;

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A SQL IN list of string literals, for CHECK constraints over a fixed set. */
const inList = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(", "));

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
    check("node_kind_check", sql`${table.kind} IN ('person', 'memory', 'plan', 'place', 'task')`),
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
    /** IANA zone of the place when it is not the box's, so clients can show its local time. */
    timeZone: text("time_zone"),
    /** Whether Ankur is going: yes or no; null while he has not said. */
    rsvp: text("rsvp"),
    /** How the plan turned out; null while nobody has said. */
    outcome: text("outcome"),
    outcomeAt: timestamptz("outcome_at"),
    /** When the plan really ran, if that differed from its start and end. */
    actualStart: timestamptz("actual_start"),
    actualEnd: timestamptz("actual_end"),
  },
  (table) => [
    check("plan_rsvp_check", sql`${table.rsvp} IS NULL OR ${table.rsvp} IN (${inList(RSVPS)})`),
    check("plan_outcome_check", sql`${table.outcome} IS NULL OR ${table.outcome} IN (${inList(OUTCOMES)})`),
  ],
);

/**
 * A task: something to do, relevant from `opens_on` until `closes_at`. No window at all means
 * Someday. A close needs an open, and `done_at` is Ankur's tick.
 */
export const taskDetail = pgTable(
  "task_detail",
  {
    nodeId: uuid("node_id")
      .primaryKey()
      .references(() => node.id, { onDelete: "cascade" }),
    opensOn: date("opens_on", { mode: "string" }),
    closesAt: timestamptz("closes_at"),
    doneAt: timestamptz("done_at"),
    verifiedAt: timestamptz("verified_at"),
  },
  (table) => [check("task_window_check", sql`${table.closesAt} IS NULL OR ${table.opensOn} IS NOT NULL`)],
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
export type TaskDetailRow = typeof taskDetail.$inferSelect;
export type PlaceDetailRow = typeof placeDetail.$inferSelect;
export type NodeHistoryRow = typeof nodeHistory.$inferSelect;
