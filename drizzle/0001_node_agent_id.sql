ALTER TABLE "node" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_agent_id_check" CHECK ("node"."agent_id" IS NULL OR "node"."source" = 'agent');