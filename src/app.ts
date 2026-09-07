import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Db, Sql } from "./db/client.js";
import type { DwarClient } from "./dwar/client.js";
import { YaadError } from "./errors.js";
import { registerV1 } from "./routers/v1/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    db: Db;
    sql: Sql;
    dwar: DwarClient;
  }
}

export async function buildApp(
  config: Config,
  deps: { db: Db; sql: Sql; dwar: DwarClient },
): Promise<FastifyInstance> {
  const app = Fastify({
    disableRequestLogging: true,
    logger: {
      level: config.env.logLevel,
      base: { service: "yaad" },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
  });
  app.decorate("config", config);
  app.decorate("db", deps.db);
  app.decorate("sql", deps.sql);
  app.decorate("dwar", deps.dwar);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof YaadError) {
      return reply.status(err.statusCode).send({
        error: { type: err.type, message: err.message },
      });
    }
    const statusCode =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof err.statusCode === "number"
        ? err.statusCode
        : 500;
    const message = err instanceof Error ? err.message : "internal error";
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { type: "invalid_request", message },
      });
    }
    request.log.error(err);
    return reply.status(500).send({
      error: { type: "internal", message: "internal error" },
    });
  });

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(registerV1);
  return app;
}
