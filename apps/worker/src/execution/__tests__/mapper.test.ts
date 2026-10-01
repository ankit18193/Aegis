import { AgentState } from "@aegis/agent-runtime";
import type { TaskAssignment, TaskExecutionContext, TaskInput } from "@aegis/contracts";
import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  mapAgentOutcomeToResult,
  mapAssignmentToExecutionRequest,
  mapRequestToAgentState,
} from "../mapper.js";

describe("Worker Execution Mapper (Phase 11C — Commit 2)", () => {
  const baseContext: TaskExecutionContext = {
    workerId: workerId("worker-test-1"),
    taskId: taskId("task-101"),
    runId: runId("run-202"),
    assignmentId: assignmentId("assign-303"),
    startedAt: "2026-10-01T12:00:00.000Z",
  };

  const createAssignment = (input?: TaskInput, description?: string): TaskAssignment => ({
    assignmentId: baseContext.assignmentId,
    taskId: baseContext.taskId,
    runId: baseContext.runId,
    workerId: baseContext.workerId,
    task: {
      id: baseContext.taskId,
      name: "IndexOptimization",
      status: "pending",
      description: description ?? "Analyze database indexes",
      attemptCount: 0,
      input,
    },
    assignedAt: "2026-10-01T11:59:00.000Z",
  });

  describe("mapAssignmentToExecutionRequest", () => {
    it("extracts explicit goal from object input when present", () => {
      const assignment = createAssignment({ goal: "Optimize slow PostgreSQL index" });
      const request = mapAssignmentToExecutionRequest(assignment, baseContext);

      expect(request.goal).toBe("Optimize slow PostgreSQL index");
      expect(request.taskId).toBe(baseContext.taskId);
      expect(request.runId).toBe(baseContext.runId);
      expect(request.assignmentId).toBe(baseContext.assignmentId);
      expect(request.workerId).toBe(baseContext.workerId);
      expect(request.context["taskName"]).toBe("IndexOptimization");
      expect(request.context["goal"]).toBe("Optimize slow PostgreSQL index");
    });

    it("falls back to prompt from object input when goal is absent", () => {
      const assignment = createAssignment({ prompt: "Calculate prime factors" });
      const request = mapAssignmentToExecutionRequest(assignment, baseContext);

      expect(request.goal).toBe("Calculate prime factors");
    });

    it("falls back to task name and description when input has no goal/prompt", () => {
      const assignment = createAssignment(undefined, "Perform heap scan analysis");
      const request = mapAssignmentToExecutionRequest(assignment, baseContext);

      expect(request.goal).toBe("IndexOptimization: Perform heap scan analysis");
    });

    it("falls back to task name alone when description is empty", () => {
      const assignment = createAssignment(undefined, "");
      const request = mapAssignmentToExecutionRequest(assignment, baseContext);

      expect(request.goal).toBe("IndexOptimization");
    });

    it("handles stringified input cleanly", () => {
      const assignment = createAssignment("Raw prompt text");
      const request = mapAssignmentToExecutionRequest(assignment, baseContext);

      expect(request.goal).toBe("Raw prompt text");
      expect(request.context["rawInput"]).toBe("Raw prompt text");
    });
  });

  describe("mapRequestToAgentState", () => {
    it("initializes an AgentState preserving runId, goal, and context", () => {
      const assignment = createAssignment({ key: "val" });
      const request = mapAssignmentToExecutionRequest(assignment, baseContext);
      const state = mapRequestToAgentState(request);

      expect(state.runId).toBe(baseContext.runId);
      expect(state.goal).toBe(request.goal);
      expect(state.iteration).toBe(0);
      expect(state.status).toBe("idle");
      expect(state.context["taskId"]).toBe("task-101");
      expect(state.context["key"]).toBe("val");
    });
  });

  describe("mapAgentOutcomeToResult", () => {
    it("maps completed AgentState to SUCCEEDED TaskExecutionResult", () => {
      const state = AgentState.init(baseContext.runId, "Analyze system");
      state.markCompleted("Summary text", "Verified 100 rows", "2026-10-01T12:05:00.000Z");

      const result = mapAgentOutcomeToResult(state, baseContext);

      expect(result.status).toBe("SUCCEEDED");
      expect(result.output).toBe("Verified 100 rows");
      expect(result.taskId).toBe(baseContext.taskId);
      expect(result.runId).toBe(baseContext.runId);
      expect(result.assignmentId).toBe(baseContext.assignmentId);
      expect(result.workerId).toBe(baseContext.workerId);
      expect(result.startedAt).toBe(baseContext.startedAt);
      expect(result.completedAt).toBe("2026-10-01T12:05:00.000Z");
      expect(result.error).toBeUndefined();
    });

    it("maps failed AgentState to FAILED TaskExecutionResult with structured error", () => {
      const state = AgentState.init(baseContext.runId, "Analyze system");
      state.incrementIteration();
      state.markFailed("Out of memory", "Heap allocation limit exceeded");

      const result = mapAgentOutcomeToResult(state, baseContext);

      expect(result.status).toBe("FAILED");
      expect(result.output).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe("TASK_EXECUTION_FAILED");
      expect(result.error?.message).toBe("Heap allocation limit exceeded");
      expect(result.error?.details).toEqual({ iterations: 1, status: "failed" });
      expect(result.taskId).toBe(baseContext.taskId);
    });

    it("maps unexpected execution exception to FAILED TaskExecutionResult with TASK_RUNTIME_ERROR", () => {
      const state = AgentState.init(baseContext.runId, "Analyze system");
      const error = new Error("Uncaught runtime exception");

      const result = mapAgentOutcomeToResult(state, baseContext, error);

      expect(result.status).toBe("FAILED");
      expect(result.error?.code).toBe("TASK_RUNTIME_ERROR");
      expect(result.error?.message).toBe("Uncaught runtime exception");
      expect(result.error?.stack).toBeDefined();
      expect(result.taskId).toBe(baseContext.taskId);
      expect(result.runId).toBe(baseContext.runId);
    });
  });
});
