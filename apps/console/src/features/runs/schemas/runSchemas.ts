import { z } from "zod";

export const runStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const taskStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "retrying",
  "cancelled",
]);

export const createRunInputSchema = z.object({
  goal: z
    .string()
    .trim()
    .min(3, "Goal must be at least 3 characters long")
    .max(1000, "Goal must not exceed 1000 characters"),
});

export type CreateRunInput = z.infer<typeof createRunInputSchema>;

export const taskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: taskStatusSchema,
  description: z.string(),
  worker: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  attemptCount: z.number().int().nonnegative(),
  output: z.string().optional(),
  error: z.string().optional(),
});

export const workflowSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  tasks: z.array(taskSummarySchema),
});

export const runResultArtifactSchema = z.object({
  name: z.string(),
  type: z.string(),
  path: z.string(),
  sizeBytes: z.number().optional(),
});

export const runResultSchema = z.object({
  summary: z.string(),
  reportMarkdown: z.string().optional(),
  metrics: z
    .object({
      durationMs: z.number(),
      tasksTotal: z.number(),
      tasksCompleted: z.number(),
      toolInvocations: z.number(),
    })
    .optional(),
  artifacts: z.array(runResultArtifactSchema).optional(),
});

export const runSchema = z.object({
  id: z.string(),
  goal: z.string(),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: z.number().min(0).max(100),
  workflow: workflowSummarySchema,
  tasks: z.array(taskSummarySchema),
  result: runResultSchema.optional(),
});
