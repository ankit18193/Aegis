import type { Result } from "@aegis/types";
import { z } from "zod";

import { eventIdSchema, runIdSchema, taskIdSchema, workerIdSchema } from "./runs.js";
import { assignmentIdSchema, type TaskAssignment } from "./taskAssignment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Execution Context Contract
// ─────────────────────────────────────────────────────────────────────────────

export const taskExecutionContextSchema = z.object({
  workerId: workerIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  assignmentId: assignmentIdSchema,
  startedAt: z.string().datetime(),
});
export type TaskExecutionContext = z.infer<typeof taskExecutionContextSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Execution Result Status & Errors
// ─────────────────────────────────────────────────────────────────────────────

export const taskResultStatusSchema = z.enum(["SUCCEEDED", "FAILED"]);
export type TaskResultStatus = z.infer<typeof taskResultStatusSchema>;

export const TaskResultStatusValue = {
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
} as const;

export const taskExecutionErrorCodeSchema = z.enum([
  "TASK_EXECUTION_FAILED",
  "TASK_EXECUTION_TIMEOUT",
  "TASK_RUNTIME_ERROR",
  "TASK_RESULT_SERIALIZATION_FAILED",
  "TASK_RESULT_PUBLICATION_FAILED",
]);
export type TaskExecutionErrorCode = z.infer<typeof taskExecutionErrorCodeSchema>;

export const taskExecutionErrorSchema = z.object({
  code: taskExecutionErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
  stack: z.string().optional(),
});
export type TaskExecutionError = z.infer<typeof taskExecutionErrorSchema>;

export function createTaskExecutionError(
  code: TaskExecutionErrorCode,
  message: string,
  details?: unknown,
  stack?: string,
): TaskExecutionError {
  return {
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    ...(stack !== undefined ? { stack } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Task Execution Result Contract
// ─────────────────────────────────────────────────────────────────────────────

export const taskExecutionResultSchema = z.object({
  taskId: taskIdSchema,
  runId: runIdSchema,
  assignmentId: assignmentIdSchema,
  workerId: workerIdSchema,
  status: taskResultStatusSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  output: z.unknown().optional(),
  error: taskExecutionErrorSchema.optional(),
});
export type TaskExecutionResult = z.infer<typeof taskExecutionResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Task Result Transport Envelope (CloudEvents compliant on aegis.tasks.results)
// ─────────────────────────────────────────────────────────────────────────────

export const taskResultEnvelopeSchema = z.object({
  id: eventIdSchema,
  type: z.literal("task_result"),
  source: z.string().min(1),
  specVersion: z.literal("1.0"),
  time: z.string().datetime(),
  aggregateId: taskIdSchema,
  aggregateType: z.literal("TaskResult"),
  correlationId: z.string().min(1),
  causationId: z.string().optional(),
  data: taskExecutionResultSchema,
});
export type TaskResultEnvelope = z.infer<typeof taskResultEnvelopeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Execution & Result Publisher Interfaces
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transport-independent contract for worker-side task execution.
 * Owns execution orchestration without leaking broker or distributed concerns.
 */
export interface ITaskExecutor {
  execute(
    assignment: TaskAssignment,
    context: TaskExecutionContext,
  ): Promise<TaskExecutionResult>;
}

/**
 * Contract for publishing canonical task execution results.
 * Decouples the executor from the Kafka transport layer.
 */
export interface ITaskResultPublisher {
  publish(
    result: TaskExecutionResult,
    metadata?: { readonly correlationId?: string; readonly causationId?: string },
  ): Promise<Result<TaskResultEnvelope, TaskExecutionError>>;
}
