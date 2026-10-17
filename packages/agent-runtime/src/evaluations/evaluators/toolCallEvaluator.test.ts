import type { EvaluatorInput, Run, RunEvent } from "@aegis/contracts";
import { evaluationCaseId, eventId, runId, taskId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { ToolCallEvaluator } from "./toolCallEvaluator.js";

function buildMockRun(): Run {
  return {
    id: runId("run-eval-tool-1"),
    goal: "Test tool call evaluation",
    status: "completed",
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-17T12:00:05.000Z",
    progress: 100,
    workflow: { id: "wf-1" as never, name: "Test Workflow", tasks: [] },
    tasks: [],
    result: {
      summary: "Completed",
      metrics: {
        durationMs: 5000,
        tasksTotal: 1,
        tasksCompleted: 1,
        toolInvocations: 2,
      },
    },
  };
}

function createToolEvent(opts: {
  id: string;
  toolName?: string;
  actionName?: string;
  message?: string;
  input?: Record<string, unknown>;
  taskId?: string;
}): RunEvent {
  return {
    id: eventId(opts.id),
    runId: runId("run-eval-tool-1"),
    type: "tool_invoked",
    severity: "info",
    message: opts.message ?? `Action '${opts.actionName ?? opts.toolName ?? "unknown"}' executed successfully`,
    timestamp: "2026-10-17T12:00:01.000Z",
    taskId: opts.taskId ? taskId(opts.taskId) : undefined,
    metadata: {
      ...(opts.actionName !== undefined ? { actionName: opts.actionName } : {}),
      ...(opts.toolName !== undefined ? { toolName: opts.toolName } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    },
  };
}

describe("ToolCallEvaluator (Phase 14B — Milestone 3)", () => {
  const evaluator = new ToolCallEvaluator();

  it("passes when all required tools were invoked and arguments match", async () => {
    const run = buildMockRun();
    const events: RunEvent[] = [
      createToolEvent({
        id: "evt-1",
        actionName: "calculate",
        input: { expression: "2 + 2" },
      }),
      createToolEvent({
        id: "evt-2",
        actionName: "echo",
        input: { message: "hello" },
      }),
    ];

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-1"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events },
      config: {
        requiredTools: ["calculate", "echo"],
        forbiddenTools: ["delete_file"],
        expectedArguments: {
          calculate: { expression: "2 + 2" },
        },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("pass");
    expect(result.value.score).toBe(1.0);
    expect(result.value.failureClassification).toBeUndefined();
    expect(result.value.assertions.length).toBe(4);
    expect(result.value.assertions.every((a) => a.passed)).toBe(true);
  });

  it("fails with assertion_failed when a required tool was not invoked", async () => {
    const run = buildMockRun();
    const events: RunEvent[] = [
      createToolEvent({
        id: "evt-1",
        actionName: "calculate",
        input: { expression: "2 + 2" },
      }),
    ];

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-2"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events },
      config: {
        requiredTools: ["calculate", "send_email"],
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("assertion_failed");
    expect(result.value.reason).toContain("Required tool 'send_email' was never invoked");
  });

  it("fails with assertion_failed when a forbidden tool was invoked", async () => {
    const run = buildMockRun();
    const events: RunEvent[] = [
      createToolEvent({
        id: "evt-1",
        actionName: "drop_database",
        input: {},
      }),
    ];

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-3"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events },
      config: {
        forbiddenTools: ["drop_database"],
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("assertion_failed");
    expect(result.value.reason).toContain("Forbidden tool 'drop_database' was invoked");
  });

  it("fails with assertion_failed when tool arguments do not match expectations", async () => {
    const run = buildMockRun();
    const events: RunEvent[] = [
      createToolEvent({
        id: "evt-1",
        actionName: "calculate",
        input: { expression: "10 * 10" },
      }),
    ];

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-4"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events },
      config: {
        expectedArguments: {
          calculate: { expression: "5 + 5" },
        },
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("assertion_failed");
    expect(result.value.reason).toContain("Tool 'calculate' arguments did not match expected parameters");
  });

  it("returns missing_evidence when events stream is undefined", async () => {
    const run = buildMockRun();
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-5"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events: undefined },
      config: {
        requiredTools: ["calculate"],
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("error");
    expect(result.value.score).toBeNull();
    expect(result.value.failureClassification).toBe("missing_evidence");
    expect(result.value.reason).toContain("contains no event stream");
  });

  it("treats empty events list as evidence of absence and fails when tools required", async () => {
    const run = buildMockRun();
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-6"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events: [] },
      config: {
        requiredTools: ["calculate"],
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("fail");
    expect(result.value.score).toBe(0.0);
    expect(result.value.failureClassification).toBe("assertion_failed");
    expect(result.value.reason).toContain("Required tool 'calculate' was never invoked");
  });

  it("filters events by target.taskId when specified", async () => {
    const run = buildMockRun();
    const events: RunEvent[] = [
      createToolEvent({
        id: "evt-1",
        actionName: "calculate",
        taskId: "task-A",
      }),
      createToolEvent({
        id: "evt-2",
        actionName: "echo",
        taskId: "task-B",
      }),
    ];

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-7"),
      target: { type: "existing_run", runId: run.id, taskId: taskId("task-A") },
      executionEvidence: { run, events },
      config: {
        requiredTools: ["calculate"],
        forbiddenTools: ["echo"],
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("pass");
    expect(result.value.score).toBe(1.0);
  });

  it("extracts tool name from message fallback when metadata does not specify actionName", async () => {
    const run = buildMockRun();
    const events: RunEvent[] = [
      {
        id: eventId("evt-fallback-1"),
        runId: run.id,
        type: "tool_invoked",
        severity: "info",
        message: "Action 'query_search' executed successfully",
        timestamp: "2026-10-17T12:00:01.000Z",
        metadata: {},
      },
    ];

    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-8"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events },
      config: {
        requiredTools: ["query_search"],
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("pass");
    expect(result.value.score).toBe(1.0);
  });

  it("returns evaluator_error on invalid configuration", async () => {
    const run = buildMockRun();
    const input: EvaluatorInput = {
      caseId: evaluationCaseId("case-tool-9"),
      target: { type: "existing_run", runId: run.id },
      executionEvidence: { run, events: [] },
      config: {
        requiredTools: "not-an-array",
      },
      captureRawOutput: false,
    };

    const result = await evaluator.evaluate(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.verdict).toBe("error");
    expect(result.value.score).toBeNull();
    expect(result.value.failureClassification).toBe("evaluator_error");
  });
});
