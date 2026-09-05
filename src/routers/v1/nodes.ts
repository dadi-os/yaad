import type { FastifyInstance } from "fastify";
import { getIncidentEdges, getNode, getNodeHistory, getPersonDetail, getPlaceDetail, getPlanDetail } from "../../db/read.js";
import {
  toEdgeRecord,
  toNodeHistoryRecord,
  toNodeRecord,
  toPersonDetail,
  toPlaceDetail,
  toPlanDetail,
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
