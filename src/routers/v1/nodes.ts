/** Node routes: `GET /nodes/:id` reads a node with its detail and current edges, and `GET /nodes/:id/history` its correction log; an unknown id is a 404. Nodes change only through ingest. */

import type { FastifyInstance } from "fastify";
import { getIncidentEdges, getNode, getNodeHistory, getPersonDetail, getPlaceDetail, getPlanDetail, getTaskDetail } from "../../db/read.js";
import {
  toEdgeRecord,
  toNodeHistoryRecord,
  toNodeRecord,
  toPersonDetail,
  toPlaceDetail,
  toPlanDetail,
  toTaskDetail,
} from "../../serialize.js";
import { idParam, parse } from "./schemas.js";

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
    | ReturnType<typeof toTaskDetail>
    | null = null;
  if (row.kind === "person") {
    detail = toPersonDetail(await getPersonDetail(app.db, id));
  } else if (row.kind === "plan") {
    detail = toPlanDetail(await getPlanDetail(app.db, id));
  } else if (row.kind === "place") {
    detail = toPlaceDetail(await getPlaceDetail(app.db, id));
  } else if (row.kind === "task") {
    detail = toTaskDetail(await getTaskDetail(app.db, id));
  }
  return {
    ...toNodeRecord(row),
    detail,
    edges: { outgoing, incoming },
  };
}
