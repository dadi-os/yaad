/**
 * Postgres + Drizzle handle for Yaad.
 * Suppresses Postgres NOTICE callbacks (Drizzle CREATE IF NOT EXISTS) so Loki
 * is not flooded with multi-line notice objects from the default console.log.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Open a client and Drizzle handle. `timeZone` sets the session's TimeZone, so SQL that casts
 * an instant to a date reads it on that zone's clock; omitted, the server's zone applies.
 */
export function createDb(databaseUrl: string, timeZone?: string) {
  const client = postgres(databaseUrl, {
    onnotice: () => {},
    ...(timeZone !== undefined ? { connection: { TimeZone: timeZone } } : {}),
  });
  const db = drizzle(client, { schema });
  return { client, db };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof postgres>;
