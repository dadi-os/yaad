/** Apply validated ingest operations in one transaction (embeds, locks, spawned sessions). */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { DwarClient } from "../dwar/client.js";
import { embeddingText } from "../dwar/client.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { getEdge, getNode, getPlanDetail, getTaskDetail } from "../db/read.js";
import { edge, node, personDetail, placeDetail, planDetail, taskDetail } from "../db/schema.js";
import { stampHubs } from "../db/tasks.js";
import {
  closeEdge,
  deleteNode,
  lockCurrentEdge,
  lockNode,
  recordDone,
  sweepOrphans,
  updateNode,
  type Tx,
} from "../db/temporal.js";
import { YaadError } from "../errors.js";
import { parse } from "../routers/v1/schemas.js";
import { historyEmbeddingText, sameInstant } from "../serialize.js";
import type { NodeAuthor } from "../types/domain.js";
import { computeExpiresAt } from "./expiry.js";
import {
  patchPersonDetailBody,
  patchPlanDetailBody,
  patchPlaceDetailBody,
  patchTaskDetailBody,
  personDetailBody,
  placeDetailBody,
  planDetailBody,
  taskDetailBody,
  type Operation,
} from "./operations.js";
import { changeSessions, insertEdge, spawnSessions } from "./sessions.js";

/** An applied operation, with the id a `create_node` made or the ids a `spawn_plans` made. */
export type AppliedOperation = Operation & { id?: string; ids?: string[] };

export type ApplyResult = {
  operations: AppliedOperation[];
  /** Operations applied by kind, plus `edge_exists`: edges skipped because a current edge already holds them. */
  counts: Record<Operation["op"] | "edge_exists", number>;
  /** Maps create_node temp_id → persisted uuid. */
  temp_ids: Record<string, string>;
  /** Maps spawn_plans temp_id → the ids of the plans it created, in date order. */
  spawned: Record<string, string[]>;
  /** Nodes deleted because the batch left them with no current edge. */
  orphans: string[];
};

/**
 * Persist emit_operations results: create/update/close nodes and edges, spawn a hub's sessions,
 * and change them in bulk after the batch's own creates and updates. All-day plans are first
 * moved to local midnight of their dates, and nodes the batch's closes left with no current
 * edge are swept.
 */
export async function applyOperations(opts: {
  db: Db;
  dwar: DwarClient;
  operations: Operation[];
  author: NodeAuthor;
  config: Config;
}): Promise<ApplyResult> {
  const operations = await anchorAllDayPlans(opts.db, opts.operations);
  const embeddings = await embedForOps(opts.dwar, opts.db, operations);
  const referenced = referencedIds(operations);

  return opts.db.transaction(async (tx) => {
    await lockReferenced(tx, referenced);
    const tempIds = new Map<string, string>();
    const spawned: Record<string, string[]> = {};
    const applied: AppliedOperation[] = [];
    let edgesSkipped = 0;
    const closedNodes = new Set<string>();
    const closedEdges = new Set<string>();
    const touchedTasks = new Set<string>();
    const stranded: string[] = [];
    const at = new Date();

    for (const op of operations) {
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
          source: opts.author.source,
          agentId: opts.author.agentId,
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
          await tx.insert(planDetail).values({
            nodeId: id,
            endAt: detail.end_at ? new Date(detail.end_at) : null,
            allDay: detail.all_day ?? false,
            timeZone: detail.time_zone ?? null,
            rsvp: detail.rsvp ?? null,
            attended: detail.attended ?? null,
          });
        } else if (op.kind === "task") {
          const detail = parse(taskDetailBody, op.detail ?? {});
          await tx.insert(taskDetail).values({
            nodeId: id,
            opensOn: detail.opens_on ?? null,
            closesAt: detail.closes_at ? new Date(detail.closes_at) : null,
            done: detail.done ?? false,
            verifiedAt: at,
          });
          if (detail.done === true) {
            await recordDone(tx, id, true, at, opts.author);
          }
          touchedTasks.add(id);
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

    for (const op of operations) {
      if (op.op === "spawn_plans") {
        const ids = await spawnSessions(tx, {
          op,
          hubId: resolve(op.hub, tempIds),
          placeId: op.place === undefined ? null : resolve(op.place, tempIds),
          author: opts.author,
          timeZone: opts.config.env.timezone,
          at,
        });
        spawned[op.temp_id] = ids;
        applied.push({ ...op, ids });
      }
    }

    for (const op of operations) {
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
                ...(detail.end_at !== undefined ? { endAt: detail.end_at ? new Date(detail.end_at) : null } : {}),
                ...(detail.all_day !== undefined ? { allDay: detail.all_day } : {}),
                ...(detail.time_zone !== undefined ? { timeZone: detail.time_zone } : {}),
                ...(detail.rsvp !== undefined ? { rsvp: detail.rsvp } : {}),
                ...(detail.attended !== undefined ? { attended: detail.attended } : {}),
              })
              .where(eq(planDetail.nodeId, op.node_id));
          } else if (current.kind === "task") {
            const detail = parse(patchTaskDetailBody, op.detail);
            const stored = await getTaskDetail(tx, op.node_id);
            await tx
              .update(taskDetail)
              .set({
                ...(detail.opens_on !== undefined ? { opensOn: detail.opens_on } : {}),
                ...(detail.closes_at !== undefined ? { closesAt: detail.closes_at ? new Date(detail.closes_at) : null } : {}),
                ...(detail.done !== undefined ? { done: detail.done } : {}),
                verifiedAt: at,
              })
              .where(eq(taskDetail.nodeId, op.node_id));
            if (detail.done !== undefined && detail.done !== stored.done) {
              await recordDone(tx, op.node_id, detail.done, at, opts.author);
            }
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
        if (current.kind === "task") {
          if (op.detail === undefined) {
            await tx.update(taskDetail).set({ verifiedAt: at }).where(eq(taskDetail.nodeId, op.node_id));
          }
          touchedTasks.add(op.node_id);
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
            opts.author,
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
        applied.push(op);
      }
    }

    for (const op of operations) {
      if (op.op === "create_edge") {
        const srcId = resolve(op.src, tempIds);
        const dstId = resolve(op.dst, tempIds);
        if (srcId === dstId) {
          throw new YaadError(422, "invalid_request", "create_edge src must not equal dst");
        }
        if (await edgeAlreadyHeld(tx, srcId, dstId, op.type, op.properties ?? {})) {
          edgesSkipped += 1;
          continue;
        }
        const id = await insertEdge(tx, {
          srcId,
          dstId,
          type: op.type,
          properties: op.properties ?? {},
          confidence: op.confidence,
          at,
        });
        applied.push({ ...op, id });
      }
    }

    for (const op of operations) {
      if (op.op === "close_edge") {
        const closed = await closeEdge(tx, op.edge_id, at);
        stranded.push(closed.srcId, closed.dstId);
        closedEdges.add(op.edge_id);
        applied.push(op);
      }
    }

    for (const op of operations) {
      if (op.op === "close_node") {
        await deleteNode(tx, op.node_id, at, opts.author);
        closedNodes.add(op.node_id);
        applied.push(op);
      }
    }

    for (const op of operations) {
      if (op.op === "update_plans") {
        const changed = await changeSessions(tx, { op, timeZone: opts.config.env.timezone, at, author: opts.author });
        stranded.push(...changed.neighbors);
        applied.push({ ...op, ids: changed.ids });
      }
    }

    for (const op of operations) {
      if (op.op === "noop") {
        if (op.node_ids !== undefined) {
          await tx.update(taskDetail).set({ verifiedAt: at }).where(inArray(taskDetail.nodeId, op.node_ids));
          op.node_ids.forEach((id) => touchedTasks.add(id));
        }
        applied.push(op);
      }
    }

    await stampHubs(tx, [...touchedTasks], at);
    await reverify(tx, referenced, closedNodes, closedEdges);
    const orphans = await sweepOrphans(tx, stranded, at, opts.author);

    const counts: Record<Operation["op"] | "edge_exists", number> = {
      edge_exists: edgesSkipped,
      create_node: 0,
      update_node: 0,
      close_node: 0,
      create_edge: 0,
      close_edge: 0,
      spawn_plans: 0,
      update_plans: 0,
      noop: 0,
    };
    for (const op of applied) {
      counts[op.op] += 1;
    }

    return {
      operations: applied,
      counts,
      temp_ids: Object.fromEntries(tempIds),
      spawned,
      orphans,
    };
  });
}

/** Local midnight of `instant`'s date. The process runs in the box's zone (`TZ`), so local is the box's. */
function localMidnight(instant: Date): Date {
  const day = new Date(instant);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** `iso` moved to local midnight of its date, in the ISO form operations carry. */
function midnightIso(iso: string): string {
  return localMidnight(new Date(iso)).toISOString();
}

/**
 * The batch with every all-day plan's occurred_at and end_at moved to local midnight of their
 * dates, so an all-day plan never carries an invented time of day. An update that turns all_day
 * on also moves the plan's existing start and end; one that leaves it on moves whichever of
 * them it sets. Everything else passes through unchanged.
 */
async function anchorAllDayPlans(db: Db, operations: Operation[]): Promise<Operation[]> {
  const anchored: Operation[] = [];
  for (const op of operations) {
    if (op.op === "create_node" && op.kind === "plan") {
      const detail = parse(planDetailBody, op.detail ?? {});
      if (detail.all_day === true) {
        anchored.push({
          ...op,
          ...(op.occurred_at ? { occurred_at: midnightIso(op.occurred_at) } : {}),
          detail: {
            ...detail,
            ...(detail.end_at ? { end_at: midnightIso(detail.end_at) } : {}),
          },
        });
        continue;
      }
    }
    if (op.op === "update_node") {
      const current = await getNode(db, op.node_id);
      if (current.kind === "plan") {
        const patch = op.detail !== undefined ? parse(patchPlanDetailBody, op.detail) : {};
        const stored = await getPlanDetail(db, op.node_id);
        if (patch.all_day ?? stored.allDay) {
          const turningOn = patch.all_day === true && !stored.allDay;
          const occurredAt =
            op.occurred_at !== undefined
              ? op.occurred_at
              : turningOn && current.occurredAt
                ? current.occurredAt.toISOString()
                : undefined;
          const endAt =
            patch.end_at !== undefined
              ? patch.end_at
              : turningOn && stored.endAt
                ? stored.endAt.toISOString()
                : undefined;
          anchored.push({
            ...op,
            ...(occurredAt !== undefined ? { occurred_at: occurredAt ? midnightIso(occurredAt) : null } : {}),
            ...(op.detail !== undefined || endAt !== undefined
              ? {
                  detail: {
                    ...patch,
                    ...(endAt !== undefined ? { end_at: endAt ? midnightIso(endAt) : null } : {}),
                  },
                }
              : {}),
          });
          continue;
        }
      }
    }
    anchored.push(op);
  }
  return anchored;
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
    if (op.op === "noop") {
      for (const id of op.node_ids ?? []) {
        nodes.add(id);
      }
    }
    if (op.op === "update_plans") {
      nodes.add(op.hub);
    }
    if (op.op === "spawn_plans") {
      for (const id of [op.hub, op.place]) {
        if (id !== undefined && !temps.has(id)) {
          nodes.add(id);
        }
      }
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

/** Person-to-person edge types read in both directions (extraction.md §2.3). */
const SYMMETRIC_EDGE_TYPES = new Set(["ROOMMATE_OF", "FRIEND_OF", "SIBLING_OF", "PARTNER_OF", "COWORKER_OF", "CLASSMATE_OF"]);

/**
 * True when a current edge of `type` already joins `srcId` and `dstId` (either way round for a
 * symmetric type) with every one of `properties` already set to the same value. Such an edge
 * adds nothing, so it is skipped; one that carries new or different properties is still inserted.
 */
async function edgeAlreadyHeld(
  tx: Tx,
  srcId: string,
  dstId: string,
  type: string,
  properties: Record<string, unknown>,
): Promise<boolean> {
  const forward = and(eq(edge.srcId, srcId), eq(edge.dstId, dstId));
  const ends = SYMMETRIC_EDGE_TYPES.has(type) ? or(forward, and(eq(edge.srcId, dstId), eq(edge.dstId, srcId))) : forward;
  const held = await tx
    .select({ properties: edge.properties })
    .from(edge)
    .where(and(ends, eq(edge.type, type), isNull(edge.validTo)));
  return held.some((row) =>
    Object.entries(properties).every(([key, value]) => JSON.stringify(row.properties[key]) === JSON.stringify(value)),
  );
}

function resolve(value: string, tempIds: Map<string, string>): string {
  const mapped = tempIds.get(value);
  if (mapped) {
    return mapped;
  }
  return value;
}
