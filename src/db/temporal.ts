import { and, eq, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { edge, node, nodeHistory, type EdgeRow, type NodeRow } from "./schema.js";
import { YaadError } from "../errors.js";
import { sameInstant } from "../serialize.js";
import type { NodeSource } from "../types/domain.js";
import type { Db } from "./client.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type NodePatch = {
  title?: string;
  body?: string | null;
  occurredAt?: Date | null;
  source?: NodeSource;
  embedding?: number[] | null;
};

export async function lockNode(tx: Tx, id: string): Promise<NodeRow> {
  const rows = await tx.select().from(node).where(eq(node.id, id)).for("update");
  const row = rows[0];
  if (!row) {
    throw new YaadError(404, "not_found", "node not found");
  }
  return row;
}

export async function lockCurrentEdge(tx: Tx, id: string): Promise<EdgeRow> {
  const rows = await tx
    .select()
    .from(edge)
    .where(and(eq(edge.id, id), isNull(edge.validTo)))
    .for("update");
  const row = rows[0];
  if (!row) {
    throw new YaadError(404, "not_found", "edge not found");
  }
  return row;
}

/** Close a current edge. Never deletes. */
export async function closeEdge(tx: Tx, id: string, at: Date): Promise<EdgeRow> {
  const current = await lockCurrentEdge(tx, id);
  const rows = await tx
    .update(edge)
    .set({ validTo: at })
    .where(and(eq(edge.id, current.id), eq(edge.validFrom, current.validFrom)))
    .returning();
  const closed = rows[0];
  if (!closed) {
    throw new YaadError(409, "conflict", "edge was modified concurrently");
  }
  return closed;
}

/**
 * Update a node in place and append one node_history row per changed field.
 * Callers compute history embeddings before the transaction and pass them in.
 */
export async function updateNode(
  tx: Tx,
  id: string,
  patch: NodePatch,
  historyEmbeddings: Map<string, number[]>,
  at: Date,
): Promise<NodeRow> {
  const current = await lockNode(tx, id);

  const nextTitle = patch.title ?? current.title;
  const nextBody = patch.body !== undefined ? patch.body : current.body;
  const nextOccurredAt = patch.occurredAt !== undefined ? patch.occurredAt : current.occurredAt;
  const nextSource = patch.source ?? current.source;

  const historyRows: Array<{
    field: "title" | "body" | "occurred_at";
    oldValue: string | null;
    newValue: string | null;
  }> = [];
  if (patch.title !== undefined && patch.title !== current.title) {
    historyRows.push({ field: "title", oldValue: current.title, newValue: nextTitle });
  }
  if (patch.body !== undefined && patch.body !== current.body) {
    historyRows.push({ field: "body", oldValue: current.body, newValue: nextBody });
  }
  if (patch.occurredAt !== undefined && !sameInstant(patch.occurredAt, current.occurredAt)) {
    historyRows.push({
      field: "occurred_at",
      oldValue: current.occurredAt ? current.occurredAt.toISOString() : null,
      newValue: nextOccurredAt ? nextOccurredAt.toISOString() : null,
    });
  }

  const rows = await tx
    .update(node)
    .set({
      title: nextTitle,
      body: nextBody,
      occurredAt: nextOccurredAt,
      source: nextSource,
      embedding: patch.embedding !== undefined ? patch.embedding : current.embedding,
      updatedAt: at,
    })
    .where(eq(node.id, id))
    .returning();
  const next = rows[0];
  if (!next) {
    throw new YaadError(500, "internal_error", "node update returned no row");
  }

  for (const row of historyRows) {
    const key = `${row.field}:${id}`;
    await tx.insert(nodeHistory).values({
      id: randomUUID(),
      nodeId: id,
      field: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      embedding: historyEmbeddings.get(key) ?? null,
      changedAt: at,
      source: nextSource,
    });
  }

  return next;
}

/**
 * Hard-delete a node, log a deleted history row, and soft-close open edges
 * touching it so edge history remains.
 */
export async function deleteNode(tx: Tx, id: string, at: Date): Promise<void> {
  const current = await lockNode(tx, id);

  await tx
    .update(edge)
    .set({ validTo: at })
    .where(and(or(eq(edge.srcId, id), eq(edge.dstId, id)), isNull(edge.validTo)));

  await tx.insert(nodeHistory).values({
    id: randomUUID(),
    nodeId: id,
    field: "deleted",
    oldValue: current.title,
    newValue: null,
    embedding: null,
    changedAt: at,
    source: current.source,
  });

  await tx.delete(node).where(eq(node.id, id));
}
