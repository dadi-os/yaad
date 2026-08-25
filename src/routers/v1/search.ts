import type { FastifyInstance } from "fastify";
import { YaadError } from "../../errors.js";
import { toNodeRecord } from "../../serialize.js";
import { parse, searchBody } from "./schemas.js";
import { annSearch } from "../../db/ann.js";

export async function registerSearch(app: FastifyInstance): Promise<void> {
  app.post("/search", async (request) => {
    const body = parse(searchBody, request.body);
    if (body.limit !== undefined && body.limit > app.config.search.max_limit) {
      throw new YaadError(
        422,
        "invalid_request",
        `limit exceeds maximum of ${app.config.search.max_limit}`,
      );
    }
    const limit = body.limit ?? app.config.search.default_limit;
    const [queryVector] = await app.dwar.embed([body.query]);
    if (!queryVector) {
      throw new YaadError(502, "dwar", "Dwar returned no embedding");
    }
    const hits = await annSearch({
      sql: app.sql,
      efSearch: app.config.hnsw.ef_search,
      embedding: queryVector,
      limit,
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
    });
    return {
      results: hits.map((hit) => ({
        node: toNodeRecord(hit.row),
        distance: hit.distance,
      })),
    };
  });
}
