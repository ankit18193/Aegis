import type { EvaluationCaseId, EvaluationSuiteId, EvaluatorId } from "@aegis/types";
import { z } from "zod";

import { runIdSchema, taskIdSchema } from "../runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Branded Identifier Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationSuiteIdSchema = z.string().min(1) as unknown as z.ZodType<EvaluationSuiteId>;
export const evaluationCaseIdSchema = z.string().min(1) as unknown as z.ZodType<EvaluationCaseId>;
export const evaluatorIdSchema = z.string().min(1) as unknown as z.ZodType<EvaluatorId>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Target Contract (Phase 14A: Existing Run Target)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Target specification for post-hoc evaluation of an existing execution run.
 * Generative scenario targets (dispatching new runs) are deferred to Phase 14D.
 */
export const existingRunTargetSchema = z.object({
  type: z.literal("existing_run"),
  runId: runIdSchema,
  taskId: taskIdSchema.optional(),
});
export type ExistingRunTarget = z.infer<typeof existingRunTargetSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Case Definition Contract
// ─────────────────────────────────────────────────────────────────────────────

export const expectedOutcomeSchema = z.object({
  outputPattern: z.string().optional(),
  requiredTools: z.array(z.string().min(1)).optional(),
  maxDurationMs: z.number().int().positive().optional(),
});
export type ExpectedOutcome = z.infer<typeof expectedOutcomeSchema>;

/**
 * Case definition embedded within an EvaluationSuite version snapshot.
 * Omits duplicate suiteId and suiteVersion because the containing suite establishes identity.
 */
export const evaluationCaseDefinitionSchema = z.object({
  id: evaluationCaseIdSchema,
  name: z.string().trim().min(1, "Case name cannot be empty").max(100),
  description: z.string().trim().max(1000).default(""),
  target: existingRunTargetSchema,
  evaluatorId: evaluatorIdSchema,
  evaluatorConfig: z.record(z.unknown()).optional(),
  expectedOutcome: expectedOutcomeSchema.optional(),
});
export type EvaluationCaseDefinition = z.infer<typeof evaluationCaseDefinitionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Suite Snapshot Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An immutable versioned snapshot defining a suite of evaluation cases.
 * Note: No updatedAt field exists because version snapshots are immutable upon creation.
 * Editing a suite creates an incremented version (version: N + 1).
 */
export const evaluationSuiteSchema = z.object({
  id: evaluationSuiteIdSchema,
  version: z.number().int().min(1, "Suite version must be an integer >= 1"),
  name: z.string().trim().min(1, "Suite name cannot be empty").max(100),
  description: z.string().trim().max(1000).default(""),
  createdAt: z.string().datetime({ message: "createdAt must be a valid ISO 8601 timestamp" }),
  cases: z.array(evaluationCaseDefinitionSchema).default([]),
});
export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
