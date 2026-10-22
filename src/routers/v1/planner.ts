/**
 * Planner routes: the day planner's timed blocks, kept apart from the memory graph.
 * `POST /planner/query` reads a range; `POST /planner/replace` writes one source's whole plan
 * for a range atomically; `POST /planner/blocks`, `PATCH` and `DELETE /planner/blocks/:id`
 * edit single blocks (`done` marks one done). A block may name a `place`; `GET /planner/places`
 * lists the known places and `PUT /planner/places` and `PUT /planner/travel` teach the planner
 * a place and a travel time. Blocks may not overlap unless one says `overlap_ok` (409
 * `overlap`), and consecutive blocks must leave the stretch minimum, or the travel plus the
 * buffer when their places differ (409 `spacing`); both errors name the blocks and what
 * would work. An unknown place is a 422 `unknown_place`; an unknown id is a 404.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { plannerBlock, plannerPlace, plannerTravel, type PlannerBlockRow } from "../../db/schema.js";
import { YaadError } from "../../errors.js";
import { requiredGap, travelMinutes, type Located, type TravelTable } from "../../planner/travel.js";
import { toPlannerBlock } from "../../serialize.js";
import type { PlannerBlock } from "../../types/planner.js";
import {
  idParam,
  parse,
  plannerBlockBody,
  plannerCreateBody,
  plannerPatchBody,
  plannerPlaceBody,
  plannerQueryBody,
  plannerReplaceBody,
  plannerTravelBody,
} from "./schemas.js";
import type { z } from "zod";

type Row = PlannerBlockRow;
type Draft = Pick<Row, "id" | "title" | "startAt" | "endAt" | "overlapOk" | "placeId">;

/** How far past a write's edges the neighbors are read, so spacing is checked against the blocks beside it. */
const NEIGHBOR_MS = 12 * 3_600_000;

/** The planner's places by id and by lower-cased name or alias, and the stored travel times. */
type Places = {
  byId: Map<string, Located>;
  byName: Map<string, Located>;
  stored: TravelTable;
};

export async function registerPlanner(app: FastifyInstance): Promise<void> {
  const tz = app.config.env.timezone;
  const planner = app.config.planner;

  app.post("/planner/query", async (request) => {
    const { from, to } = parse(plannerQueryBody, request.body);
    const places = await loadPlaces(app.db);
    return { blocks: present(await blocksBetween(app.db, new Date(from), new Date(to)), places, planner) };
  });

  app.post("/planner/replace", async (request) => {
    const body = parse(plannerReplaceBody, request.body);
    const from = new Date(body.from);
    const to = new Date(body.to);
    if (!(from < to)) {
      throw new YaadError(422, "invalid_request", "from must be before to");
    }
    const places = await loadPlaces(app.db);
    const rows = body.blocks.map((block) => newRow(block, body.source, resolvePlace(places, block.place)));
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
      const existing = await blocksBetween(tx, new Date(spanStart.getTime() - NEIGHBOR_MS), new Date(spanEnd.getTime() + NEIGHBOR_MS));
      assertNoOverlap(rows, existing, tz);
      assertSpacing(rows, existing, places, planner, tz);
      if (rows.length > 0) {
        await tx.insert(plannerBlock).values(rows);
      }
      return blocksBetween(tx, from, to);
    });
    return { blocks: present(written, places, planner) };
  });

  app.post("/planner/blocks", async (request, reply) => {
    const { source, ...block } = parse(plannerCreateBody, request.body);
    const places = await loadPlaces(app.db);
    const row = newRow(block, source, resolvePlace(places, block.place));
    await app.db.transaction(async (tx) => {
      const existing = await blocksBetween(tx, new Date(row.startAt.getTime() - NEIGHBOR_MS), new Date(row.endAt.getTime() + NEIGHBOR_MS));
      assertNoOverlap([row], existing, tz);
      assertSpacing([row], existing, places, planner, tz);
      await tx.insert(plannerBlock).values(row);
    });
    reply.code(201);
    return presentOne(row, places);
  });

  app.patch("/planner/blocks/:id", async (request) => {
    const { id } = parse(idParam, request.params);
    const { done, place, ...fields } = parse(plannerPatchBody, request.body);
    const places = await loadPlaces(app.db);
    const placeId = place === undefined ? undefined : resolvePlace(places, place);
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
        ...(placeId !== undefined ? { placeId } : {}),
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
      const existing = (await blocksBetween(tx, new Date(next.startAt.getTime() - NEIGHBOR_MS), new Date(next.endAt.getTime() + NEIGHBOR_MS))).filter(
        (row) => row.id !== id,
      );
      assertNoOverlap([next], existing, tz);
      assertSpacing([next], existing, places, planner, tz);
      await tx.update(plannerBlock).set(next).where(eq(plannerBlock.id, id));
      return presentOne(next, places);
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

  app.get("/planner/places", async () => {
    const places = await app.db.select().from(plannerPlace).orderBy(asc(plannerPlace.name));
    const names = new Map(places.map((place) => [place.id, place.name]));
    const travel = await app.db.select().from(plannerTravel);
    return {
      places: places.map(({ name, aliases, latitude, longitude }) => ({ name, aliases, latitude, longitude })),
      travel: travel.map((row) => ({ from: names.get(row.fromPlace)!, to: names.get(row.toPlace)!, minutes: row.minutes })),
    };
  });

  app.put("/planner/places", async (request) => {
    const body = parse(plannerPlaceBody, request.body);
    const values = { name: body.name, aliases: body.aliases ?? [], latitude: body.latitude, longitude: body.longitude };
    const [existing] = await app.db.select().from(plannerPlace).where(sql`lower(${plannerPlace.name}) = lower(${body.name})`);
    if (existing) {
      await app.db.update(plannerPlace).set(values).where(eq(plannerPlace.id, existing.id));
    } else {
      await app.db.insert(plannerPlace).values({ id: randomUUID(), ...values });
    }
    return values;
  });

  app.put("/planner/travel", async (request) => {
    const body = parse(plannerTravelBody, request.body);
    const places = await loadPlaces(app.db);
    const from = requirePlace(places, body.from);
    const to = requirePlace(places, body.to);
    await app.db
      .insert(plannerTravel)
      .values({ fromPlace: from.id, toPlace: to.id, minutes: body.minutes })
      .onConflictDoUpdate({ target: [plannerTravel.fromPlace, plannerTravel.toPlace], set: { minutes: body.minutes } });
    return { from: from.name, to: to.name, minutes: body.minutes };
  });
}

/** A row for a block body, written by `source` now. */
function newRow(block: z.infer<typeof plannerBlockBody>, source: string, placeId: string | null | undefined): Row {
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
    placeId: placeId ?? null,
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

/** Every place with its names and every stored travel time. */
async function loadPlaces(db: Pick<Db, "select">): Promise<Places> {
  const rows = await db.select().from(plannerPlace);
  const byId = new Map<string, Located>();
  const byName = new Map<string, Located>();
  for (const row of rows) {
    const place: Located = { id: row.id, name: row.name, latitude: row.latitude, longitude: row.longitude };
    byId.set(row.id, place);
    for (const name of [row.name, ...row.aliases]) {
      byName.set(name.toLowerCase(), place);
    }
  }
  const stored: TravelTable = new Map((await db.select().from(plannerTravel)).map((row) => [`${row.fromPlace}>${row.toPlace}`, row.minutes]));
  return { byId, byName, stored };
}

/** The place a name or alias stands for (any case). @throws A 422 `unknown_place` listing the known names. */
function requirePlace(places: Places, name: string): Located {
  const place = places.byName.get(name.toLowerCase());
  if (!place) {
    const known = [...places.byId.values()].map((p) => p.name).sort();
    throw new YaadError(
      422,
      "unknown_place",
      `no place named "${name}". Known places: ${known.length > 0 ? known.join(", ") : "none yet"}. Use one of them, or leave place out.`,
    );
  }
  return place;
}

/** The id of the named place; null for an explicit null or an absent name. @throws A 422 `unknown_place`. */
function resolvePlace(places: Places, name: string | null | undefined): string | null {
  return name === null || name === undefined ? null : requirePlace(places, name).id;
}

/** `row` as the API shape, naming its place and the travel from `previous`'s place when both have one. */
function presentRow(row: Row, previous: Row | undefined, places: Places, planner: Config["planner"]): PlannerBlock {
  const place = row.placeId === null ? undefined : places.byId.get(row.placeId);
  const before = previous?.placeId == null ? undefined : places.byId.get(previous.placeId);
  const travel = place !== undefined && before !== undefined && before.id !== place.id ? travelMinutes(before, place, places.stored, planner) : null;
  return toPlannerBlock(row, place?.name ?? null, travel);
}

/** Blocks in time order as the API shape, each with the travel from the block before it. */
function present(rows: Row[], places: Places, planner: Config["planner"]): PlannerBlock[] {
  return rows.map((row, i) => presentRow(row, rows[i - 1], places, planner));
}

/** One block as the API shape, with no previous block to travel from. */
function presentOne(row: Row, places: Places): PlannerBlock {
  return toPlannerBlock(row, row.placeId === null ? null : (places.byId.get(row.placeId)?.name ?? null), null);
}

/** "Wed 14:30" in the box's timezone. */
function clock(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("weekday")} ${get("hour")}:${get("minute")}`;
}

/**
 * @throws A 409 `overlap` naming every pair where one of `drafts` overlaps another draft or an
 * existing block and neither says `overlap_ok`.
 */
function assertNoOverlap(drafts: Draft[], existing: Draft[], tz: string): void {
  const clashes: string[] = [];
  const clash = (a: Draft, b: Draft) => {
    if (!a.overlapOk && !b.overlapOk && a.startAt < b.endAt && b.startAt < a.endAt) {
      clashes.push(`"${a.title}" (${clock(a.startAt, tz)} to ${clock(a.endAt, tz)}) overlaps "${b.title}" (${clock(b.startAt, tz)} to ${clock(b.endAt, tz)})`);
    }
  };
  drafts.forEach((draft, i) => {
    drafts.slice(i + 1).forEach((other) => clash(draft, other));
    existing.forEach((other) => clash(draft, other));
  });
  if (clashes.length > 0) {
    throw new YaadError(409, "overlap", `${clashes.join("; ")}. Times are ${tz}. Fix the times or set overlap_ok.`);
  }
}

/**
 * @throws A 409 `spacing` for every pair of consecutive blocks, one of them in `drafts`, that
 * leaves less than the planner needs: the stretch minimum, or the travel plus the buffer when
 * both have a place and the places differ. The message says the earliest the later block can start.
 */
function assertSpacing(drafts: Row[], existing: Row[], places: Places, planner: Config["planner"], tz: string): void {
  const draftIds = new Set(drafts.map((draft) => draft.id));
  const all = [...existing.filter((row) => !draftIds.has(row.id)), ...drafts].sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime(),
  );
  const tooClose: string[] = [];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i]!;
    const b = all[i + 1]!;
    if ((!draftIds.has(a.id) && !draftIds.has(b.id)) || a.overlapOk || b.overlapOk || a.endAt > b.startAt) {
      continue;
    }
    const fromPlace = a.placeId === null ? null : (places.byId.get(a.placeId) ?? null);
    const toPlace = b.placeId === null ? null : (places.byId.get(b.placeId) ?? null);
    const need = requiredGap(fromPlace, toPlace, places.stored, planner);
    const gap = Math.round((b.startAt.getTime() - a.endAt.getTime()) / 60_000);
    if (gap < need.minutes) {
      const earliest = new Date(a.endAt.getTime() + need.minutes * 60_000);
      const why =
        need.travel !== null
          ? `the trip from ${fromPlace!.name} to ${toPlace!.name} is ${need.travel} min plus a ${planner.travel_buffer_min} min buffer`
          : `leave at least ${planner.stretch_min} min between tasks`;
      tooClose.push(`"${b.title}" starts ${gap} min after "${a.title}" ends, but ${why}, so it can start at ${clock(earliest, tz)} at the earliest`);
    }
  }
  if (tooClose.length > 0) {
    throw new YaadError(409, "spacing", `${tooClose.join("; ")}. Times are ${tz}. Move the block, or set overlap_ok on one of the pair.`);
  }
}

function notFound(id: string): YaadError {
  return new YaadError(404, "not_found", `planner block ${id} not found`);
}
