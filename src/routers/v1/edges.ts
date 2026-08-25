import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { edge } from "../../db/schema.js";
import { getNode } from "../../db/read.js";
import { closeEdge } from "../../db/temporal.js";
import { YaadError } from "../../errors.js";
import { toEdgeRecord } from "../../serialize.js";
import { createEdgeBody, idParam, parse } from "./schemas.js";

export async function registerEdges(app: FastifyInstance): Promise<void> {
  app.post("/edges", async (request, reply) => {
    const body = parse(createEdgeBody, request.body);
    await getNode(app.db, body.src_id, undefined);
    await getNode(app.db, body.dst_id, undefined);
    const now = new Date();
    const rows = await app.db
      .insert(edge)
      .values({
        id: randomUUID(),
        srcId: body.src_id,
        dstId: body.dst_id,
        type: body.type,
        properties: body.properties ?? {},
        confidence: body.confidence ?? 1,
        createdAt: now,
        validFrom: now,
        validTo: null,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new YaadError(500, "internal", "edge insert returned no row");
    }
    return reply.status(201).send(toEdgeRecord(row));
  });

  app.delete("/edges/:id", async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await app.db.transaction(async (tx) => {
      await closeEdge(tx, id, new Date());
    });
    return reply.status(204).send();
  });
}
