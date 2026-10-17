import { z } from "zod";

import type { ValidationErrorDetail } from "../errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation Error Codes & Envelopes
// ─────────────────────────────────────────────────────────────────────────────

export const evaluationErrorCodeSchema = z.enum([
  "EVALUATION_SUITE_NOT_FOUND",
  "EVALUATION_CASE_NOT_FOUND",
  "EVALUATION_RUN_NOT_FOUND",
  "INCOMPATIBLE_SUITE_VERSION",
  "EVALUATOR_VERSION_MISMATCH",
  "ILLEGAL_EVALUATION_TRANSITION",
  "EVALUATOR_EXECUTION_FAILED",
  "INVALID_EVALUATION_TARGET",
  "EMPTY_EVALUATION_DATASET",
  "VALIDATION_ERROR",
]);
export type EvaluationErrorCode = z.infer<typeof evaluationErrorCodeSchema>;

export const evaluationErrorResponseSchema = z.object({
  error: z.object({
    code: evaluationErrorCodeSchema,
    message: z.string().min(1),
    details: z
      .array(
        z.object({
          field: z.string(),
          message: z.string(),
          code: z.string().default("INVALID"),
        }),
      )
      .optional(),
    traceId: z.string().optional(),
  }),
});
export type EvaluationErrorResponse = z.infer<typeof evaluationErrorResponseSchema>;

/**
 * Creates a strongly-typed EvaluationErrorResponse envelope.
 */
export function createEvaluationError(
  code: EvaluationErrorCode,
  message: string,
  details?: ValidationErrorDetail[],
  traceId?: string,
): EvaluationErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
      ...(traceId ? { traceId } : {}),
    },
  };
}

/**
 * Formats a Zod validation error into an EvaluationErrorResponse envelope.
 */
export function formatEvaluationZodError(
  error: z.ZodError,
  traceId?: string,
): EvaluationErrorResponse {
  const details: ValidationErrorDetail[] = error.issues.map((issue) => ({
    field: issue.path.join(".") || "root",
    message: issue.message,
    code: issue.code,
  }));

  return createEvaluationError(
    "VALIDATION_ERROR",
    `Evaluation validation failed: ${details.map((d) => `${d.field}: ${d.message}`).join("; ")}`,
    details,
    traceId,
  );
}
