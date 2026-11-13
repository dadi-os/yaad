/** API-facing types for the timeline: every plan is a stored row, and each view is a filter over them. */

/** Whether a plan is happening: tentative, confirmed, or cancelled. */
export const PLAN_STATUSES = ["tentative", "confirmed", "cancelled"] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Whether Ankur is going; a plan with no answer has a null rsvp. */
export const RSVPS = ["yes", "no"] as const;

export type Rsvp = (typeof RSVPS)[number];

/** How a plan turned out; null while nobody has said. */
export const OUTCOMES = ["done", "missed"] as const;

export type Outcome = (typeof OUTCOMES)[number];

/** The filters `POST /timeline` applies: `planner` (the day and week grid), `month`, and `tile` (the home ribbon). */
export const TIMELINE_VIEWS = ["planner", "month", "tile"] as const;

export type TimelineView = (typeof TIMELINE_VIEWS)[number];

/** Edge type from a course (or any hub) to each of its sessions. */
export const SESSION_EDGE = "HAS_SESSION";

/** A memory attached to one plan (`HAS_NOTE`): what was covered, what to follow up. */
export type PlanNote = { id: string; title: string; body: string | null };

/** Where a plan happens: its `AT_LOCATION` place, and the room the edge names. */
export type TimelinePlace = { id: string; title: string; address: string | null; room: string | null };

/** The hub a plan or task belongs to (a course), when it has one. */
export type TimelineHub = { id: string; title: string };

/** One plan as a view shows it. */
export type TimelineItem = {
  id: string;
  title: string;
  body: string | null;
  status: PlanStatus;
  rsvp: Rsvp | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  /** IANA zone of the place, when it is not the box's; times stay instants. */
  time_zone: string | null;
  outcome: Outcome | null;
  outcome_at: string | null;
  actual_start: string | null;
  actual_end: string | null;
  place: TimelinePlace | null;
  hub: TimelineHub | null;
  /** Who keeps it: the Hath agent that wrote it, or `manual` / `ingest`. */
  owner: string;
  notes: PlanNote[];
};
