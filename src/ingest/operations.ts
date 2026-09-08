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

/** Hand-written JSON Schema shown to Dwar for `emit_operations`. */
export const emitOperationsToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op"],
        properties: {
          op: {
            type: "string",
            enum: ["create_node", "update_node", "close_node", "create_edge", "close_edge", "noop"],
          },
          temp_id: { type: "string" },
          kind: { type: "string", enum: ["person", "memory", "plan", "place"] },
          title: { type: "string" },
          body: { type: ["string", "null"] },
          occurred_at: { type: ["string", "null"] },
          ttl_days: { type: ["integer", "null"], minimum: 1 },
          detail: { type: "object" },
          node_id: { type: "string" },
          reason: { type: "string" },
          src: { type: "string" },
          dst: { type: "string" },
          type: { type: "string" },
          properties: { type: "object" },
          confidence: { type: "number" },
          edge_id: { type: "string" },
        },
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
