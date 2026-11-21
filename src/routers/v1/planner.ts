/**
 * Planner routes: every plan and task is a stored row, and the app decides what to show of them.
 * `POST /planner/plans` reads every plan touching `[from, to)`; `POST /planner/tasks` reads the
 * tasks one local day shows (`on`: those not done whose open day has come, open or past due, plus
 * those done that day or whose window held it) or the ones with no window (`someday`), from stored
 * dates alone. Ankur's only hand writes are here: `PUT /planner/tasks/done` marks a task done or
 * not (appending a `node_history` row when the flag changed, and stamping `verified_at`) and
 * `PUT /planner/plans/attended` says whether he was at a plan. `POST /planner/tasks/verify` restates
 * tasks as still true, stamping their and their courses' `verified_at`.
 *
 * Transitional aliases serve the routes the apps called before the rename (`POST /timeline` with
 * its `view`, `POST /tasks`, `PUT /tasks/done`, `PUT /timeline/attended`) so a yaad deploy and an app
 * release need not land together; delete them once Thaali's and Khisso's planner releases are out.
 */

import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import { getNode, getTaskDetail } from "../../db/read.js";
import { edge, node, placeDetail, planDetail, taskDetail } from "../../db/schema.js";
import { recordDone } from "../../db/temporal.js";
import { hubsOf, somedayTasks, tasksOn, verifyTasks } from "../../db/tasks.js";
import { YaadError } from "../../errors.js";
import { localDate } from "../../local-time.js";
import { toPlanDetail } from "../../serialize.js";
import type { NodeAuthor } from "../../types/domain.js";
import { PLAN_EDGE, type Hub, type PlanItem, type PlanNote, type PlanPlace } from "../../types/planner.js";
import { attendedBody, legacyTimelineBody, parse, plansBody, taskDoneBody, tasksBody, tasksVerifyBody } from "./schemas.js";

/** Author recorded in history for the two hand writes Ankur makes in the planner. */
export const MANUAL: NodeAuthor = { source: "manual", agentId: null };

/** A plan with its detail, as the reads see it. */
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

export async function registerPlanner(app: FastifyInstance): Promise<void> {
  const timeZone = app.config.env.timezone;

  const readPlans = async (body: { from: string; to: string }) => {
    const { rows, hubs } = await plansTouching(app.db, new Date(body.from), new Date(body.to));
    return { rows, hubs };
  };
  const readTasks = async (body: ReturnType<typeof parseTasks>) =>
    ({ items: body.on !== undefined ? await tasksOn(app.db, body.on, timeZone) : await somedayTasks(app.db) });
  const markDone = async (raw: unknown) => {
    const body = parse(taskDoneBody, raw);
    const row = await getNode(app.db, body.task_id);
    if (row.kind !== "task") {
      throw new YaadError(422, "invalid_request", `node ${body.task_id} is not a task`);
    }
    const now = new Date();
    await app.db.transaction(async (tx) => {
      const stored = await getTaskDetail(tx, body.task_id);
      await tx.update(taskDetail).set({ done: body.done, verifiedAt: now }).where(eq(taskDetail.nodeId, body.task_id));
      if (stored.done !== body.done) {
        await recordDone(tx, body.task_id, body.done, now, MANUAL);
      }
    });
    return { task_id: body.task_id, done: body.done };
  };
  const markAttended = async (raw: unknown) => {
    const body = parse(attendedBody, raw);
    await requirePlan(app.db, body.plan_id);
    await app.db.update(planDetail).set({ attended: body.attended }).where(eq(planDetail.nodeId, body.plan_id));
    return { plan_id: body.plan_id, attended: body.attended };
  };

  app.post("/planner/plans", async (request) => {
    const { rows, hubs } = await readPlans(parse(plansBody, request.body));
    return { items: sortPlans(await toItems(app.db, rows, hubs)) };
  });
  app.post("/planner/tasks", async (request) => readTasks(parseTasks(request.body)));
  app.put("/planner/tasks/done", async (request) => markDone(request.body));
  app.put("/planner/plans/attended", async (request) => markAttended(request.body));
  app.post("/planner/tasks/verify", async (request) => {
    const body = parse(tasksVerifyBody, request.body);
    for (const id of body.node_ids) {
      if ((await getNode(app.db, id)).kind !== "task") {
        throw new YaadError(422, "invalid_request", `node ${id} is not a task`);
      }
    }
    const now = new Date();
    await verifyTasks(app.db, body.node_ids, now);
    return { node_ids: body.node_ids, verified_at: now.toISOString() };
  });

  app.post("/timeline", async (request) => {
    const body = parse(legacyTimelineBody, request.body);
    const { rows, hubs } = await readPlans(body);
    const multiDay = ({ node: plan, detail }: PlanRow) =>
      plan.occurredAt !== null &&
      detail.endAt !== null &&
      localDate(plan.occurredAt, timeZone) !== localDate(new Date(detail.endAt.getTime() - 1), timeZone);
    const shown = rows.filter((row) =>
      body.view === "planner"
        ? !row.detail.allDay && row.detail.endAt !== null
        : body.view === "month"
          ? row.detail.allDay || multiDay(row) || !hubs.has(row.node.id)
          : true,
    );
    return { items: sortPlans(await toItems(app.db, shown, hubs)) };
  });
  app.post("/tasks", async (request) => readTasks(parseTasks(request.body)));
  app.put("/tasks/done", async (request) => markDone(request.body));
  app.put("/timeline/attended", async (request) => markAttended(request.body));
}

function parseTasks(raw: unknown) {
  return parse(tasksBody, raw);
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

/** The live plans touching `[from, to)` with the hub each is a plan of. */
async function plansTouching(db: Db, from: Date, to: Date): Promise<{ rows: PlanRow[]; hubs: Map<string, Hub> }> {
  const found: PlanRow[] = await db
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
  const rows = found.filter(({ node: plan, detail }) => plan.occurredAt !== null && touches(plan.occurredAt, detail.endAt, detail.allDay, from, to));
  return { rows, hubs: await hubsOf(db, rows.map(({ node: plan }) => plan.id), PLAN_EDGE) };
}

/** Plans earliest first, ties by title. */
function sortPlans(items: PlanItem[]): PlanItem[] {
  return items.sort((a, b) => a.start_at.localeCompare(b.start_at) || a.title.localeCompare(b.title));
}

/** The plans as items, with their places and notes. */
async function toItems(db: Db, shown: PlanRow[], hubs: Map<string, Hub>): Promise<PlanItem[]> {
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
  const places = new Map<string, PlanPlace>();
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
  return shown.map(({ node: plan, detail }): PlanItem => {
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
      attended: plain.attended,
      place: places.get(plan.id) ?? null,
      hub: hubs.get(plan.id) ?? null,
      owner: plan.agentId,
      notes: notes.get(plan.id) ?? [],
    };
  });
}
