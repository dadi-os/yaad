/** `POST /recall` — graph retrieval anchored on a query, explicit node ids, or exact filters. */

import type { FastifyInstance } from "fastify";
import { assertFilterCoherent, hasFilter } from "../../db/filter.js";
import { YaadError } from "../../errors.js";
import { recall, recordAccess } from "../../recall/pipeline.js";
import { parse, recallBody } from "./schemas.js";

export async function registerRecall(app: FastifyInstance): Promise<void> {
  app.post("/recall", async (request) => {
    const { query, from, hops, limit, debug, ...filter } = parse(recallBody, request.body);
    const filtered = hasFilter(filter);
    if (query === undefined && from === undefined && !filtered) {
      throw new YaadError(422, "invalid_request", "query, from, or a filter is required");
    }
    if (from !== undefined && filtered) {
      throw new YaadError(422, "invalid_request", "from cannot be combined with filters");
    }
    assertFilterCoherent(filter);
    if (hops !== undefined && hops > app.config.recall.hop_cap) {
      throw new YaadError(
        422,
        "invalid_request",
        `hops exceeds maximum of ${app.config.recall.hop_cap}`,
      );
    }
    if (limit !== undefined && limit > app.config.page.max_size) {
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
      query,
      from,
      filter,
      hops,
      limit: limit ?? app.config.recall.default_limit,
      debug: debug === true,
    });
    void recordAccess(
      app.db,
      result.nodes.map((item) => item.id),
    ).catch((err) => {
      request.log.error(
        { code: "record_access_failed", request_id: request.requestId, err },
        "record access failed",
      );
    });
    return result;
  });
}
