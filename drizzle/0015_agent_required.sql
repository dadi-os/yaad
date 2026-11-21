ALTER TABLE "node" DROP CONSTRAINT "node_agent_id_check";--> statement-breakpoint
ALTER TABLE "node" DROP CONSTRAINT "node_source_check";--> statement-breakpoint
ALTER TABLE "node" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_source_check" CHECK ("node"."source" = 'agent');