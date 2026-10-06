/** Expand RRULE plan templates into dated instances within a horizon. */

import rrule from "rrule";
import { YaadError } from "../errors.js";

const { rrulestr } = rrule;

/**
 * Materialize recurrence dates between `start` and the nearer of rule `until` or `horizonEnd`.
 * The rule runs on `timeZone` wall-clock time, so a 10:20 class stays at 10:20 across DST changes.
 * Preserves event duration when `end` is set. Rejects rules that exceed `maxInstances`.
 */
export function expandRecurrence(opts: {
  rule: string;
  start: Date;
  end: Date | null;
  horizonEnd: Date;
  maxInstances: number;
  /** IANA zone the schedule is kept in, e.g. `America/Detroit`. */
  timeZone: string;
}): Array<{ occurredAt: Date; endAt: Date | null }> {
  const wallStart = toWallClock(opts.start, opts.timeZone);
  let rule;
  try {
    rule = rrulestr(opts.rule, { dtstart: wallStart });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new YaadError(422, "invalid_request", `invalid recurrence rule: ${message}`);
  }

  const wallHorizon = toWallClock(opts.horizonEnd, opts.timeZone);
  const until = rule.options.until;
  const rangeEnd = until && until.getTime() < wallHorizon.getTime() ? until : wallHorizon;
  const dates = rule.between(wallStart, rangeEnd, true);

  if (dates.length > opts.maxInstances) {
    throw new YaadError(
      422,
      "invalid_request",
      `recurrence rule expands to ${dates.length} instances, exceeding max_instances_per_series (${opts.maxInstances}): ${opts.rule}`,
    );
  }

  const durationMs =
    opts.end !== null ? opts.end.getTime() - opts.start.getTime() : null;

  return dates.map((wall) => {
    const occurredAt = fromWallClock(wall, opts.timeZone);
    return {
      occurredAt,
      endAt: durationMs !== null ? new Date(occurredAt.getTime() + durationMs) : null,
    };
  });
}

/** `instant` as a floating date whose UTC fields are the wall-clock time in `timeZone`. */
function toWallClock(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return new Date(
    Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour"),
      field("minute"),
      field("second"),
      instant.getUTCMilliseconds(),
    ),
  );
}

/** The instant at which `timeZone` wall-clock time equals the UTC fields of `wall`. */
function fromWallClock(wall: Date, timeZone: string): Date {
  const firstGuess = new Date(wall.getTime() - zoneOffsetMs(wall, timeZone));
  return new Date(wall.getTime() - zoneOffsetMs(firstGuess, timeZone));
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  return toWallClock(instant, timeZone).getTime() - instant.getTime();
}
