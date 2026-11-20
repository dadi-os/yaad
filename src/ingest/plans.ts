/**
 * Sessions of a hub (a course): plain plans stamped out from one template, and edited in bulk by
 * date. No rule is stored; each session is an ordinary plan row linked to its hub by `HAS_PLAN`.
 */

import { randomUUID } from "node:crypto";
import { and, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { edge, node, planDetail } from "../db/schema.js";
import { deleteNode, type Tx } from "../db/temporal.js";
import { YaadError } from "../errors.js";
import { addDays, dayStart, localDate, localInstant } from "../local-time.js";
import type { NodeAuthor } from "../types/domain.js";
import { PLAN_EDGE } from "../types/planner.js";
import type { SpawnPlansOp, UpdatePlansOp } from "./operations.js";

/** Insert one current edge of confidence 1, valid from `at`; returns its id. */
export async function insertEdge(
  tx: Tx,
  opts: { srcId: string; dstId: string; type: string; properties: Record<string, unknown>; confidence: number; at: Date },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(edge).values({
    id,
    srcId: opts.srcId,
    dstId: opts.dstId,
    type: opts.type,
    properties: opts.properties,
    confidence: opts.confidence,
    createdAt: opts.at,
    validFrom: opts.at,
    validTo: null,
  });
  return id;
}

/**
 * Create one plan per date of `op`, each linked to `hubId` and, when given, `placeId`. The
 * plans carry no embedding, so semantic recall finds the hub and not every session. Returns
 * the new plan ids in date order.
 */
export async function spawnPlans(
  tx: Tx,
  opts: {
    op: SpawnPlansOp;
    hubId: string;
    placeId: string | null;
    author: NodeAuthor;
    timeZone: string;
    at: Date;
  },
): Promise<string[]> {
  const { op, at } = opts;
  const zone = op.time_zone ?? opts.timeZone;
  const ids: string[] = [];
  for (const date of [...op.dates].sort()) {
    const id = randomUUID();
    await tx.insert(node).values({
      id,
      kind: "plan",
      title: op.title,
      body: op.body ?? null,
      embedding: null,
      occurredAt: localInstant(date, op.start_time, zone),
      expiresAt: null,
      source: opts.author.source,
      agentId: opts.author.agentId,
      createdAt: at,
      updatedAt: at,
    });
    await tx.insert(planDetail).values({
      nodeId: id,
      endAt: op.end_time === undefined ? null : localInstant(date, op.end_time, zone),
      allDay: false,
      timeZone: op.time_zone ?? null,
      rsvp: op.rsvp ?? null,
    });
    await insertEdge(tx, { srcId: opts.hubId, dstId: id, type: PLAN_EDGE, properties: {}, confidence: 1, at });
    if (opts.placeId !== null) {
      await insertEdge(tx, {
        srcId: id,
        dstId: opts.placeId,
        type: "AT_LOCATION",
        properties: op.room === undefined ? {} : { room: op.room },
        confidence: 1,
        at,
      });
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Apply `op.set` to every session of `op.hub` between `from_date` and `to_date` (local dates in
 * the box's zone). A moved start keeps each session's own date and, unless the op sets an end,
 * its length. Node history is not written for a change: sessions change by the dozen. `close`
 * closes each matched session as `close_node` closes a node (history keeps a record), and
 * returns the nodes its edges joined as `neighbors`. Returns the ids changed; a change that
 * matches no session is a 422.
 */
export async function changePlans(
  tx: Tx,
  opts: { op: UpdatePlansOp; timeZone: string; at: Date; author: NodeAuthor },
): Promise<{ ids: string[]; neighbors: string[] }> {
  const { op, at } = opts;
  const from = dayStart(op.from_date, opts.timeZone);
  const sessions = await tx
    .select({ node, detail: planDetail })
    .from(edge)
    .innerJoin(node, eq(node.id, edge.dstId))
    .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
    .where(
      and(
        eq(edge.srcId, op.hub),
        eq(edge.type, PLAN_EDGE),
        isNull(edge.validTo),
        or(isNull(node.expiresAt), gt(node.expiresAt, at)),
        gte(node.occurredAt, from),
        op.to_date === undefined ? undefined : lt(node.occurredAt, dayStart(addDays(op.to_date, 1), opts.timeZone)),
      ),
    );
  if (sessions.length === 0) {
    throw new YaadError(422, "invalid_request", `update_plans ${op.hub}: no session from ${op.from_date}${op.to_date ? ` to ${op.to_date}` : ""}`);
  }
  if (op.set.close === true) {
    const neighbors: string[] = [];
    for (const { node: session } of sessions) {
      neighbors.push(...(await deleteNode(tx, session.id, at, opts.author)));
    }
    return { ids: sessions.map((row) => row.node.id), neighbors };
  }
  const { body, rsvp, attended, start_time: startTime, end_time: endTime, room } = op.set;
  for (const { node: session, detail } of sessions) {
    const start = session.occurredAt;
    if (start === null) {
      throw new YaadError(500, "internal_error", `session ${session.id} has no start`);
    }
    const zone = detail.timeZone ?? opts.timeZone;
    const date = localDate(start, zone);
    const movedStart = startTime === undefined ? start : localInstant(date, startTime, zone);
    const keptLength = detail.endAt === null ? null : new Date(movedStart.getTime() + (detail.endAt.getTime() - start.getTime()));
    const endAt = endTime === undefined ? keptLength : endTime === null ? null : localInstant(date, endTime, zone);
    await tx
      .update(node)
      .set({ ...(body !== undefined ? { body } : {}), occurredAt: movedStart, updatedAt: at })
      .where(eq(node.id, session.id));
    await tx
      .update(planDetail)
      .set({
        endAt,
        ...(rsvp !== undefined ? { rsvp } : {}),
        ...(attended !== undefined ? { attended } : {}),
      })
      .where(eq(planDetail.nodeId, session.id));
  }
  if (room !== undefined) {
    await tx
      .update(edge)
      .set({ properties: room === null ? sql`${edge.properties} - 'room'` : sql`${edge.properties} || ${JSON.stringify({ room })}::jsonb` })
      .where(and(eq(edge.type, "AT_LOCATION"), isNull(edge.validTo), inArray(edge.srcId, sessions.map((row) => row.node.id))));
  }
  return { ids: sessions.map((row) => row.node.id), neighbors: [] };
}
