-- A plan's `attended` (true he was there, false he was not, null not yet) replaces `outcome`
-- (done to true, missed to false). Nothing computed from outcome_at, actual_start or actual_end, so they go too.
-- A task is done or it is not: `done` replaces the `done_at` tick. Each task that had a done_at becomes
-- done, with one node_history row at that time (`field = 'done'`, false to true), so "done that day" is
-- still answerable. The column has no default: every insert states it.
ALTER TABLE "plan_detail" ADD COLUMN "attended" boolean;--> statement-breakpoint
UPDATE "plan_detail" SET "attended" = CASE "outcome" WHEN 'done' THEN true WHEN 'missed' THEN false END;--> statement-breakpoint
ALTER TABLE "plan_detail" DROP CONSTRAINT "plan_outcome_check";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "outcome";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "outcome_at";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "actual_start";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "actual_end";--> statement-breakpoint
ALTER TABLE "task_detail" ADD COLUMN "done" boolean;--> statement-breakpoint
UPDATE "task_detail" SET "done" = ("done_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "task_detail" ALTER COLUMN "done" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "node_history" DROP CONSTRAINT "node_history_field_check";--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_field_check" CHECK ("node_history"."field" IN ('title', 'body', 'occurred_at', 'deleted', 'done'));--> statement-breakpoint
INSERT INTO "node_history" ("id", "node_id", "field", "old_value", "new_value", "changed_at", "source")
SELECT gen_random_uuid(), "node_id", 'done', 'false', 'true', "done_at", 'ingest' FROM "task_detail" WHERE "done_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "task_detail" DROP COLUMN "done_at";
