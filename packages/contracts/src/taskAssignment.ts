import type { AssignmentId, RunId, TaskId, WorkerId } from "@aegis/types";
import { z } from "zod";

import { eventIdSchema, runIdSchema, taskIdSchema, taskSchema, workerIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Assignment Branded Identifier & Status Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const assignmentIdSchema = z.string().min(1) as unknown as z.ZodType<AssignmentId>;

export const assignmentStatusSchema = z.enum([
  "received",
  "accepted",
  "rejected",
  "ignored_not_targeted",
]);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

export const AssignmentStatusValue = {
  RECEIVED: "received",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  IGNORED_NOT_TARGETED: "ignored_not_targeted",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Task Assignment Canonical Payload
// ─────────────────────────────────────────────────────────────────────────────

export const taskAssignmentSchema = z.object({
  assignmentId: assignmentIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  workerId: workerIdSchema.optional(),
  task: taskSchema,
  assignedAt: z.string().datetime(),
});
export type TaskAssignment = z.infer<typeof taskAssignmentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Task Assignment Transport Envelope (CloudEvents compliant on aegis.tasks.assign)
// ─────────────────────────────────────────────────────────────────────────────

export const taskAssignmentEnvelopeSchema = z.object({
  id: eventIdSchema,
  type: z.literal("task_assigned"),
  source: z.string().min(1),
  specVersion: z.literal("1.0"),
  time: z.string().datetime(),
  aggregateId: taskIdSchema,
  aggregateType: z.literal("TaskAssignment"),
  correlationId: z.string().min(1),
  causationId: z.string().optional(),
  data: taskAssignmentSchema,
});
export type TaskAssignmentEnvelope = z.infer<typeof taskAssignmentEnvelopeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Assignment Error Contracts & Codes
// ─────────────────────────────────────────────────────────────────────────────

export const assignmentErrorCodeSchema = z.enum([
  "ASSIGNMENT_DESERIALIZATION_FAILED",
  "INVALID_ASSIGNMENT_ENVELOPE",
  "ASSIGNMENT_TARGET_MISMATCH",
  "ASSIGNMENT_CAPABILITY_MISMATCH",
  "DUPLICATE_ASSIGNMENT",
  "CONSUMER_NOT_CONNECTED",
  "HANDLER_EXECUTION_FAILED",
]);
export type AssignmentErrorCode = z.infer<typeof assignmentErrorCodeSchema>;

export interface AssignmentErrorContract {
  readonly code: AssignmentErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export function createAssignmentError(
  code: AssignmentErrorCode,
  message: string,
  cause?: unknown,
): AssignmentErrorContract {
  return { code, message, cause };
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Assignment Decision Outcome (Phase 11B)
// ─────────────────────────────────────────────────────────────────────────────

export interface AssignmentDecisionContract {
  readonly status: AssignmentStatus;
  readonly assignmentId: AssignmentId;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly workerId?: WorkerId | undefined;
  readonly reason?: string | undefined;
}
