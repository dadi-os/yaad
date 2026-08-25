import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  const client = postgres(databaseUrl);
  const db = drizzle(client, { schema });
  return { client, db };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof postgres>;
