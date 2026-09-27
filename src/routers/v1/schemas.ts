/** Request body / param zod schemas and parse helpers for `/v1` routes. */

import { z, type ZodError, type ZodType } from "zod";
import { YaadError } from "../../errors.js";

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

const planStatus = z.enum(["idea", "tentative", "confirmed"]);

export const personDetailBody = z
  .object({
    birthday: z.string().date().nullable().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .strict();

export const planDetailBody = z
  .object({
    end_at: z.string().datetime({ offset: true }).nullable().optional(),
    status: planStatus,
    recurrence: z.string().nullable().optional(),
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
    end_at: z.string().datetime({ offset: true }).nullable().optional(),
    status: planStatus.optional(),
    recurrence: z.string().nullable().optional(),
  })
  .strict();

export const patchPlaceDetailBody = placeDetailBody.partial();

export const idParam = z.object({ id: z.string().uuid() }).strict();

const ingestFields = {
  text: z.string().min(1),
  occurred_at: z.string().datetime({ offset: true }),
  participant_ids: z.array(z.string().uuid()).optional(),
};

/** `source: "agent"` names the writing Dimaag agent; `source: "ingest"` carries no agent. */
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
  kind: z.enum(["person", "memory", "plan", "place"]).optional(),
  name: z.string().min(1).optional(),
  occurred_from: z.string().datetime({ offset: true }).optional(),
  occurred_to: z.string().datetime({ offset: true }).optional(),
  status: planStatus.optional(),
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
    limit: z.number().int().positive().optional(),
  })
  .strict();
