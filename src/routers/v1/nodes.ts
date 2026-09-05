import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { node, personDetail, planDetail } from "../../db/schema.js";
import { getIncidentEdges, getNode, getNodeHistory, getPersonDetail, getPlanDetail } from "../../db/read.js";
import { deleteNode, updateNode } from "../../db/temporal.js";
import { embeddingText } from "../../dwar/client.js";
import { YaadError } from "../../errors.js";
import {
  historyEmbeddingText,
  sameInstant,
  toEdgeRecord,
  toNodeHistoryRecord,
  toNodeRecord,
  toPersonDetail,
  toPlanDetail,
} from "../../serialize.js";
import {
  createNodeBody,
  idParam,
  parse,
  patchNodeBody,
  patchPersonDetailBody,
  patchPlanDetailBody,
} from "./schemas.js";

export async function registerNodes(app: FastifyInstance): Promise<void> {
  app.post("/nodes", async (request, reply) => {
    const body = parse(createNodeBody, request.body);
    const [embedding] = await app.dwar.embed([embeddingText(body.title, body.body ?? null)]);
    if (!embedding) {
      throw new YaadError(502, "dwar", "Dwar returned no embedding");
    }
    const id = randomUUID();
    const now = new Date();
    const occurredAt = body.occurred_at ? new Date(body.occurred_at) : null;

    await app.db.transaction(async (tx) => {
      const rows = await tx
        .insert(node)
        .values({
          id,
          kind: body.kind,
          title: body.title,
          body: body.body ?? null,
          embedding,
          occurredAt,
          source: body.source,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new YaadError(500, "internal", "node insert returned no row");
      }
      if (body.kind === "person") {
        await tx.insert(personDetail).values({
          nodeId: id,
          birthday: body.detail.birthday ?? null,
          aliases: body.detail.aliases ?? [],
        });
      } else if (body.kind === "plan") {
        await tx.insert(planDetail).values({
          nodeId: id,
          endAt: body.detail.end_at ? new Date(body.detail.end_at) : null,
          status: body.detail.status,
          recurrence: body.detail.recurrence ?? null,
        });
      }
    });

    return reply.status(201).send(await nodeResponse(app, id));
  });

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
    const current = await getNode(app.db, id);

    const personPatch =
      body.detail && current.kind === "person" ? parse(patchPersonDetailBody, body.detail) : undefined;
    const planPatch =
      body.detail && current.kind === "plan" ? parse(patchPlanDetailBody, body.detail) : undefined;
    if (body.detail && current.kind === "memory") {
      throw new YaadError(422, "invalid_request", "memory nodes have no detail");
    }

    const nextTitle = body.title ?? current.title;
    const nextBody = body.body !== undefined ? body.body : current.body;
    const nextOccurred =
      body.occurred_at !== undefined
        ? body.occurred_at
          ? new Date(body.occurred_at)
          : null
        : current.occurredAt;
    const titleChanged = body.title !== undefined && body.title !== current.title;
    const bodyChanged = body.body !== undefined && body.body !== current.body;
    const occurredChanged =
      body.occurred_at !== undefined && !sameInstant(nextOccurred, current.occurredAt);
    const sourceChanged = body.source !== undefined && body.source !== current.source;
    const nodeChanged = titleChanged || bodyChanged || occurredChanged || sourceChanged;

    let embedding = current.embedding;
    const historyJobs: Array<{ key: string; text: string }> = [];
    if (titleChanged) {
      historyJobs.push({
        key: `title:${id}`,
        text: historyEmbeddingText(current.title, nextTitle),
      });
    }
    if (bodyChanged) {
      historyJobs.push({
        key: `body:${id}`,
        text: historyEmbeddingText(current.body, nextBody),
      });
    }
    if (occurredChanged) {
      historyJobs.push({
        key: `occurred_at:${id}`,
        text: historyEmbeddingText(
          current.occurredAt ? current.occurredAt.toISOString() : null,
          nextOccurred ? nextOccurred.toISOString() : null,
        ),
      });
    }

    const embedTexts: string[] = [];
    const embedKeys: Array<"node" | string> = [];
    if (titleChanged || bodyChanged) {
      embedTexts.push(embeddingText(nextTitle, nextBody));
      embedKeys.push("node");
    }
    for (const job of historyJobs) {
      embedTexts.push(job.text);
      embedKeys.push(job.key);
    }

    const historyEmbeddings = new Map<string, number[]>();
    if (embedTexts.length > 0) {
      const vectors = await app.dwar.embed(embedTexts);
      for (let i = 0; i < embedKeys.length; i++) {
        const key = embedKeys[i];
        const vector = vectors[i];
        if (!key || !vector) {
          throw new YaadError(502, "dwar", "Dwar returned no embedding");
        }
        if (key === "node") {
          embedding = vector;
        } else {
          historyEmbeddings.set(key, vector);
        }
      }
    }

    await app.db.transaction(async (tx) => {
      if (personPatch && (personPatch.birthday !== undefined || personPatch.aliases !== undefined)) {
        await tx
          .update(personDetail)
          .set({
            ...(personPatch.birthday !== undefined ? { birthday: personPatch.birthday } : {}),
            ...(personPatch.aliases !== undefined ? { aliases: personPatch.aliases } : {}),
          })
          .where(eq(personDetail.nodeId, id));
      }
      if (
        planPatch &&
        (planPatch.end_at !== undefined ||
          planPatch.status !== undefined ||
          planPatch.recurrence !== undefined)
      ) {
        await tx
          .update(planDetail)
          .set({
            ...(planPatch.end_at !== undefined
              ? { endAt: planPatch.end_at ? new Date(planPatch.end_at) : null }
              : {}),
            ...(planPatch.status !== undefined ? { status: planPatch.status } : {}),
            ...(planPatch.recurrence !== undefined ? { recurrence: planPatch.recurrence } : {}),
          })
          .where(eq(planDetail.nodeId, id));
      }
      if (nodeChanged) {
        await updateNode(
          tx,
          id,
          {
            title: nextTitle,
            body: nextBody,
            occurredAt: nextOccurred,
            ...(body.source !== undefined ? { source: body.source } : {}),
            embedding,
          },
          historyEmbeddings,
          new Date(),
        );
      }
    });

    return nodeResponse(app, id);
  });

  app.delete("/nodes/:id", async (request, reply) => {
    const { id } = parse(idParam, request.params);
    await app.db.transaction(async (tx) => {
      await deleteNode(tx, id, new Date());
    });
    return reply.status(204).send();
  });
}

async function nodeResponse(app: FastifyInstance, id: string) {
  const row = await getNode(app.db, id);
  const edges = await getIncidentEdges(app.db, id);
  const outgoing = edges.filter((item) => item.srcId === id).map(toEdgeRecord);
  const incoming = edges.filter((item) => item.dstId === id).map(toEdgeRecord);
  let detail: ReturnType<typeof toPersonDetail> | ReturnType<typeof toPlanDetail> | null = null;
  if (row.kind === "person") {
    detail = toPersonDetail(await getPersonDetail(app.db, id));
  } else if (row.kind === "plan") {
    detail = toPlanDetail(await getPlanDetail(app.db, id));
  }
  return {
    ...toNodeRecord(row),
    detail,
    edges: { outgoing, incoming },
  };
}
