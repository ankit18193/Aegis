import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createEvaluationError,
  evaluationErrorCodeSchema,
  evaluationErrorResponseSchema,
  formatEvaluationZodError,
} from "./evaluationErrors.js";

describe("Evaluation Errors Contract", () => {
  describe("evaluationErrorCodeSchema", () => {
    it("validates all canonical evaluation error codes", () => {
      const codes = [
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
      ];

      for (const code of codes) {
        expect(evaluationErrorCodeSchema.parse(code)).toBe(code);
      }
      expect(() => evaluationErrorCodeSchema.parse("UNKNOWN_ERROR")).toThrow();
    });
  });

  describe("createEvaluationError", () => {
    it("creates strongly typed error envelope with details and traceId", () => {
      const envelope = createEvaluationError(
        "INCOMPATIBLE_SUITE_VERSION",
        "Cannot execute run against suite version 2 when version 3 is current.",
        [{ field: "suiteVersion", message: "Outdated version", code: "VERSION_STALE" }],
        "trace-123",
      );

      expect(envelope.error.code).toBe("INCOMPATIBLE_SUITE_VERSION");
      expect(envelope.error.message).toContain("suite version 2");
      expect(envelope.error.details).toHaveLength(1);
      expect(envelope.error.traceId).toBe("trace-123");

      const validated = evaluationErrorResponseSchema.parse(envelope);
      expect(validated.error.code).toBe("INCOMPATIBLE_SUITE_VERSION");
    });
  });

  describe("formatEvaluationZodError", () => {
    it("converts ZodError to evaluation error response", () => {
      const testSchema = z.object({
        name: z.string().min(3),
        score: z.number().min(0),
      });

      const parseResult = testSchema.safeParse({ name: "a", score: -5 });
      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        const errorEnvelope = formatEvaluationZodError(parseResult.error, "trace-zod-01");
        expect(errorEnvelope.error.code).toBe("VALIDATION_ERROR");
        expect(errorEnvelope.error.details).toHaveLength(2);
        expect(errorEnvelope.error.traceId).toBe("trace-zod-01");
      }
    });
  });
});
