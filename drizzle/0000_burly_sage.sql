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
	"id" uuid NOT NULL,
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
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	CONSTRAINT "node_id_valid_from_pk" PRIMARY KEY("id","valid_from"),
	CONSTRAINT "node_kind_check" CHECK ("node"."kind" IN ('person', 'memory', 'plan')),
	CONSTRAINT "node_source_check" CHECK ("node"."source" IN ('manual', 'agent', 'ingest'))
);
--> statement-breakpoint
CREATE TABLE "node_identity" (
	"id" uuid PRIMARY KEY NOT NULL
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
ALTER TABLE "edge" ADD CONSTRAINT "edge_src_id_node_identity_id_fk" FOREIGN KEY ("src_id") REFERENCES "public"."node_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge" ADD CONSTRAINT "edge_dst_id_node_identity_id_fk" FOREIGN KEY ("dst_id") REFERENCES "public"."node_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node" ADD CONSTRAINT "node_id_node_identity_id_fk" FOREIGN KEY ("id") REFERENCES "public"."node_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_detail" ADD CONSTRAINT "person_detail_node_id_node_identity_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD CONSTRAINT "plan_detail_node_id_node_identity_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_src_id_idx" ON "edge" USING btree ("src_id");--> statement-breakpoint
CREATE INDEX "edge_dst_id_idx" ON "edge" USING btree ("dst_id");--> statement-breakpoint
CREATE INDEX "edge_type_idx" ON "edge" USING btree ("type");--> statement-breakpoint
CREATE INDEX "edge_src_id_current_idx" ON "edge" USING btree ("src_id") WHERE "edge"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "node_kind_idx" ON "node" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "node_occurred_at_idx" ON "node" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "node_kind_current_idx" ON "node" USING btree ("kind") WHERE "node"."valid_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "node_id_current_idx" ON "node" USING btree ("id") WHERE "node"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "node_embedding_hnsw" ON "node" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "person_detail_aliases_gin" ON "person_detail" USING gin ("aliases");