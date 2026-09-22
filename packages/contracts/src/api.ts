import { z } from "zod";

import { eventSeveritySchema, eventTypeSchema, runEventSchema } from "./events.js";
import {
  runSchema,
  runStatusSchema,
  runSummarySchema,
  taskIdSchema,
  taskInputSchema,
  workflowIdSchema,
} from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Run Operation Request & Response Contracts
// ─────────────────────────────────────────────────────────────────────────────

export const createRunTaskDefinitionSchema = z.object({
  id: taskIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  dependencies: z.array(taskIdSchema).optional(),
  input: taskInputSchema.optional(),
});
export type CreateRunTaskDefinition = z.infer<typeof createRunTaskDefinitionSchema>;

export const createRunRequestSchema = z.object({
  goal: z.string().trim().min(3, "Goal must be at least 3 characters").max(1000, "Goal must not exceed 1000 characters"),
  workflowTemplateId: workflowIdSchema.optional(),
  parameters: z.record(z.unknown()).optional(),
  tasks: z.array(createRunTaskDefinitionSchema).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const createRunResponseSchema = z.object({
  run: runSchema,
});
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

export const getRunResponseSchema = z.object({
  run: runSchema,
});
export type GetRunResponse = z.infer<typeof getRunResponseSchema>;

export const listRunsQuerySchema = z.object({
  status: runStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  query: z.string().trim().optional(),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const listRunsResponseSchema = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().optional(),
  totalCount: z.number().int().nonnegative().optional(),
});
export type ListRunsResponse = z.infer<typeof listRunsResponseSchema>;

export const cancelRunRequestSchema = z.object({
  reason: z.string().trim().max(500, "Reason must not exceed 500 characters").optional(),
});
export type CancelRunRequest = z.infer<typeof cancelRunRequestSchema>;

export const cancelRunResponseSchema = z.object({
  run: runSchema,
});
export type CancelRunResponse = z.infer<typeof cancelRunResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Event Operation Request & Response Contracts
// ─────────────────────────────────────────────────────────────────────────────

export const getRunEventsQuerySchema = z.object({
  severity: eventSeveritySchema.optional(),
  type: eventTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type GetRunEventsQuery = z.infer<typeof getRunEventsQuerySchema>;

export const getRunEventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  nextCursor: z.string().optional(),
});
export type GetRunEventsResponse = z.infer<typeof getRunEventsResponseSchema>;
