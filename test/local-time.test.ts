import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, dayStart, localDate, localInstant, localTime } from "../src/local-time.js";

const ZONE = "America/New_York";

test("a local time keeps its wall-clock reading across the daylight-saving change", () => {
  assert.equal(localInstant("2026-10-27", "10:20", ZONE).toISOString(), "2026-10-27T14:20:00.000Z");
  assert.equal(localInstant("2026-11-03", "10:20", ZONE).toISOString(), "2026-11-03T15:20:00.000Z");
});

test("a local day starts at local midnight and lasts 25 hours on the day the clocks fall back", () => {
  assert.equal(dayStart("2026-11-01", ZONE).toISOString(), "2026-11-01T04:00:00.000Z");
  assert.equal(dayStart("2026-11-02", ZONE).getTime() - dayStart("2026-11-01", ZONE).getTime(), 25 * 3_600_000);
});

test("localDate and localTime read an instant on the zone's wall clock", () => {
  const instant = new Date("2026-11-03T03:30:00.000Z");
  assert.equal(localDate(instant, ZONE), "2026-11-02");
  assert.equal(localTime(instant, ZONE), "22:30");
});

test("addDays moves a local date across month and year ends", () => {
  assert.equal(addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
});
