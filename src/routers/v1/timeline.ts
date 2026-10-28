/**
 * Timeline routes: every time-bound thing is a plan, and each view is a filter over its
 * sessions. `POST /timeline` reads `[from, to)` through one view: `planner` (timed sessions
 * with a start and an end, not hidden, cancelled ones kept and marked), `due` (sessions whose
 * due falls in the range), `month` (due sessions, all-day and multi-day sessions, and one-off
 * timed commitments), `someday` (ideas, and tasks still up in the air: no time yet, not a
 * milestone or a class's coursework, the range's start standing for now) and `tile` (commitments, for the home ribbon). Ideas reach
 * only `someday`. `PUT /timeline/outcome` is the one write a client makes: Ankur marks a
 * session completed, or takes the mark back.
 */

import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import { writeOccurrence } from "../../db/occurrence.js";
import { edge, node, placeDetail, planDetail, planOccurrence, type PlanOccurrenceRow } from "../../db/schema.js";
import { localDate, planSessions, ruleSummary, sessionOn, type PlanTiming, type Session } from "../../ingest/recurrence.js";
import { parseKnown, toPlanDetail } from "../../serialize.js";
import {
  OCCURRENCE_STATES,
  OUTCOMES,
  ROUTINE_KINDS,
  type SessionNote,
  type TimelineItem,
  type TimelinePlace,
  type TimelineView,
} from "../../types/timeline.js";
import { outcomeBody, parse, timelineBody } from "./schemas.js";

type Reader = Pick<Db, "select" | "selectDistinct">;

/** How sessions expand: the box's zone, the per-range cap, and how far back series counts reach. */
type Calendar = { timeZone: string; maxInstances: number; horizonDays: number };

/**
 * True when a session from `start` to `end` touches `[from, to)`. A session with no end is a
 * point. An all-day session's end is its last day at local midnight, so it runs 23 hours past
 * that: the rest of the day, without reaching the next one even on a 23-hour day.
 */
function touches(start: Date, end: Date | null, allDay: boolean, from: Date, to: Date): boolean {
  const until = allDay ? new Date((end ?? start).getTime() + 23 * 3_600_000) : end;
  return until === null ? start >= from && start < to : start < to && until > from;
}

/** A plan as the views read it. */
type PlanRow = Awaited<ReturnType<typeof plansWhere>>[number];

export async function registerTimeline(app: FastifyInstance): Promise<void> {
  const calendar: Calendar = {
    timeZone: app.config.env.timezone,
    maxInstances: app.config.plan.max_instances_per_series,
    horizonDays: app.config.plan.recurrence_horizon_days,
  };

  app.post("/timeline", async (request) => {
    const body = parse(timelineBody, request.body);
    return { items: await timeline(app.db, new Date(body.from), new Date(body.to), body.view, calendar) };
  });

  app.put("/timeline/outcome", async (request) => {
    const body = parse(outcomeBody, request.body);
    const at = new Date();
    const row = await app.db.transaction((tx) =>
      writeOccurrence(tx, {
        planId: body.plan_id,
        date: body.occurrence_date,
        change: { outcome: body.outcome },
        source: "manual",
        calendar,
        at,
      }),
    );
    return {
      plan_id: body.plan_id,
      occurrence_date: body.occurrence_date,
      outcome: row?.outcome ?? null,
      outcome_at: row?.outcomeAt?.toISOString() ?? null,
    };
  });
}

/** Live plans with their detail, narrowed by `where`. */
function plansWhere(db: Reader, ...where: SQL[]) {
  return db
    .select({ node, detail: planDetail })
    .from(node)
    .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
    .where(and(eq(node.kind, "plan"), or(isNull(node.expiresAt), gt(node.expiresAt, new Date())), ...where));
}

/** The times a plan's sessions are worked out from. */
function timingOf(plan: PlanRow): PlanTiming {
  return {
    start: plan.node.occurredAt,
    end: plan.detail.endAt,
    due: plan.detail.dueAt,
    opens: plan.detail.opensAt,
    rule: plan.detail.recurrence,
  };
}

/** True for a routine kind (meal, shower, gym, study, focus), which stays off the month and the tile. */
function isRoutine(kind: string | null): boolean {
  return ROUTINE_KINDS.some((routine) => routine === kind);
}

/** One session with its plan, its row in plan_occurrence, and its times once a move is applied. */
type Placed = {
  plan: PlanRow;
  session: Session | null;
  override: PlanOccurrenceRow | undefined;
  start: Date | null;
  end: Date | null;
};

/** The view's items in `[from, to)`, earliest first; undated ideas last. */
async function timeline(db: Reader, from: Date, to: Date, view: TimelineView, calendar: Calendar): Promise<TimelineItem[]> {
  const plans = view === "someday" ? await somedayPlans(db, from) : await datedPlans(db, from, to);
  const ids = plans.map((plan) => plan.node.id);
  const overrides = ids.length === 0 ? [] : await db.select().from(planOccurrence).where(inArray(planOccurrence.planId, ids));
  const overrideOf = new Map(overrides.map((row) => [`${row.planId} ${row.occurrenceDate}`, row] as const));

  const placed: Placed[] = [];
  for (const plan of plans) {
    const timing = timingOf(plan);
    const sessions = new Map<string, Session>();
    for (const session of planSessions(timing, from, to, calendar)) {
      sessions.set(session.date, session);
    }
    for (const row of overrides) {
      if (row.planId === plan.node.id && row.state === "moved" && !sessions.has(row.occurrenceDate)) {
        const session = sessionOn(timing, row.occurrenceDate, calendar);
        if (session) {
          sessions.set(session.date, session);
        }
      }
    }
    if (sessions.size === 0 && view === "someday") {
      placed.push({ plan, session: null, override: undefined, start: null, end: null });
    }
    for (const session of sessions.values()) {
      const override = overrideOf.get(`${plan.node.id} ${session.date}`);
      const moved = override?.state === "moved";
      placed.push({
        plan,
        session,
        override,
        start: moved ? override.startAt : session.start,
        end: moved ? override.endAt : session.end,
      });
    }
  }

  const dueIn = (due: Date | null) => due !== null && due >= from && due < to;
  const multiDay = (start: Date, end: Date | null) =>
    end !== null && localDate(start, calendar.timeZone) !== localDate(new Date(end.getTime() - 1), calendar.timeZone);
  const shown = placed.filter(({ plan, session, override, start, end }) => {
    const { detail } = plan;
    const due = session?.due ?? null;
    const overlaps = (at: Date, until: Date | null) => touches(at, until, detail.allDay, from, to);
    if (view === "someday") {
      return override?.outcome !== "done";
    }
    if (view === "planner") {
      return !detail.allDay && !detail.hideFromPlanner && start !== null && end !== null && overlaps(start, end);
    }
    if (view === "due") {
      return dueIn(due);
    }
    if (detail.hideFromPlanner) {
      return false;
    }
    if (view === "tile") {
      return !isRoutine(detail.kind) && (dueIn(due) || (start !== null && overlaps(start, end)));
    }
    const oneOffCommitment = detail.recurrence === null && !isRoutine(detail.kind);
    return dueIn(due) || (start !== null && overlaps(start, end) && (detail.allDay || multiDay(start, end) || oneOffCommitment));
  });

  const items = await toItems(db, shown, overrides, calendar);
  const at = (item: TimelineItem) => item.start_at ?? item.due_at ?? item.opens_at;
  return items.sort((a, b) => {
    const left = at(a);
    const right = at(b);
    if (left === null || right === null) {
      return left === right ? a.title.localeCompare(b.title) : left === null ? 1 : -1;
    }
    return left.localeCompare(right) || a.title.localeCompare(b.title);
  });
}

/**
 * Plans that may have a session in `[from, to)`: series anchored before `to`, one-off plans whose
 * span or due touches the range, and plans with a session moved into it. Ideas never.
 */
async function datedPlans(db: Reader, from: Date, to: Date): Promise<PlanRow[]> {
  const movedIn = await db
    .selectDistinct({ planId: planOccurrence.planId })
    .from(planOccurrence)
    .where(
      and(
        eq(planOccurrence.state, "moved"),
        lt(planOccurrence.startAt, to),
        sql`COALESCE(${planOccurrence.endAt}, ${planOccurrence.startAt}) >= ${from.toISOString()}`,
      ),
    );
  const anchor = sql`COALESCE(${node.occurredAt}, ${planDetail.dueAt})`;
  const spanEnd = sql`COALESCE(${planDetail.endAt}, ${node.occurredAt})`;
  const reaches = or(
    and(isNotNull(planDetail.recurrence), sql`${anchor} < ${to.toISOString()}`),
    and(isNull(planDetail.recurrence), lt(node.occurredAt, to), sql`${spanEnd} >= ${from.toISOString()}`),
    and(isNull(planDetail.recurrence), gte(planDetail.dueAt, from), lt(planDetail.dueAt, to)),
    ...(movedIn.length > 0 ? [inArray(node.id, movedIn.map((row) => row.planId))] : []),
  );
  return plansWhere(db, ne(planDetail.status, "idea"), reaches!).orderBy(asc(node.createdAt));
}

/**
 * Plans for Someday ("needs a time"): what is still up in the air. Every idea, and tasks with a
 * due or an open but no time set aside (not a series, not a bill, not due before `now`), except
 * a task whose hub files it as a milestone (a date that passes, with nothing to do), coursework
 * (an assignment or quiz of a class, worked in the study time its course budgets), and a task
 * that already has its time: a plan works on it (`FOR`), or its hub is itself a one-off timed
 * plan, the visit or session it is due for.
 */
async function somedayPlans(db: Reader, now: Date): Promise<PlanRow[]> {
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

/** The shown sessions as items, with their places, session notes, and series counts. */
async function toItems(db: Reader, shown: Placed[], overrides: PlanOccurrenceRow[], calendar: Calendar): Promise<TimelineItem[]> {
  const ids = [...new Set(shown.map(({ plan }) => plan.node.id))];
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
  const notes = new Map<string, SessionNote[]>();
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
    const occurrence = link.properties.occurrence;
    if (link.type === "HAS_NOTE" && typeof occurrence === "string") {
      const key = `${link.src} ${occurrence}`;
      notes.set(key, [...(notes.get(key) ?? []), { id: link.target.id, title: link.target.title, body: link.target.body }]);
    }
  }

  const now = new Date();
  const series = new Map<string, TimelineItem["series"]>();
  for (const { plan } of shown) {
    if (plan.detail.recurrence === null || series.has(plan.node.id)) {
      continue;
    }
    const timing = timingOf(plan);
    const anchor = timing.start ?? timing.due;
    if (anchor === null) {
      continue;
    }
    const reach = new Date(Math.max(anchor.getTime(), now.getTime() - calendar.horizonDays * 86_400_000));
    const rows = new Map(overrides.filter((row) => row.planId === plan.node.id).map((row) => [row.occurrenceDate, row] as const));
    const held = planSessions(timing, reach, now, calendar).filter((session) => {
      const at = session.start ?? session.due;
      return at !== null && at <= now && rows.get(session.date)?.state !== "cancelled";
    });
    series.set(plan.node.id, {
      completed: held.filter((session) => rows.get(session.date)?.outcome === "done").length,
      total: held.length,
    });
  }

  const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
  return shown.map(({ plan, session, override, start, end }): TimelineItem => {
    const detail = toPlanDetail(plan.detail);
    const date = session?.date ?? null;
    const anchor = plan.node.occurredAt ?? plan.detail.dueAt;
    return {
      id: plan.node.id,
      occurrence_date: date,
      title: plan.node.title,
      body: plan.node.body,
      kind: detail.kind,
      status: detail.status,
      start_at: iso(start),
      end_at: iso(end),
      due_at: iso(session?.due),
      opens_at: iso(session?.opens),
      all_day: detail.all_day,
      time_zone: detail.time_zone,
      hide_from_planner: detail.hide_from_planner,
      state: override ? parseKnown(OCCURRENCE_STATES, override.state, "occurrence state") : "scheduled",
      outcome: override?.outcome ? parseKnown(OUTCOMES, override.outcome, "outcome") : null,
      outcome_at: iso(override?.outcomeAt),
      actual_start: iso(override?.actualStart),
      actual_end: iso(override?.actualEnd),
      recurrence:
        plan.detail.recurrence !== null && anchor !== null ? ruleSummary(plan.detail.recurrence, anchor, calendar.timeZone) : null,
      series: series.get(plan.node.id) ?? null,
      place: places.get(plan.node.id) ?? null,
      owner: plan.node.agentId ?? plan.node.source,
      notes: date === null ? [] : (notes.get(`${plan.node.id} ${date}`) ?? []),
    };
  });
}
