/** API-facing types for tasks: things to do, each relevant from an open day until a close. */

import type { TimelineHub } from "./timeline.js";

/** One task as the task reads show it. */
export type TaskItem = {
  id: string;
  title: string;
  body: string | null;
  /** First local day the task is relevant; null together with `closes_at` means Someday. */
  opens_on: string | null;
  closes_at: string | null;
  done_at: string | null;
  /** When the task was last created, changed, ticked, or restated true; stale means check the source. Null for rows that predate it. */
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  /** True when the task closed before now and is not done. */
  past_due: boolean;
  hub: TimelineHub | null;
  /** Who keeps it: the Hath agent that wrote it, or `manual` / `ingest`. */
  owner: string;
};
