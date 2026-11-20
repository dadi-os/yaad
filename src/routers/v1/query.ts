/**
 * `POST /query` — exact/filter lookup over live nodes (kind, name, date range, tasks relevant on a day, a hub).
 * `GET /counts` — how many live nodes of each kind Yaad holds, and the total: every node is a memory.
 */

import { gt, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import { assertFilterCoherent, filterNodes, hasFilter } from "../../db/filter.js";
import { getPersonDetail, getPlaceDetail, getPlanDetail, getTaskDetail } from "../../db/read.js";
import { node, type NodeRow } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { parseKind, toNodeRecord, toPersonDetail, toPlaceDetail, toPlanDetail, toTaskDetail } from "../../serialize.js";
import type { NodeKind, PersonDetail, PlaceDetail, PlanDetail, TaskDetail } from "../../types/domain.js";
import { parse, queryBody } from "./schemas.js";

export async function registerQuery(app: FastifyInstance): Promise<void> {
  app.get("/counts", async () => {
    const rows = await app.db
      .select({ kind: node.kind, n: sql<number>`count(*)::int` })
      .from(node)
      .where(or(isNull(node.expiresAt), gt(node.expiresAt, new Date())))
      .groupBy(node.kind);
    const kinds: Record<NodeKind, number> = { person: 0, memory: 0, place: 0, plan: 0, task: 0 };
    for (const row of rows) {
      kinds[parseKind(row.kind)] = row.n;
    }
    return { total: Object.values(kinds).reduce((sum, n) => sum + n, 0), kinds };
  });

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
