/** Zod shapes and JSON Schema for Dwar `emit_operations` tool calls. */

import { z } from "zod";
import {
  personDetailBody,
  planDetailBody,
  placeDetailBody,
  patchPersonDetailBody,
  patchPlanDetailBody,
  patchPlaceDetailBody,
} from "../routers/v1/schemas.js";

const ttlDays = z.number().int().positive().nullable().optional();

const createNodeOp = z
  .object({
    op: z.literal("create_node"),
    temp_id: z.string().min(1),
    kind: z.enum(["person", "memory", "plan", "place"]),
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

const closeNodeOp = z
  .object({
    op: z.literal("close_node"),
    node_id: z.string().uuid(),
    reason: z.string().min(1),
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

const noopOp = z
  .object({
    op: z.literal("noop"),
    reason: z.string().min(1),
  })
  .strict();

/** One memory mutation emitted by extraction (create/update/close node or edge, or noop). */
export const operationSchema = z.discriminatedUnion("op", [
  createNodeOp,
  updateNodeOp,
  closeNodeOp,
  createEdgeOp,
  closeEdgeOp,
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

const nullableString = { type: ["string", "null"] } as const;

/**
 * Hand-written JSON Schema shown to Dwar for `emit_operations`. One strict variant per op,
 * mirroring the zod shapes above, so the model is only offered keys Yaad accepts for that op.
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
            properties: {
              op: { const: "create_node" },
              temp_id: { type: "string" },
              kind: { type: "string", enum: ["person", "memory", "plan", "place"] },
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
            required: ["op", "node_id", "reason"],
            properties: {
              op: { const: "close_node" },
              node_id: { type: "string" },
              reason: { type: "string" },
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
            required: ["op", "reason"],
            properties: {
              op: { const: "noop" },
              reason: { type: "string" },
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
};
