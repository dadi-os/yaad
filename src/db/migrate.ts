import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate as runMigrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig, type Config } from "../config.js";
import { createDb } from "./client.js";

export async function migrate(config: Config): Promise<void> {
  const { client, db } = createDb(config.env.databaseUrl);
  try {
    await runMigrate(db, { migrationsFolder: join(config.serviceRoot, "drizzle") });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate(loadConfig());
}
