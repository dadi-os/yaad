CREATE TABLE "planner_block" (
	"id" uuid PRIMARY KEY NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"kind" text NOT NULL,
	"icon" text NOT NULL,
	"fixed" boolean DEFAULT true NOT NULL,
	"overlap_ok" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "planner_block_span_check" CHECK ("planner_block"."end_at" > "planner_block"."start_at"),
	CONSTRAINT "planner_block_kind_check" CHECK ("planner_block"."kind" IN ('wake', 'meal', 'class', 'exam', 'study', 'gym', 'shower', 'recruiting', 'free', 'lights_out', 'fixed')),
	CONSTRAINT "planner_block_icon_check" CHECK ("planner_block"."icon" IN ('sun', 'cup', 'fork', 'book', 'pulse', 'drop', 'brief', 'leaf', 'moon', 'flag', 'pencil', 'walk', 'users', 'phone'))
);
--> statement-breakpoint
CREATE INDEX "planner_block_start_idx" ON "planner_block" USING btree ("start_at");