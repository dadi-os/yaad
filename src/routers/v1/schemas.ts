import { z, type ZodError, type ZodType } from "zod";
import { YaadError } from "../../errors.js";

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new YaadError(422, "invalid_request", formatZod(parsed.error));
  }
  return parsed.data;
}

export function formatZod(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const loc = issue.path.join(".");
      return loc ? `${loc}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

const source = z.enum(["manual", "agent", "ingest"]);
const kind = z.enum(["person", "memory", "plan"]);
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

export const patchPersonDetailBody = personDetailBody.partial();

export const patchPlanDetailBody = z
  .object({
    end_at: z.string().datetime({ offset: true }).nullable().optional(),
    status: planStatus.optional(),
    recurrence: z.string().nullable().optional(),
  })
  .strict();

export const createNodeBody = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("person"),
      title: z.string().min(1),
      body: z.string().nullable().optional(),
      occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
      source,
      detail: personDetailBody,
    })
    .strict(),
  z
    .object({
      kind: z.literal("memory"),
      title: z.string().min(1),
      body: z.string().nullable().optional(),
      occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
      source,
    })
    .strict(),
  z
    .object({
      kind: z.literal("plan"),
      title: z.string().min(1),
      body: z.string().nullable().optional(),
      occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
      source,
      detail: planDetailBody,
    })
    .strict(),
]);

export const patchNodeBody = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
    source: source.optional(),
    detail: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field is required",
  });

export const createEdgeBody = z
  .object({
    src_id: z.string().uuid(),
    dst_id: z.string().uuid(),
    type: z.string().min(1),
    properties: z.record(z.unknown()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const searchBody = z
  .object({
    query: z.string().min(1),
    kind: kind.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const idParam = z.object({ id: z.string().uuid() }).strict();

export const asOfQuery = z
  .object({
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const ingestBody = z
  .object({
    text: z.string().min(1),
    occurred_at: z.string().datetime({ offset: true }),
    participant_ids: z.array(z.string().uuid()).optional(),
    source: z.enum(["agent", "ingest"]),
  })
  .strict();

export const recallBody = z
  .object({
    query: z.string().min(1),
    limit: z.number().int().positive().optional(),
    as_of: z.string().datetime({ offset: true }).optional(),
    debug: z.boolean().optional(),
  })
  .strict();

export const timelineQuery = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    status: planStatus.optional(),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
