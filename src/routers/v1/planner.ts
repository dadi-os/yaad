/**
 * Planner routes: the day planner's timed blocks, kept apart from the memory graph.
 * `POST /planner/query` reads a range; `POST /planner/replace` writes one source's whole plan
 * for a range atomically; `POST /planner/blocks`, `PATCH` and `DELETE /planner/blocks/:id`
 * edit single blocks (`done` marks one done). Blocks may not overlap unless one says
 * `overlap_ok`; a write that would overlap is a 409 `overlap` naming the clashing blocks.
 * An unknown id is a 404.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import { plannerBlock, type PlannerBlockRow } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { toPlannerBlock } from "../../serialize.js";
import {
  idParam,
  parse,
  plannerBlockBody,
  plannerCreateBody,
  plannerPatchBody,
  plannerQueryBody,
  plannerReplaceBody,
} from "./schemas.js";
import type { z } from "zod";

type Row = PlannerBlockRow;
type Draft = Pick<Row, "title" | "startAt" | "endAt" | "overlapOk">;

export async function registerPlanner(app: FastifyInstance): Promise<void> {
  app.post("/planner/query", async (request) => {
    const { from, to } = parse(plannerQueryBody, request.body);
    return { blocks: (await blocksBetween(app.db, new Date(from), new Date(to))).map(toPlannerBlock) };
  });

  app.post("/planner/replace", async (request) => {
    const body = parse(plannerReplaceBody, request.body);
    const from = new Date(body.from);
    const to = new Date(body.to);
    if (!(from < to)) {
      throw new YaadError(422, "invalid_request", "from must be before to");
    }
    const rows = body.blocks.map((block) => newRow(block, body.source));
    for (const row of rows) {
      if (row.startAt < from || row.startAt >= to) {
        throw new YaadError(422, "out_of_range", `"${row.title}" starts outside [from, to)`);
      }
    }
    const written = await app.db.transaction(async (tx) => {
      await tx
        .delete(plannerBlock)
        .where(and(eq(plannerBlock.source, body.source), gte(plannerBlock.startAt, from), lt(plannerBlock.startAt, to)));
      const spanStart = rows.reduce((least, row) => (row.startAt < least ? row.startAt : least), from);
      const spanEnd = rows.reduce((most, row) => (row.endAt > most ? row.endAt : most), to);
      assertNoOverlap(rows, await blocksBetween(tx, spanStart, spanEnd));
      if (rows.length > 0) {
        await tx.insert(plannerBlock).values(rows);
      }
      return blocksBetween(tx, from, to);
    });
    return { blocks: written.map(toPlannerBlock) };
  });

  app.post("/planner/blocks", async (request, reply) => {
    const { source, ...block } = parse(plannerCreateBody, request.body);
    const row = newRow(block, source);
    await app.db.transaction(async (tx) => {
      assertNoOverlap([row], await blocksBetween(tx, row.startAt, row.endAt));
      await tx.insert(plannerBlock).values(row);
    });
    reply.code(201);
    return toPlannerBlock(row);
  });

  app.patch("/planner/blocks/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const { done, ...fields } = parse(plannerPatchBody, request.body);
    return app.db.transaction(async (tx) => {
      const [current] = await tx.select().from(plannerBlock).where(eq(plannerBlock.id, id)).for("update");
      if (!current) {
        throw notFound(id);
      }
      const next: Row = {
        ...current,
        ...(fields.start_at !== undefined ? { startAt: new Date(fields.start_at) } : {}),
        ...(fields.end_at !== undefined ? { endAt: new Date(fields.end_at) } : {}),
        ...(fields.title !== undefined ? { title: fields.title } : {}),
        ...(fields.note !== undefined ? { note: fields.note } : {}),
        ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
        ...(fields.icon !== undefined ? { icon: fields.icon } : {}),
        ...(fields.fixed !== undefined ? { fixed: fields.fixed } : {}),
        ...(fields.overlap_ok !== undefined ? { overlapOk: fields.overlap_ok } : {}),
        ...(done !== undefined ? { doneAt: done ? new Date() : null } : {}),
        updatedAt: new Date(),
      };
      if (!(next.startAt < next.endAt)) {
        throw new YaadError(422, "invalid_request", "start_at must be before end_at");
      }
      assertNoOverlap([next], (await blocksBetween(tx, next.startAt, next.endAt)).filter((row) => row.id !== id));
      await tx.update(plannerBlock).set(next).where(eq(plannerBlock.id, id));
      return toPlannerBlock(next);
    });
  });

  app.delete("/planner/blocks/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const deleted = await app.db.delete(plannerBlock).where(eq(plannerBlock.id, id)).returning({ id: plannerBlock.id });
    if (deleted.length === 0) {
      throw notFound(id);
    }
    return { id };
  });
}

/** A row for a block body, written by `source` now. */
function newRow(block: z.infer<typeof plannerBlockBody>, source: string): Row {
  const startAt = new Date(block.start_at);
  const endAt = new Date(block.end_at);
  if (!(startAt < endAt)) {
    throw new YaadError(422, "invalid_request", `"${block.title}": start_at must be before end_at`);
  }
  const now = new Date();
  return {
    id: randomUUID(),
    startAt,
    endAt,
    title: block.title,
    note: block.note ?? null,
    kind: block.kind,
    icon: block.icon,
    fixed: block.fixed ?? true,
    overlapOk: block.overlap_ok ?? false,
    doneAt: null,
    source,
    createdAt: now,
    updatedAt: now,
  };
}

/** Blocks that overlap `[from, to)`, earliest first. */
async function blocksBetween(db: Pick<Db, "select">, from: Date, to: Date): Promise<Row[]> {
  return db
    .select()
    .from(plannerBlock)
    .where(and(lt(plannerBlock.startAt, to), gt(plannerBlock.endAt, from)))
    .orderBy(asc(plannerBlock.startAt), asc(plannerBlock.endAt));
}

const clock = (at: Date) => at.toISOString().slice(0, 16).replace("T", " ");

/**
 * @throws A 409 `overlap` naming every pair where one of `drafts` overlaps another draft or an
 * existing block and neither says `overlap_ok`.
 */
function assertNoOverlap(drafts: Draft[], existing: Draft[]): void {
  const clashes: string[] = [];
  const clash = (a: Draft, b: Draft) => {
    if (!a.overlapOk && !b.overlapOk && a.startAt < b.endAt && b.startAt < a.endAt) {
      clashes.push(`"${a.title}" (${clock(a.startAt)} to ${clock(a.endAt)}) overlaps "${b.title}" (${clock(b.startAt)} to ${clock(b.endAt)})`);
    }
  };
  drafts.forEach((draft, i) => {
    drafts.slice(i + 1).forEach((other) => clash(draft, other));
    existing.forEach((other) => clash(draft, other));
  });
  if (clashes.length > 0) {
    throw new YaadError(409, "overlap", `${clashes.join("; ")}. Times are UTC. Fix the times or set overlap_ok.`);
  }
}

function notFound(id: string): YaadError {
  return new YaadError(404, "not_found", `planner block ${id} not found`);
}
