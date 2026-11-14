-- A plan is something with a real time. `tentative` and `cancelled` were redundant: an invite with a
-- time is a plan with rsvp unset, and a plan called off is closed. Before the column goes, each
-- cancelled plan is closed the way close_node closes a node: a `deleted` node_history row records it,
-- its current edges end, and the node and its plan_detail row (cascade) are removed. `tentative` and
-- `confirmed` need no conversion. The legacy plan columns and plan_occurrence stay for
-- scripts/migrate-timeline.ts.
UPDATE "edge" SET "valid_to" = now()
WHERE "valid_to" IS NULL AND ("src_id" IN (SELECT "node_id" FROM "plan_detail" WHERE "status" = 'cancelled')
  OR "dst_id" IN (SELECT "node_id" FROM "plan_detail" WHERE "status" = 'cancelled'));--> statement-breakpoint
INSERT INTO "node_history" ("id", "node_id", "field", "old_value", "new_value", "changed_at", "source")
SELECT gen_random_uuid(), n."id", 'deleted', n."title", NULL, now(), 'ingest'
FROM "node" n JOIN "plan_detail" d ON d."node_id" = n."id" WHERE d."status" = 'cancelled';--> statement-breakpoint
DELETE FROM "node" WHERE "id" IN (SELECT "node_id" FROM "plan_detail" WHERE "status" = 'cancelled');--> statement-breakpoint
ALTER TABLE "plan_detail" DROP CONSTRAINT "plan_status_check";--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "status";
