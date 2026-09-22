import { taskId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { TaskEntity } from "../../domain/task.js";
import { WorkflowScheduler } from "../scheduler.js";

describe("WorkflowScheduler", () => {
  const scheduler = new WorkflowScheduler();

  describe("Initial readiness evaluation", () => {
    it("classifies root tasks as ready and dependent tasks as waiting in a linear DAG", () => {
      const taskA = TaskEntity.create({ id: taskId("task-A"), name: "Task A" });
      const taskB = TaskEntity.create({
        id: taskId("task-B"),
        name: "Task B",
        dependencies: [taskId("task-A")],
      });
      const taskC = TaskEntity.create({
        id: taskId("task-C"),
        name: "Task C",
        dependencies: [taskId("task-B")],
      });

      const report = scheduler.getReadinessReport([taskA, taskB, taskC]);

      expect(report.readyTasks.map((t) => t.id)).toEqual(["task-A"]);
      expect(report.waitingTasks.map((t) => t.id)).toEqual(["task-B", "task-C"]);
      expect(report.blockedTasks).toHaveLength(0);
      expect(report.isComplete).toBe(false);
      expect(report.isTerminal).toBe(false);
    });

    it("evaluates fan-out initial state where single root is ready", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });
      const taskC = TaskEntity.create({ id: taskId("C"), name: "C", dependencies: [taskId("A")] });

      const report = scheduler.getReadinessReport([taskA, taskB, taskC]);
      expect(report.readyTasks.map((t) => t.id)).toEqual(["A"]);
      expect(report.waitingTasks.map((t) => t.id)).toEqual(["B", "C"]);
    });

    it("evaluates disconnected independent tasks as all initially ready", () => {
      const t1 = TaskEntity.create({ id: taskId("t1"), name: "Task 1" });
      const t2 = TaskEntity.create({ id: taskId("t2"), name: "Task 2" });
      const t3 = TaskEntity.create({ id: taskId("t3"), name: "Task 3" });

      const report = scheduler.getReadinessReport([t1, t2, t3]);
      expect(report.readyTasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
      expect(report.waitingTasks).toHaveLength(0);
    });
  });

  describe("Deterministic ready-task ordering (LOCK 3)", () => {
    it("orders multiple simultaneously ready tasks deterministically by canonical TaskId", () => {
      // Create tasks out of alphabetical order
      const taskZ = TaskEntity.create({ id: taskId("task-z"), name: "Task Z" });
      const taskA = TaskEntity.create({ id: taskId("task-a"), name: "Task A" });
      const taskM = TaskEntity.create({ id: taskId("task-m"), name: "Task M" });

      const report1 = scheduler.getReadinessReport([taskZ, taskA, taskM]);
      const report2 = scheduler.getReadinessReport([taskM, taskZ, taskA]);

      expect(report1.readyTasks.map((t) => t.id)).toEqual(["task-a", "task-m", "task-z"]);
      expect(report2.readyTasks.map((t) => t.id)).toEqual(["task-a", "task-m", "task-z"]);
      expect(scheduler.getNextReadyTask([taskZ, taskA, taskM])?.id).toBe("task-a");
    });
  });

  describe("Dependency transitions & fan-in / diamond behavior", () => {
    it("transitions fan-out dependents to ready when root completes", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });
      const taskC = TaskEntity.create({ id: taskId("C"), name: "C", dependencies: [taskId("A")] });

      taskA.markQueued();
      taskA.start();
      taskA.complete("Output A");

      const report = scheduler.getReadinessReport([taskA, taskB, taskC]);
      expect(report.readyTasks.map((t) => t.id)).toEqual(["B", "C"]);
      expect(report.waitingTasks).toHaveLength(0);
    });

    it("keeps fan-in task waiting until ALL dependencies complete", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });
      const taskC = TaskEntity.create({ id: taskId("C"), name: "C", dependencies: [taskId("A")] });
      const taskD = TaskEntity.create({
        id: taskId("D"),
        name: "D",
        dependencies: [taskId("B"), taskId("C")],
      });

      taskA.markQueued();
      taskA.start();
      taskA.complete("A done");

      // B completes, but C is still running
      taskB.markQueued();
      taskB.start();
      taskB.complete("B done");

      taskC.markQueued();
      taskC.start();

      const reportMid = scheduler.getReadinessReport([taskA, taskB, taskC, taskD]);
      expect(reportMid.readyTasks).toHaveLength(0);
      expect(reportMid.waitingTasks.map((t) => t.id)).toEqual(["D"]);

      // Now C completes
      taskC.complete("C done");

      const reportFinal = scheduler.getReadinessReport([taskA, taskB, taskC, taskD]);
      expect(reportFinal.readyTasks.map((t) => t.id)).toEqual(["D"]);
      expect(reportFinal.waitingTasks).toHaveLength(0);
    });
  });

  describe("Failure and cancellation blocking (LOCK 6)", () => {
    it("blocks downstream dependent tasks when an upstream dependency fails", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });
      const taskC = TaskEntity.create({ id: taskId("C"), name: "C", dependencies: [taskId("B")] });

      taskA.markQueued();
      taskA.start();
      taskA.fail("Upstream crashed");

      const report = scheduler.getReadinessReport([taskA, taskB, taskC]);
      expect(report.readyTasks).toHaveLength(0);
      expect(report.blockedTasks).toHaveLength(1);
      expect(report.blockedTasks[0]?.task.id).toBe("B");
      expect(report.blockedTasks[0]?.reason).toBe("dependency_failed");
      expect(report.blockedTasks[0]?.blockerId).toBe("A");
      expect(scheduler.isWorkflowFailed([taskA, taskB, taskC])).toBe(true);
    });

    it("blocks downstream tasks when an upstream dependency is cancelled", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });

      taskA.cancel("User cancelled A");

      const report = scheduler.getReadinessReport([taskA, taskB]);
      expect(report.readyTasks).toHaveLength(0);
      expect(report.blockedTasks).toHaveLength(1);
      expect(report.blockedTasks[0]?.task.id).toBe("B");
      expect(report.blockedTasks[0]?.reason).toBe("dependency_cancelled");
      expect(report.blockedTasks[0]?.blockerId).toBe("A");
    });
  });

  describe("Completion and terminal checks", () => {
    it("identifies when all tasks have reached completed status", () => {
      const task1 = TaskEntity.create({ id: taskId("t1"), name: "T1" });
      const task2 = TaskEntity.create({ id: taskId("t2"), name: "T2", dependencies: [taskId("t1")] });

      expect(scheduler.isWorkflowComplete([task1, task2])).toBe(false);

      task1.markQueued();
      task1.start();
      task1.complete("done 1");

      task2.markQueued();
      task2.start();
      task2.complete("done 2");

      expect(scheduler.isWorkflowComplete([task1, task2])).toBe(true);
      expect(scheduler.isWorkflowFailed([task1, task2])).toBe(false);
      const report = scheduler.getReadinessReport([task1, task2]);
      expect(report.isComplete).toBe(true);
      expect(report.isTerminal).toBe(true);
    });
  });
});
