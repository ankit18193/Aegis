import type { EvaluatorInput, Run } from "@aegis/contracts";
import { evaluationCaseId, runId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { RunLifecycleEvaluator } from "./runLifecycleEvaluator.js";

function buildMockRun(params?: {
  status?: Run["status"] | undefined;
  durationMs?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}): Run {
  return {
    id: runId("run-lifecycle-1"),
    goal: "Test lifecycle evaluation",
    status: params?.status ?? "completed",
    createdAt: params?.createdAt ?? "2026-10-17T12:00:00.000Z",
    updatedAt: params?.updatedAt ?? "2026-10-17T12:00:04.000Z",
    progress: 100,
    workflow: { id: "wf-1" as never, name: "Test Workflow", tasks: [] },
    tasks: [],
    result:
      params?.durationMs !== undefined
        ? {
            summary: "Done",
            metrics: {
              durationMs: params.durationMs,
              tasksTotal: 1,
              tasksCompleted: 1,
              toolInvocations: 0,
            },
          }
        : undefined,
  };
}

describe("RunLifecycleEvaluator (Phase 14B — Milestone 2)", () => {
  const evaluator = new RunLifecycleEvaluator();

  it("passes when status matches expectedStatus and duration within bounds", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ status: "completed", durationMs: 2500 }),
      },
      config: {
        expectedStatus: "completed",
        maxDurationMs: 5000,
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("pass");
    expect(res.value.score).toBe(1.0);
    expect(res.value.assertions).toHaveLength(2);
    expect(res.value.assertions.every((a) => a.passed)).toBe(true);
  });

  it("fails with assertion_failed when status does not match expectedStatus", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ status: "failed" }),
      },
      config: {
        expectedStatus: "completed",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("fail");
    expect(res.value.score).toBe(0.0);
    expect(res.value.failureClassification).toBe("assertion_failed");
    expect(res.value.reason).toContain("does not match expected status");
  });

  it("fails with timeout when duration exceeds maxDurationMs", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ status: "completed", durationMs: 8000 }),
      },
      config: {
        expectedStatus: "completed",
        maxDurationMs: 5000,
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("fail");
    expect(res.value.score).toBe(0.0);
    expect(res.value.failureClassification).toBe("timeout");
    expect(res.value.reason).toContain("timed out");
  });

  it("fails with assertion_failed when duration is below minDurationMs", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ status: "completed", durationMs: 500 }),
      },
      config: {
        expectedStatus: "completed",
        minDurationMs: 1000,
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("fail");
    expect(res.value.score).toBe(0.0);
    expect(res.value.failureClassification).toBe("assertion_failed");
    expect(res.value.reason).toContain("below expected minimum");
  });

  it("uses createdAt and updatedAt fallback when metrics.durationMs is absent", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({
          status: "completed",
          durationMs: undefined,
          createdAt: "2026-10-17T12:00:00.000Z",
          updatedAt: "2026-10-17T12:00:03.000Z", // 3000ms delta
        }),
      },
      config: {
        maxDurationMs: 5000,
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("pass");
    expect(res.value.score).toBe(1.0);
  });

  it("returns missing_evidence when duration cannot be computed from evidence", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({
          status: "completed",
          durationMs: undefined,
          createdAt: "invalid-date",
          updatedAt: "invalid-date",
        }),
      },
      config: {
        maxDurationMs: 5000,
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("error");
    expect(res.value.score).toBeNull();
    expect(res.value.failureClassification).toBe("missing_evidence");
    expect(res.value.reason).toContain("cannot be determined from evidence");
  });

  it("returns evaluator_error on invalid configuration", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun(),
      },
      config: {
        maxDurationMs: -100, // Non-positive duration is invalid
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("error");
    expect(res.value.failureClassification).toBe("evaluator_error");
    expect(res.value.reason).toContain("Invalid RunLifecycle configuration");
  });
});
