-- A plan is something with a real time. A plan that starts at 00:00 in its zone, has no end and is not an
-- all-day event states no time at all (an all-day event is the form for a date with no time), so it is
-- an idea someone dated by default: it becomes a Someday task (kind task, no window, not done) with an
-- `occurred_at` node_history row for the start it gave up. Migration 0011 did this only for plans whose
-- former status an archive still held; this one reads the plan's own shape, so it also covers plans made
-- after that archive. A converted plan is no longer a plan, so a second run finds nothing to do.
WITH picked AS (
  SELECT n."id", n."occurred_at" FROM "node" n
  JOIN "plan_detail" d ON d."node_id" = n."id"
  WHERE n."kind" = 'plan' AND d."end_at" IS NULL AND NOT d."all_day" AND n."occurred_at" IS NOT NULL
    AND (n."occurred_at" AT TIME ZONE COALESCE(d."time_zone", current_setting('TimeZone')))::time = '00:00'
), history AS (
  INSERT INTO "node_history" ("id", "node_id", "field", "old_value", "new_value", "changed_at", "source")
  SELECT gen_random_uuid(), "id", 'occurred_at', to_char("occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NULL, now(), 'ingest' FROM picked
), detail AS (
  INSERT INTO "task_detail" ("node_id", "opens_on", "closes_at", "done") SELECT "id", NULL, NULL, false FROM picked
), gone AS (
  DELETE FROM "plan_detail" WHERE "node_id" IN (SELECT "id" FROM picked)
)
UPDATE "node" SET "kind" = 'task', "occurred_at" = NULL, "updated_at" = now() WHERE "id" IN (SELECT "id" FROM picked);
