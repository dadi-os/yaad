/** Wall-clock arithmetic in an IANA zone: local dates, local day bounds, and a local date and time as an instant. */

/** The date of `instant` on the wall clock of `timeZone`, as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** The local `date` (YYYY-MM-DD) `days` later or earlier, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The instant at which `timeZone` reads `time` (HH:MM) on the local `date` (YYYY-MM-DD). */
export function localInstant(date: string, time: string, timeZone: string): Date {
  const wall = new Date(`${date}T${time}:00Z`);
  const firstGuess = new Date(wall.getTime() - zoneOffsetMs(wall, timeZone));
  return new Date(wall.getTime() - zoneOffsetMs(firstGuess, timeZone));
}

/** The instant the local `date` begins in `timeZone`. */
export function dayStart(date: string, timeZone: string): Date {
  return localInstant(date, "00:00", timeZone);
}

/** The wall-clock time of `instant` in `timeZone`, as HH:MM. */
export function localTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(instant);
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
  const field = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(
    Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"), instant.getUTCMilliseconds()),
  );
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  return toWallClock(instant, timeZone).getTime() - instant.getTime();
}
