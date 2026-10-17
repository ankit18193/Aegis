import type { EvaluatorId, Result } from "@aegis/types";
import { z } from "zod";

import { runEventSchema } from "../events.js";
import { runSchema } from "../runs.js";
import { evaluationCaseIdSchema, evaluatorIdSchema, existingRunTargetSchema } from "./evaluationSuite.js";
import {
  assertionResultSchema,
  evaluationVerdictSchema,
  failureClassificationSchema,
} from "./evaluationResult.js";

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Metadata & Classification Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const evaluatorKindSchema = z.enum(["deterministic", "model_based"]);
export type EvaluatorKind = z.infer<typeof evaluatorKindSchema>;

export const evaluatorMetricTypeSchema = z.enum(["binary", "continuous_score", "categorical"]);
export type EvaluatorMetricType = z.infer<typeof evaluatorMetricTypeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Input & Output Contracts
// ─────────────────────────────────────────────────────────────────────────────

export const evaluatorInputSchema = z.object({
  caseId: evaluationCaseIdSchema,
  target: existingRunTargetSchema,
  executionEvidence: z.object({
    run: runSchema,
    events: z.array(runEventSchema).optional(),
  }),
  config: z.record(z.unknown()).optional(),
  captureRawOutput: z.boolean().default(false),
});
export type EvaluatorInput = z.infer<typeof evaluatorInputSchema>;

export const evaluatorOutputSchema = z.object({
  verdict: evaluationVerdictSchema,
  score: z.number().min(0).max(1).nullable(),
  failureClassification: failureClassificationSchema.optional(),
  reason: z.string().default(""),
  assertions: z.array(assertionResultSchema).default([]),
  rawOutputSnippet: z.string().max(4096).optional(),
});
export type EvaluatorOutput = z.infer<typeof evaluatorOutputSchema>;

export interface EvaluatorErrorContract {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stateless Evaluator Interface & Comparability Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transport-agnostic, stateless contract for executing an evaluation against evidence.
 */
export interface IEvaluator {
  readonly id: EvaluatorId;
  readonly version: string; // Semantic version, e.g. "1.0.0"
  readonly kind: EvaluatorKind;
  readonly metricType: EvaluatorMetricType;
  evaluate(input: EvaluatorInput): Promise<Result<EvaluatorOutput, EvaluatorErrorContract>>;
}

/**
 * Validates whether two evaluator configurations produce mutually comparable metrics.
 * Comparisons between mismatched evaluator IDs, versions, or metric types are invalid.
 */
export function areEvaluatorMetricsComparable(
  a: { id: string; version: string; metricType: EvaluatorMetricType },
  b: { id: string; version: string; metricType: EvaluatorMetricType },
): boolean {
  return a.id === b.id && a.version === b.version && a.metricType === b.metricType;
}
