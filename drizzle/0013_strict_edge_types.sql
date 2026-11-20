-- Strict edge types. HAS_SESSION is renamed HAS_PLAN. Any edge whose type is not in the allowed list
-- (src/types/edges.ts) becomes RELATED_TO and keeps its old type as the property "was", so nothing is lost
-- and the audit can re-type it. Closed edges are rewritten too, so the history stays readable.
UPDATE "edge" SET "type" = 'HAS_PLAN' WHERE "type" = 'HAS_SESSION';--> statement-breakpoint
UPDATE "edge" SET "properties" = "properties" || jsonb_build_object('was', "type"), "type" = 'RELATED_TO'
WHERE "type" NOT IN ('LIVES_AT', 'ATTENDS', 'ATTENDED', 'WORKS_AT', 'WORKED_AT', 'FREQUENTS', 'FROM', 'ROOMMATE_OF', 'FRIEND_OF', 'PARTNER_OF', 'SIBLING_OF', 'PARENT_OF', 'FAMILY_OF', 'COWORKER_OF', 'CLASSMATE_OF', 'KNOWS', 'ABOUT', 'PREFERS', 'DISLIKES', 'PARTICIPANT', 'ENROLLED_IN', 'TEACHES', 'MEMBER_OF', 'WORKS_ON', 'OWNS', 'HAS_FACET', 'HAS_ITEM', 'HAS_PLAN', 'HAS_NOTE', 'FOR', 'AT_LOCATION', 'RELATED_TO');
