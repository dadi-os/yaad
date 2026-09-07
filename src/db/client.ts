import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  // Drizzle CREATE IF NOT EXISTS emits Postgres NOTICE; default console.log
  // dumps the notice object as multi-line stdout and shreds Loki into noise.
  const client = postgres(databaseUrl, { onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { client, db };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof postgres>;
