/**
 * Task routes. `POST /tasks` reads the tasks one local day shows (`on`: those not done whose open
 * day has come, open or past due, plus those done that day or whose window held it) or the ones
 * with no window (`someday`), from stored dates alone. `PUT /tasks/done` is Ankur's mark: it sets
 * `done`, appends a `node_history` row when the flag changed, and stamps `verified_at`.
 * `POST /tasks/verify` restates tasks as still true, stamping their and their courses' `verified_at`.
 */

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getNode, getTaskDetail } from "../../db/read.js";
import { taskDetail } from "../../db/schema.js";
import { recordDone } from "../../db/temporal.js";
import { somedayTasks, tasksOn, verifyTasks } from "../../db/tasks.js";
import { YaadError } from "../../errors.js";
import { MANUAL } from "./nodes.js";
import { parse, taskDoneBody, tasksBody, tasksVerifyBody } from "./schemas.js";

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
    await app.db.transaction(async (tx) => {
      const stored = await getTaskDetail(tx, body.task_id);
      await tx.update(taskDetail).set({ done: body.done, verifiedAt: now }).where(eq(taskDetail.nodeId, body.task_id));
      if (stored.done !== body.done) {
        await recordDone(tx, body.task_id, body.done, now, MANUAL);
      }
    });
    return { task_id: body.task_id, done: body.done };
  });

  app.post("/tasks/verify", async (request) => {
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
}
