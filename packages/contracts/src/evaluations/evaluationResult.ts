import type { EvaluationResultId } from "@aegis/types";
import { z } from "zod";

import { eventIdSchema, runIdSchema } from "../runs.js";

import { MAX_RAW_OUTPUT_BYTES } from "./evaluationConstants.js";

import { evaluationRunIdSchema } from "./evaluationRun.js";
import {
  evaluationCaseIdSchema,
  evaluationSuiteIdSchema,
  evaluatorIdSchema,
} from "./evaluationSuite.js";

// ─────────────────────────────────────────────────────────────────────────────
// Branded Identifier Schema
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationResultIdSchema = z.string().min(1) as unknown as z.ZodType<EvaluationResultId>;

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle Status & State Machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execution lifecycle status of an individual evaluation case.
 * Strictly separates execution state from terminal verdict.
 */
export const evaluationLifecycleStatusSchema = z.enum(["pending", "running", "completed"]);
export type EvaluationLifecycleStatus = z.infer<typeof evaluationLifecycleStatusSchema>;

export const VALID_EVALUATION_RESULT_TRANSITIONS: Readonly<
  Record<EvaluationLifecycleStatus, readonly EvaluationLifecycleStatus[]>
> = {
  pending: ["running"],
  running: ["completed"],
  completed: [],
};

/**
 * Pure transition guard for EvaluationResult lifecycle mutations.
 */
export function isValidEvaluationResultTransition(
  from: EvaluationLifecycleStatus,
  to: EvaluationLifecycleStatus,
): boolean {
  return VALID_EVALUATION_RESULT_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome, Verdict & Failure Classification
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationVerdictSchema = z.enum(["pass", "fail", "error", "skipped"]);
export type EvaluationVerdict = z.infer<typeof evaluationVerdictSchema>;

/**
 * Deterministic failure taxonomy for Phase 14A.
 * Cognitive/subjective categories (e.g. hallucination, prompt injection) are deferred to Phase 15.
 */
export const failureClassificationSchema = z.enum([
  "assertion_failed",
  "schema_violation",
  "timeout",
  "missing_evidence",
  "evaluator_error",
  "unclassified",
]);
export type FailureClassification = z.infer<typeof failureClassificationSchema>;

export const assertionResultSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  message: z.string().optional(),
});
export type AssertionResult = z.infer<typeof assertionResultSchema>;

export const evaluationEvidenceSchema = z.object({
  inspectedRunId: runIdSchema,
  inspectedEventIds: z.array(eventIdSchema).optional(),
  assertions: z.array(assertionResultSchema).default([]),
  rawOutputSnippet: z.string().max(MAX_RAW_OUTPUT_BYTES).optional(),
});
export type EvaluationEvidence = z.infer<typeof evaluationEvidenceSchema>;

/**
 * The terminal outcome of an evaluated case.
 * Required when lifecycleStatus === "completed"; forbidden when lifecycleStatus !== "completed".
 */
export const evaluationOutcomeSchema = z.object({
  verdict: evaluationVerdictSchema,
  score: z.number().min(0).max(1).nullable(),
  failureClassification: failureClassificationSchema.optional(),
  reason: z.string().default(""),
  evidence: evaluationEvidenceSchema,
  evaluatedAt: z.string().datetime({ message: "evaluatedAt must be an ISO 8601 timestamp" }),
  durationMs: z.number().nonnegative(),
});
export type EvaluationOutcome = z.infer<typeof evaluationOutcomeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Result Schema
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationResultSchema = z
  .object({
    id: evaluationResultIdSchema,
    evaluationRunId: evaluationRunIdSchema,
    caseId: evaluationCaseIdSchema,
    suiteId: evaluationSuiteIdSchema,
    suiteVersion: z.number().int().min(1),
    evaluatorId: evaluatorIdSchema,
    evaluatorVersion: z.string().min(1),
    lifecycleStatus: evaluationLifecycleStatusSchema,
    outcome: evaluationOutcomeSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.lifecycleStatus === "completed" && !data.outcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "EvaluationResult with lifecycleStatus 'completed' must include an outcome.",
        path: ["outcome"],
      });
    } else if (data.lifecycleStatus !== "completed" && data.outcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `EvaluationResult with lifecycleStatus '${data.lifecycleStatus}' cannot have an outcome populated.`,
        path: ["outcome"],
      });
    }
  });

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
