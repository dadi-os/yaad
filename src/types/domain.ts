/** API-facing domain types for the memory graph (nodes, edges, history). */

/** Graph node kind. */
export type NodeKind = "person" | "memory" | "plan" | "place";

/** Provenance of a node write. */
export type NodeSource = "manual" | "agent" | "ingest";

/** Lifecycle status for plan nodes. */
export type PlanStatus = "idea" | "tentative" | "confirmed";

export type PersonDetail = {
  birthday: string | null;
  aliases: string[];
};

export type PlanDetail = {
  end_at: string | null;
  status: PlanStatus;
  /** RRULE string when this plan is a recurrence template; null on instances. */
  recurrence: string | null;
  /** Template node id for materialized instances; null on the template itself. */
  series_id: string | null;
};

export type PlaceDetail = {
  address: string | null;
  latitude: number | null;
  longitude: number | null;
};

export type NodeRecord = {
  id: string;
  kind: NodeKind;
  title: string;
  body: string | null;
  occurred_at: string | null;
  expires_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  source: NodeSource;
  created_at: string;
  updated_at: string;
};

export type EdgeRecord = {
  id: string;
  src_id: string;
  dst_id: string;
  type: string;
  properties: Record<string, unknown>;
  confidence: number;
  created_at: string;
  valid_from: string;
  /** Soft-close timestamp; null while the edge is current. */
  valid_to: string | null;
};

export type NodeHistoryRecord = {
  id: string;
  node_id: string;
  field: "title" | "body" | "occurred_at" | "deleted";
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  source: NodeSource;
};
