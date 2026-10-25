/** API-facing types for the timeline: plans read session by session through one set of views. */

/** Kinds of plan Ankur commits to; they reach the month and the home tile. */
export const COMMITMENT_KINDS = [
  "class",
  "lab",
  "exam",
  "task",
  "meeting",
  "appointment",
  "reservation",
  "social",
  "trip",
  "bill",
] as const;

/** Kinds of time agents lay out around the commitments; they stay on the day and week grid only. */
export const ROUTINE_KINDS = ["meal", "shower", "gym", "study", "focus"] as const;

/** What a plan is, which decides where the views show it and how clients draw it. */
export const PLAN_KINDS = [...COMMITMENT_KINDS, ...ROUTINE_KINDS] as const;

export type PlanKind = (typeof PLAN_KINDS)[number];

/** How one session turned out; null while nobody has said. */
export const OUTCOMES = ["done", "missed"] as const;

export type Outcome = (typeof OUTCOMES)[number];

/** What happened to one session: as scheduled, moved to other times, or cancelled. */
export const OCCURRENCE_STATES = ["scheduled", "moved", "cancelled"] as const;

export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

/**
 * The filters `POST /timeline` applies: `planner` (the day and week grid), `due`, `month`,
 * `someday`, and `tile` (the home ribbon's commitments).
 */
export const TIMELINE_VIEWS = ["planner", "due", "month", "someday", "tile"] as const;

export type TimelineView = (typeof TIMELINE_VIEWS)[number];

/** A memory attached to one session (`HAS_NOTE` with that session's date): what was covered, what to follow up. */
export type SessionNote = { id: string; title: string; body: string | null };

/** Where a plan happens: its `AT_LOCATION` place, and the room the edge names. */
export type TimelinePlace = { id: string; title: string; address: string | null; room: string | null };

/** One session of a plan as a view shows it, with what happened to it. */
export type TimelineItem = {
  /** The plan node's id, the same for every session of a series. */
  id: string;
  /** Local date the session was first scheduled for; with `id` it names the session. Null for an undated idea. */
  occurrence_date: string | null;
  title: string;
  body: string | null;
  kind: PlanKind | null;
  status: "idea" | "tentative" | "confirmed";
  /** When the session runs, moved times applied; null for a deadline with no time set aside. */
  start_at: string | null;
  end_at: string | null;
  due_at: string | null;
  opens_at: string | null;
  all_day: boolean;
  /** IANA zone of the place, when it is not the box's; times stay instants. */
  time_zone: string | null;
  hide_from_planner: boolean;
  state: OccurrenceState;
  outcome: Outcome | null;
  outcome_at: string | null;
  actual_start: string | null;
  actual_end: string | null;
  /** The plan's rule in words ("every Tue and Thu"); null for a one-off plan. */
  recurrence: string | null;
  /** For a series: sessions completed and sessions held so far (cancelled ones left out); null for a one-off plan. */
  series: { completed: number; total: number } | null;
  place: TimelinePlace | null;
  /** Who keeps it: the Hath agent that wrote it, or `manual` / `ingest`. */
  owner: string;
  notes: SessionNote[];
};
