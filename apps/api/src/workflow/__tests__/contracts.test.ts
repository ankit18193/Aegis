import { taskSchema } from "@aegis/contracts";
import { taskId, workflowId, runId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { TaskEntity } from "../../domain/task.js";
import {
  InvalidDependencyError,
  InvalidTaskInputError,
  InvalidWorkflowError,
  TaskBlockedError,
  WorkflowCancelledError,
  WorkflowCycleError,
  WorkflowError,
  WorkflowExecutionFailedError,
} from "../errors.js";
import type {
  TaskDefinition,
  TaskExecutionInput,
  WorkflowDefinition,
  WorkflowExecutionResult,
} from "../types.js";

describe("Workflow Engine Contracts", () => {
  describe("Task input contract", () => {
    it("preserves task input in TaskEntity through create and toSnapshot", () => {
      const task = TaskEntity.create({
        id: taskId("task-1"),
        name: "Test Task",
        description: "Task description",
        input: { query: "search terms", limit: 10 },
      });

      expect(task.input).toEqual({ query: "search terms", limit: 10 });
      const snapshot = task.toSnapshot();
      expect(snapshot.input).toEqual({ query: "search terms", limit: 10 });

      const reconstituted = TaskEntity.reconstitute(snapshot);
      expect(reconstituted.input).toEqual({ query: "search terms", limit: 10 });
    });

    it("supports string task input in TaskEntity", () => {
      const task = TaskEntity.create({
        id: taskId("task-string"),
        name: "String Task",
        input: "raw prompt text",
      });

      expect(task.input).toBe("raw prompt text");
      expect(task.toSnapshot().input).toBe("raw prompt text");
    });

    it("validates task schema with input in @aegis/contracts", () => {
      const parsed = taskSchema.safeParse({
        id: "task-1",
        name: "Parse Task",
        status: "pending",
        input: { key: "value" },
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.input).toEqual({ key: "value" });
      }
    });
  });

  describe("WorkflowError hierarchy", () => {
    it("instantiates InvalidWorkflowError with correct code and message", () => {
      const err = new InvalidWorkflowError("Missing tasks");
      expect(err).toBeInstanceOf(WorkflowError);
      expect(err.code).toBe("INVALID_WORKFLOW");
      expect(err.message).toContain("Missing tasks");
    });

    it("instantiates WorkflowCycleError with formatted cycle path", () => {
      const err = new WorkflowCycleError(["A", "B", "C", "A"]);
      expect(err.code).toBe("CYCLE_DETECTED");
      expect(err.cyclePath).toEqual(["A", "B", "C", "A"]);
      expect(err.message).toContain("A -> B -> C -> A");
    });

    it("instantiates InvalidDependencyError with reason details", () => {
      const missingErr = new InvalidDependencyError("t2", "t1", "missing");
      expect(missingErr.code).toBe("INVALID_DEPENDENCY");
      expect(missingErr.message).toContain("references unknown dependency 't1'");

      const selfErr = new InvalidDependencyError("t1", "t1", "self");
      expect(selfErr.message).toContain("cannot depend on itself");

      const dupErr = new InvalidDependencyError("t2", "t1", "duplicate");
      expect(dupErr.message).toContain("declares duplicate dependency on 't1'");
    });

    it("instantiates TaskBlockedError with blocker details", () => {
      const err = new TaskBlockedError("t2", "t1", "dependency_failed");
      expect(err.code).toBe("TASK_BLOCKED");
      expect(err.blockerId).toBe("t1");
      expect(err.reason).toBe("dependency_failed");
    });

    it("instantiates WorkflowCancelledError with reason", () => {
      const err = new WorkflowCancelledError("run-1", "User cancelled");
      expect(err.code).toBe("WORKFLOW_CANCELLED");
      expect(err.runId).toBe("run-1");
      expect(err.reason).toBe("User cancelled");
    });

    it("instantiates WorkflowExecutionFailedError with underlying cause", () => {
      const err = new WorkflowExecutionFailedError("run-1", "t2", "Tool failure");
      expect(err.code).toBe("WORKFLOW_EXECUTION_FAILED");
      expect(err.failedTaskId).toBe("t2");
      expect(err.underlyingError).toBe("Tool failure");
    });

    it("instantiates InvalidTaskInputError", () => {
      const err = new InvalidTaskInputError("t1", "Payload schema mismatch");
      expect(err.code).toBe("INVALID_TASK_INPUT");
      expect(err.message).toContain("Payload schema mismatch");
    });
  });

  describe("Workflow type definitions", () => {
    it("constructs valid WorkflowDefinition and TaskExecutionInput objects", () => {
      const taskDef: TaskDefinition = {
        id: taskId("task-1"),
        name: "Analyze",
        description: "Analyze goal",
        input: { prompt: "test" },
      };

      const wfDef: WorkflowDefinition = {
        id: workflowId("wf-1"),
        name: "Test Workflow",
        tasks: [taskDef],
      };

      expect(wfDef.tasks).toHaveLength(1);
      expect(wfDef.tasks[0]?.id).toBe("task-1");

      const execInput: TaskExecutionInput = {
        taskId: taskId("task-2"),
        name: "Execute",
        description: "Execute action",
        staticInput: { param: 42 },
        dependencyOutputs: {
          [taskId("task-1")]: "analysis completed",
        },
      };

      expect(execInput.dependencyOutputs[taskId("task-1")]).toBe("analysis completed");

      const result: WorkflowExecutionResult = {
        runId: runId("run-1"),
        status: "completed",
        tasksTotal: 1,
        tasksCompleted: 1,
        tasksFailed: 0,
        summary: "Done",
        durationMs: 120,
      };

      expect(result.status).toBe("completed");
    });
  });
});
