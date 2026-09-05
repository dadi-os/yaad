CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "edge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"src_id" uuid NOT NULL,
	"dst_id" uuid NOT NULL,
	"type" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "node" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"embedding" vector(1536),
	"occurred_at" timestamp with time zone,
	"salience" real DEFAULT 0 NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_kind_check" CHECK ("node"."kind" IN ('person', 'memory', 'plan')),
	CONSTRAINT "node_source_check" CHECK ("node"."source" IN ('manual', 'agent', 'ingest'))
);
--> statement-breakpoint
CREATE TABLE "node_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"embedding" vector(1536),
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "node_history_field_check" CHECK ("node_history"."field" IN ('title', 'body', 'occurred_at', 'deleted')),
	CONSTRAINT "node_history_source_check" CHECK ("node_history"."source" IN ('manual', 'agent', 'ingest'))
);
--> statement-breakpoint
CREATE TABLE "person_detail" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"birthday" date,
	"aliases" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_detail" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"end_at" timestamp with time zone,
	"status" text NOT NULL,
	"recurrence" text,
	CONSTRAINT "plan_status_check" CHECK ("plan_detail"."status" IN ('idea', 'tentative', 'confirmed'))
);
--> statement-breakpoint
ALTER TABLE "person_detail" ADD CONSTRAINT "person_detail_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD CONSTRAINT "plan_detail_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_src_id_idx" ON "edge" USING btree ("src_id");--> statement-breakpoint
CREATE INDEX "edge_dst_id_idx" ON "edge" USING btree ("dst_id");--> statement-breakpoint
CREATE INDEX "edge_type_idx" ON "edge" USING btree ("type");--> statement-breakpoint
CREATE INDEX "edge_src_id_current_idx" ON "edge" USING btree ("src_id") WHERE "edge"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "node_kind_idx" ON "node" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "node_occurred_at_idx" ON "node" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "node_embedding_hnsw" ON "node" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "node_history_node_id_idx" ON "node_history" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "node_history_embedding_hnsw" ON "node_history" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "person_detail_aliases_gin" ON "person_detail" USING gin ("aliases");