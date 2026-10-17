import { evaluatorId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  areEvaluatorMetricsComparable,
  evaluatorInputSchema,
  evaluatorKindSchema,
  evaluatorMetricTypeSchema,
  evaluatorOutputSchema,
} from "./evaluatorContract.js";

describe("Evaluator Contract Schemas & Comparability", () => {
  describe("evaluatorKindSchema & evaluatorMetricTypeSchema", () => {
    it("validates deterministic and model_based kinds", () => {
      expect(evaluatorKindSchema.parse("deterministic")).toBe("deterministic");
      expect(evaluatorKindSchema.parse("model_based")).toBe("model_based");
      expect(() => evaluatorKindSchema.parse("heuristic")).toThrow();
    });

    it("validates metric types", () => {
      expect(evaluatorMetricTypeSchema.parse("binary")).toBe("binary");
      expect(evaluatorMetricTypeSchema.parse("continuous_score")).toBe("continuous_score");
      expect(evaluatorMetricTypeSchema.parse("categorical")).toBe("categorical");
      expect(() => evaluatorMetricTypeSchema.parse("ratio")).toThrow();
    });
  });

  describe("evaluatorInputSchema", () => {
    it("parses valid evaluator input with execution evidence", () => {
      const input = evaluatorInputSchema.parse({
        caseId: "case-001",
        target: {
          type: "existing_run",
          runId: "run-target-1",
        },
        executionEvidence: {
          run: {
            id: "run-target-1",
            goal: "Refactor database queries",
            status: "completed",
            createdAt: "2026-10-17T10:00:00.000Z",
            updatedAt: "2026-10-17T10:05:00.000Z",
            progress: 100,
            workflow: { id: "wf-1", name: "Refactor", tasks: [] },
            tasks: [],
          },
        },
        config: { maxDurationMs: 6000 },
        captureRawOutput: false,
      });

      expect(input.caseId).toBe("case-001");
      expect(input.target.runId).toBe("run-target-1");
      expect(input.executionEvidence.run.status).toBe("completed");
      expect(input.captureRawOutput).toBe(false);
    });
  });

  describe("evaluatorOutputSchema", () => {
    it("parses valid evaluator output with assertions", () => {
      const output = evaluatorOutputSchema.parse({
        verdict: "pass",
        score: 0.95,
        reason: "All validation constraints met.",
        assertions: [
          { name: "Schema check", passed: true },
          { name: "No forbidden tools", passed: true },
        ],
        rawOutputSnippet: "Analysis succeeded.",
      });

      expect(output.verdict).toBe("pass");
      expect(output.score).toBe(0.95);
      expect(output.assertions).toHaveLength(2);
    });

    it("parses valid failure output with failureClassification", () => {
      const output = evaluatorOutputSchema.parse({
        verdict: "fail",
        score: 0.0,
        failureClassification: "assertion_failed",
        reason: "Output violated required format.",
        assertions: [{ name: "Format check", passed: false, message: "Missing title key" }],
      });

      expect(output.verdict).toBe("fail");
      expect(output.failureClassification).toBe("assertion_failed");
      expect(output.assertions[0]?.passed).toBe(false);
    });
  });

  describe("areEvaluatorMetricsComparable", () => {
    it("returns true when evaluatorId, version, and metricType match exactly", () => {
      const a = { id: evaluatorId("exact-match"), version: "1.0.0", metricType: "binary" as const };
      const b = { id: evaluatorId("exact-match"), version: "1.0.0", metricType: "binary" as const };
      expect(areEvaluatorMetricsComparable(a, b)).toBe(true);
    });

    it("returns false when evaluatorId differs", () => {
      const a = { id: evaluatorId("exact-match"), version: "1.0.0", metricType: "binary" as const };
      const b = { id: evaluatorId("fuzzy-match"), version: "1.0.0", metricType: "binary" as const };
      expect(areEvaluatorMetricsComparable(a, b)).toBe(false);
    });

    it("returns false when version differs", () => {
      const a = { id: evaluatorId("exact-match"), version: "1.0.0", metricType: "binary" as const };
      const b = { id: evaluatorId("exact-match"), version: "1.1.0", metricType: "binary" as const };
      expect(areEvaluatorMetricsComparable(a, b)).toBe(false);
    });

    it("returns false when metricType differs", () => {
      const a = { id: evaluatorId("evaluator-score"), version: "1.0.0", metricType: "binary" as const };
      const b = { id: evaluatorId("evaluator-score"), version: "1.0.0", metricType: "continuous_score" as const };
      expect(areEvaluatorMetricsComparable(a, b)).toBe(false);
    });
  });
});
