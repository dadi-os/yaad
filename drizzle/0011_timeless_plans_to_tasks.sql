-- Migration 0008 dropped plan_detail.status without converting `tentative`, so the placeholders the
-- timeline migration made from untimed ideas ("Gym training split", "weekly average weigh-in") became
-- real plans at 00:00. A plan is something with a real time: each plan that was `tentative`, starts at
-- 00:00 in its zone (the plan's time_zone, else the migrator session's) and has no end becomes a
-- Someday task (kind task, no window, not done), with an `occurred_at` node_history row for the start
-- it gave up. The former status is not in the live schema; it is read from the archive copies of
-- plan_detail taken before 0008 (plan_detail_evals0_v3 and plan_detail_evalb, each node_id and status),
-- and an archive that does not exist is skipped, so an empty database converts nothing. A converted
-- plan is no longer a plan, so a second run finds nothing to do.
DO $$
DECLARE
  archive text;
BEGIN
  FOREACH archive IN ARRAY ARRAY['plan_detail_evals0_v3', 'plan_detail_evalb'] LOOP
    IF to_regclass(archive) IS NOT NULL THEN
      EXECUTE format($q$
        WITH picked AS (
          SELECT n."id", n."occurred_at" FROM "node" n
          JOIN "plan_detail" d ON d."node_id" = n."id"
          JOIN %I a ON a."node_id" = n."id"
          WHERE n."kind" = 'plan' AND a."status" = 'tentative' AND d."end_at" IS NULL AND n."occurred_at" IS NOT NULL
            AND (n."occurred_at" AT TIME ZONE COALESCE(d."time_zone", current_setting('TimeZone')))::time = '00:00'
        ), history AS (
          INSERT INTO "node_history" ("id", "node_id", "field", "old_value", "new_value", "changed_at", "source")
          SELECT gen_random_uuid(), "id", 'occurred_at', to_char("occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NULL, now(), 'ingest' FROM picked
        ), detail AS (
          INSERT INTO "task_detail" ("node_id", "opens_on", "closes_at", "done") SELECT "id", NULL, NULL, false FROM picked
        ), gone AS (
          DELETE FROM "plan_detail" WHERE "node_id" IN (SELECT "id" FROM picked)
        )
        UPDATE "node" SET "kind" = 'task', "occurred_at" = NULL, "updated_at" = now() WHERE "id" IN (SELECT "id" FROM picked)
      $q$, archive);
    END IF;
  END LOOP;
END
$$;
