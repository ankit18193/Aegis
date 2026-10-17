import { describe, expect, it } from "vitest";

import {
  evaluationLifecycleStatusSchema,
  evaluationResultSchema,
  evaluationVerdictSchema,
  failureClassificationSchema,
  isValidEvaluationResultTransition,
  VALID_EVALUATION_RESULT_TRANSITIONS,
} from "./evaluationResult.js";

describe("Evaluation Result Contract & Lifecycle", () => {
  describe("evaluationLifecycleStatusSchema & evaluationVerdictSchema", () => {
    it("validates all lifecycle statuses", () => {
      const statuses = ["pending", "running", "completed"];
      for (const s of statuses) {
        expect(evaluationLifecycleStatusSchema.parse(s)).toBe(s);
      }
      expect(() => evaluationLifecycleStatusSchema.parse("done")).toThrow();
    });

    it("validates all canonical evaluation verdicts", () => {
      const verdicts = ["pass", "fail", "error", "skipped"];
      for (const v of verdicts) {
        expect(evaluationVerdictSchema.parse(v)).toBe(v);
      }
      expect(() => evaluationVerdictSchema.parse("success")).toThrow();
    });

    it("validates failure classifications", () => {
      const classifications = [
        "assertion_failed",
        "schema_violation",
        "timeout",
        "missing_evidence",
        "evaluator_error",
        "unclassified",
      ];
      for (const c of classifications) {
        expect(failureClassificationSchema.parse(c)).toBe(c);
      }
    });
  });

  describe("Lifecycle Transitions", () => {
    it("allows legal result lifecycle transitions", () => {
      expect(isValidEvaluationResultTransition("pending", "running")).toBe(true);
      expect(isValidEvaluationResultTransition("running", "completed")).toBe(true);
    });

    it("rejects illegal result lifecycle transitions", () => {
      expect(isValidEvaluationResultTransition("pending", "completed")).toBe(false);
      expect(isValidEvaluationResultTransition("running", "pending")).toBe(false);
      expect(isValidEvaluationResultTransition("completed", "running")).toBe(false);
    });

    it("enforces terminal completed state has zero outgoing transitions", () => {
      expect(VALID_EVALUATION_RESULT_TRANSITIONS.completed).toHaveLength(0);
    });
  });

  describe("evaluationResultSchema Refinements & Outcome Separation", () => {
    it("parses valid in-flight result with outcome undefined", () => {
      const pendingResult = evaluationResultSchema.parse({
        id: "evalres-001",
        evaluationRunId: "evalrun-001",
        caseId: "case-01",
        suiteId: "suite-prod",
        suiteVersion: 1,
        evaluatorId: "evaluator-json-schema",
        evaluatorVersion: "1.0.0",
        lifecycleStatus: "running",
      });

      expect(pendingResult.lifecycleStatus).toBe("running");
      expect(pendingResult.outcome).toBeUndefined();
    });

    it("parses valid completed result with full outcome and evidence", () => {
      const completedResult = evaluationResultSchema.parse({
        id: "evalres-002",
        evaluationRunId: "evalrun-001",
        caseId: "case-02",
        suiteId: "suite-prod",
        suiteVersion: 1,
        evaluatorId: "evaluator-exact-match",
        evaluatorVersion: "1.2.0",
        lifecycleStatus: "completed",
        outcome: {
          verdict: "pass",
          score: 1.0,
          reason: "Output matched expected pattern exactly.",
          evidence: {
            inspectedRunId: "run-target-1",
            assertions: [
              { name: "Schema validation", passed: true },
              { name: "Exact regex match", passed: true },
            ],
            rawOutputSnippet: '{"status":"ok"}',
          },
          evaluatedAt: "2026-10-17T12:01:00.000Z",
          durationMs: 145,
        },
      });

      expect(completedResult.lifecycleStatus).toBe("completed");
      expect(completedResult.outcome?.verdict).toBe("pass");
      expect(completedResult.outcome?.score).toBe(1.0);
      expect(completedResult.outcome?.evidence.assertions).toHaveLength(2);
    });

    it("rejects completed result missing an outcome", () => {
      expect(() =>
        evaluationResultSchema.parse({
          id: "evalres-003",
          evaluationRunId: "evalrun-001",
          caseId: "case-03",
          suiteId: "suite-prod",
          suiteVersion: 1,
          evaluatorId: "evaluator-1",
          evaluatorVersion: "1.0.0",
          lifecycleStatus: "completed",
        }),
      ).toThrow("EvaluationResult with lifecycleStatus 'completed' must include an outcome.");
    });

    it("rejects running result that prematurely populates an outcome", () => {
      expect(() =>
        evaluationResultSchema.parse({
          id: "evalres-004",
          evaluationRunId: "evalrun-001",
          caseId: "case-04",
          suiteId: "suite-prod",
          suiteVersion: 1,
          evaluatorId: "evaluator-1",
          evaluatorVersion: "1.0.0",
          lifecycleStatus: "running",
          outcome: {
            verdict: "pass",
            score: 1.0,
            reason: "",
            evidence: { inspectedRunId: "run-target-1", assertions: [] },
            evaluatedAt: "2026-10-17T12:01:00.000Z",
            durationMs: 50,
          },
        }),
      ).toThrow("cannot have an outcome populated");
    });
  });
});
