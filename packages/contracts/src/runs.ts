import type { RunId, TaskId, WorkflowId, WorkerId, EventId } from "@aegis/types";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Branded Identifier Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const runIdSchema = z.string().min(1) as unknown as z.ZodType<RunId>;
export const taskIdSchema = z.string().min(1) as unknown as z.ZodType<TaskId>;
export const workflowIdSchema = z.string().min(1) as unknown as z.ZodType<WorkflowId>;
export const workerIdSchema = z.string().min(1) as unknown as z.ZodType<WorkerId>;
export const eventIdSchema = z.string().min(1) as unknown as z.ZodType<EventId>;

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Statuses and Transition State Machines
// ─────────────────────────────────────────────────────────────────────────────

export const runStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const taskStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "retrying",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Valid state transitions for an Execution Run lifecycle.
 * Terminal states (completed, failed, cancelled) have no outgoing transitions.
 */
export const VALID_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  pending: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Valid state transitions for an individual Task lifecycle.
 * Terminal states (completed, failed, cancelled) have no outgoing transitions.
 */
export const VALID_TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["completed", "failed", "retrying", "cancelled"],
  retrying: ["queued", "running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Validates whether a proposed transition from one RunStatus to another is legal.
 */
export function isValidRunTransition(from: RunStatus, to: RunStatus): boolean {
  return VALID_RUN_TRANSITIONS[from].includes(to);
}

/**
 * Validates whether a proposed transition from one TaskStatus to another is legal.
 */
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TASK_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Task & Workflow Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const taskSchema = z.object({
  id: taskIdSchema,
  name: z.string().min(1),
  status: taskStatusSchema,
  description: z.string().default(""),
  worker: workerIdSchema.optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  attemptCount: z.number().int().min(0).default(0),
  output: z.string().optional(),
  error: z.string().optional(),
  dependencies: z.array(taskIdSchema).optional(),
});
export type Task = z.infer<typeof taskSchema>;

export const workflowSchema = z.object({
  id: workflowIdSchema,
  name: z.string().min(1),
  tasks: z.array(taskSchema).default([]),
});
export type Workflow = z.infer<typeof workflowSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Run Result & Artifact Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const runResultArtifactSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type RunResultArtifact = z.infer<typeof runResultArtifactSchema>;

export const runMetricsSchema = z.object({
  durationMs: z.number().nonnegative(),
  tasksTotal: z.number().int().nonnegative(),
  tasksCompleted: z.number().int().nonnegative(),
  toolInvocations: z.number().int().nonnegative(),
});
export type RunMetrics = z.infer<typeof runMetricsSchema>;

export const runResultSchema = z.object({
  summary: z.string(),
  reportMarkdown: z.string().optional(),
  metrics: runMetricsSchema.optional(),
  artifacts: z.array(runResultArtifactSchema).optional(),
});
export type RunResult = z.infer<typeof runResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Run & RunSummary Aggregate Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const runSchema = z.object({
  id: runIdSchema,
  goal: z.string().min(1),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: z.number().min(0).max(100),
  workflow: workflowSchema,
  tasks: z.array(taskSchema),
  result: runResultSchema.optional(),
});
export type Run = z.infer<typeof runSchema>;

/**
 * Lightweight Run summary projection for high-volume list and query endpoints.
 * Omits workflow, full task array, and run results to prevent over-fetching.
 */
export const runSummarySchema = z.object({
  id: runIdSchema,
  goal: z.string().min(1),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: z.number().min(0).max(100),
  totalTasks: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;
