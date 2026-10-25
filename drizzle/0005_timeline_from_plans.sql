-- The planner becomes a filter over plans. Schema: plan_detail gains kind, due_at, opens_at,
-- time_zone and hide_from_planner; plan_occurrence holds what happened to one session; the
-- planner_block table goes. Data, in order (the migrator runs in the box's zone, so ::date is
-- the box's local date):
-- 1. kind, from what the graph already says: "lab" for a recurring plan titled with a course
--    code ("CSE 380 — lab …") and the word lab, or a HAS_ITEM lab item; "class" for any other
--    recurring course-code plan or a course-code HAS_ITEM session ("CSE 300 — discussion
--    session"); "task" for a HAS_ITEM assignment, deadline or milestone, or a title ending
--    " due"; "exam" for any other HAS_ITEM quiz or exam; "bill" for a monthly series about
--    rent, a payment, a bill, a transfer, a card, a loan, insurance, a subscription or tuition.
-- 2. hide_from_planner for office hours.
-- 3. A task or bill with a start and no end is a deadline: its occurred_at moves to due_at (a
--    series then anchors on its due), with an occurred_at history row. All-day ones stay
--    all-day, due at local midnight.
-- 4. Planner blocks starting today or later become one-off plans with no embedding (meal,
--    shower, gym and study keep their kind, recruiting becomes focus, fixed becomes meeting),
--    written by the block's source, with a done block's mark as a done session. Class, exam,
--    wake, free and lights_out blocks are dropped (commitments come from their own plans), as
--    is a block that starts exactly when a live timed plan does (its twin, such as a dinner
--    reservation). Past blocks are dropped with the table.
CREATE TABLE "plan_occurrence" (
	"plan_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_occurrence_plan_id_occurrence_date_pk" PRIMARY KEY("plan_id","occurrence_date"),
	CONSTRAINT "plan_occurrence_state_check" CHECK ("plan_occurrence"."state" IN ('scheduled', 'moved', 'cancelled')),
	CONSTRAINT "plan_occurrence_outcome_check" CHECK ("plan_occurrence"."outcome" IS NULL OR "plan_occurrence"."outcome" IN ('done', 'missed')),
	CONSTRAINT "plan_occurrence_moved_check" CHECK (("plan_occurrence"."state" = 'moved') = ("plan_occurrence"."start_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "opens_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD COLUMN "hide_from_planner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_occurrence" ADD CONSTRAINT "plan_occurrence_plan_id_node_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_detail" ADD CONSTRAINT "plan_kind_check" CHECK ("plan_detail"."kind" IS NULL OR "plan_detail"."kind" IN ('class', 'lab', 'exam', 'task', 'meeting', 'appointment', 'reservation', 'social', 'trip', 'bill', 'meal', 'shower', 'gym', 'study', 'focus'));--> statement-breakpoint
UPDATE "plan_detail" SET "kind" = 'lab'
WHERE "node_id" IN (
  SELECT "node"."id" FROM "node" JOIN "plan_detail" "d" ON "d"."node_id" = "node"."id"
  WHERE "d"."recurrence" IS NOT NULL AND "node"."title" ~ '^[A-Z]{2,4} ?[0-9]{3}' AND "node"."title" ~* '\mlab\M'
  UNION
  SELECT "dst_id" FROM "edge" WHERE "valid_to" IS NULL AND "type" = 'HAS_ITEM' AND "properties"->>'item' = 'lab'
);--> statement-breakpoint
UPDATE "plan_detail" SET "kind" = 'class'
WHERE "kind" IS NULL
  AND "node_id" IN (SELECT "id" FROM "node" WHERE "title" ~ '^[A-Z]{2,4} ?[0-9]{3}')
  AND ("recurrence" IS NOT NULL
    OR "node_id" IN (SELECT "dst_id" FROM "edge" WHERE "valid_to" IS NULL AND "type" = 'HAS_ITEM' AND "properties"->>'item' = 'session'));--> statement-breakpoint
UPDATE "plan_detail" SET "kind" = 'task'
WHERE "kind" IS NULL
  AND ("node_id" IN (SELECT "dst_id" FROM "edge" WHERE "valid_to" IS NULL AND "type" = 'HAS_ITEM' AND "properties"->>'item' IN ('assignment', 'deadline', 'milestone'))
    OR "node_id" IN (SELECT "id" FROM "node" WHERE "title" ~* ' due$'));--> statement-breakpoint
UPDATE "plan_detail" SET "kind" = 'exam'
WHERE "kind" IS NULL
  AND "node_id" IN (SELECT "dst_id" FROM "edge" WHERE "valid_to" IS NULL AND "type" = 'HAS_ITEM' AND "properties"->>'item' IN ('quiz', 'exam'));--> statement-breakpoint
UPDATE "plan_detail" SET "kind" = 'bill'
WHERE "kind" IS NULL
  AND "recurrence" ~* 'FREQ=MONTHLY'
  AND "node_id" IN (SELECT "id" FROM "node" WHERE "title" ~* '\m(rent|payments?|bills?|transfers?|credit card|loan|insurance|subscription|tuition)\M');--> statement-breakpoint
UPDATE "plan_detail" SET "hide_from_planner" = true
WHERE "node_id" IN (SELECT "id" FROM "node" WHERE "title" ~* 'office hours');--> statement-breakpoint
INSERT INTO "node_history" ("id", "node_id", "field", "old_value", "new_value", "changed_at", "source")
SELECT gen_random_uuid(), "node"."id", 'occurred_at', to_char("node"."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NULL, now(), 'manual'
FROM "node" JOIN "plan_detail" ON "plan_detail"."node_id" = "node"."id"
WHERE "plan_detail"."kind" IN ('task', 'bill') AND "plan_detail"."end_at" IS NULL AND "node"."occurred_at" IS NOT NULL;--> statement-breakpoint
UPDATE "plan_detail" SET "due_at" = "node"."occurred_at"
FROM "node"
WHERE "node"."id" = "plan_detail"."node_id"
  AND "plan_detail"."kind" IN ('task', 'bill') AND "plan_detail"."end_at" IS NULL AND "node"."occurred_at" IS NOT NULL;--> statement-breakpoint
UPDATE "node" SET "occurred_at" = NULL, "updated_at" = now()
FROM "plan_detail"
WHERE "plan_detail"."node_id" = "node"."id"
  AND "plan_detail"."kind" IN ('task', 'bill') AND "plan_detail"."due_at" IS NOT NULL AND "node"."occurred_at" = "plan_detail"."due_at";--> statement-breakpoint
CREATE TEMP TABLE "block_plan" ON COMMIT DROP AS
SELECT gen_random_uuid() AS "plan_id", "b".*,
  CASE "b"."kind" WHEN 'recruiting' THEN 'focus' WHEN 'fixed' THEN 'meeting' ELSE "b"."kind" END AS "plan_kind"
FROM "planner_block" "b"
WHERE "b"."start_at" >= date_trunc('day', now())
  AND "b"."kind" IN ('meal', 'shower', 'gym', 'study', 'recruiting', 'fixed')
  AND NOT EXISTS (
    SELECT 1 FROM "node" JOIN "plan_detail" ON "plan_detail"."node_id" = "node"."id"
    WHERE "node"."occurred_at" = "b"."start_at" AND ("node"."expires_at" IS NULL OR "node"."expires_at" > now())
  );--> statement-breakpoint
INSERT INTO "node" ("id", "kind", "title", "body", "embedding", "occurred_at", "source", "agent_id", "created_at", "updated_at")
SELECT "plan_id", 'plan', "title", "note", NULL, "start_at",
  CASE WHEN "source" = 'manual' THEN 'manual' ELSE 'agent' END,
  CASE WHEN "source" = 'manual' THEN NULL ELSE "source" END,
  "created_at", now()
FROM "block_plan";--> statement-breakpoint
INSERT INTO "plan_detail" ("node_id", "end_at", "all_day", "status", "kind")
SELECT "plan_id", "end_at", false, 'confirmed', "plan_kind" FROM "block_plan";--> statement-breakpoint
INSERT INTO "plan_occurrence" ("plan_id", "occurrence_date", "state", "outcome", "outcome_at", "source", "updated_at")
SELECT "plan_id", "start_at"::date, 'scheduled', 'done', "done_at", "source", now()
FROM "block_plan" WHERE "done_at" IS NOT NULL;--> statement-breakpoint
DROP TABLE "planner_block" CASCADE;
