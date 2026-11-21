ALTER TABLE "plan_occurrence" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "plan_occurrence" CASCADE;--> statement-breakpoint
ALTER TABLE "node_history" DROP CONSTRAINT "node_history_field_check";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP CONSTRAINT "plan_kind_check";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "recurrence";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "due_at";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "opens_at";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "hide_from_planner";--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_field_check" CHECK ("node_history"."field" IN ('title', 'body', 'occurred_at', 'deleted', 'done', 'agent_id'));