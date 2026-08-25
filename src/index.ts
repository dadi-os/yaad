import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { createDwarClient } from "./dwar/client.js";

const config = loadConfig();
await migrate(config);
const { client, db } = createDb(config.env.databaseUrl);
const app = await buildApp(config, {
  db,
  sql: client,
  dwar: createDwarClient(config),
});

const shutdown = async () => {
  await app.close();
  await client.end();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ host: config.env.host, port: config.env.port });
