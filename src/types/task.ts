/** API-facing types for tasks: things to do, each relevant from an open day until a close. */

import type { Hub } from "./planner.js";

/** One task as the task reads show it. */
export type TaskItem = {
  id: string;
  title: string;
  body: string | null;
  /** First local day the task is relevant; null together with `closes_at` means Someday. */
  opens_on: string | null;
  closes_at: string | null;
  done: boolean;
  /** When the task was last created, changed, marked done or not done, or restated true; stale means check the source. Null for rows that predate it. */
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  /** True when the task closed before now and is not done. */
  past_due: boolean;
  hub: Hub | null;
  /** The Hath agent that keeps it: who Message agent reaches. */
  owner: string;
};

/** Where a task's close falls against a day: on it, after it, or before it while the task is not done. */
export type TaskBucket = "due_on_day" | "upcoming" | "past_due";

/** What recall adds to a task's detail so a caller reads dates and urgency without arithmetic. */
export type TaskReading = {
  /** The close in the box's time zone with its weekday, `Wed 2026-11-25 23:59`; null with no close. */
  closes_local: string | null;
  /** The open day with its weekday, `Wed 2026-11-11`; null for Someday. */
  opens_local: string | null;
  /** Against the `relevant_on` day, or today without it; null with no close, or when it closed before the day and is done. */
  bucket: TaskBucket | null;
  /** The Hath agent that wrote the task's course hub, or null when it has no hub or a person wrote it. */
  owner: string | null;
};

/** One course's freshness as recall reports it, keyed by the hub's title. */
export type CourseFreshness = {
  verified_at: string | null;
  /** True when `verified_at` is on today's date in the box's time zone. */
  verified_today: boolean;
  owner: string | null;
};
