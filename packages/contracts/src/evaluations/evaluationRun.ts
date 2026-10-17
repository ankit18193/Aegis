import type { EvaluationRunId } from "@aegis/types";
import { z } from "zod";

import { evaluationSuiteIdSchema } from "./evaluationSuite.js";

// ─────────────────────────────────────────────────────────────────────────────
// Branded Identifier Schema
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationRunIdSchema = z.string().min(1) as unknown as z.ZodType<EvaluationRunId>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Run Lifecycle Status & State Machine
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type EvaluationRunStatus = z.infer<typeof evaluationRunStatusSchema>;

/**
 * Valid state transitions for an Evaluation Run.
 * Terminal states (completed, failed, cancelled) have no outgoing transitions.
 */
export const VALID_EVALUATION_RUN_TRANSITIONS: Readonly<
  Record<EvaluationRunStatus, readonly EvaluationRunStatus[]>
> = {
  pending: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Pure transition guard validating legal EvaluationRun status changes.
 */
export function isValidEvaluationRunTransition(
  from: EvaluationRunStatus,
  to: EvaluationRunStatus,
): boolean {
  return VALID_EVALUATION_RUN_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Run Metrics & Invariants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregated evaluation run metrics.
 * Note: Uses four mutually exclusive terminal counters (passed, failed, error, skipped).
 * The previous ambiguous completedCases counter is eliminated to prevent overlapping state.
 */
export const evaluationMetricsSchema = z.object({
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  errorCases: z.number().int().nonnegative(),
  skippedCases: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1).nullable(),
  errorRate: z.number().min(0).max(1),
  skippedRate: z.number().min(0).max(1),
  meanScore: z.number().min(0).max(1).nullable(),
  durationMs: z.number().nonnegative(),
});
export type EvaluationMetrics = z.infer<typeof evaluationMetricsSchema>;

/**
 * Checks whether an evaluation run has satisfied the terminal completion invariant:
 * passedCases + failedCases + errorCases + skippedCases === totalCases.
 */
export function isEvaluationRunComplete(metrics: EvaluationMetrics): boolean {
  const terminalCases =
    metrics.passedCases + metrics.failedCases + metrics.errorCases + metrics.skippedCases;
  return terminalCases === metrics.totalCases;
}

/**
 * Computes deterministic, null-safe evaluation metrics.
 * If evaluableCases (passed + failed) === 0, passRate evaluates strictly to null.
 */
export function calculateEvaluationMetrics(params: {
  totalCases: number;
  passedCases: number;
  failedCases: number;
  errorCases: number;
  skippedCases: number;
  scores?: readonly (number | null)[];
  durationMs: number;
}): EvaluationMetrics {
  const { totalCases, passedCases, failedCases, errorCases, skippedCases, scores, durationMs } =
    params;
  const evaluableCases = passedCases + failedCases;
  const passRate = evaluableCases > 0 ? passedCases / evaluableCases : null;
  const errorRate = totalCases > 0 ? errorCases / totalCases : 0;
  const skippedRate = totalCases > 0 ? skippedCases / totalCases : 0;

  let meanScore: number | null = null;
  if (scores && scores.length > 0) {
    const numericScores = scores.filter(
      (s): s is number => typeof s === "number" && !Number.isNaN(s),
    );
    if (numericScores.length > 0) {
      const sum = numericScores.reduce((acc, v) => acc + v, 0);
      meanScore = sum / numericScores.length;
    }
  }

  return {
    totalCases,
    passedCases,
    failedCases,
    errorCases,
    skippedCases,
    passRate,
    errorRate,
    skippedRate,
    meanScore,
    durationMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Run Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationRunSchema = z.object({
  id: evaluationRunIdSchema,
  suiteId: evaluationSuiteIdSchema,
  suiteVersion: z.number().int().min(1),
  status: evaluationRunStatusSchema,
  triggeredBy: z.string().optional(),
  metrics: evaluationMetricsSchema,
  createdAt: z.string().datetime({ message: "createdAt must be a valid ISO 8601 timestamp" }),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  failureReason: z.string().optional(),
});
export type EvaluationRun = z.infer<typeof evaluationRunSchema>;

/**
 * Lightweight projection for listing evaluation runs.
 */
export const evaluationRunSummarySchema = z.object({
  id: evaluationRunIdSchema,
  suiteId: evaluationSuiteIdSchema,
  suiteVersion: z.number().int().min(1),
  status: evaluationRunStatusSchema,
  totalCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1).nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type EvaluationRunSummary = z.infer<typeof evaluationRunSummarySchema>;
