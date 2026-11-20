/** API-facing types for the planner: every plan is a stored row, and the app filters what it shows. */

/** Whether Ankur is going; a plan with no answer has a null rsvp. */
export const RSVPS = ["yes", "no"] as const;

export type Rsvp = (typeof RSVPS)[number];

/** Edge type from a course (or any hub) to each of its plans. */
export const PLAN_EDGE = "HAS_PLAN";

/** A memory attached to one plan (`HAS_NOTE`): what was covered, what to follow up. */
export type PlanNote = { id: string; title: string; body: string | null };

/** Where a plan happens: its `AT_LOCATION` place, and the room the edge names. */
export type PlanPlace = { id: string; title: string; address: string | null; room: string | null };

/** The hub a plan or task belongs to (a course, an account), when it has one. */
export type Hub = { id: string; title: string };

/** One plan as the planner shows it. */
export type PlanItem = {
  id: string;
  title: string;
  body: string | null;
  rsvp: Rsvp | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  /** IANA zone of the place, when it is not the box's; times stay instants. */
  time_zone: string | null;
  /** Whether Ankur was there: true attended, false did not; null until he says. */
  attended: boolean | null;
  place: PlanPlace | null;
  hub: Hub | null;
  /** The Hath agent that keeps it (`manual` / `ingest` on rows no agent wrote). */
  owner: string;
  notes: PlanNote[];
};
