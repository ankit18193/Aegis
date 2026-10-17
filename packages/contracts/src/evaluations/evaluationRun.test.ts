import { describe, expect, it } from "vitest";

import {
  calculateEvaluationMetrics,
  evaluationMetricsSchema,
  evaluationRunIdSchema,
  evaluationRunSchema,
  evaluationRunStatusSchema,
  isEvaluationRunComplete,
  isValidEvaluationRunTransition,
  VALID_EVALUATION_RUN_TRANSITIONS,
} from "./evaluationRun.js";

describe("Evaluation Run Contract & State Machine", () => {
  describe("evaluationRunIdSchema", () => {
    it("parses valid evaluation run identifier", () => {
      expect(evaluationRunIdSchema.parse("evalrun-001")).toBe("evalrun-001");
    });

    it("rejects empty evaluation run identifier", () => {
      expect(() => evaluationRunIdSchema.parse("")).toThrow();
    });
  });

  describe("evaluationRunStatusSchema", () => {
    it("validates all canonical evaluation run statuses", () => {
      const statuses = ["pending", "running", "completed", "failed", "cancelled"];
      for (const status of statuses) {
        expect(evaluationRunStatusSchema.parse(status)).toBe(status);
      }
      expect(() => evaluationRunStatusSchema.parse("invalid_status")).toThrow();
    });
  });

  describe("Lifecycle State Transitions", () => {
    it("allows legal run transitions", () => {
      expect(isValidEvaluationRunTransition("pending", "running")).toBe(true);
      expect(isValidEvaluationRunTransition("pending", "cancelled")).toBe(true);
      expect(isValidEvaluationRunTransition("running", "completed")).toBe(true);
      expect(isValidEvaluationRunTransition("running", "failed")).toBe(true);
      expect(isValidEvaluationRunTransition("running", "cancelled")).toBe(true);
    });

    it("rejects illegal run transitions", () => {
      expect(isValidEvaluationRunTransition("pending", "completed")).toBe(false);
      expect(isValidEvaluationRunTransition("running", "pending")).toBe(false);
      expect(isValidEvaluationRunTransition("completed", "running")).toBe(false);
      expect(isValidEvaluationRunTransition("failed", "running")).toBe(false);
      expect(isValidEvaluationRunTransition("cancelled", "pending")).toBe(false);
    });

    it("enforces terminal states have zero outgoing transitions", () => {
      expect(VALID_EVALUATION_RUN_TRANSITIONS.completed).toHaveLength(0);
      expect(VALID_EVALUATION_RUN_TRANSITIONS.failed).toHaveLength(0);
      expect(VALID_EVALUATION_RUN_TRANSITIONS.cancelled).toHaveLength(0);
    });
  });

  describe("Metrics Calculation & Completion Invariant", () => {
    it("computes accurate pass rate and mean score for mixed outcomes", () => {
      const metrics = calculateEvaluationMetrics({
        totalCases: 10,
        passedCases: 6,
        failedCases: 2,
        errorCases: 1,
        skippedCases: 1,
        scores: [1.0, 1.0, 0.8, 0.9, 0.7, 0.6, 0.0, 0.2],
        durationMs: 4500,
      });

      // evaluableCases = 6 + 2 = 8. passRate = 6 / 8 = 0.75
      expect(metrics.passRate).toBe(0.75);
      expect(metrics.errorRate).toBe(0.1);
      expect(metrics.skippedRate).toBe(0.1);
      expect(metrics.meanScore).toBeCloseTo(0.65, 2);
      expect(metrics.durationMs).toBe(4500);
      expect(isEvaluationRunComplete(metrics)).toBe(true);
    });

    it("returns null passRate when there are zero evaluable cases (all error / skipped)", () => {
      const allErrors = calculateEvaluationMetrics({
        totalCases: 5,
        passedCases: 0,
        failedCases: 0,
        errorCases: 5,
        skippedCases: 0,
        durationMs: 2000,
      });

      expect(allErrors.passRate).toBeNull();
      expect(allErrors.errorRate).toBe(1.0);
      expect(allErrors.meanScore).toBeNull();
      expect(isEvaluationRunComplete(allErrors)).toBe(true);

      const allSkipped = calculateEvaluationMetrics({
        totalCases: 5,
        passedCases: 0,
        failedCases: 0,
        errorCases: 0,
        skippedCases: 5,
        durationMs: 500,
      });

      expect(allSkipped.passRate).toBeNull();
      expect(allSkipped.skippedRate).toBe(1.0);
      expect(isEvaluationRunComplete(allSkipped)).toBe(true);
    });

    it("detects incomplete evaluation runs", () => {
      const incomplete = calculateEvaluationMetrics({
        totalCases: 10,
        passedCases: 4,
        failedCases: 1,
        errorCases: 0,
        skippedCases: 0,
        durationMs: 2500,
      });

      // 4 + 1 = 5 < 10
      expect(isEvaluationRunComplete(incomplete)).toBe(false);
    });

    it("validates metrics against evaluationMetricsSchema", () => {
      const metrics = calculateEvaluationMetrics({
        totalCases: 4,
        passedCases: 3,
        failedCases: 1,
        errorCases: 0,
        skippedCases: 0,
        durationMs: 1200,
      });

      const parsed = evaluationMetricsSchema.parse(metrics);
      expect(parsed.totalCases).toBe(4);
      expect(parsed.passRate).toBe(0.75);
    });
  });

  describe("evaluationRunSchema", () => {
    it("parses valid completed evaluation run", () => {
      const run = evaluationRunSchema.parse({
        id: "evalrun-001",
        suiteId: "suite-prod",
        suiteVersion: 2,
        status: "completed",
        triggeredBy: "ci-pipeline",
        metrics: {
          totalCases: 5,
          passedCases: 4,
          failedCases: 1,
          errorCases: 0,
          skippedCases: 0,
          passRate: 0.8,
          errorRate: 0,
          skippedRate: 0,
          meanScore: 0.82,
          durationMs: 3400,
        },
        createdAt: "2026-10-17T12:00:00.000Z",
        startedAt: "2026-10-17T12:00:01.000Z",
        completedAt: "2026-10-17T12:00:05.000Z",
      });

      expect(run.id).toBe("evalrun-001");
      expect(run.status).toBe("completed");
      expect(run.metrics.passRate).toBe(0.8);
    });

    it("rejects run with invalid suite version", () => {
      expect(() =>
        evaluationRunSchema.parse({
          id: "evalrun-001",
          suiteId: "suite-prod",
          suiteVersion: 0,
          status: "pending",
          metrics: {
            totalCases: 0,
            passedCases: 0,
            failedCases: 0,
            errorCases: 0,
            skippedCases: 0,
            passRate: null,
            errorRate: 0,
            skippedRate: 0,
            meanScore: null,
            durationMs: 0,
          },
          createdAt: "2026-10-17T12:00:00.000Z",
        }),
      ).toThrow();
    });
  });
});
