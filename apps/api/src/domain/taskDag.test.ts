import { describe, it, expect } from "vitest";
import { TaskDag, type TaskNode } from "./taskDag.js";
import {
  DagCycleError,
  DuplicateDependencyError,
  DuplicateTaskIdError,
  MissingDependencyError,
  SelfDependencyError,
} from "./errors.js";

describe("TaskDag (Directed Acyclic Graph)", () => {
  describe("Validation & Integrity Invariants", () => {
    it("builds a valid linear DAG and returns topological sort order", () => {
      const tasks: TaskNode[] = [
        { id: "task-3", dependencies: ["task-2"] },
        { id: "task-1", dependencies: [] },
        { id: "task-2", dependencies: ["task-1"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const dag = result.value;
        expect(dag.size).toBe(3);
        const order = dag.getTopologicalOrder().map((t) => t.id);
        expect(order).toEqual(["task-1", "task-2", "task-3"]);
        expect(dag.getRootTasks().map((t) => t.id)).toEqual(["task-1"]);
        expect(dag.getLeafTasks().map((t) => t.id)).toEqual(["task-3"]);
        expect(dag.getDependencies("task-2")).toEqual(["task-1"]);
        expect(dag.getDependents("task-1")).toEqual(["task-2"]);
      }
    });

    it("builds a valid diamond/branching DAG", () => {
      //      A
      //     / \
      //    B   C
      //     \ /
      //      D
      const tasks: TaskNode[] = [
        { id: "D", dependencies: ["B", "C"] },
        { id: "A", dependencies: [] },
        { id: "C", dependencies: ["A"] },
        { id: "B", dependencies: ["A"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const dag = result.value;
        const order = dag.getTopologicalOrder().map((t) => t.id);
        expect(order[0]).toBe("A");
        expect(order[3]).toBe("D");
        expect(order.indexOf("B")).toBeGreaterThan(order.indexOf("A"));
        expect(order.indexOf("C")).toBeGreaterThan(order.indexOf("A"));
        expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("B"));
        expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("C"));
      }
    });

    it("rejects duplicate task IDs (INV-DAG-01)", () => {
      const tasks: TaskNode[] = [
        { id: "task-1", dependencies: [] },
        { id: "task-1", dependencies: [] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DuplicateTaskIdError);
        expect(result.error.code).toBe("DUPLICATE_TASK_ID");
        expect(result.error.message).toContain("task-1");
      }
    });

    it("rejects non-existent dependencies (INV-DAG-02)", () => {
      const tasks: TaskNode[] = [
        { id: "task-1", dependencies: ["missing-task-999"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MissingDependencyError);
        expect(result.error.code).toBe("MISSING_DEPENDENCY_ERROR");
        expect(result.error.message).toContain("missing-task-999");
      }
    });

    it("rejects self-dependencies (INV-DAG-03)", () => {
      const tasks: TaskNode[] = [
        { id: "task-self", dependencies: ["task-self"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SelfDependencyError);
        expect(result.error.code).toBe("SELF_DEPENDENCY_ERROR");
        expect(result.error.message).toContain("task-self");
      }
    });

    it("rejects duplicate dependencies within a task (INV-DAG-04)", () => {
      const tasks: TaskNode[] = [
        { id: "dep-1", dependencies: [] },
        { id: "task-1", dependencies: ["dep-1", "dep-1"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DuplicateDependencyError);
        expect(result.error.code).toBe("DUPLICATE_DEPENDENCY");
      }
    });
  });

  describe("Cycle Detection", () => {
    it("detects a 2-node cycle (A -> B -> A) and returns explicit cycle path", () => {
      const tasks: TaskNode[] = [
        { id: "A", dependencies: ["B"] },
        { id: "B", dependencies: ["A"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DagCycleError);
        expect(result.error.code).toBe("DAG_CYCLE_ERROR");
        const cycleError = result.error as DagCycleError;
        expect(cycleError.cyclePath).toEqual(["A", "B", "A"]);
        expect(cycleError.message).toBe("Cycle detected in task dependencies: A -> B -> A");
      }
    });

    it("detects a 3-node cycle (A -> B -> C -> A)", () => {
      const tasks: TaskNode[] = [
        { id: "A", dependencies: ["C"] },
        { id: "B", dependencies: ["A"] },
        { id: "C", dependencies: ["B"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DagCycleError);
        const cycleError = result.error as DagCycleError;
        expect(cycleError.cyclePath).toEqual(["A", "C", "B", "A"]);
        expect(cycleError.message).toBe("Cycle detected in task dependencies: A -> C -> B -> A");
      }
    });

    it("detects a cycle nested inside a larger graph", () => {
      const tasks: TaskNode[] = [
        { id: "start", dependencies: [] },
        { id: "middle-1", dependencies: ["start", "middle-2"] },
        { id: "middle-2", dependencies: ["middle-1"] },
        { id: "end", dependencies: ["middle-2"] },
      ];

      const result = TaskDag.build(tasks);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DagCycleError);
        const cycleError = result.error as DagCycleError;
        expect(cycleError.cyclePath).toEqual(["middle-1", "middle-2", "middle-1"]);
      }
    });
  });

  describe("Query and Graph Inspection", () => {
    it("provides fast lookup and membership checks", () => {
      const tasks: TaskNode[] = [
        { id: "t1", dependencies: [] },
        { id: "t2", dependencies: ["t1"] },
      ];

      const dag = TaskDag.build(tasks).value!;
      expect(dag.hasTask("t1")).toBe(true);
      expect(dag.hasTask("t2")).toBe(true);
      expect(dag.hasTask("t3")).toBe(false);
      expect(dag.getTask("t1")?.id).toBe("t1");
      expect(dag.getTask("t3")).toBeUndefined();
      expect(dag.getTasks()).toHaveLength(2);
    });
  });
});
