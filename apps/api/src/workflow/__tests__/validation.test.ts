import { taskId, workflowId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  InvalidDependencyError,
  InvalidWorkflowError,
  WorkflowCycleError,
} from "../errors.js";
import type { WorkflowDefinition } from "../types.js";
import { validateWorkflowDefinition } from "../validation.js";

describe("Workflow Definition Validation", () => {
  describe("Valid workflows", () => {
    it("validates a single-task workflow with no dependencies", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-1"),
        name: "Single Task Workflow",
        tasks: [
          {
            id: taskId("task-1"),
            name: "Initial Task",
          },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(1);
        expect(result.value.getTopologicalOrder().map((t) => t.id)).toEqual(["task-1"]);
      }
    });

    it("validates a linear multi-task workflow", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-linear"),
        name: "Linear Pipeline",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("B")] },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(3);
        expect(result.value.getTopologicalOrder().map((t) => t.id)).toEqual(["A", "B", "C"]);
      }
    });

    it("validates diamond DAG workflow", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-diamond"),
        name: "Diamond DAG",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("A")] },
          { id: taskId("D"), name: "Task D", dependencies: [taskId("B"), taskId("C")] },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(4);
        const order = result.value.getTopologicalOrder().map((t) => t.id);
        expect(order[0]).toBe("A");
        expect(order[3]).toBe("D");
      }
    });

    it("validates disconnected independent tasks", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-independent"),
        name: "Independent Tasks",
        tasks: [
          { id: taskId("task-1"), name: "Task 1" },
          { id: taskId("task-2"), name: "Task 2" },
          { id: taskId("task-3"), name: "Task 3" },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(3);
        expect(result.value.getRootTasks()).toHaveLength(3);
      }
    });
  });

  describe("Structural identity validation", () => {
    it("rejects empty workflow ID", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("   "),
        name: "Empty ID Workflow",
        tasks: [{ id: taskId("t1"), name: "Task 1" }],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWorkflowError);
        expect(result.error.message).toContain("Workflow ID cannot be empty");
      }
    });

    it("rejects empty workflow name", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-1"),
        name: "",
        tasks: [{ id: taskId("t1"), name: "Task 1" }],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWorkflowError);
        expect(result.error.message).toContain("Workflow name cannot be empty");
      }
    });

    it("rejects workflow with empty task list", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-empty"),
        name: "Empty Workflow",
        tasks: [],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWorkflowError);
        expect(result.error.message).toContain("at least one task");
      }
    });

    it("rejects task with empty ID", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-1"),
        name: "Bad Task ID",
        tasks: [{ id: taskId(""), name: "Task 1" }],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWorkflowError);
        expect(result.error.message).toContain("Task ID cannot be empty");
      }
    });

    it("rejects task with empty name", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-1"),
        name: "Bad Task Name",
        tasks: [{ id: taskId("t1"), name: "  " }],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidWorkflowError);
        expect(result.error.message).toContain("must have a non-empty name");
      }
    });
  });

  describe("Graph invariant validation", () => {
    it("detects and rejects duplicate task IDs", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-dup"),
        name: "Duplicate Task IDs",
        tasks: [
          { id: taskId("A"), name: "First Task A" },
          { id: taskId("A"), name: "Duplicate Task A" },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_WORKFLOW");
        expect(result.error.message).toContain("Duplicate task ID 'A'");
      }
    });

    it("detects and rejects missing/unknown dependency", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-missing-dep"),
        name: "Missing Dependency",
        tasks: [
          { id: taskId("B"), name: "Task B", dependencies: [taskId("UNKNOWN")] },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidDependencyError);
        expect(result.error.code).toBe("INVALID_DEPENDENCY");
        expect((result.error as InvalidDependencyError).reason).toBe("missing");
        expect(result.error.message).toContain("unknown dependency 'UNKNOWN'");
      }
    });

    it("detects and rejects self-dependency", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-self-dep"),
        name: "Self Dependency",
        tasks: [
          { id: taskId("A"), name: "Task A", dependencies: [taskId("A")] },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidDependencyError);
        expect((result.error as InvalidDependencyError).reason).toBe("self");
        expect(result.error.message).toContain("cannot depend on itself");
      }
    });

    it("detects and rejects duplicate dependencies on the same task", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-dup-dep"),
        name: "Duplicate Dependency",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A"), taskId("A")] },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidDependencyError);
        expect((result.error as InvalidDependencyError).reason).toBe("duplicate");
        expect(result.error.message).toContain("duplicate dependency on 'A'");
      }
    });

    it("detects and rejects direct cycle (A -> B -> A)", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-direct-cycle"),
        name: "Direct Cycle",
        tasks: [
          { id: taskId("A"), name: "Task A", dependencies: [taskId("B")] },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(WorkflowCycleError);
        expect(result.error.code).toBe("CYCLE_DETECTED");
        expect((result.error as WorkflowCycleError).cyclePath).toContain("A");
        expect((result.error as WorkflowCycleError).cyclePath).toContain("B");
      }
    });

    it("detects and rejects indirect cycle (A -> B -> C -> A)", () => {
      const workflow: WorkflowDefinition = {
        id: workflowId("wf-indirect-cycle"),
        name: "Indirect Cycle",
        tasks: [
          { id: taskId("A"), name: "Task A", dependencies: [taskId("C")] },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("B")] },
        ],
      };

      const result = validateWorkflowDefinition(workflow);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(WorkflowCycleError);
        expect(result.error.code).toBe("CYCLE_DETECTED");
        expect(result.error.message).toContain("Cycle detected");
      }
    });
  });
});
