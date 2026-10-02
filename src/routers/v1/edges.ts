/**
 * Edge routes for hand edits: `POST /edges` draws an edge between two current nodes and
 * `POST /edges/:id/close` closes a current one. Both run as one validated `create_edge` /
 * `close_edge` through ingest's apply path, so closing an edge sweeps the nodes it
 * strands and logs them. Edges are never edited in place: to change one, close it and
 * create its replacement.
 */

import type { FastifyInstance } from "fastify";
import { getEdge } from "../../db/read.js";
import { YaadError } from "../../errors.js";
import { applyOperations } from "../../ingest/apply.js";
import type { Operation } from "../../ingest/operations.js";
import { validateOperations } from "../../ingest/validate.js";
import { toEdgeRecord } from "../../serialize.js";
import { MANUAL } from "./nodes.js";
import { createEdgeBody, idParam, parse } from "./schemas.js";

/** Register `POST /edges` and `POST /edges/:id/close`. */
export async function registerEdges(app: FastifyInstance): Promise<void> {
  app.post("/edges", async (request, reply) => {
    const body = parse(createEdgeBody, request.body);
    const operations: Operation[] = [
      {
        op: "create_edge",
        src: body.src_id,
        dst: body.dst_id,
        type: body.type,
        ...(body.properties !== undefined ? { properties: body.properties } : {}),
        confidence: body.confidence,
      },
    ];
    await validateOperations({ db: app.db, operations });
    const result = await applyOperations({ db: app.db, dwar: app.dwar, operations, author: MANUAL, config: app.config });
    const created = result.operations.find((op) => op.op === "create_edge");
    if (!created?.id) {
      throw new YaadError(500, "internal_error", "create_edge returned no id");
    }
    reply.code(201);
    return toEdgeRecord(await getEdge(app.db, created.id));
  });

  app.post("/edges/:id/close", async (request) => {
    const { id } = parse(idParam, request.params);
    const operations: Operation[] = [{ op: "close_edge", edge_id: id, reason: "closed by hand" }];
    await validateOperations({ db: app.db, operations });
    const result = await applyOperations({ db: app.db, dwar: app.dwar, operations, author: MANUAL, config: app.config });
    if (result.orphans.length > 0) {
      request.log.info({ request_id: request.requestId, node_ids: result.orphans }, "orphans swept");
    }
    return { id, orphans: result.orphans };
  });
}
