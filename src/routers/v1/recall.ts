import type { FastifyInstance } from "fastify";
import { YaadError } from "../../errors.js";
import { recall, recordAccess } from "../../recall/pipeline.js";
import { parse, recallBody } from "./schemas.js";

export async function registerRecall(app: FastifyInstance): Promise<void> {
  app.post("/recall", async (request) => {
    const body = parse(recallBody, request.body);
    if (body.limit !== undefined && body.limit > app.config.page.max_size) {
      throw new YaadError(
        422,
        "invalid_request",
        `limit exceeds maximum of ${app.config.page.max_size}`,
      );
    }
    const result = await recall({
      db: app.db,
      sql: app.sql,
      dwar: app.dwar,
      config: app.config,
      query: body.query,
      limit: body.limit ?? app.config.recall.default_limit,
      asOf: body.as_of ? new Date(body.as_of) : undefined,
      debug: body.debug === true,
    });
    void recordAccess(
      app.db,
      result.nodes.map((item) => item.id),
    ).catch((err) => {
      request.log.error(err);
    });
    return result;
  });
}
