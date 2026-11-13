CREATE TABLE "task_detail" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"opens_on" date,
	"closes_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	CONSTRAINT "task_window_check" CHECK ("task_detail"."closes_at" IS NULL OR "task_detail"."opens_on" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "node" DROP CONSTRAINT "node_kind_check";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP CONSTRAINT "plan_status_check";--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "rsvp" text;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "actual_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "actual_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_detail" ADD CONSTRAINT "task_detail_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_kind_check" CHECK ("node"."kind" IN ('person', 'memory', 'plan', 'place', 'task'));--> statement-breakpoint
ALTER TABLE "plan_detail" ADD CONSTRAINT "plan_rsvp_check" CHECK ("plan_detail"."rsvp" IS NULL OR "plan_detail"."rsvp" IN ('yes', 'no'));--> statement-breakpoint
ALTER TABLE "plan_detail" ADD CONSTRAINT "plan_outcome_check" CHECK ("plan_detail"."outcome" IS NULL OR "plan_detail"."outcome" IN ('done', 'missed'));--> statement-breakpoint
ALTER TABLE "plan_detail" ADD CONSTRAINT "plan_status_check" CHECK ("plan_detail"."status" IN ('idea', 'tentative', 'confirmed', 'cancelled'));--> statement-breakpoint
-- Tasks and RSVP. The schema above is additive: the legacy plan columns (kind, due_at,
-- opens_at, recurrence, hide_from_planner) and plan_occurrence stay until scripts/migrate-timeline.ts
-- has expanded the recurring series, and a later migration drops them. Data, in order (the migrator
-- runs in the box's zone, so ::date is the box's local date):
-- 1. rsvp: a plan hidden from the planner is one Ankur said no to.
-- 2. A one-off plan's only session row folds into the plan: outcome, actual times, cancelled
--    status, and a moved session's start and end.
-- 3. A plan with no start and no rule that is an idea or has a due or an open (a deadline with no
--    time set aside) becomes a task: it closes at its due, opens on its open day (else the day it was
--    created, so nothing that was due stops showing, and never after its close day, which the task
--    window rule forbids), and keeps a done mark as done_at. An idea with no due or open has no window.
-- 4. Any other plan with no start and no rule is a hub (a course or orientation whose schedule was never
--    stored) and becomes a memory; its edges stay.
-- 5. Any other plan still marked idea becomes tentative.
UPDATE "plan_detail" SET "rsvp" = 'no' WHERE "hide_from_planner";--> statement-breakpoint
UPDATE "plan_detail" d SET
  "outcome" = o."outcome",
  "outcome_at" = o."outcome_at",
  "actual_start" = o."actual_start",
  "actual_end" = o."actual_end",
  "status" = CASE WHEN o."state" = 'cancelled' THEN 'cancelled' ELSE d."status" END,
  "end_at" = CASE WHEN o."state" = 'moved' THEN COALESCE(o."end_at", o."start_at" + (d."end_at" - n."occurred_at")) ELSE d."end_at" END
FROM "plan_occurrence" o, "node" n
WHERE o."plan_id" = d."node_id" AND n."id" = d."node_id" AND d."recurrence" IS NULL AND n."occurred_at" IS NOT NULL;--> statement-breakpoint
UPDATE "node" n SET "occurred_at" = o."start_at"
FROM "plan_occurrence" o, "plan_detail" d
WHERE o."plan_id" = n."id" AND d."node_id" = n."id" AND d."recurrence" IS NULL AND n."occurred_at" IS NOT NULL AND o."state" = 'moved';--> statement-breakpoint
INSERT INTO "task_detail" ("node_id", "opens_on", "closes_at", "done_at")
SELECT n."id",
  CASE
    WHEN d."due_at" IS NULL AND d."opens_at" IS NULL THEN NULL
    WHEN d."due_at" IS NULL THEN d."opens_at"::date
    ELSE LEAST(COALESCE(d."opens_at"::date, n."created_at"::date), d."due_at"::date)
  END,
  d."due_at",
  (SELECT COALESCE(o."outcome_at", o."updated_at") FROM "plan_occurrence" o WHERE o."plan_id" = n."id" AND o."outcome" = 'done' LIMIT 1)
FROM "node" n JOIN "plan_detail" d ON d."node_id" = n."id"
WHERE n."kind" = 'plan' AND n."occurred_at" IS NULL AND d."recurrence" IS NULL
  AND (d."due_at" IS NOT NULL OR d."opens_at" IS NOT NULL OR d."status" = 'idea');--> statement-breakpoint
UPDATE "node" SET "kind" = 'task'
WHERE "kind" = 'plan' AND "occurred_at" IS NULL AND "id" IN (SELECT "node_id" FROM "task_detail");--> statement-breakpoint
DELETE FROM "plan_detail" WHERE "node_id" IN (SELECT "node_id" FROM "task_detail");--> statement-breakpoint
UPDATE "node" SET "kind" = 'memory'
WHERE "kind" = 'plan' AND "occurred_at" IS NULL AND "id" IN (SELECT "node_id" FROM "plan_detail" WHERE "recurrence" IS NULL);--> statement-breakpoint
DELETE FROM "plan_detail" WHERE "node_id" IN (SELECT "id" FROM "node" WHERE "kind" = 'memory');--> statement-breakpoint
UPDATE "plan_detail" SET "status" = 'tentative' WHERE "status" = 'idea';
