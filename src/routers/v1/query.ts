/**
 * `POST /query` — exact/filter lookup over live nodes (kind, name, date, plan status).
 * Date-bounded plan queries exclude recurrence templates (patterns, not dated events)
 * and treat null plan end_at as an instantaneous event at occurred_at.
 */

import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import { getPersonDetail, getPlaceDetail, getPlanDetail } from "../../db/read.js";
import { node, personDetail, planDetail, type NodeRow } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { toNodeRecord, toPersonDetail, toPlaceDetail, toPlanDetail } from "../../serialize.js";
import type { PersonDetail, PlaceDetail, PlanDetail } from "../../types/domain.js";
import { parse, queryBody } from "./schemas.js";

export async function registerQuery(app: FastifyInstance): Promise<void> {
  app.post("/query", async (request) => {
    const body = parse(queryBody, request.body);

    const hasFilter =
      body.kind !== undefined ||
      body.name !== undefined ||
      body.occurred_from !== undefined ||
      body.occurred_to !== undefined ||
      body.status !== undefined;
    if (!hasFilter) {
      throw new YaadError(422, "invalid_request", "at least one filter is required");
    }

    if (body.status !== undefined && body.kind !== undefined && body.kind !== "plan") {
      throw new YaadError(
        422,
        "invalid_request",
        "status filter requires kind to be plan or unset",
      );
    }

    if (body.limit !== undefined && body.limit > app.config.page.max_size) {
      throw new YaadError(
        422,
        "invalid_request",
        `limit exceeds maximum of ${app.config.page.max_size}`,
      );
    }

    const limit = body.limit ?? app.config.page.default_size;
    const offset = body.offset ?? 0;
    const rows = await runQuery(app.db, body, limit, offset);
    const nodes = [];
    for (const row of rows) {
      nodes.push({
        ...toNodeRecord(row),
        detail: await loadDetail(app.db, row),
      });
    }
    return { nodes, limit, offset };
  });
}

async function runQuery(
  db: Db,
  body: ReturnType<typeof queryBody.parse>,
  limit: number,
  offset: number,
): Promise<NodeRow[]> {
  const conditions = [];
  const dateBounded = body.occurred_from !== undefined || body.occurred_to !== undefined;
  const needsPlanJoin = dateBounded || body.status !== undefined;
  const needsPersonJoin =
    body.name !== undefined && (body.kind === undefined || body.kind === "person");

  conditions.push(or(isNull(node.expiresAt), gt(node.expiresAt, new Date()))!);

  if (body.kind !== undefined) {
    conditions.push(eq(node.kind, body.kind));
  } else if (body.status !== undefined) {
    conditions.push(eq(node.kind, "plan"));
  }

  if (body.status !== undefined) {
    conditions.push(eq(planDetail.status, body.status));
  }

  if (body.name !== undefined) {
    const titleMatch = sql`lower(${node.title}) = lower(${body.name})`;
    if (needsPersonJoin) {
      const aliasMatch = sql`EXISTS (
        SELECT 1 FROM unnest(${personDetail.aliases}) AS alias(val)
        WHERE lower(alias.val) = lower(${body.name})
      )`;
      conditions.push(or(titleMatch, aliasMatch)!);
    } else {
      conditions.push(titleMatch);
    }
  }

  if (dateBounded) {
    conditions.push(isNotNull(node.occurredAt));
    conditions.push(or(sql`${node.kind} <> 'plan'`, isNull(planDetail.recurrence))!);

    const from = body.occurred_from ?? null;
    const to = body.occurred_to ?? null;
    const effectiveEnd = sql`COALESCE(${planDetail.endAt}, ${node.occurredAt})`;
    if (to) {
      conditions.push(sql`${node.occurredAt} <= ${to}`);
    }
    if (from) {
      conditions.push(sql`${effectiveEnd} >= ${from}`);
    }
  }

  let query = db.select({ node }).from(node).$dynamic();
  if (needsPlanJoin) {
    query = query.leftJoin(planDetail, eq(planDetail.nodeId, node.id));
  }
  if (needsPersonJoin) {
    query = query.leftJoin(personDetail, eq(personDetail.nodeId, node.id));
  }

  const rows = await query
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(node.occurredAt), asc(node.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => row.node);
}

async function loadDetail(
  db: Db,
  row: NodeRow,
): Promise<PersonDetail | PlanDetail | PlaceDetail | null> {
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
