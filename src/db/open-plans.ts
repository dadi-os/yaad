/** Reads of live plans shared by the timeline views and ingest: all plans, and the ones still up in the air. */

import { and, asc, eq, gt, gte, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.js";
import { node, planDetail } from "./schema.js";

export type Reader = Pick<Db, "select" | "selectDistinct">;

/** Live plans with their detail, narrowed by `where`. */
export function plansWhere(db: Reader, ...where: SQL[]) {
  return db
    .select({ node, detail: planDetail })
    .from(node)
    .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
    .where(and(eq(node.kind, "plan"), or(isNull(node.expiresAt), gt(node.expiresAt, new Date())), ...where));
}

/**
 * Plans for Someday ("needs a time"): what is still up in the air. Every idea, and tasks with a
 * due or an open but no time set aside (not a series, not a bill, not due before `now`), except
 * a task whose hub files it as a milestone (a date that passes, with nothing to do), coursework
 * (an assignment or quiz of a class, worked in the study time its course budgets), and a task
 * that already has its time: a plan works on it (`FOR`), or its hub is itself a one-off timed
 * plan, the visit or session it is due for.
 */
export async function somedayPlans(db: Reader, now: Date) {
  const settled = sql`EXISTS (
    SELECT 1 FROM edge e
    WHERE e.dst_id = ${node.id} AND e.valid_to IS NULL AND (
      e.type = 'FOR'
      OR (e.type = 'HAS_ITEM' AND (
        e.properties->>'item' = 'milestone'
        OR (e.properties->>'item' IN ('assignment', 'quiz')
          AND EXISTS (SELECT 1 FROM plan_detail hub WHERE hub.node_id = e.src_id AND hub.kind = 'class'))
        OR EXISTS (
          SELECT 1 FROM node hub JOIN plan_detail hd ON hd.node_id = hub.id
          WHERE hub.id = e.src_id AND hub.occurred_at IS NOT NULL AND hd.recurrence IS NULL
        )
      ))
    )
  )`;
  const needsTime = and(
    ne(planDetail.status, "idea"),
    isNull(node.occurredAt),
    isNull(planDetail.recurrence),
    or(isNotNull(planDetail.dueAt), isNotNull(planDetail.opensAt)),
    or(isNull(planDetail.kind), ne(planDetail.kind, "bill")),
    or(isNull(planDetail.dueAt), gte(planDetail.dueAt, now)),
    sql`NOT ${settled}`,
  );
  return plansWhere(db, or(eq(planDetail.status, "idea"), needsTime)!).orderBy(asc(node.createdAt));
}
