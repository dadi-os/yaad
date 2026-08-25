import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DwarClient } from "../dwar/client.js";
import { embeddingText } from "../dwar/client.js";
import type { Db } from "../db/client.js";
import { getEdge, getNode } from "../db/read.js";
import { edge, node, nodeIdentity, personDetail, planDetail } from "../db/schema.js";
import { closeEdge, closeNode, lockCurrentEdge, lockCurrentNode, supersedeNode, type Tx } from "../db/temporal.js";
import { YaadError } from "../errors.js";
import { parse } from "../routers/v1/schemas.js";
import { sameInstant } from "../serialize.js";
import type { NodeSource } from "../types/domain.js";
import {
  patchPersonDetailBody,
  patchPlanDetailBody,
  personDetailBody,
  planDetailBody,
  type Operation,
} from "./operations.js";

export type AppliedOperation = Operation & { id?: string };

export type ApplyResult = {
  operations: AppliedOperation[];
  counts: Record<Operation["op"], number>;
  temp_ids: Record<string, string>;
};

export async function applyOperations(opts: {
  db: Db;
  dwar: DwarClient;
  operations: Operation[];
  source: NodeSource;
}): Promise<ApplyResult> {
  const embeddings = await embedForOps(opts.dwar, opts.db, opts.operations);
  const referenced = referencedIds(opts.operations);

  return opts.db.transaction(async (tx) => {
    await lockReferenced(tx, referenced);
    const tempIds = new Map<string, string>();
    const applied: AppliedOperation[] = [];
    const closedNodes = new Set<string>();
    const closedEdges = new Set<string>();
    const at = new Date();

    for (const op of opts.operations) {
      if (op.op === "create_node") {
        const id = randomUUID();
        const embedding = embeddings.get(`create:${op.temp_id}`);
        if (!embedding) {
          throw new YaadError(500, "internal", `missing embedding for temp_id ${op.temp_id}`);
        }
        await tx.insert(nodeIdentity).values({ id });
        await tx.insert(node).values({
          id,
          kind: op.kind,
          title: op.title,
          body: op.body ?? null,
          embedding,
          occurredAt: op.occurred_at ? new Date(op.occurred_at) : null,
          source: opts.source,
          createdAt: at,
          validFrom: at,
          validTo: null,
        });
        if (op.kind === "person") {
          const detail = parse(personDetailBody, op.detail ?? {});
          await tx.insert(personDetail).values({
            nodeId: id,
            birthday: detail.birthday ?? null,
            aliases: detail.aliases ?? [],
          });
        } else if (op.kind === "plan") {
          const detail = parse(planDetailBody, op.detail ?? {});
          await tx.insert(planDetail).values({
            nodeId: id,
            endAt: detail.end_at ? new Date(detail.end_at) : null,
            status: detail.status,
            recurrence: detail.recurrence ?? null,
          });
        }
        tempIds.set(op.temp_id, id);
        applied.push({ ...op, id });
      }
    }

    for (const op of opts.operations) {
      if (op.op === "update_node") {
        const current = await getNode(tx, op.node_id, undefined);
        if (op.detail !== undefined) {
          if (current.kind === "person") {
            const detail = parse(patchPersonDetailBody, op.detail);
            await tx
              .update(personDetail)
              .set({
                ...(detail.birthday !== undefined ? { birthday: detail.birthday } : {}),
                ...(detail.aliases !== undefined ? { aliases: detail.aliases } : {}),
              })
              .where(eq(personDetail.nodeId, op.node_id));
          } else if (current.kind === "plan") {
            const detail = parse(patchPlanDetailBody, op.detail);
            await tx
              .update(planDetail)
              .set({
                ...(detail.end_at !== undefined
                  ? { endAt: detail.end_at ? new Date(detail.end_at) : null }
                  : {}),
                ...(detail.status !== undefined ? { status: detail.status } : {}),
                ...(detail.recurrence !== undefined ? { recurrence: detail.recurrence } : {}),
              })
              .where(eq(planDetail.nodeId, op.node_id));
          }
        }
        const nextTitle = op.title ?? current.title;
        const nextBody = op.body !== undefined ? op.body : current.body;
        const nextOccurred =
          op.occurred_at !== undefined
            ? op.occurred_at
              ? new Date(op.occurred_at)
              : null
            : current.occurredAt;
        const nodeChanged =
          (op.title !== undefined && op.title !== current.title) ||
          (op.body !== undefined && op.body !== current.body) ||
          (op.occurred_at !== undefined && !sameInstant(nextOccurred, current.occurredAt));
        if (nodeChanged) {
          const embedding = embeddings.get(`update:${op.node_id}`) ?? current.embedding;
          await supersedeNode(
            tx,
            op.node_id,
            {
              title: nextTitle,
              body: nextBody,
              occurredAt: nextOccurred,
              embedding,
            },
            at,
          );
        }
        applied.push(op);
      }
    }

    for (const op of opts.operations) {
      if (op.op === "create_edge") {
        const srcId = resolve(op.src, tempIds);
        const dstId = resolve(op.dst, tempIds);
        if (srcId === dstId) {
          throw new YaadError(422, "invalid_request", "create_edge src must not equal dst");
        }
        const id = randomUUID();
        await tx.insert(edge).values({
          id,
          srcId,
          dstId,
          type: op.type,
          properties: op.properties ?? {},
          confidence: op.confidence,
          createdAt: at,
          validFrom: at,
          validTo: null,
        });
        applied.push({ ...op, id });
      }
    }

    for (const op of opts.operations) {
      if (op.op === "close_edge") {
        await closeEdge(tx, op.edge_id, at);
        closedEdges.add(op.edge_id);
        applied.push(op);
      }
    }

    for (const op of opts.operations) {
      if (op.op === "close_node") {
        await closeNode(tx, op.node_id, at);
        closedNodes.add(op.node_id);
        applied.push(op);
      }
    }

    for (const op of opts.operations) {
      if (op.op === "noop") {
        applied.push(op);
      }
    }

    await reverify(tx, referenced, closedNodes, closedEdges);

    const counts: Record<Operation["op"], number> = {
      create_node: 0,
      update_node: 0,
      close_node: 0,
      create_edge: 0,
      close_edge: 0,
      noop: 0,
    };
    for (const op of applied) {
      counts[op.op] += 1;
    }

    return {
      operations: applied,
      counts,
      temp_ids: Object.fromEntries(tempIds),
    };
  });
}

async function embedForOps(dwar: DwarClient, db: Db, operations: Operation[]): Promise<Map<string, number[]>> {
  const jobs: Array<{ key: string; text: string }> = [];
  for (const op of operations) {
    if (op.op === "create_node") {
      jobs.push({ key: `create:${op.temp_id}`, text: embeddingText(op.title, op.body ?? null) });
    }
    if (op.op === "update_node" && (op.title !== undefined || op.body !== undefined)) {
      const current = await getNode(db, op.node_id, undefined);
      const title = op.title ?? current.title;
      const body = op.body !== undefined ? op.body : current.body;
      if (title !== current.title || body !== current.body) {
        jobs.push({ key: `update:${op.node_id}`, text: embeddingText(title, body) });
      }
    }
  }
  const out = new Map<string, number[]>();
  if (jobs.length === 0) {
    return out;
  }
  const vectors = await dwar.embed(jobs.map((job) => job.text));
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const vector = vectors[i];
    if (!job || !vector) {
      throw new YaadError(500, "internal", "embed batch length mismatch");
    }
    out.set(job.key, vector);
  }
  return out;
}

function referencedIds(operations: Operation[]): { nodes: string[]; edges: string[] } {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const temps = new Set<string>();
  for (const op of operations) {
    if (op.op === "create_node") {
      temps.add(op.temp_id);
    }
  }
  for (const op of operations) {
    if (op.op === "update_node" || op.op === "close_node") {
      nodes.add(op.node_id);
    }
    if (op.op === "close_edge") {
      edges.add(op.edge_id);
    }
    if (op.op === "create_edge") {
      if (!temps.has(op.src)) {
        nodes.add(op.src);
      }
      if (!temps.has(op.dst)) {
        nodes.add(op.dst);
      }
    }
  }
  return { nodes: [...nodes].sort(), edges: [...edges].sort() };
}

async function lockReferenced(tx: Tx, referenced: { nodes: string[]; edges: string[] }): Promise<void> {
  for (const id of referenced.nodes) {
    try {
      await lockCurrentNode(tx, id);
    } catch (err) {
      if (err instanceof YaadError && err.statusCode === 404) {
        throw new YaadError(409, "conflict", `node ${id} is no longer current`);
      }
      throw err;
    }
  }
  for (const id of referenced.edges) {
    try {
      await lockCurrentEdge(tx, id);
    } catch (err) {
      if (err instanceof YaadError && err.statusCode === 404) {
        throw new YaadError(409, "conflict", `edge ${id} is no longer current`);
      }
      throw err;
    }
  }
}

async function reverify(
  tx: Tx,
  referenced: { nodes: string[]; edges: string[] },
  closedNodes: Set<string>,
  closedEdges: Set<string>,
): Promise<void> {
  for (const id of referenced.nodes) {
    if (closedNodes.has(id)) {
      continue;
    }
    try {
      await getNode(tx, id, undefined);
    } catch (err) {
      if (err instanceof YaadError && err.statusCode === 404) {
        throw new YaadError(409, "conflict", `node ${id} is no longer current`);
      }
      throw err;
    }
  }
  for (const id of referenced.edges) {
    if (closedEdges.has(id)) {
      continue;
    }
    try {
      await getEdge(tx, id, undefined);
    } catch (err) {
      if (err instanceof YaadError && err.statusCode === 404) {
        throw new YaadError(409, "conflict", `edge ${id} is no longer current`);
      }
      throw err;
    }
  }
}

function resolve(value: string, tempIds: Map<string, string>): string {
  const mapped = tempIds.get(value);
  if (mapped) {
    return mapped;
  }
  return value;
}
