/**
 * Task routes. `POST /tasks` reads the tasks one local day shows (`on`: those not done whose open
 * day has come, open or past due, plus those done that day or whose window held it) or the ones
 * with no window (`someday`), from stored dates alone. `PUT /tasks/done` is Ankur's tick: it
 * sets `done_at` to now, or clears it, and either way stamps `verified_at`.
 */

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getNode } from "../../db/read.js";
import { taskDetail } from "../../db/schema.js";
import { somedayTasks, tasksOn } from "../../db/tasks.js";
import { YaadError } from "../../errors.js";
import { parse, taskDoneBody, tasksBody } from "./schemas.js";

export async function registerTasks(app: FastifyInstance): Promise<void> {
  app.post("/tasks", async (request) => {
    const body = parse(tasksBody, request.body);
    const items = body.on !== undefined ? await tasksOn(app.db, body.on, app.config.env.timezone) : await somedayTasks(app.db);
    return { items };
  });

  app.put("/tasks/done", async (request) => {
    const body = parse(taskDoneBody, request.body);
    const row = await getNode(app.db, body.task_id);
    if (row.kind !== "task") {
      throw new YaadError(422, "invalid_request", `node ${body.task_id} is not a task`);
    }
    const now = new Date();
    const doneAt = body.done ? now : null;
    await app.db.update(taskDetail).set({ doneAt, verifiedAt: now }).where(eq(taskDetail.nodeId, body.task_id));
    return { task_id: body.task_id, done_at: doneAt?.toISOString() ?? null };
  });
}
