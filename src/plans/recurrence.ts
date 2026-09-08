/** Expand RRULE plan templates into dated instances within a horizon. */

import rrule from "rrule";
import { YaadError } from "../errors.js";

const { rrulestr } = rrule;

/**
 * Materialize recurrence dates between `start` and the nearer of rule `until` or `horizonEnd`.
 * Preserves event duration when `end` is set. Rejects rules that exceed `maxInstances`.
 */
export function expandRecurrence(opts: {
  rule: string;
  start: Date;
  end: Date | null;
  horizonEnd: Date;
  maxInstances: number;
}): Array<{ occurredAt: Date; endAt: Date | null }> {
  let rule;
  try {
    rule = rrulestr(opts.rule, { dtstart: opts.start });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new YaadError(422, "invalid_request", `invalid recurrence rule: ${message}`);
  }

  const until = rule.options.until;
  const rangeEnd =
    until && until.getTime() < opts.horizonEnd.getTime() ? until : opts.horizonEnd;
  const dates = rule.between(opts.start, rangeEnd, true);

  if (dates.length > opts.maxInstances) {
    throw new YaadError(
      422,
      "invalid_request",
      `recurrence rule expands to ${dates.length} instances, exceeding max_instances_per_series (${opts.maxInstances}): ${opts.rule}`,
    );
  }

  const durationMs =
    opts.end !== null ? opts.end.getTime() - opts.start.getTime() : null;

  return dates.map((occurredAt) => ({
    occurredAt,
    endAt: durationMs !== null ? new Date(occurredAt.getTime() + durationMs) : null,
  }));
}
