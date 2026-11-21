/** API-facing domain types for the memory graph (nodes, edges, history). */

import type { Rsvp } from "./planner.js";

/** Graph node kind. */
export type NodeKind = "person" | "memory" | "plan" | "place" | "task";

/** Provenance of a node write. */
export type NodeSource = "manual" | "agent" | "ingest";

/** Who made a change to a node: an agent write names the Hath agent; a hand mark of Ankur's carries none. */
export type NodeAuthor =
  | { source: "agent"; agentId: string }
  | { source: "manual" | "ingest"; agentId: null };

/** The agent that writes memory: every node a write creates belongs to it. */
export type AgentAuthor = { source: "agent"; agentId: string };

export type PersonDetail = {
  birthday: string | null;
  aliases: string[];
};

export type PlanDetail = {
  end_at: string | null;
  /** Date without a time of day: occurred_at and end_at sit at local midnight of their dates. */
  all_day: boolean;
  /** IANA zone of the place when it is not the box's (a Chicago dinner); null otherwise. */
  time_zone: string | null;
  /** Whether Ankur is going; null until he says. */
  rsvp: Rsvp | null;
  /** Whether Ankur was there: true attended, false did not; null until he says. */
  attended: boolean | null;
};

/** A task's window: relevant from `opens_on` until `closes_at`; with neither it is Someday. `verified_at` is its freshness. */
export type TaskDetail = {
  opens_on: string | null;
  closes_at: string | null;
  done: boolean;
  /** When the task was last created, changed, marked done or not done, or restated true by an ingest; null for rows that predate it. */
  verified_at: string | null;
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
  field: "title" | "body" | "occurred_at" | "deleted" | "done" | "agent_id";
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
  | "agent_instruction"
  | "noon_placeholder"
  | "dated_plan_title"
  | "dated_hub"
  | "long_span"
  | "duplicate"
  | "unaliased_person"
  | "place_without_address"
  | "floating"
  | "unknown_edge_type";

/** One `GET /lint` finding: the nodes it concerns and what to check. Lint never changes the graph. */
export type LintFinding = {
  rule: LintRule;
  node_ids: string[];
  /** Title of the (first) node, for reading the report without a lookup. */
  title: string;
  note: string;
};
