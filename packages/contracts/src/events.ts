import { z } from "zod";

import { eventIdSchema, runIdSchema, taskIdSchema, workerIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Event Types and Severity Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const eventTypeSchema = z.enum([
  "run_created",
  "workflow_started",
  "task_scheduled",
  "task_started",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "tool_invoked",
  "run_completed",
  "run_failed",
  "run_cancelled",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventSeveritySchema = z.enum(["info", "warn", "error", "success"]);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Run Event Contract
// ─────────────────────────────────────────────────────────────────────────────

export const runEventSchema = z.object({
  id: eventIdSchema,
  runId: runIdSchema,
  type: eventTypeSchema,
  severity: eventSeveritySchema,
  timestamp: z.string(),
  message: z.string().min(1),
  taskId: taskIdSchema.optional(),
  taskName: z.string().optional(),
  worker: workerIdSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;
