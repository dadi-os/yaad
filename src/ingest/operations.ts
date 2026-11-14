/** Zod shapes and JSON Schema for Dwar `emit_operations` tool calls. */

import { z } from "zod";
import { OUTCOMES, PLAN_STATUSES, RSVPS } from "../types/timeline.js";
import {
  personDetailBody,
  planDetailBody,
  placeDetailBody,
  patchPersonDetailBody,
  patchPlanDetailBody,
  patchPlaceDetailBody,
  patchTaskDetailBody,
  taskDetailBody,
} from "../routers/v1/schemas.js";

const ttlDays = z.number().int().positive().nullable().optional();

const createNodeOp = z
  .object({
    op: z.literal("create_node"),
    temp_id: z.string().min(1),
    kind: z.enum(["person", "memory", "plan", "place", "task"]),
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
    ttl_days: ttlDays,
    detail: z.unknown().optional(),
  })
  .strict();

const updateNodeOp = z
  .object({
    op: z.literal("update_node"),
    node_id: z.string().uuid(),
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
    ttl_days: ttlDays,
    detail: z.unknown().optional(),
  })
  .strict();

/** `evidence` quotes the utterance words that retract or contradict the node; Yaad checks the quote. */
const closeNodeOp = z
  .object({
    op: z.literal("close_node"),
    node_id: z.string().uuid(),
    reason: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict();

const createEdgeOp = z
  .object({
    op: z.literal("create_edge"),
    src: z.string().min(1),
    dst: z.string().min(1),
    type: z.string().min(1),
    properties: z.record(z.unknown()).optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const closeEdgeOp = z
  .object({
    op: z.literal("close_edge"),
    edge_id: z.string().uuid(),
    reason: z.string().min(1),
  })
  .strict();

const instant = z.string().datetime({ offset: true });

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a local time as HH:MM");

/**
 * Stamps out one plan per date from a template: the same title, body, local start and end times,
 * status, RSVP and place on every date. Each plan is a plain stored plan with no rule, linked
 * to `hub` (a course) by `HAS_SESSION` and to `place` by `AT_LOCATION` with `room`. `hub` and
 * `place` are node ids or temp_ids of nodes created earlier in the batch; `temp_id` names the
 * group so the result can return the new ids.
 */
const spawnPlansOp = z
  .object({
    op: z.literal("spawn_plans"),
    temp_id: z.string().min(1),
    hub: z.string().min(1),
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    dates: z.array(z.string().date()).min(1),
    start_time: localTime,
    end_time: localTime.optional(),
    time_zone: z.string().min(1).optional(),
    status: z.enum(PLAN_STATUSES),
    rsvp: z.enum(RSVPS).optional(),
    place: z.string().min(1).optional(),
    room: z.string().min(1).optional(),
  })
  .strict();

/** What `update_plans` changes on every matched session; at least one field. */
const sessionChange = z
  .object({
    body: z.string().nullable().optional(),
    status: z.enum(PLAN_STATUSES).optional(),
    rsvp: z.enum(RSVPS).nullable().optional(),
    outcome: z.enum(OUTCOMES).nullable().optional(),
    start_time: localTime.optional(),
    end_time: localTime.nullable().optional(),
    room: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((change) => Object.keys(change).length > 0, "change at least one field");

/**
 * Changes every session of `hub` (a course) on or after `from_date`, up to `to_date` when given:
 * the way to move a class's time, change its room, or cancel the rest of the term in one op, and,
 * with `to_date` equal to `from_date`, to change or mark one session, which extraction never sees as
 * a candidate. Dates are local. A change that matches no session is an error.
 */
const updatePlansOp = z
  .object({
    op: z.literal("update_plans"),
    hub: z.string().uuid(),
    from_date: z.string().date(),
    to_date: z.string().date().optional(),
    set: sessionChange,
  })
  .strict();

const noopOp = z
  .object({
    op: z.literal("noop"),
    reason: z.string().min(1),
    /** Open tasks the text restates exactly as stored: each gets `verified_at` touched and nothing else. */
    node_ids: z.array(z.string().uuid()).min(1).optional(),
  })
  .strict();

/** One memory mutation emitted by extraction (create/update/close node or edge, spawn or change sessions, or noop). */
export const operationSchema = z.discriminatedUnion("op", [
  createNodeOp,
  updateNodeOp,
  closeNodeOp,
  createEdgeOp,
  closeEdgeOp,
  spawnPlansOp,
  updatePlansOp,
  noopOp,
]);

/** Wrapper zod schema for the emit_operations tool input. */
export const emitOperationsInput = z
  .object({
    operations: z.array(operationSchema).min(1),
  })
  .strict();

export type Operation = z.infer<typeof operationSchema>;
export type CreateNodeOp = z.infer<typeof createNodeOp>;
export type UpdateNodeOp = z.infer<typeof updateNodeOp>;
export type SpawnPlansOp = z.infer<typeof spawnPlansOp>;
export type UpdatePlansOp = z.infer<typeof updatePlansOp>;

const nullableString = { type: ["string", "null"] } as const;

const createNodeCommon = {
  op: { const: "create_node" },
  temp_id: { type: "string" },
  title: { type: "string" },
  body: nullableString,
  occurred_at: nullableString,
  ttl_days: { type: ["integer", "null"], minimum: 1 },
} as const;

/**
 * Hand-written JSON Schema shown to Dwar for `emit_operations`. One strict variant per op,
 * and per kind for `create_node`, mirroring the zod shapes above, so the model is only offered
 * keys Yaad accepts for that op (a memory is never offered `detail`).
 */
export const emitOperationsToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "temp_id", "kind", "title"],
            properties: { ...createNodeCommon, kind: { const: "memory" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "temp_id", "kind", "title"],
            properties: {
              ...createNodeCommon,
              kind: { const: "person" },
              detail: {
                type: "object",
                additionalProperties: false,
                properties: {
                  birthday: nullableString,
                  aliases: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "temp_id", "kind", "title", "detail"],
            properties: {
              ...createNodeCommon,
              kind: { const: "plan" },
              detail: {
                type: "object",
                additionalProperties: false,
                required: ["status"],
                properties: {
                  end_at: nullableString,
                  all_day: { type: "boolean" },
                  status: { type: "string", enum: [...PLAN_STATUSES] },
                  time_zone: nullableString,
                  rsvp: { type: ["string", "null"], enum: [...RSVPS, null] },
                  outcome: { type: ["string", "null"], enum: [...OUTCOMES, null] },
                  actual_start: nullableString,
                  actual_end: nullableString,
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "temp_id", "kind", "title"],
            properties: {
              ...createNodeCommon,
              kind: { const: "task" },
              detail: {
                type: "object",
                additionalProperties: false,
                properties: {
                  opens_on: nullableString,
                  closes_at: nullableString,
                  done_at: nullableString,
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "temp_id", "kind", "title"],
            properties: {
              ...createNodeCommon,
              kind: { const: "place" },
              detail: {
                type: "object",
                additionalProperties: false,
                properties: {
                  address: nullableString,
                  latitude: { type: ["number", "null"] },
                  longitude: { type: ["number", "null"] },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "node_id"],
            properties: {
              op: { const: "update_node" },
              node_id: { type: "string" },
              title: { type: "string" },
              body: nullableString,
              occurred_at: nullableString,
              ttl_days: { type: ["integer", "null"], minimum: 1 },
              detail: { type: "object" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "node_id", "reason", "evidence"],
            properties: {
              op: { const: "close_node" },
              node_id: { type: "string" },
              reason: { type: "string" },
              evidence: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "src", "dst", "type", "confidence"],
            properties: {
              op: { const: "create_edge" },
              src: { type: "string" },
              dst: { type: "string" },
              type: { type: "string" },
              properties: { type: "object" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "edge_id", "reason"],
            properties: {
              op: { const: "close_edge" },
              edge_id: { type: "string" },
              reason: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "temp_id", "hub", "title", "dates", "start_time", "status"],
            properties: {
              op: { const: "spawn_plans" },
              temp_id: { type: "string" },
              hub: { type: "string" },
              title: { type: "string" },
              body: nullableString,
              dates: { type: "array", minItems: 1, items: { type: "string" } },
              start_time: { type: "string" },
              end_time: { type: "string" },
              time_zone: { type: "string" },
              status: { type: "string", enum: [...PLAN_STATUSES] },
              rsvp: { type: "string", enum: [...RSVPS] },
              place: { type: "string" },
              room: { type: "string" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "hub", "from_date", "set"],
            properties: {
              op: { const: "update_plans" },
              hub: { type: "string" },
              from_date: { type: "string" },
              to_date: { type: "string" },
              set: {
                type: "object",
                additionalProperties: false,
                properties: {
                  body: nullableString,
                  status: { type: "string", enum: [...PLAN_STATUSES] },
                  rsvp: { type: ["string", "null"], enum: [...RSVPS, null] },
                  outcome: { type: ["string", "null"], enum: [...OUTCOMES, null] },
                  start_time: { type: "string" },
                  end_time: nullableString,
                  room: nullableString,
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["op", "reason"],
            properties: {
              op: { const: "noop" },
              reason: { type: "string" },
              node_ids: { type: "array", items: { type: "string" } },
            },
          },
        ],
      },
    },
  },
} as const;

export {
  personDetailBody,
  planDetailBody,
  placeDetailBody,
  patchPersonDetailBody,
  patchPlanDetailBody,
  patchPlaceDetailBody,
  patchTaskDetailBody,
  taskDetailBody,
};
