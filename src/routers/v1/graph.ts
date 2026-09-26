/**
 * `POST /graph` — bounded live subgraph for drawing the memory network.
 * Without `seed_ids` it returns the most-used live nodes; with `seed_ids` it returns
 * those seeds plus their live one-hop neighbors. Edges are the current edges among
 * the returned nodes, so every edge endpoint is in `nodes`.
 */

import type { FastifyInstance } from "fastify";
import {
  getEdgesAmong,
  getIncidentEdgesForIds,
  getNodesByIds,
  getTopLiveNodes,
} from "../../db/read.js";
import type { NodeRow } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { toEdgeRecord, toNodeRecord } from "../../serialize.js";
import { graphBody, parse } from "./schemas.js";

export async function registerGraph(app: FastifyInstance): Promise<void> {
  app.post("/graph", async (request) => {
    const body = parse(graphBody, request.body);
    const max = app.config.graph.max_nodes;
    if (body.limit !== undefined && body.limit > max) {
      throw new YaadError(422, "invalid_request", `limit exceeds maximum of ${max}`);
    }
    if (body.seed_ids !== undefined && body.seed_ids.length > max) {
      throw new YaadError(422, "invalid_request", `seed_ids exceeds maximum of ${max}`);
    }
    const limit = body.limit ?? app.config.graph.default_nodes;

    const rows =
      body.seed_ids === undefined
        ? await getTopLiveNodes(app.db, limit)
        : await seededNodes(app, [...new Set(body.seed_ids)], limit);

    const edges = await getEdgesAmong(
      app.db,
      rows.map((row) => row.id),
    );
    return { nodes: rows.map(toNodeRecord), edges: edges.map(toEdgeRecord) };
  });
}

/** Seeds first, then their most-used live neighbors until `limit` nodes total. */
async function seededNodes(
  app: FastifyInstance,
  seedIds: string[],
  limit: number,
): Promise<NodeRow[]> {
  const seeds = await getNodesByIds(app.db, seedIds);
  if (seeds.length !== seedIds.length) {
    const found = new Set(seeds.map((row) => row.id));
    const missing = seedIds.filter((id) => !found.has(id));
    throw new YaadError(404, "not_found", `seed node not found: ${missing.join(", ")}`);
  }
  const seedSet = new Set(seedIds);
  const neighborIds = new Set<string>();
  for (const row of await getIncidentEdgesForIds(app.db, seedIds)) {
    for (const id of [row.srcId, row.dstId]) {
      if (!seedSet.has(id)) {
        neighborIds.add(id);
      }
    }
  }
  const neighbors = (await getNodesByIds(app.db, [...neighborIds]))
    .sort((a, b) => b.accessCount - a.accessCount || a.id.localeCompare(b.id))
    .slice(0, Math.max(limit - seeds.length, 0));
  return [...seeds, ...neighbors];
}
