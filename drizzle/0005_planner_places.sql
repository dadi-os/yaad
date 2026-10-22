CREATE TABLE "planner_place" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planner_travel" (
	"from_place" uuid NOT NULL,
	"to_place" uuid NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "planner_travel_from_place_to_place_pk" PRIMARY KEY("from_place","to_place"),
	CONSTRAINT "planner_travel_minutes_check" CHECK ("planner_travel"."minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "planner_block" ADD COLUMN "place_id" uuid;--> statement-breakpoint
ALTER TABLE "planner_travel" ADD CONSTRAINT "planner_travel_from_place_planner_place_id_fk" FOREIGN KEY ("from_place") REFERENCES "public"."planner_place"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planner_travel" ADD CONSTRAINT "planner_travel_to_place_planner_place_id_fk" FOREIGN KEY ("to_place") REFERENCES "public"."planner_place"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planner_place_name_idx" ON "planner_place" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "planner_block" ADD CONSTRAINT "planner_block_place_id_planner_place_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."planner_place"("id") ON DELETE set null ON UPDATE no action;