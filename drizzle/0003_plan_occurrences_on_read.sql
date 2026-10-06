INSERT INTO "node_history" ("id", "node_id", "field", "old_value", "new_value", "changed_at", "source")
SELECT gen_random_uuid(), "node"."id", 'deleted', "node"."title", NULL, now(), 'manual'
FROM "node" JOIN "plan_detail" ON "plan_detail"."node_id" = "node"."id"
WHERE "plan_detail"."series_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "node" WHERE "id" IN (SELECT "node_id" FROM "plan_detail" WHERE "series_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "plan_detail" DROP COLUMN "series_id";
