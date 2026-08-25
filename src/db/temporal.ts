import { and, eq, gt, isNull, lte, or, type SQL } from "drizzle-orm";
import { edge, node, type EdgeRow, type NodeRow } from "./schema.js";
import { YaadError } from "../errors.js";
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

/**
 * Current-row predicate. Pass `asOf` to reconstruct state at that instant
 * (`valid_from <= asOf` and `valid_to` null or after `asOf`). Default is
 * currently true rows only.
 */
export function asOfClause(
  validFrom: typeof node.validFrom | typeof edge.validFrom,
  validTo: typeof node.validTo | typeof edge.validTo,
  asOf: Date | undefined,
): SQL {
  if (!asOf) {
    return isNull(validTo);
  }
  const clause = and(lte(validFrom, asOf), or(isNull(validTo), gt(validTo, asOf)));
  if (!clause) {
    throw new YaadError(500, "internal", "as-of clause is empty");
  }
  return clause;
}

export async function lockCurrentNode(tx: Tx, id: string): Promise<NodeRow> {
  const rows = await tx
    .select()
    .from(node)
    .where(and(eq(node.id, id), isNull(node.validTo)))
    .for("update");
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

/** Close a current node. Never deletes. */
export async function closeNode(tx: Tx, id: string, at: Date): Promise<NodeRow> {
  const current = await lockCurrentNode(tx, id);
  const rows = await tx
    .update(node)
    .set({ validTo: at })
    .where(and(eq(node.id, current.id), eq(node.validFrom, current.validFrom)))
    .returning();
  const closed = rows[0];
  if (!closed) {
    throw new YaadError(409, "conflict", "node was modified concurrently");
  }
  return closed;
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
 * Supersede a current node: close it, then insert a successor with the same
 * id and a new valid_from. Callers must go through this for any node field change.
 */
export async function supersedeNode(tx: Tx, id: string, patch: NodePatch, at: Date): Promise<NodeRow> {
  const current = await closeNode(tx, id, at);
  const rows = await tx
    .insert(node)
    .values({
      id: current.id,
      kind: current.kind,
      title: patch.title ?? current.title,
      body: patch.body !== undefined ? patch.body : current.body,
      embedding: patch.embedding !== undefined ? patch.embedding : current.embedding,
      occurredAt: patch.occurredAt !== undefined ? patch.occurredAt : current.occurredAt,
      salience: current.salience,
      accessCount: current.accessCount,
      lastAccessedAt: current.lastAccessedAt,
      source: patch.source ?? current.source,
      createdAt: current.createdAt,
      validFrom: at,
      validTo: null,
    })
    .returning();
  const next = rows[0];
  if (!next) {
    throw new YaadError(500, "internal", "supersede insert returned no row");
  }
  return next;
}
