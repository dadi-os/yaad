import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { edge, node, personDetail, planDetail, type EdgeRow, type NodeRow, type PersonDetailRow, type PlanDetailRow } from "./schema.js";
import { asOfClause } from "./temporal.js";
import { YaadError } from "../errors.js";

type SelectDb = { select: Db["select"] };

export async function getNode(db: SelectDb, id: string, asOf: Date | undefined): Promise<NodeRow> {
  const rows = await db
    .select()
    .from(node)
    .where(and(eq(node.id, id), asOfClause(node.validFrom, node.validTo, asOf)));
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
    throw new YaadError(500, "internal", `person_detail missing for node ${nodeId}`);
  }
  return row;
}

export async function getPlanDetail(db: Db, nodeId: string): Promise<PlanDetailRow> {
  const rows = await db.select().from(planDetail).where(eq(planDetail.nodeId, nodeId));
  const row = rows[0];
  if (!row) {
    throw new YaadError(500, "internal", `plan_detail missing for node ${nodeId}`);
  }
  return row;
}

export async function getIncidentEdges(db: Db, nodeId: string, asOf: Date | undefined): Promise<EdgeRow[]> {
  return getIncidentEdgesForIds(db, [nodeId], asOf);
}

export async function getIncidentEdgesForIds(
  db: Db,
  nodeIds: string[],
  asOf: Date | undefined,
): Promise<EdgeRow[]> {
  if (nodeIds.length === 0) {
    return [];
  }
  return db
    .select()
    .from(edge)
    .where(
      and(
        or(inArray(edge.srcId, nodeIds), inArray(edge.dstId, nodeIds)),
        asOfClause(edge.validFrom, edge.validTo, asOf),
      ),
    );
}

export async function getNodesByIds(
  db: Db,
  ids: string[],
  asOf: Date | undefined,
): Promise<NodeRow[]> {
  if (ids.length === 0) {
    return [];
  }
  return db
    .select()
    .from(node)
    .where(and(inArray(node.id, ids), asOfClause(node.validFrom, node.validTo, asOf)));
}

export async function getEdge(db: SelectDb, id: string, asOf: Date | undefined): Promise<EdgeRow> {
  const rows = await db
    .select()
    .from(edge)
    .where(and(eq(edge.id, id), asOfClause(edge.validFrom, edge.validTo, asOf)));
  const row = rows[0];
  if (!row) {
    throw new YaadError(404, "not_found", "edge not found");
  }
  return row;
}

export async function getCurrentPersons(
  db: Db,
): Promise<Array<{ node: NodeRow; detail: PersonDetailRow }>> {
  const rows = await db
    .select({ node, detail: personDetail })
    .from(node)
    .innerJoin(personDetail, eq(personDetail.nodeId, node.id))
    .where(and(eq(node.kind, "person"), asOfClause(node.validFrom, node.validTo, undefined)));
  return rows;
}
