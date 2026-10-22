/** API-facing types for the day planner: timed blocks that are separate from the memory graph. */

/** What a block is, which decides how the planner draws it. */
export const PLANNER_KINDS = [
  "wake",
  "meal",
  "class",
  "exam",
  "study",
  "gym",
  "shower",
  "recruiting",
  "free",
  "lights_out",
  "fixed",
] as const;

export type PlannerKind = (typeof PLANNER_KINDS)[number];

/** The glyphs a block can carry, drawn by the client. */
export const PLANNER_ICONS = [
  "sun",
  "cup",
  "fork",
  "book",
  "pulse",
  "drop",
  "brief",
  "leaf",
  "moon",
  "flag",
  "pencil",
  "walk",
  "users",
  "phone",
] as const;

export type PlannerIcon = (typeof PLANNER_ICONS)[number];

/** One timed block of the plan. */
export type PlannerBlock = {
  id: string;
  start_at: string;
  end_at: string;
  title: string;
  note: string | null;
  /** Name of the place the block happens, or null when it has none. */
  place: string | null;
  /**
   * Minutes of travel the planner counts from the previous block's place to this one, or
   * null when either block has no place, the places are the same, or no block precedes it in the result.
   */
  travel_min: number | null;
  kind: PlannerKind;
  icon: PlannerIcon;
  /** The block never moves or shrinks to make room; false only for time that can give way (free time). */
  fixed: boolean;
  /** The block may overlap others, because the person said that overlap is fine. */
  overlap_ok: boolean;
  /** When the person marked the block done; null while open. */
  done_at: string | null;
  /** Who wrote the block: a Hath agent id or "manual". `replace` only ever touches its own source. */
  source: string;
  created_at: string;
  updated_at: string;
};
