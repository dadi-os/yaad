/** Apply validated ingest operations in one transaction (embeds, locks, series). */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DwarClient } from "../dwar/client.js";
import { embeddingText } from "../dwar/client.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { getEdge, getNode, getPlanDetail } from "../db/read.js";
import { edge, node, personDetail, placeDetail, planDetail } from "../db/schema.js";
import {
  closeEdge,
  deleteNode,
  lockCurrentEdge,
  lockNode,
  updateNode,
  type Tx,
} from "../db/temporal.js";
import { YaadError } from "../errors.js";
import { expandRecurrence } from "../plans/recurrence.js";
import { parse } from "../routers/v1/schemas.js";
import { historyEmbeddingText, sameInstant } from "../serialize.js";
import type { NodeSource } from "../types/domain.js";
import { computeExpiresAt } from "./expiry.js";
import {
  patchPersonDetailBody,
  patchPlanDetailBody,
  patchPlaceDetailBody,
  personDetailBody,
  placeDetailBody,
  planDetailBody,
  type Operation,
} from "./operations.js";

export type AppliedOperation = Operation & { id?: string };

export type ApplyResult = {
  operations: AppliedOperation[];
  counts: Record<Operation["op"], number>;
  /** Maps create_node temp_id → persisted uuid. */
  temp_ids: Record<string, string>;
};

/**
 * Persist emit_operations results: create/update/close nodes and edges.
 * Materializes recurring plan series when create_node includes an RRULE.
 */
export async function applyOperations(opts: {
  db: Db;
  dwar: DwarClient;
  operations: Operation[];
  source: NodeSource;
  config: Config;
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
          throw new YaadError(500, "internal_error", `missing embedding for temp_id ${op.temp_id}`);
        }
        const occurredAt = op.occurred_at ? new Date(op.occurred_at) : null;
        const expiresAt =
          op.ttl_days !== undefined && op.ttl_days !== null
            ? computeExpiresAt(occurredAt ?? at, op.ttl_days)
            : null;
        await tx.insert(node).values({
          id,
          kind: op.kind,
          title: op.title,
          body: op.body ?? null,
          embedding,
          occurredAt,
          expiresAt,
          source: opts.source,
          createdAt: at,
          updatedAt: at,
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
          const endAt = detail.end_at ? new Date(detail.end_at) : null;
          const recurrence = detail.recurrence ?? null;
          await tx.insert(planDetail).values({
            nodeId: id,
            endAt,
            status: detail.status,
            recurrence,
            seriesId: null,
          });
          if (recurrence) {
            await materializeSeries({
              tx,
              templateId: id,
              title: op.title,
              body: op.body ?? null,
              embedding,
              source: opts.source,
              status: detail.status,
              recurrence,
              start: occurredAt,
              endAt,
              createdAt: at,
              config: opts.config,
            });
          }
        } else if (op.kind === "place") {
          const detail = parse(placeDetailBody, op.detail ?? {});
          await tx.insert(placeDetail).values({
            nodeId: id,
            address: detail.address ?? null,
            latitude: detail.latitude ?? null,
            longitude: detail.longitude ?? null,
          });
        }
        tempIds.set(op.temp_id, id);
        applied.push({ ...op, id });
      }
    }

    for (const op of opts.operations) {
      if (op.op === "update_node") {
        const current = await getNode(tx, op.node_id);
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
          } else if (current.kind === "place") {
            const detail = parse(patchPlaceDetailBody, op.detail);
            await tx
              .update(placeDetail)
              .set({
                ...(detail.address !== undefined ? { address: detail.address } : {}),
                ...(detail.latitude !== undefined ? { latitude: detail.latitude } : {}),
                ...(detail.longitude !== undefined ? { longitude: detail.longitude } : {}),
              })
              .where(eq(placeDetail.nodeId, op.node_id));
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
        const titleChanged = op.title !== undefined && op.title !== current.title;
        const bodyChanged = op.body !== undefined && op.body !== current.body;
        const occurredChanged =
          op.occurred_at !== undefined && !sameInstant(nextOccurred, current.occurredAt);
        const nodeChanged = titleChanged || bodyChanged || occurredChanged;
        if (nodeChanged) {
          const embedding = embeddings.get(`update:${op.node_id}`) ?? current.embedding;
          const historyEmbeddings = new Map<string, number[]>();
          for (const field of ["title", "body", "occurred_at"] as const) {
            const key = `${field}:${op.node_id}`;
            const vector = embeddings.get(key);
            if (vector) {
              historyEmbeddings.set(key, vector);
            }
          }
          await updateNode(
            tx,
            op.node_id,
            {
              title: nextTitle,
              body: nextBody,
              occurredAt: nextOccurred,
              embedding,
            },
            historyEmbeddings,
            at,
          );
        }
        if (op.ttl_days !== undefined) {
          const expiresAt =
            op.ttl_days === null ? null : computeExpiresAt(at, op.ttl_days);
          await tx
            .update(node)
            .set({ expiresAt, updatedAt: at })
            .where(eq(node.id, op.node_id));
        }
        if (current.kind === "plan" && changesSchedule(op)) {
          await rematerializeSeries({
            tx,
            templateId: op.node_id,
            source: opts.source,
            at,
            config: opts.config,
          });
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
        await deleteNode(tx, op.node_id, at);
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

async function materializeSeries(opts: {
  tx: Tx;
  templateId: string;
  title: string;
  body: string | null;
  embedding: number[];
  source: NodeSource;
  status: string;
  recurrence: string;
  start: Date | null;
  endAt: Date | null;
  createdAt: Date;
  config: Config;
}): Promise<void> {
  if (!opts.start) {
    throw new YaadError(
      422,
      "invalid_request",
      "recurring plan requires occurred_at as the series start",
    );
  }
  const horizonEnd = new Date(
    opts.createdAt.getTime() + opts.config.plan.recurrence_horizon_days * 86_400_000,
  );
  const instances = expandRecurrence({
    rule: opts.recurrence,
    start: opts.start,
    end: opts.endAt,
    horizonEnd,
    maxInstances: opts.config.plan.max_instances_per_series,
    timeZone: opts.config.plan.timezone,
  });
  for (const instance of instances) {
    const id = randomUUID();
    await opts.tx.insert(node).values({
      id,
      kind: "plan",
      title: opts.title,
      body: opts.body,
      embedding: opts.embedding,
      occurredAt: instance.occurredAt,
      source: opts.source,
      createdAt: opts.createdAt,
      updatedAt: opts.createdAt,
    });
    await opts.tx.insert(planDetail).values({
      nodeId: id,
      endAt: instance.endAt,
      status: opts.status,
      recurrence: null,
      seriesId: opts.templateId,
    });
  }
}

function changesSchedule(op: Extract<Operation, { op: "update_node" }>): boolean {
  if (op.occurred_at !== undefined) {
    return true;
  }
  if (op.detail === null || typeof op.detail !== "object") {
    return false;
  }
  return "recurrence" in op.detail || "end_at" in op.detail;
}

/**
 * Rebuild a series after its schedule changed: delete the template's existing instances
 * (history kept, edges closed) and materialize again from the template's current rule.
 * A template whose rule was cleared ends with no instances.
 */
async function rematerializeSeries(opts: {
  tx: Tx;
  templateId: string;
  source: NodeSource;
  at: Date;
  config: Config;
}): Promise<void> {
  const instances = await opts.tx
    .select({ id: planDetail.nodeId })
    .from(planDetail)
    .where(eq(planDetail.seriesId, opts.templateId));
  for (const instance of instances) {
    await deleteNode(opts.tx, instance.id, opts.at);
  }
  const detail = await getPlanDetail(opts.tx, opts.templateId);
  if (!detail.recurrence) {
    return;
  }
  const template = await getNode(opts.tx, opts.templateId);
  if (!template.embedding) {
    throw new YaadError(500, "internal_error", `plan ${opts.templateId} has no embedding`);
  }
  await materializeSeries({
    tx: opts.tx,
    templateId: opts.templateId,
    title: template.title,
    body: template.body,
    embedding: template.embedding,
    source: opts.source,
    status: detail.status,
    recurrence: detail.recurrence,
    start: template.occurredAt,
    endAt: detail.endAt,
    createdAt: opts.at,
    config: opts.config,
  });
}

async function embedForOps(dwar: DwarClient, db: Db, operations: Operation[]): Promise<Map<string, number[]>> {
  const jobs: Array<{ key: string; text: string }> = [];
  for (const op of operations) {
    if (op.op === "create_node") {
      jobs.push({ key: `create:${op.temp_id}`, text: embeddingText(op.title, op.body ?? null) });
    }
    if (op.op === "update_node") {
      const current = await getNode(db, op.node_id);
      const nextTitle = op.title ?? current.title;
      const nextBody = op.body !== undefined ? op.body : current.body;
      const nextOccurred =
        op.occurred_at !== undefined
          ? op.occurred_at
            ? new Date(op.occurred_at)
            : null
          : current.occurredAt;
      const titleChanged = op.title !== undefined && op.title !== current.title;
      const bodyChanged = op.body !== undefined && op.body !== current.body;
      const occurredChanged =
        op.occurred_at !== undefined && !sameInstant(nextOccurred, current.occurredAt);
      if (titleChanged || bodyChanged) {
        jobs.push({ key: `update:${op.node_id}`, text: embeddingText(nextTitle, nextBody) });
      }
      if (titleChanged) {
        jobs.push({
          key: `title:${op.node_id}`,
          text: historyEmbeddingText(current.title, nextTitle),
        });
      }
      if (bodyChanged) {
        jobs.push({
          key: `body:${op.node_id}`,
          text: historyEmbeddingText(current.body, nextBody),
        });
      }
      if (occurredChanged) {
        jobs.push({
          key: `occurred_at:${op.node_id}`,
          text: historyEmbeddingText(
            current.occurredAt ? current.occurredAt.toISOString() : null,
            nextOccurred ? nextOccurred.toISOString() : null,
          ),
        });
      }
    }
  }
  const out = new Map<string, number[]>();
  if (jobs.length === 0) {
    return out;
  }
  const vectors = await dwar.embed(
    jobs.map((job) => job.text),
    "yaad/ingest",
  );
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const vector = vectors[i];
    if (!job || !vector) {
      throw new YaadError(500, "internal_error", "embed batch length mismatch");
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
      await lockNode(tx, id);
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
      await getNode(tx, id);
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
      await getEdge(tx, id);
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
