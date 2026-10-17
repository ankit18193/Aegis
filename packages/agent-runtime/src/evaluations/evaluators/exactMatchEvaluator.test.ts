import type { EvaluatorInput, Run } from "@aegis/contracts";
import { evaluationCaseId, runId, taskId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { ExactMatchEvaluator } from "./exactMatchEvaluator.js";

function buildMockRun(params?: {
  summary?: string | undefined;
  tasks?: Run["tasks"] | undefined;
}): Run {
  return {
    id: runId("run-test-1"),
    goal: "Test exact match evaluation",
    status: "completed",
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-17T12:00:05.000Z",
    progress: 100,
    workflow: { id: "wf-1" as never, name: "Test Workflow", tasks: [] },
    tasks: params?.tasks ?? [],
    result:
      params?.summary !== undefined
        ? {
            summary: params.summary,
            metrics: {
              durationMs: 5000,
              tasksTotal: 1,
              tasksCompleted: 1,
              toolInvocations: 0,
            },
          }
        : undefined,
  };
}

describe("ExactMatchEvaluator (Phase 14B — Milestone 2)", () => {
  const evaluator = new ExactMatchEvaluator();

  it("passes when output matches exact string", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ summary: "Deployment completed successfully" }),
      },
      config: {
        expectedPattern: "Deployment completed successfully",
        matchMode: "exact",
      },
      captureRawOutput: true,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("pass");
    expect(res.value.score).toBe(1.0);
    expect(res.value.assertions).toHaveLength(1);
    expect(res.value.assertions[0]?.passed).toBe(true);
    expect(res.value.rawOutputSnippet).toBe(
      "Deployment completed successfully",
    );
  });

  it("fails with assertion_failed when exact string does not match", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ summary: "Deployment failed" }),
      },
      config: {
        expectedPattern: "Deployment completed successfully",
        matchMode: "exact",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("fail");
    expect(res.value.score).toBe(0.0);
    expect(res.value.failureClassification).toBe("assertion_failed");
    expect(res.value.assertions[0]?.passed).toBe(false);
  });

  it("supports contains matching with case sensitivity controls", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({
          summary: "Error 404: resource NOT found on server",
        }),
      },
      config: {
        expectedPattern: "not found",
        matchMode: "contains",
        caseSensitive: false,
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("pass");
    expect(res.value.score).toBe(1.0);
  });

  it("supports regex pattern matching", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({
          summary: "Final score is 98.5% with 0 regressions",
        }),
      },
      config: {
        expectedPattern: "\\d+\\.\\d+%",
        matchMode: "regex",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("pass");
    expect(res.value.score).toBe(1.0);
  });

  it("returns evaluator_error when regex pattern is malformed", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ summary: "Some output" }),
      },
      config: {
        expectedPattern: "[unclosed-bracket",
        matchMode: "regex",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("error");
    expect(res.value.score).toBeNull();
    expect(res.value.failureClassification).toBe("evaluator_error");
    expect(res.value.reason).toContain("Malformed regular expression");
  });

  it("returns missing_evidence when output is undefined", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ summary: undefined }),
      },
      config: {
        expectedPattern: "expected something",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("error");
    expect(res.value.score).toBeNull();
    expect(res.value.failureClassification).toBe("missing_evidence");
    expect(res.value.reason).toContain("no output string");
  });

  it("distinguishes valid empty output from missing evidence", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ summary: "" }), // Genuinely empty output
      },
      config: {
        expectedPattern: "hello",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Must be assertion_failed, NOT missing_evidence!
    expect(res.value.verdict).toBe("fail");
    expect(res.value.failureClassification).toBe("assertion_failed");
  });

  it("targets specific task output when target.taskId is provided", async () => {
    const targetTaskId = taskId("task-42");
    const run = buildMockRun({
      summary: "Run summary",
      tasks: [
        {
          id: targetTaskId,
          name: "Compute Task",
          status: "completed",
          version: 1,
          attemptCount: 1,
          output: "Task result: 42",
          description: "Task desc",
        },
      ],
    });

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: {
        type: "existing_run",
        runId: runId("run-1"),
        taskId: targetTaskId,
      },
      executionEvidence: { run },
      config: {
        expectedPattern: "Task result: 42",
        matchMode: "exact",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("pass");
    expect(res.value.score).toBe(1.0);
  });

  it("returns missing_evidence when target.taskId is not found in run tasks", async () => {
    const run = buildMockRun({ summary: "Run summary", tasks: [] });

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: {
        type: "existing_run",
        runId: runId("run-1"),
        taskId: taskId("non-existent-task"),
      },
      executionEvidence: { run },
      config: {
        expectedPattern: "something",
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("error");
    expect(res.value.failureClassification).toBe("missing_evidence");
    expect(res.value.reason).toContain("not found in execution evidence");
  });

  it("returns evaluator_error when config is invalid", async () => {
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-1"),
      target: { type: "existing_run", runId: runId("run-1") },
      executionEvidence: {
        run: buildMockRun({ summary: "Valid output" }),
      },
      config: {
        expectedPattern: "", // Empty pattern is invalid
      },
      captureRawOutput: false,
    };

    const res = await evaluator.evaluate(input);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.verdict).toBe("error");
    expect(res.value.failureClassification).toBe("evaluator_error");
    expect(res.value.reason).toContain("Invalid ExactMatch configuration");
  });
});
