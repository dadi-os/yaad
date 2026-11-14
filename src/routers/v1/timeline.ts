/**
 * Timeline routes: every plan is a stored row, and each view is a filter over them. `POST
 * /timeline` reads `[from, to)` through one view: `planner` (timed plans with a start and an end,
 * for the day and week grid), `month` (all-day and multi-day plans, and plans that are not a
 * session of a course) and `tile` (every plan, for the home ribbon). Declined plans
 * are kept and marked, never hidden; a plan called off is closed and gone. `PUT /timeline/outcome` and `PUT /timeline/rsvp` are
 * the writes Ankur makes by hand on a plan.
 */

import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import { getNode } from "../../db/read.js";
import { edge, node, placeDetail, planDetail } from "../../db/schema.js";
import { hubsOf } from "../../db/tasks.js";
import { YaadError } from "../../errors.js";
import { localDate } from "../../local-time.js";
import { toPlanDetail } from "../../serialize.js";
import {
  SESSION_EDGE,
  type PlanNote,
  type TimelineItem,
  type TimelinePlace,
  type TimelineView,
} from "../../types/timeline.js";
import { outcomeBody, parse, rsvpBody, timelineBody } from "./schemas.js";

/** A plan with its detail, as the views read it. */
type PlanRow = { node: typeof node.$inferSelect; detail: typeof planDetail.$inferSelect };

/**
 * True when a plan from `start` to `end` touches `[from, to)`. A plan with no end is a point. An
 * all-day plan's end is its last day at local midnight, so it runs 23 hours past that: the rest
 * of the day, without reaching the next one even on a 23-hour day.
 */
function touches(start: Date, end: Date | null, allDay: boolean, from: Date, to: Date): boolean {
  const until = allDay ? new Date((end ?? start).getTime() + 23 * 3_600_000) : end;
  return until === null ? start >= from && start < to : start < to && until > from;
}

export async function registerTimeline(app: FastifyInstance): Promise<void> {
  app.post("/timeline", async (request) => {
    const body = parse(timelineBody, request.body);
    return { items: await timeline(app.db, new Date(body.from), new Date(body.to), body.view, app.config.env.timezone) };
  });

  app.put("/timeline/outcome", async (request) => {
    const body = parse(outcomeBody, request.body);
    await requirePlan(app.db, body.plan_id);
    const outcomeAt = body.outcome === null ? null : new Date();
    await app.db.update(planDetail).set({ outcome: body.outcome, outcomeAt }).where(eq(planDetail.nodeId, body.plan_id));
    return { plan_id: body.plan_id, outcome: body.outcome, outcome_at: outcomeAt?.toISOString() ?? null };
  });

  app.put("/timeline/rsvp", async (request) => {
    const body = parse(rsvpBody, request.body);
    await requirePlan(app.db, body.plan_id);
    await app.db.update(planDetail).set({ rsvp: body.rsvp }).where(eq(planDetail.nodeId, body.plan_id));
    return { plan_id: body.plan_id, rsvp: body.rsvp };
  });
}

/** 404 for an unknown or expired node, 422 for one that is not a plan. */
async function requirePlan(db: Db, id: string): Promise<void> {
  const row = await getNode(db, id);
  if (row.kind !== "plan") {
    throw new YaadError(422, "invalid_request", `node ${id} is not a plan`);
  }
  if (row.expiresAt !== null && row.expiresAt <= new Date()) {
    throw new YaadError(404, "not_found", "node not found");
  }
}

/** The view's plans touching `[from, to)`, earliest first. */
async function timeline(db: Db, from: Date, to: Date, view: TimelineView, timeZone: string): Promise<TimelineItem[]> {
  const rows: PlanRow[] = await db
    .select({ node, detail: planDetail })
    .from(node)
    .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
    .where(
      and(
        eq(node.kind, "plan"),
        or(isNull(node.expiresAt), gt(node.expiresAt, new Date())),
        lt(node.occurredAt, to),
        sql`COALESCE(${planDetail.endAt}, ${node.occurredAt}) >= ${new Date(from.getTime() - 23 * 3_600_000).toISOString()}`,
      ),
    );
  const touching = rows.filter(({ node: plan, detail }) => {
    const start = plan.occurredAt;
    return start !== null && touches(start, detail.endAt, detail.allDay, from, to);
  });
  const ids = touching.map(({ node: plan }) => plan.id);
  const hubs = await hubsOf(db, ids, SESSION_EDGE);
  const multiDay = ({ node: plan, detail }: PlanRow) =>
    plan.occurredAt !== null &&
    detail.endAt !== null &&
    localDate(plan.occurredAt, timeZone) !== localDate(new Date(detail.endAt.getTime() - 1), timeZone);
  const shown = touching.filter((row) => {
    if (view === "planner") {
      return !row.detail.allDay && row.detail.endAt !== null;
    }
    if (view === "month") {
      return row.detail.allDay || multiDay(row) || !hubs.has(row.node.id);
    }
    return true;
  });
  const items = await toItems(db, shown, hubs);
  return items.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.title.localeCompare(b.title));
}

/** The plans as items, with their places and notes. */
async function toItems(db: Db, shown: PlanRow[], hubs: Awaited<ReturnType<typeof hubsOf>>): Promise<TimelineItem[]> {
  const ids = shown.map(({ node: plan }) => plan.id);
  if (ids.length === 0) {
    return [];
  }
  const links = await db
    .select({ src: edge.srcId, type: edge.type, properties: edge.properties, target: node, address: placeDetail.address })
    .from(edge)
    .innerJoin(node, eq(node.id, edge.dstId))
    .leftJoin(placeDetail, eq(placeDetail.nodeId, node.id))
    .where(
      and(
        inArray(edge.srcId, ids),
        isNull(edge.validTo),
        inArray(edge.type, ["AT_LOCATION", "HAS_NOTE"]),
        or(isNull(node.expiresAt), gt(node.expiresAt, new Date())),
      ),
    )
    .orderBy(asc(edge.createdAt));
  const places = new Map<string, TimelinePlace>();
  const notes = new Map<string, PlanNote[]>();
  for (const link of links) {
    if (link.type === "AT_LOCATION" && link.target.kind === "place" && !places.has(link.src)) {
      const room = link.properties.room;
      places.set(link.src, {
        id: link.target.id,
        title: link.target.title,
        address: link.address,
        room: typeof room === "string" || typeof room === "number" ? String(room) : null,
      });
    }
    if (link.type === "HAS_NOTE") {
      notes.set(link.src, [...(notes.get(link.src) ?? []), { id: link.target.id, title: link.target.title, body: link.target.body }]);
    }
  }
  return shown.map(({ node: plan, detail }): TimelineItem => {
    const plain = toPlanDetail(detail);
    if (plan.occurredAt === null) {
      throw new YaadError(500, "internal_error", `plan ${plan.id} has no start`);
    }
    return {
      id: plan.id,
      title: plan.title,
      body: plan.body,
      rsvp: plain.rsvp,
      start_at: plan.occurredAt.toISOString(),
      end_at: plain.end_at,
      all_day: plain.all_day,
      time_zone: plain.time_zone,
      outcome: plain.outcome,
      outcome_at: plain.outcome_at,
      actual_start: plain.actual_start,
      actual_end: plain.actual_end,
      place: places.get(plan.id) ?? null,
      hub: hubs.get(plan.id) ?? null,
      owner: plan.agentId ?? plan.source,
      notes: notes.get(plan.id) ?? [],
    };
  });
}
