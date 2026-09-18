import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Standardized API Error Envelopes (Transport-Agnostic)
// ─────────────────────────────────────────────────────────────────────────────

export const apiErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "UNPROCESSABLE_ENTITY",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const validationErrorDetailSchema = z.object({
  field: z.string(),
  message: z.string(),
  code: z.string().default("INVALID"),
});
export type ValidationErrorDetail = z.infer<typeof validationErrorDetailSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    details: z.array(validationErrorDetailSchema).optional(),
    traceId: z.string().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/**
 * Creates a strongly-typed ApiErrorResponse envelope.
 */
export function createApiError(
  code: ApiErrorCode,
  message: string,
  details?: ValidationErrorDetail[],
  traceId?: string,
): ApiErrorResponse {
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
 * Formats a Zod validation error into an ApiErrorResponse envelope.
 */
export function formatZodError(error: z.ZodError, traceId?: string): ApiErrorResponse {
  const details: ValidationErrorDetail[] = error.issues.map((issue) => ({
    field: issue.path.join(".") || "root",
    message: issue.message,
    code: issue.code,
  }));

  return createApiError(
    "VALIDATION_ERROR",
    `Validation failed: ${details.map((d) => `${d.field}: ${d.message}`).join("; ")}`,
    details,
    traceId,
  );
}
