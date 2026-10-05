import {
  DefaultActionExecutor,
  DeterministicPlanner,
} from "@aegis/agent-runtime";
import type { TaskAssignment, TaskExecutionContext } from "@aegis/contracts";
import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { TaskExecutor } from "../taskExecutor.js";

describe("TaskExecutor AgentRuntime Integration (Phase 11C — Commit 2)", () => {
  const currentWorkerId = workerId("worker-node-42");
  const currentTaskId = taskId("task-compute-88");
  const currentRunId = runId("run-flow-999");
  const currentAssignmentId = assignmentId("assign-job-111");

  const testContext: TaskExecutionContext = {
    workerId: currentWorkerId,
    taskId: currentTaskId,
    runId: currentRunId,
    assignmentId: currentAssignmentId,
    startedAt: "2026-10-01T14:00:00.000Z",
  };

  const testAssignment: TaskAssignment = {
    assignmentId: currentAssignmentId,
    taskId: currentTaskId,
    runId: currentRunId,
    workerId: currentWorkerId,
    task: {
      id: currentTaskId,
      name: "CalculateMetric",
      status: "pending",
      description: "Compute rolling average",
      attemptCount: 0,
      version: 1,
      input: {
        expression: "(50 * 2) + 25",
        metricName: "p99_latency",
      },
    },
    assignedAt: "2026-10-01T13:59:30.000Z",
  };

  it("executes multi-step Reason -> Action -> Observation loop and produces SUCCEEDED result", async () => {
    const planner = new DeterministicPlanner([
      {
        type: "execute",
        action: {
          name: "calculate",
          payload: { expression: "10 * 5" },
        },
      },
      {
        type: "execute",
        action: {
          name: "echo",
          payload: { text: "Latency calculation complete" },
        },
      },
      {
        type: "complete",
        summary: "Calculations validated successfully",
        output: "Result is 50",
      },
    ]);

    const executor = new TaskExecutor({
      planner,
      executor: new DefaultActionExecutor(),
      policy: { maxIterations: 5 },
    });

    const result = await executor.execute(testAssignment, testContext);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.output).toBe("Result is 50");
    expect(result.error).toBeUndefined();

    // Verify identity preservation
    expect(result.taskId).toBe(currentTaskId);
    expect(result.runId).toBe(currentRunId);
    expect(result.assignmentId).toBe(currentAssignmentId);
    expect(result.workerId).toBe(currentWorkerId);
    expect(result.startedAt).toBe(testContext.startedAt);
    expect(result.completedAt).toBeDefined();
  });

  it("captures planned failure decision and produces FAILED result without throwing", async () => {
    const planner = new DeterministicPlanner([
      {
        type: "fail",
        reason: "Input database connection string is malformed",
      },
    ]);

    const executor = new TaskExecutor({ planner });
    const result = await executor.execute(testAssignment, testContext);

    expect(result.status).toBe("FAILED");
    expect(result.output).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe("TASK_EXECUTION_FAILED");
    expect(result.error?.message).toContain("Input database connection string is malformed");
    expect(result.taskId).toBe(currentTaskId);
    expect(result.runId).toBe(currentRunId);
  });

  it("halts cleanly and reports FAILED when runtime exceeds policy maxIterations", async () => {
    const infinitePlanner = new DeterministicPlanner(() => ({
      ok: true,
      value: {
        type: "execute",
        action: { name: "noop", payload: {} },
      },
    }));

    const executor = new TaskExecutor({
      planner: infinitePlanner,
      policy: { maxIterations: 3 },
    });

    const result = await executor.execute(testAssignment, testContext);

    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("TASK_EXECUTION_FAILED");
    expect(result.error?.message).toContain("exceeded maximum iterations limit (3)");
    expect(result.error?.details).toEqual({ iterations: 3, status: "failed" });
  });

  it("propagates assignment context and input into the AgentState", async () => {
    let observedContext: Record<string, unknown> | undefined;

    const contextInspectingPlanner = new DeterministicPlanner((state) => {
      observedContext = { ...state.context };
      return {
        ok: true,
        value: {
          type: "complete",
          summary: "Inspected context",
          output: "OK",
        },
      };
    });

    const executor = new TaskExecutor({
      planner: contextInspectingPlanner,
    });

    const result = await executor.execute(testAssignment, testContext);

    expect(result.status).toBe("SUCCEEDED");
    expect(observedContext).toBeDefined();
    expect(observedContext?.["taskId"]).toBe(currentTaskId);
    expect(observedContext?.["runId"]).toBe(currentRunId);
    expect(observedContext?.["workerId"]).toBe(currentWorkerId);
    expect(observedContext?.["metricName"]).toBe("p99_latency");
    expect(observedContext?.["expression"]).toBe("(50 * 2) + 25");
  });

  it("safely catches unexpected runtime exceptions and maps to TASK_RUNTIME_ERROR", async () => {
    const throwingPlanner = new DeterministicPlanner(() => {
      throw new Error("Fatal hardware panic in worker subsystem");
    });

    const executor = new TaskExecutor({ planner: throwingPlanner });
    const result = await executor.execute(testAssignment, testContext);

    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("TASK_RUNTIME_ERROR");
    expect(result.error?.message).toContain("Fatal hardware panic in worker subsystem");
    expect(result.taskId).toBe(currentTaskId);
    expect(result.assignmentId).toBe(currentAssignmentId);
  });
});
