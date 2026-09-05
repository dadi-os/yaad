import type { FastifyInstance } from "fastify";
import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { node, planDetail } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { toNodeRecord, toPlanDetail } from "../../serialize.js";
import { parse, timelineQuery } from "./schemas.js";

export async function registerTimeline(app: FastifyInstance): Promise<void> {
  app.get("/timeline", async (request) => {
    const query = parse(timelineQuery, request.query);
    if (query.limit !== undefined && query.limit > app.config.page.max_size) {
      throw new YaadError(
        422,
        "invalid_request",
        `limit exceeds maximum of ${app.config.page.max_size}`,
      );
    }
    const limit = query.limit ?? app.config.page.default_size;
    const offset = query.offset ?? 0;
    const ranged = query.from !== undefined || query.to !== undefined;
    const conditions = [eq(node.kind, "plan")];
    if (ranged) {
      conditions.push(isNotNull(node.occurredAt));
      if (query.from) {
        conditions.push(gte(node.occurredAt, new Date(query.from)));
      }
      if (query.to) {
        conditions.push(lte(node.occurredAt, new Date(query.to)));
      }
    }
    if (query.status) {
      conditions.push(eq(planDetail.status, query.status));
    }

    const rows = await app.db
      .select({ node, detail: planDetail })
      .from(node)
      .innerJoin(planDetail, eq(planDetail.nodeId, node.id))
      .where(and(...conditions))
      .orderBy(sql`${node.occurredAt} ASC NULLS LAST`)
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map((row) => ({
        ...toNodeRecord(row.node),
        detail: toPlanDetail(row.detail),
      })),
      limit,
      offset,
    };
  });
}
