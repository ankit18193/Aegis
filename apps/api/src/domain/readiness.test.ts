import { describe, it, expect } from "vitest";
import { taskId } from "@aegis/types";
import { TaskEntity } from "./task.js";
import { evaluateTaskReadiness } from "./readiness.js";
import { InvalidStateTransitionError, TerminalStateError } from "./errors.js";

describe("TaskEntity & Pure Task Readiness Engine", () => {
  describe("TaskEntity Lifecycle", () => {
    it("creates a task in pending status with attempt count 0", () => {
      const task = TaskEntity.create({
        id: taskId("task-1"),
        name: "Discovery",
        description: "Initial discovery phase",
      });

      expect(task.id).toBe("task-1");
      expect(task.name).toBe("Discovery");
      expect(task.status).toBe("pending");
      expect(task.attemptCount).toBe(0);
      expect(task.isTerminal()).toBe(false);
    });

    it("transitions through legal lifecycle: pending -> queued -> running -> completed", () => {
      const task = TaskEntity.create({
        id: taskId("task-1"),
        name: "Compile",
      });

      const queuedRes = task.markQueued();
      expect(queuedRes.ok).toBe(true);
      expect(task.status).toBe("queued");

      const startRes = task.start();
      expect(startRes.ok).toBe(true);
      expect(task.status).toBe("running");
      expect(task.attemptCount).toBe(1);
      expect(task.startedAt).toBeDefined();

      const compRes = task.complete("Success output");
      expect(compRes.ok).toBe(true);
      expect(task.status).toBe("completed");
      expect(task.output).toBe("Success output");
      expect(task.completedAt).toBeDefined();
      expect(task.isTerminal()).toBe(true);
    });

    it("rejects illegal transitions with InvalidStateTransitionError", () => {
      const task = TaskEntity.create({
        id: taskId("task-1"),
        name: "Test",
      });

      // Cannot jump directly from pending to completed
      const res = task.complete("done");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBeInstanceOf(InvalidStateTransitionError);
      }
    });

    it("prevents transitioning from terminal state with TerminalStateError", () => {
      const task = TaskEntity.create({
        id: taskId("task-1"),
        name: "Test",
      });

      task.cancel("Run cancelled");
      expect(task.isTerminal()).toBe(true);

      const res = task.markQueued();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBeInstanceOf(TerminalStateError);
      }
    });

    it("serializes to snapshot and accurately reconstitutes", () => {
      const task = TaskEntity.create({
        id: taskId("task-1"),
        name: "Analyze",
        description: "Analyze code",
        dependencies: [taskId("task-0")],
      });
      task.markQueued();
      task.start();

      const snapshot = task.toSnapshot();
      expect(snapshot.id).toBe("task-1");
      expect(snapshot.status).toBe("running");
      expect(snapshot.attemptCount).toBe(1);
      expect(snapshot.dependencies).toEqual(["task-0"]);

      const reconstituted = TaskEntity.reconstitute(snapshot);
      expect(reconstituted.id).toBe("task-1");
      expect(reconstituted.status).toBe("running");
      expect(reconstituted.attemptCount).toBe(1);
      expect(reconstituted.dependencies).toEqual(["task-0"]);
    });
  });

  describe("Pure Task Readiness Evaluation", () => {
    it("classifies task with 0 dependencies as ready", () => {
      const rootTask = TaskEntity.create({
        id: taskId("root"),
        name: "Root",
      });

      const report = evaluateTaskReadiness([rootTask]);
      expect(report.readyTasks).toHaveLength(1);
      expect(report.readyTasks[0]?.id).toBe("root");
      expect(report.waitingTasks).toHaveLength(0);
      expect(report.blockedTasks).toHaveLength(0);
    });

    it("classifies task with all completed dependencies as ready", () => {
      const dep1 = TaskEntity.create({ id: taskId("dep-1"), name: "Dep 1" });
      dep1.markQueued();
      dep1.start();
      dep1.complete();

      const dep2 = TaskEntity.create({ id: taskId("dep-2"), name: "Dep 2" });
      dep2.markQueued();
      dep2.start();
      dep2.complete();

      const downstream = TaskEntity.create({
        id: taskId("downstream"),
        name: "Downstream",
        dependencies: [taskId("dep-1"), taskId("dep-2")],
      });

      const report = evaluateTaskReadiness([dep1, dep2, downstream]);
      expect(report.readyTasks.map((t) => t.id)).toEqual(["downstream"]);
      expect(report.waitingTasks).toHaveLength(0);
      expect(report.blockedTasks).toHaveLength(0);
    });

    it("classifies task with in-progress dependencies as waiting", () => {
      const runningDep = TaskEntity.create({ id: taskId("dep-1"), name: "Dep 1" });
      runningDep.markQueued();
      runningDep.start();

      const downstream = TaskEntity.create({
        id: taskId("downstream"),
        name: "Downstream",
        dependencies: [taskId("dep-1")],
      });

      const report = evaluateTaskReadiness([runningDep, downstream]);
      expect(report.readyTasks).toHaveLength(0);
      expect(report.waitingTasks.map((t) => t.id)).toEqual(["downstream"]);
      expect(report.blockedTasks).toHaveLength(0);
    });

    it("classifies task with failed dependency as blocked", () => {
      const failedDep = TaskEntity.create({ id: taskId("dep-1"), name: "Dep 1" });
      failedDep.markQueued();
      failedDep.start();
      failedDep.fail("Network failure");

      const downstream = TaskEntity.create({
        id: taskId("downstream"),
        name: "Downstream",
        dependencies: [taskId("dep-1")],
      });

      const report = evaluateTaskReadiness([failedDep, downstream]);
      expect(report.readyTasks).toHaveLength(0);
      expect(report.waitingTasks).toHaveLength(0);
      expect(report.blockedTasks).toHaveLength(1);
      expect(report.blockedTasks[0]?.task.id).toBe("downstream");
      expect(report.blockedTasks[0]?.reason).toBe("dependency_failed");
      expect(report.blockedTasks[0]?.blockerId).toBe("dep-1");
    });

    it("classifies task with cancelled dependency as blocked", () => {
      const cancelledDep = TaskEntity.create({ id: taskId("dep-1"), name: "Dep 1" });
      cancelledDep.cancel("Run cancelled");

      const downstream = TaskEntity.create({
        id: taskId("downstream"),
        name: "Downstream",
        dependencies: [taskId("dep-1")],
      });

      const report = evaluateTaskReadiness([cancelledDep, downstream]);
      expect(report.readyTasks).toHaveLength(0);
      expect(report.waitingTasks).toHaveLength(0);
      expect(report.blockedTasks).toHaveLength(1);
      expect(report.blockedTasks[0]?.task.id).toBe("downstream");
      expect(report.blockedTasks[0]?.reason).toBe("dependency_cancelled");
      expect(report.blockedTasks[0]?.blockerId).toBe("dep-1");
    });

    it("prioritizes blocked classification over waiting if any dependency is failed", () => {
      const runningDep = TaskEntity.create({ id: taskId("running-dep"), name: "Running" });
      runningDep.markQueued();
      runningDep.start();

      const failedDep = TaskEntity.create({ id: taskId("failed-dep"), name: "Failed" });
      failedDep.markQueued();
      failedDep.start();
      failedDep.fail("Compilation failed");

      const downstream = TaskEntity.create({
        id: taskId("downstream"),
        name: "Downstream",
        dependencies: [taskId("running-dep"), taskId("failed-dep")],
      });

      const report = evaluateTaskReadiness([runningDep, failedDep, downstream]);
      expect(report.blockedTasks).toHaveLength(1);
      expect(report.blockedTasks[0]?.task.id).toBe("downstream");
      expect(report.waitingTasks).toHaveLength(0);
    });

    it("ENFORCES PURITY INVARIANT (INV-RDY-01): evaluateTaskReadiness NEVER mutates task status", () => {
      const taskA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const taskB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });

      // Before evaluation
      expect(taskA.status).toBe("pending");
      expect(taskB.status).toBe("pending");
      const aPropsBefore = taskA.toSnapshot();
      const bPropsBefore = taskB.toSnapshot();

      // Run evaluation multiple times
      const report1 = evaluateTaskReadiness([taskA, taskB]);
      const report2 = evaluateTaskReadiness([taskA, taskB]);

      expect(report1.readyTasks.map((t) => t.id)).toEqual(["A"]);
      expect(report1.waitingTasks.map((t) => t.id)).toEqual(["B"]);
      expect(report2.readyTasks.map((t) => t.id)).toEqual(["A"]);

      // After evaluation: all properties and statuses are completely identical and unmutated
      expect(taskA.status).toBe("pending");
      expect(taskB.status).toBe("pending");
      expect(taskA.toSnapshot()).toEqual(aPropsBefore);
      expect(taskB.toSnapshot()).toEqual(bPropsBefore);
    });
  });
});
