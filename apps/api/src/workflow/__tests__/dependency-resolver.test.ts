import { taskId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { TaskEntity } from "../../domain/task.js";
import { DependencyResolver } from "../dependency-resolver.js";
import { InvalidDependencyError, TaskBlockedError } from "../errors.js";

describe("DependencyResolver", () => {
  const resolver = new DependencyResolver();

  describe("Root task resolution", () => {
    it("resolves static input and empty dependencyOutputs for root task with no dependencies", () => {
      const task = TaskEntity.create({
        id: taskId("root-1"),
        name: "Root Task",
        description: "Initial task in workflow",
        input: { prompt: "Analyze codebase" },
      });

      const result = resolver.resolveExecutionInput(task, [task]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBe("root-1");
        expect(result.value.name).toBe("Root Task");
        expect(result.value.description).toBe("Initial task in workflow");
        expect(result.value.staticInput).toEqual({ prompt: "Analyze codebase" });
        expect(result.value.dependencyOutputs).toEqual({});
      }
      expect(resolver.areDependenciesSatisfied(task, [task])).toBe(true);
    });
  });

  describe("Linear DAG output propagation (A -> B)", () => {
    it("propagates output from upstream completed task to dependent task", () => {
      const taskA = TaskEntity.create({
        id: taskId("task-A"),
        name: "Task A",
      });
      taskA.markQueued();
      taskA.start();
      taskA.complete("Output from A: Analysis complete");

      const taskB = TaskEntity.create({
        id: taskId("task-B"),
        name: "Task B",
        dependencies: [taskId("task-A")],
        input: { operation: "transform" },
      });

      const result = resolver.resolveExecutionInput(taskB, [taskA, taskB]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBe("task-B");
        expect(result.value.staticInput).toEqual({ operation: "transform" });
        expect(result.value.dependencyOutputs[taskId("task-A")]).toBe(
          "Output from A: Analysis complete",
        );
      }
      expect(resolver.areDependenciesSatisfied(taskB, [taskA, taskB])).toBe(true);
    });
  });

  describe("Fan-out output propagation (A -> B, C)", () => {
    it("makes root output available to all fan-out dependents", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      taskA.markQueued();
      taskA.start();
      taskA.complete("Shared root output");

      const taskB = TaskEntity.create({
        id: taskId("B"),
        name: "Task B",
        dependencies: [taskId("A")],
      });
      const taskC = TaskEntity.create({
        id: taskId("C"),
        name: "Task C",
        dependencies: [taskId("A")],
      });

      const resB = resolver.resolveExecutionInput(taskB, [taskA, taskB, taskC]);
      const resC = resolver.resolveExecutionInput(taskC, [taskA, taskB, taskC]);

      expect(resB.ok).toBe(true);
      expect(resC.ok).toBe(true);
      if (resB.ok && resC.ok) {
        expect(resB.value.dependencyOutputs[taskId("A")]).toBe("Shared root output");
        expect(resC.value.dependencyOutputs[taskId("A")]).toBe("Shared root output");
      }
    });
  });

  describe("Fan-in and Diamond DAG output propagation ((B, C) -> D)", () => {
    it("collects outputs from multiple upstream dependencies for fan-in task", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      taskA.markQueued();
      taskA.start();
      taskA.complete("A result");

      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });
      taskB.markQueued();
      taskB.start();
      taskB.complete("B result");

      const taskC = TaskEntity.create({ id: taskId("C"), name: "Task C", dependencies: [taskId("A")] });
      taskC.markQueued();
      taskC.start();
      taskC.complete("C result");

      const taskD = TaskEntity.create({
        id: taskId("D"),
        name: "Task D",
        dependencies: [taskId("B"), taskId("C")],
        input: "Synthesize outputs",
      });

      const result = resolver.resolveExecutionInput(taskD, [taskA, taskB, taskC, taskD]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.staticInput).toBe("Synthesize outputs");
        expect(result.value.dependencyOutputs).toEqual({
          [taskId("B")]: "B result",
          [taskId("C")]: "C result",
        });
      }
      expect(resolver.areDependenciesSatisfied(taskD, [taskA, taskB, taskC, taskD])).toBe(true);
    });
  });

  describe("Downstream blocking on dependency failure / cancellation (LOCK 6)", () => {
    it("returns TaskBlockedError when dependency has failed", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      taskA.markQueued();
      taskA.start();
      taskA.fail("Upstream crashed");

      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });

      const result = resolver.resolveExecutionInput(taskB, [taskA, taskB]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(TaskBlockedError);
        expect((result.error as TaskBlockedError).reason).toBe("dependency_failed");
        expect((result.error as TaskBlockedError).blockerId).toBe("A");
      }
      expect(resolver.areDependenciesSatisfied(taskB, [taskA, taskB])).toBe(false);
    });

    it("returns TaskBlockedError when dependency was cancelled", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      taskA.cancel("Cancelled by user");

      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });

      const result = resolver.resolveExecutionInput(taskB, [taskA, taskB]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(TaskBlockedError);
        expect((result.error as TaskBlockedError).reason).toBe("dependency_cancelled");
        expect((result.error as TaskBlockedError).blockerId).toBe("A");
      }
    });

    it("returns TaskBlockedError if dependency is not yet completed", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      taskA.markQueued();
      taskA.start(); // Still running

      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });

      const result = resolver.resolveExecutionInput(taskB, [taskA, taskB]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(TaskBlockedError);
      }
      expect(resolver.areDependenciesSatisfied(taskB, [taskA, taskB])).toBe(false);
    });

    it("returns InvalidDependencyError if declared dependency does not exist", () => {
      const taskB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("MISSING")] });

      const result = resolver.resolveExecutionInput(taskB, [taskB]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidDependencyError);
        expect((result.error as InvalidDependencyError).reason).toBe("missing");
      }
    });
  });
});
