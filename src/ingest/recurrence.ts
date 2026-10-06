/** RRULE plan templates: validated on write, expanded into occurrences on read. */

import rrule from "rrule";
import { YaadError } from "../errors.js";

const { rrulestr } = rrule;

/** One dated occurrence of a recurring plan. */
export type Occurrence = { occurredAt: Date; endAt: Date | null };

/**
 * Parse `rule` from `start` in `timeZone` wall-clock time; an unparsable rule is a 422. The
 * rule is either a bare RRULE (`FREQ=WEEKLY;BYDAY=FR`) or RRULE and EXDATE lines, with
 * UNTIL and EXDATE in local time. The start goes in as a DTSTART line because rrule drops
 * its dtstart option for multi-line rules.
 */
function parseRule(rule: string, start: Date, timeZone: string) {
  const dtstart = toWallClock(start, timeZone).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const lines = rule.includes(":") ? rule : `RRULE:${rule}`;
  try {
    return rrulestr(`DTSTART:${dtstart}\n${lines}`, { forceset: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new YaadError(422, "invalid_request", `invalid recurrence rule: ${message}`);
  }
}

/** Reject a recurring plan with no start (its occurred_at) or a rule that does not parse. */
export function assertRecurrence(opts: { rule: string; start: Date | null; timeZone: string }): void {
  if (!opts.start) {
    throw new YaadError(422, "invalid_request", "recurring plan requires occurred_at as the series start");
  }
  parseRule(opts.rule, opts.start, opts.timeZone);
}

/**
 * Occurrences of a recurring plan that overlap `from`..`to`, keeping each one's duration.
 * The rule runs on `timeZone` wall-clock time, so a 10:20 class stays at 10:20 across DST
 * changes. Rejects a window holding more than `maxInstances` occurrences.
 */
export function occurrencesBetween(opts: {
  rule: string;
  start: Date;
  end: Date | null;
  from: Date;
  to: Date;
  maxInstances: number;
  /** IANA zone the schedule is kept in, e.g. `America/Detroit`. */
  timeZone: string;
}): Occurrence[] {
  const rule = parseRule(opts.rule, opts.start, opts.timeZone);
  const durationMs = opts.end !== null ? opts.end.getTime() - opts.start.getTime() : 0;
  const dates = rule.between(
    toWallClock(new Date(opts.from.getTime() - durationMs), opts.timeZone),
    toWallClock(opts.to, opts.timeZone),
    true,
  );
  if (dates.length > opts.maxInstances) {
    throw new YaadError(
      422,
      "invalid_request",
      `recurrence rule has ${dates.length} occurrences in the requested range, more than max_instances_per_series (${opts.maxInstances}); narrow the date range: ${opts.rule}`,
    );
  }
  return dates.map((wall) => {
    const occurredAt = fromWallClock(wall, opts.timeZone);
    return {
      occurredAt,
      endAt: opts.end !== null ? new Date(occurredAt.getTime() + durationMs) : null,
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
