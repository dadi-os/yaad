/**
 * Node routes: `GET /nodes/:id` and `GET /nodes/:id/history` read; `PATCH /nodes/:id`
 * and `DELETE /nodes/:id` are hand edits from a client. `PATCH` runs as one validated
 * `update_node`, so it writes history, re-embeds, and rematerializes a series exactly
 * like an ingest correction. `DELETE` deletes the node and sweeps the neighbors it
 * leaves with no current edge, logging what it swept. An unknown id is a 404 on both.
 */

import type { FastifyInstance } from "fastify";
import { getIncidentEdges, getNode, getNodeHistory, getPersonDetail, getPlaceDetail, getPlanDetail } from "../../db/read.js";
import { deleteNode, sweepOrphans } from "../../db/temporal.js";
import { applyOperations } from "../../ingest/apply.js";
import type { Operation } from "../../ingest/operations.js";
import { validateOperations } from "../../ingest/validate.js";
import {
  toEdgeRecord,
  toNodeHistoryRecord,
  toNodeRecord,
  toPersonDetail,
  toPlaceDetail,
  toPlanDetail,
} from "../../serialize.js";
import type { NodeAuthor } from "../../types/domain.js";
import { idParam, parse, patchNodeBody } from "./schemas.js";

/** Author of edits made by hand in a client rather than learned by ingest. */
const MANUAL: NodeAuthor = { source: "manual", agentId: null };

export async function registerNodes(app: FastifyInstance): Promise<void> {
  app.get("/nodes/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    return nodeResponse(app, id);
  });

  app.get("/nodes/:id/history", async (request) => {
    const { id } = parse(idParam, request.params);
    const history = await getNodeHistory(app.db, id);
    return { history: history.map(toNodeHistoryRecord) };
  });

  app.patch("/nodes/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const body = parse(patchNodeBody, request.body);
    await getNode(app.db, id);
    const operations: Operation[] = [{ op: "update_node", node_id: id, ...body }];
    await validateOperations({ db: app.db, operations });
    await applyOperations({ db: app.db, dwar: app.dwar, operations, author: MANUAL, config: app.config });
    return nodeResponse(app, id);
  });

  app.delete("/nodes/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const orphans = await app.db.transaction(async (tx) => {
      const at = new Date();
      return sweepOrphans(tx, await deleteNode(tx, id, at), at);
    });
    if (orphans.length > 0) {
      request.log.info({ request_id: request.requestId, node_ids: orphans }, "orphans swept");
    }
    return { id, orphans };
  });
}

/** Full node payload with kind detail and incident edges (outgoing / incoming). */
export async function nodeResponse(app: FastifyInstance, id: string) {
  const row = await getNode(app.db, id);
  const edges = await getIncidentEdges(app.db, id);
  const outgoing = edges.filter((item) => item.srcId === id).map(toEdgeRecord);
  const incoming = edges.filter((item) => item.dstId === id).map(toEdgeRecord);
  let detail:
    | ReturnType<typeof toPersonDetail>
    | ReturnType<typeof toPlanDetail>
    | ReturnType<typeof toPlaceDetail>
    | null = null;
  if (row.kind === "person") {
    detail = toPersonDetail(await getPersonDetail(app.db, id));
  } else if (row.kind === "plan") {
    detail = toPlanDetail(await getPlanDetail(app.db, id));
  } else if (row.kind === "place") {
    detail = toPlaceDetail(await getPlaceDetail(app.db, id));
  }
  return {
    ...toNodeRecord(row),
    detail,
    edges: { outgoing, incoming },
  };
}
