import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "./client.js";
import {
  edge,
  node,
  nodeHistory,
  personDetail,
  placeDetail,
  planDetail,
  type EdgeRow,
  type NodeHistoryRow,
  type NodeRecordRow,
  type NodeRow,
  type PersonDetailRow,
  type PlaceDetailRow,
  type PlanDetailRow,
} from "./schema.js";
import { YaadError } from "../errors.js";

type SelectDb = { select: Db["select"] };

export async function getNode(db: SelectDb, id: string): Promise<NodeRow> {
  const rows = await db.select().from(node).where(eq(node.id, id));
  const row = rows[0];
  if (!row) {
    throw new YaadError(404, "not_found", "node not found");
  }
  return row;
}

export async function getPersonDetail(db: Db, nodeId: string): Promise<PersonDetailRow> {
  const rows = await db.select().from(personDetail).where(eq(personDetail.nodeId, nodeId));
  const row = rows[0];
  if (!row) {
    throw new YaadError(500, "internal_error", `person_detail missing for node ${nodeId}`);
  }
  return row;
}

export async function getPlanDetail(db: SelectDb, nodeId: string): Promise<PlanDetailRow> {
  const rows = await db.select().from(planDetail).where(eq(planDetail.nodeId, nodeId));
  const row = rows[0];
  if (!row) {
    throw new YaadError(500, "internal_error", `plan_detail missing for node ${nodeId}`);
  }
  return row;
}

export async function getPlaceDetail(db: Db, nodeId: string): Promise<PlaceDetailRow> {
  const rows = await db.select().from(placeDetail).where(eq(placeDetail.nodeId, nodeId));
  const row = rows[0];
  if (!row) {
    throw new YaadError(500, "internal_error", `place_detail missing for node ${nodeId}`);
  }
  return row;
}

/** Current edges touching one node. */
export async function getIncidentEdges(db: Db, nodeId: string): Promise<EdgeRow[]> {
  return getIncidentEdgesForIds(db, [nodeId]);
}

/** Current edges only (`valid_to IS NULL`). Historical edge lookup not wired yet. */
export async function getIncidentEdgesForIds(db: Db, nodeIds: string[]): Promise<EdgeRow[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(edge)
    .where(
      and(or(inArray(edge.srcId, nodeIds), inArray(edge.dstId, nodeIds)), isNull(edge.validTo)),
    );
}

/** Live nodes only — expired rows are omitted so graph expansion cannot bridge through them. */
export async function getNodesByIds(db: Db, ids: string[]): Promise<NodeRow[]> {
  if (ids.length === 0) {
    return [];
  }
  const now = new Date();
  return db
    .select()
    .from(node)
    .where(and(inArray(node.id, ids), or(isNull(node.expiresAt), gt(node.expiresAt, now))));
}

/** Every live node without its embedding, oldest first. */
export async function getLiveNodes(db: Db): Promise<NodeRecordRow[]> {
  const { embedding: _embedding, ...columns } = getTableColumns(node);
  return db
    .select(columns)
    .from(node)
    .where(or(isNull(node.expiresAt), gt(node.expiresAt, new Date())))
    .orderBy(asc(node.createdAt), asc(node.id));
}

/** Every current edge whose endpoints are both live. */
export async function getLiveEdges(db: Db): Promise<EdgeRow[]> {
  const src = alias(node, "src");
  const dst = alias(node, "dst");
  const now = new Date();
  return db
    .select(getTableColumns(edge))
    .from(edge)
    .innerJoin(src, eq(src.id, edge.srcId))
    .innerJoin(dst, eq(dst.id, edge.dstId))
    .where(
      and(
        isNull(edge.validTo),
        or(isNull(src.expiresAt), gt(src.expiresAt, now)),
        or(isNull(dst.expiresAt), gt(dst.expiresAt, now)),
      ),
    );
}

/** Current edges whose endpoints are both in `nodeIds`. */
export async function getEdgesAmong(db: Db, nodeIds: string[]): Promise<EdgeRow[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(edge)
    .where(and(inArray(edge.srcId, nodeIds), inArray(edge.dstId, nodeIds), isNull(edge.validTo)));
}

/** Current edge only. Historical edge lookup not wired yet. */
export async function getEdge(db: SelectDb, id: string): Promise<EdgeRow> {
  const rows = await db
    .select()
    .from(edge)
    .where(and(eq(edge.id, id), isNull(edge.validTo)));
  const row = rows[0];
  if (!row) {
    throw new YaadError(404, "not_found", "edge not found");
  }
  return row;
}

/** Every person node joined with its detail row. */
export async function getCurrentPersons(
  db: Db,
): Promise<Array<{ node: NodeRow; detail: PersonDetailRow }>> {
  const rows = await db
    .select({ node, detail: personDetail })
    .from(node)
    .innerJoin(personDetail, eq(personDetail.nodeId, node.id))
    .where(eq(node.kind, "person"));
  return rows;
}

export async function getNodeHistory(
  db: Db,
  nodeId: string,
  limit = 50,
): Promise<NodeHistoryRow[]> {
  return db
    .select()
    .from(nodeHistory)
    .where(eq(nodeHistory.nodeId, nodeId))
    .orderBy(desc(nodeHistory.changedAt))
    .limit(limit);
}
