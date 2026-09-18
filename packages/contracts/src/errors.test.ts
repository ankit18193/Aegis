import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  apiErrorCodeSchema,
  apiErrorResponseSchema,
  createApiError,
  formatZodError,
} from "./errors.js";

describe("API Error Contracts & Envelope Helpers", () => {
  describe("apiErrorCodeSchema", () => {
    it("validates recognized error codes", () => {
      const codes = [
        "BAD_REQUEST",
        "VALIDATION_ERROR",
        "NOT_FOUND",
        "CONFLICT",
        "UNPROCESSABLE_ENTITY",
        "INTERNAL_SERVER_ERROR",
        "SERVICE_UNAVAILABLE",
      ] as const;

      for (const code of codes) {
        expect(apiErrorCodeSchema.parse(code)).toBe(code);
      }
      expect(() => apiErrorCodeSchema.parse("UNKNOWN_CODE")).toThrow();
    });
  });

  describe("createApiError", () => {
    it("builds a well-formed ApiErrorResponse envelope", () => {
      const error = createApiError("NOT_FOUND", "Run run-123 was not found");
      expect(apiErrorResponseSchema.parse(error)).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Run run-123 was not found",
        },
      });
    });

    it("includes validation details and traceId when provided", () => {
      const error = createApiError(
        "VALIDATION_ERROR",
        "Invalid payload parameters",
        [{ field: "goal", message: "Goal is too short", code: "TOO_SMALL" }],
        "trace-xyz-789",
      );

      const parsed = apiErrorResponseSchema.parse(error);
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
      expect(parsed.error.details).toHaveLength(1);
      expect(parsed.error.details?.[0]?.field).toBe("goal");
      expect(parsed.error.traceId).toBe("trace-xyz-789");
    });
  });

  describe("formatZodError", () => {
    it("converts ZodError into standardized ApiErrorResponse", () => {
      const testSchema = z.object({
        goal: z.string().min(3),
        limit: z.number().int().positive(),
      });

      const result = testSchema.safeParse({ goal: "a", limit: -1 });
      expect(result.success).toBe(false);

      if (!result.success) {
        const apiError = formatZodError(result.error, "req-test-456");
        const parsed = apiErrorResponseSchema.parse(apiError);

        expect(parsed.error.code).toBe("VALIDATION_ERROR");
        expect(parsed.error.traceId).toBe("req-test-456");
        expect(parsed.error.details).toHaveLength(2);
        expect(parsed.error.details?.[0]?.field).toBe("goal");
        expect(parsed.error.details?.[1]?.field).toBe("limit");
      }
    });
  });
});
