/**
 * Postgres + Drizzle handle for Yaad.
 * Suppresses Postgres NOTICE callbacks (Drizzle CREATE IF NOT EXISTS) so Loki
 * is not flooded with multi-line notice objects from the default console.log.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl, { onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { client, db };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof postgres>;
