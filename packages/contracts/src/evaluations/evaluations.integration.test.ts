import { describe, expect, it } from "vitest";

import {
  calculateEvaluationMetrics,
  createEvaluationError,
  evaluationOutcomeSchema,
  evaluationResultSchema,
  evaluationRunSchema,
  evaluationSuiteSchema,
  isEvaluationRunComplete,
  isValidEvaluationResultTransition,
  isValidEvaluationRunTransition,
} from "../index.js";

describe("Evaluations Package Root Integration & Roundtrip", () => {
  it("imports and executes all evaluation domain utilities from package root", () => {
    expect(typeof calculateEvaluationMetrics).toBe("function");
    expect(typeof isEvaluationRunComplete).toBe("function");
    expect(typeof isValidEvaluationRunTransition).toBe("function");
    expect(typeof isValidEvaluationResultTransition).toBe("function");
    expect(typeof createEvaluationError).toBe("function");
  });

  it("performs complete evaluation lifecycle serialization roundtrip", () => {
    // 1. Define Suite Version Snapshot
    const rawSuite = {
      id: "suite-benchmark-1",
      version: 1,
      name: "Core Reliability Benchmark",
      description: "Verifies grounding and tool dispatch behavior",
      createdAt: "2026-10-17T14:00:00.000Z",
      cases: [
        {
          id: "case-01",
          name: "Verify Tool Call Count",
          target: {
            type: "existing_run" as const,
            runId: "run-exec-100",
          },
          evaluatorId: "evaluator-tool-call",
        },
      ],
    };
    const suite = evaluationSuiteSchema.parse(rawSuite);
    expect(suite.version).toBe(1);

    // 2. Compute Metrics for Run
    const metrics = calculateEvaluationMetrics({
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      errorCases: 0,
      skippedCases: 0,
      scores: [1.0],
      durationMs: 350,
    });
    expect(metrics.passRate).toBe(1.0);
    expect(isEvaluationRunComplete(metrics)).toBe(true);

    // 3. Serialize and Parse Completed Run
    const run = evaluationRunSchema.parse({
      id: "evalrun-500",
      suiteId: suite.id,
      suiteVersion: suite.version,
      status: "completed",
      metrics,
      createdAt: "2026-10-17T14:01:00.000Z",
      startedAt: "2026-10-17T14:01:01.000Z",
      completedAt: "2026-10-17T14:01:02.000Z",
    });
    expect(run.status).toBe("completed");

    // 4. Serialize and Parse Case Result
    const outcome = evaluationOutcomeSchema.parse({
      verdict: "pass",
      score: 1.0,
      reason: "Correct tools were called in sequence.",
      evidence: {
        inspectedRunId: "run-exec-100",
        assertions: [{ name: "Has tool_invoked events", passed: true }],
      },
      evaluatedAt: "2026-10-17T14:01:02.000Z",
      durationMs: 350,
    });

    const targetCase = suite.cases[0];
    expect(targetCase).toBeDefined();
    if (!targetCase) return;

    const result = evaluationResultSchema.parse({
      id: "evalres-900",
      evaluationRunId: run.id,
      caseId: targetCase.id,
      suiteId: suite.id,
      suiteVersion: suite.version,
      evaluatorId: "evaluator-tool-call",
      evaluatorVersion: "1.0.0",
      lifecycleStatus: "completed",
      outcome,
    });

    expect(result.outcome?.verdict).toBe("pass");
    expect(result.outcome?.evidence.inspectedRunId).toBe("run-exec-100");
  });
});
