import type { FastifyInstance } from "fastify";
import { getIncidentEdges, getNode, getPersonDetail } from "../../db/read.js";
import { YaadError } from "../../errors.js";
import { toEdgeRecord, toNodeRecord, toPersonDetail } from "../../serialize.js";
import type { EdgeRecord } from "../../types/domain.js";
import { asOfQuery, idParam, parse } from "./schemas.js";

export async function registerPeople(app: FastifyInstance): Promise<void> {
  app.get("/people/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const query = parse(asOfQuery, request.query);
    const asOf = query.as_of ? new Date(query.as_of) : undefined;
    const row = await getNode(app.db, id, asOf);
    if (row.kind !== "person") {
      throw new YaadError(422, "invalid_request", "node is not a person");
    }
    const detail = toPersonDetail(await getPersonDetail(app.db, id));
    const edges = await getIncidentEdges(app.db, id, asOf);
    const grouped: Record<string, { outgoing: EdgeRecord[]; incoming: EdgeRecord[] }> = {};
    for (const item of edges) {
      const bucket = grouped[item.type] ?? { outgoing: [], incoming: [] };
      grouped[item.type] = bucket;
      const record = toEdgeRecord(item);
      if (item.srcId === id) {
        bucket.outgoing.push(record);
      }
      if (item.dstId === id) {
        bucket.incoming.push(record);
      }
    }
    return {
      ...toNodeRecord(row),
      detail,
      edges: grouped,
    };
  });
}
