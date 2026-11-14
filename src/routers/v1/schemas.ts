/** Request body / param zod schemas and parse helpers for `/v1` routes. */

import { z, type ZodError, type ZodType } from "zod";
import { YaadError } from "../../errors.js";
import { RSVPS, TIMELINE_VIEWS } from "../../types/timeline.js";

/** Parse with zod; map failures to `422 invalid_request`. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new YaadError(422, "invalid_request", formatZod(parsed.error));
  }
  return parsed.data;
}

/** Flatten zod issues into a single semicolon-joined message. */
export function formatZod(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const loc = issue.path.join(".");
      return loc ? `${loc}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export const personDetailBody = z
  .object({
    birthday: z.string().date().nullable().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .strict();

const instant = z.string().datetime({ offset: true });

/** An IANA zone the runtime knows, such as `America/Chicago`. */
const timeZone = z
  .string()
  .refine((zone) => Intl.supportedValuesOf("timeZone").includes(zone), "time_zone must be an IANA time zone");

/** What a plan's detail carries besides its end, all-day flag. */
const planOptionalFields = {
  time_zone: timeZone.nullable().optional(),
  rsvp: z.enum(RSVPS).nullable().optional(),
  attended: z.boolean().nullable().optional(),
};

/**
 * A plan's detail on create. `all_day: true` means a date without a time of day (Yaad
 * anchors it at local midnight); absent or false means a timed plan.
 */
export const planDetailBody = z
  .object({
    end_at: instant.nullable().optional(),
    all_day: z.boolean().optional(),
    ...planOptionalFields,
  })
  .strict();

/**
 * A task's detail: relevant from `opens_on` until `closes_at`, with neither it is Someday, and a
 * close needs an open. `done` says whether it is done; it is set like any other field, and
 * a create that does not state it is not done.
 */
export const taskDetailBody = z
  .object({
    opens_on: z.string().date().nullable().optional(),
    closes_at: instant.nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();

export const placeDetailBody = z
  .object({
    address: z.string().nullable().optional(),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
  })
  .strict();

export const patchPersonDetailBody = personDetailBody.partial();

export const patchPlanDetailBody = z
  .object({
    end_at: instant.nullable().optional(),
    all_day: z.boolean().optional(),
    ...planOptionalFields,
  })
  .strict();

export const patchTaskDetailBody = taskDetailBody;

export const patchPlaceDetailBody = placeDetailBody.partial();

export const idParam = z.object({ id: z.string().uuid() }).strict();

/**
 * `PATCH /nodes/:id` — a hand edit. `detail` is checked against the node's kind;
 * `ttl_days` (memory, plan and task) restarts expiry from now, and null clears it.
 */
export const patchNodeBody = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
    ttl_days: z.number().int().positive().nullable().optional(),
    detail: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "at least one field is required");

/** `POST /nodes` — a node made by hand; `detail` is checked against `kind` as on ingest. */
export const createNodeBody = z
  .object({
    kind: z.enum(["person", "memory", "plan", "place", "task"]),
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
    ttl_days: z.number().int().positive().nullable().optional(),
    detail: z.record(z.unknown()).optional(),
  })
  .strict();

/** `POST /edges` — an edge drawn by hand between two current nodes. */
export const createEdgeBody = z
  .object({
    src_id: z.string().uuid(),
    dst_id: z.string().uuid(),
    type: z.string().regex(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/, "type must be UPPER_SNAKE_CASE"),
    properties: z.record(z.unknown()).optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const ingestFields = {
  text: z.string().min(1),
  /** Ankur's own words, verbatim: what lets a task that closed before the text be stored when he states its date. Omit when there are none. */
  source_text: z.string().min(1).optional(),
  occurred_at: z.string().datetime({ offset: true }),
  participant_ids: z.array(z.string().uuid()).optional(),
};

/** `source: "agent"` names the writing Hath agent; `source: "ingest"` carries no agent. */
export const ingestBody = z.discriminatedUnion("source", [
  z
    .object({
      ...ingestFields,
      source: z.literal("agent"),
      agent_id: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "agent_id must be kebab-case"),
    })
    .strict(),
  z.object({ ...ingestFields, source: z.literal("ingest") }).strict(),
]);

export const historySearchBody = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const nodeFilterFields = {
  kind: z.enum(["person", "memory", "plan", "place", "task"]).optional(),
  name: z.string().min(1).optional(),
  occurred_from: z.string().datetime({ offset: true }).optional(),
  occurred_to: z.string().datetime({ offset: true }).optional(),
  relevant_on: z.string().date().optional(),
  hub: z.string().min(1).optional(),
  closes_from: z.string().date().optional(),
  closes_to: z.string().date().optional(),
};

export const queryBody = z
  .object({
    ...nodeFilterFields,
    limit: z.number().int().positive().optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * Anchors come from `from`, else the filters, else ANN on `query`. `hops` fixes the
 * expansion depth; omitted, expansion is gated when `query` is set and 0 otherwise.
 */
export const recallBody = z
  .object({
    query: z.string().min(1).optional(),
    from: z.array(z.string().uuid()).min(1).optional(),
    hops: z.number().int().min(0).optional(),
    ...nodeFilterFields,
    limit: z.number().int().positive().optional(),
    debug: z.boolean().optional(),
  })
  .strict();

export const graphBody = z
  .object({
    seed_ids: z.array(z.string().uuid()).min(1).optional(),
  })
  .strict();

/** `POST /timeline` — plans in `[from, to)` through one view's filter. */
export const timelineBody = z
  .object({ from: instant, to: instant, view: z.enum(TIMELINE_VIEWS) })
  .strict()
  .refine((body) => Date.parse(body.from) < Date.parse(body.to), "from must be before to");

/** `PUT /timeline/attended` — Ankur says whether he was at one plan (true or false), or takes the mark back (null). */
export const attendedBody = z
  .object({ plan_id: z.string().uuid(), attended: z.boolean().nullable() })
  .strict();

/** `PUT /timeline/rsvp` — Ankur says whether he is going to one plan, or clears the answer (null). */
export const rsvpBody = z
  .object({ plan_id: z.string().uuid(), rsvp: z.enum(RSVPS).nullable() })
  .strict();

/** `POST /tasks` — the tasks one local day shows (`on`), or the ones with no window (`someday`). */
export const tasksBody = z
  .object({ on: z.string().date().optional(), someday: z.literal(true).optional() })
  .strict()
  .refine((body) => (body.on === undefined) !== (body.someday === undefined), "send exactly one of on or someday");

/** `POST /tasks/verify` — Ankur's agent restates these tasks as still true, with no extraction. */
export const tasksVerifyBody = z.object({ node_ids: z.array(z.string().uuid()).min(1) }).strict();

/** `PUT /tasks/done` — Ankur marks one task done (`done: true`) or not done (`done: false`). */
export const taskDoneBody = z.object({ task_id: z.string().uuid(), done: z.boolean() }).strict();
