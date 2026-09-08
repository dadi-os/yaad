/** `POST /history/search` — semantic search over node_history corrections. */

import type { FastifyInstance } from "fastify";
import { searchNodeHistory } from "../../db/ann.js";
import { YaadError } from "../../errors.js";
import { toNodeHistoryRecord } from "../../serialize.js";
import { historySearchBody, parse } from "./schemas.js";

export async function registerHistory(app: FastifyInstance): Promise<void> {
  app.post("/history/search", async (request) => {
    const body = parse(historySearchBody, request.body);
    if (body.limit !== undefined && body.limit > app.config.search.max_limit) {
      throw new YaadError(
        422,
        "invalid_request",
        `limit exceeds maximum of ${app.config.search.max_limit}`,
      );
    }
    const [queryEmbedding] = await app.dwar.embed([body.query]);
    if (!queryEmbedding) {
      throw new YaadError(502, "dwar", "Dwar returned no embedding");
    }
    const limit = body.limit ?? app.config.search.default_limit;
    const rows = await searchNodeHistory({
      sql: app.sql,
      efSearch: app.config.hnsw.ef_search,
      embedding: queryEmbedding,
      limit,
    });
    return { results: rows.map(toNodeHistoryRecord) };
  });
}
