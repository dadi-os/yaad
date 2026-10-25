import assert from "node:assert/strict";
import { test } from "node:test";
import { planSessions, ruleSummary, sessionOn } from "../src/ingest/recurrence.js";

const calendar = { timeZone: "America/New_York", maxInstances: 500 };

test("a series anchors on its due when it has no start, and every time moves with the occurrence", () => {
  const due = new Date("2026-10-01T04:00:00.000Z");
  const opens = new Date("2026-09-28T13:00:00.000Z");
  const sessions = planSessions(
    { start: null, end: null, due, opens, rule: "FREQ=MONTHLY;BYMONTHDAY=1" },
    new Date("2026-10-01T00:00:00.000Z"),
    new Date("2026-12-15T00:00:00.000Z"),
    calendar,
  );
  assert.deepEqual(
    sessions.map((session) => [session.date, session.start, session.due?.toISOString(), session.opens?.toISOString()]),
    [
      ["2026-10-01", null, "2026-10-01T04:00:00.000Z", "2026-09-28T13:00:00.000Z"],
      ["2026-11-01", null, "2026-11-01T04:00:00.000Z", "2026-10-29T13:00:00.000Z"],
      ["2026-12-01", null, "2026-12-01T05:00:00.000Z", "2026-11-28T14:00:00.000Z"],
    ],
  );
});

test("a session is named by its local date, a one-off plan has its only session, and an undated plan has none", () => {
  const evening = { start: new Date("2026-10-22T02:30:00.000Z"), end: null, due: null, opens: null, rule: null };
  assert.equal(sessionOn(evening, "2026-10-21", calendar)?.date, "2026-10-21");
  assert.equal(sessionOn(evening, "2026-10-22", calendar), null);
  assert.deepEqual(planSessions({ start: null, end: null, due: null, opens: null, rule: null }, new Date(0), new Date(), calendar), []);
});

test("a rule reads in words", () => {
  const start = new Date("2026-09-01T17:00:00.000Z");
  assert.equal(ruleSummary("RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261211T235959\nEXDATE:20261027T130000", start, calendar.timeZone), "every Tue and Thu");
  assert.equal(ruleSummary("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", start, calendar.timeZone), "every 2 weeks on Fri");
  assert.equal(ruleSummary("RDATE:20260903T183000,20261001T183000", start, calendar.timeZone), "on 2 dates");
  assert.equal(ruleSummary("FREQ=MONTHLY;BYMONTHDAY=1", start, calendar.timeZone), "every month on the 1st");
});
