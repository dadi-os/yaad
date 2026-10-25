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

/**
 * Reject a recurring plan with no anchor or a rule that does not parse. The anchor is the
 * plan's occurred_at, or its due_at when it has no start (rent due on the 1st).
 */
export function assertRecurrence(opts: { rule: string; start: Date | null; timeZone: string }): void {
  if (!opts.start) {
    throw new YaadError(422, "invalid_request", "recurring plan requires occurred_at or due_at as the series anchor");
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

/** The times a plan's sessions are worked out from. */
export type PlanTiming = {
  start: Date | null;
  end: Date | null;
  due: Date | null;
  opens: Date | null;
  rule: string | null;
};

/** One session of a plan, before what happened to it is applied. */
export type Session = {
  /** Local date of the session's anchor (its start, else its due); it names the session. */
  date: string;
  start: Date | null;
  end: Date | null;
  due: Date | null;
  opens: Date | null;
};

/**
 * A plan's sessions: a one-off plan's only session whatever the window, or each occurrence of
 * a series that may overlap `from`..`to`. A series anchors on the start, or on the due when the
 * plan has none, and every time of the plan moves with its occurrence. An undated plan has none.
 */
export function planSessions(
  timing: PlanTiming,
  from: Date,
  to: Date,
  opts: { timeZone: string; maxInstances: number },
): Session[] {
  const anchor = timing.start ?? timing.due;
  if (anchor === null) {
    return [];
  }
  const shift = (value: Date | null, by: number) => (value === null ? null : new Date(value.getTime() + by));
  if (timing.rule === null) {
    return [{ date: localDate(anchor, opts.timeZone), ...timing }];
  }
  return occurrencesBetween({
    rule: timing.rule,
    start: anchor,
    end: timing.start !== null ? timing.end : null,
    from,
    to,
    maxInstances: opts.maxInstances,
    timeZone: opts.timeZone,
  }).map((occurrence) => {
    const by = occurrence.occurredAt.getTime() - anchor.getTime();
    return {
      date: localDate(occurrence.occurredAt, opts.timeZone),
      start: shift(timing.start, by),
      end: shift(timing.end, by),
      due: shift(timing.due, by),
      opens: shift(timing.opens, by),
    };
  });
}

/** The plan's session on the local `date`, or null when it has none that day. */
export function sessionOn(
  timing: PlanTiming,
  date: string,
  opts: { timeZone: string; maxInstances: number },
): Session | null {
  const day = Date.parse(`${date}T00:00:00Z`);
  const around = planSessions(timing, new Date(day - 86_400_000), new Date(day + 2 * 86_400_000), opts);
  return around.find((session) => session.date === date) ?? null;
}

/** The date of `instant` on the wall clock of `timeZone`, as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A plan's rule in words for a client: "every Tue and Thu", "every 2 weeks on Fri", or rrule's own text. */
export function ruleSummary(rule: string, start: Date, timeZone: string): string {
  const set = parseRule(rule, start, timeZone);
  if (!(set instanceof rrule.RRuleSet)) {
    throw new YaadError(500, "internal_error", `recurrence rule did not parse as a set: ${rule}`);
  }
  const [first] = set.rrules();
  if (first === undefined) {
    return `on ${set.rdates().length} dates`;
  }
  const { freq, interval, byweekday } = first.options;
  if (freq === rrule.RRule.WEEKLY && byweekday.length > 0) {
    const days = byweekday.map((day) => WEEKDAY_NAMES[day]);
    const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}` : days.join("");
    return interval !== undefined && interval > 1 ? `every ${interval} weeks on ${list}` : `every ${list}`;
  }
  return first.toText();
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
