ALTER TABLE "node_history" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "node_history" ADD CONSTRAINT "node_history_agent_id_check" CHECK ("node_history"."agent_id" IS NULL OR "node_history"."source" = 'agent');