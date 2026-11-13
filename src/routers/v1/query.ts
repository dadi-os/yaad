/** `POST /query` — exact/filter lookup over live nodes (kind, name, date range, plan status, tasks relevant on a day). */

import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import { assertFilterCoherent, filterNodes, hasFilter } from "../../db/filter.js";
import { getPersonDetail, getPlaceDetail, getPlanDetail, getTaskDetail } from "../../db/read.js";
import type { NodeRow } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { toNodeRecord, toPersonDetail, toPlaceDetail, toPlanDetail, toTaskDetail } from "../../serialize.js";
import type { PersonDetail, PlaceDetail, PlanDetail, TaskDetail } from "../../types/domain.js";
import { parse, queryBody } from "./schemas.js";

export async function registerQuery(app: FastifyInstance): Promise<void> {
  app.post("/query", async (request) => {
    const { limit: requestedLimit, offset: requestedOffset, ...filter } = parse(queryBody, request.body);

    if (!hasFilter(filter)) {
      throw new YaadError(422, "invalid_request", "at least one filter is required");
    }
    assertFilterCoherent(filter);

    if (requestedLimit !== undefined && requestedLimit > app.config.page.max_size) {
      throw new YaadError(
        422,
        "invalid_request",
        `limit exceeds maximum of ${app.config.page.max_size}`,
      );
    }

    const limit = requestedLimit ?? app.config.page.default_size;
    const offset = requestedOffset ?? 0;
    const matches = await filterNodes(app.db, filter, limit, offset);
    const nodes = [];
    for (const row of matches) {
      nodes.push({ ...toNodeRecord(row), detail: await loadDetail(app.db, row) });
    }
    return { nodes, limit, offset };
  });
}

async function loadDetail(
  db: Db,
  row: NodeRow,
): Promise<PersonDetail | PlanDetail | PlaceDetail | TaskDetail | null> {
  if (row.kind === "task") {
    return toTaskDetail(await getTaskDetail(db, row.id));
  }
  if (row.kind === "person") {
    return toPersonDetail(await getPersonDetail(db, row.id));
  }
  if (row.kind === "plan") {
    return toPlanDetail(await getPlanDetail(db, row.id));
  }
  if (row.kind === "place") {
    return toPlaceDetail(await getPlaceDetail(db, row.id));
  }
  return null;
}
