/**
 * `POST /graph` — live subgraph for drawing the memory network.
 * Without `seed_ids` it returns every live node; with `seed_ids` it returns those seeds
 * plus all their live one-hop neighbors. Sessions of a course (the targets of `HAS_PLAN`) are
 * never drawn: they belong to the timeline, not the memory view. Edges are the current
 * edges among the returned nodes, so every edge endpoint is in `nodes`.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  getEdgesAmong,
  getIncidentEdgesForIds,
  getLiveEdges,
  getLiveNodes,
  getNodesByIds,
} from "../../db/read.js";
import { edge, type NodeRow } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { toEdgeRecord, toNodeRecord } from "../../serialize.js";
import { PLAN_EDGE } from "../../types/planner.js";
import { graphBody, parse } from "./schemas.js";

export async function registerGraph(app: FastifyInstance): Promise<void> {
  app.post("/graph", async (request) => {
    const body = parse(graphBody, request.body);
    const sessions = new Set(
      (
        await app.db
          .select({ id: edge.dstId })
          .from(edge)
          .where(and(eq(edge.type, PLAN_EDGE), isNull(edge.validTo)))
      ).map((row) => row.id),
    );
    if (body.seed_ids === undefined) {
      const [nodes, edges] = await Promise.all([getLiveNodes(app.db), getLiveEdges(app.db)]);
      return {
        nodes: nodes.filter((row) => !sessions.has(row.id)).map(toNodeRecord),
        edges: edges.filter((row) => !sessions.has(row.srcId) && !sessions.has(row.dstId)).map(toEdgeRecord),
      };
    }

    const rows = (await seededNodes(app, [...new Set(body.seed_ids)])).filter((row) => !sessions.has(row.id));
    const edges = await getEdgesAmong(
      app.db,
      rows.map((row) => row.id),
    );
    return { nodes: rows.map(toNodeRecord), edges: edges.map(toEdgeRecord) };
  });
}

/** Seeds first, then all their live one-hop neighbors. */
async function seededNodes(app: FastifyInstance, seedIds: string[]): Promise<NodeRow[]> {
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
  return [...seeds, ...(await getNodesByIds(app.db, [...neighborIds]))];
}
