-- A course hub's freshness: stamped when any task under it is created, changed, marked done or verified.
-- Null until the first such write; existing hubs start stale rather than claiming a check nobody made.
ALTER TABLE "node" ADD COLUMN "verified_at" timestamp with time zone;
