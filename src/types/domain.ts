/** API-facing domain types for the memory graph (nodes, edges, history). */

/** Graph node kind. */
export type NodeKind = "person" | "memory" | "plan" | "place";

/** Provenance of a node write. */
export type NodeSource = "manual" | "agent" | "ingest";

/** Who wrote a node: an agent write names the Hath agent; other sources carry none. */
export type NodeAuthor =
  | { source: "agent"; agentId: string }
  | { source: "manual" | "ingest"; agentId: null };

/** Lifecycle status for plan nodes. */
export type PlanStatus = "idea" | "tentative" | "confirmed";

export type PersonDetail = {
  birthday: string | null;
  aliases: string[];
};

export type PlanDetail = {
  end_at: string | null;
  /** Date without a time of day: occurred_at and end_at sit at local midnight of their dates. */
  all_day: boolean;
  status: PlanStatus;
  /** RRULE string when this plan is a recurrence template; null on instances. */
  recurrence: string | null;
  /**
   * On an occurrence a date-bounded query expanded from a recurring plan, that plan's id
   * (the record's own id); null on every stored node.
   */
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
  /** Hath agent that created the node; null unless source is agent. */
  agent_id: string | null;
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
  /** Who made this change, which may differ from who created the node. */
  source: NodeSource;
  /** Hath agent that made this change; null unless source is agent. */
  agent_id: string | null;
};

/** Why `GET /lint` flagged nodes; each rule is a pattern past audits found wrong. */
export type LintRule =
  | "status_snapshot"
  | "working_note"
  | "noon_placeholder"
  | "dated_hub"
  | "duplicate"
  | "unaliased_person";

/** One `GET /lint` finding: the nodes it concerns and what to check. Lint never changes the graph. */
export type LintFinding = {
  rule: LintRule;
  node_ids: string[];
  /** Title of the (first) node, for reading the report without a lookup. */
  title: string;
  note: string;
};
