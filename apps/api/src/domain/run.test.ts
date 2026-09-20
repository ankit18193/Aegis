import { runId, taskId, workerId, workflowId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  DagCycleError,
  InvalidStateTransitionError,
  TerminalStateError,
} from "./errors.js";
import type {
  RunCreatedDomainEvent,
  TaskCancelledDomainEvent,
} from "./events.js";
import { ExecutionRun } from "./run.js";
import { TaskEntity } from "./task.js";

describe("ExecutionRun Aggregate Root", () => {
  function createSampleTasks(): TaskEntity[] {
    const t1 = TaskEntity.create({ id: taskId("t1"), name: "Task 1" });
    const t2 = TaskEntity.create({
      id: taskId("t2"),
      name: "Task 2",
      dependencies: [taskId("t1")],
    });
    return [t1, t2];
  }

  function createValidRun(
    goal = "Test run",
    tasks: TaskEntity[] = createSampleTasks(),
    id = runId("run-001"),
  ): ExecutionRun {
    const res = ExecutionRun.create({
      id,
      goal,
      workflow: { id: workflowId("wf-1"), name: "Workflow" },
      tasks,
    });
    if (!res.ok) {
      throw new Error(`Failed to create test run: ${res.error.message}`);
    }
    return res.value;
  }

  describe("Creation and Invariant Validation", () => {
    it("creates an execution run in pending status and emits run_created event", () => {
      const tasks = createSampleTasks();
      const runResult = ExecutionRun.create({
        id: runId("run-001"),
        goal: "Analyze codebase performance",
        workflow: { id: workflowId("wf-1"), name: "Perf Workflow" },
        tasks,
      });

      expect(runResult.ok).toBe(true);
      if (runResult.ok) {
        const run = runResult.value;
        expect(run.id).toBe("run-001");
        expect(run.status).toBe("pending");
        expect(run.calculateProgress()).toBe(0);
        expect(run.tasks).toHaveLength(2);

        const events = run.pullEvents();
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("run_created");
        const createdEvent = events[0] as RunCreatedDomainEvent;
        expect(createdEvent.taskCount).toBe(2);

        // Pulling again returns empty buffer
        expect(run.pullEvents()).toHaveLength(0);
      }
    });

    it("rejects run creation if tasks contain a cycle", () => {
      const t1 = TaskEntity.create({
        id: taskId("t1"),
        name: "Task 1",
        dependencies: [taskId("t2")],
      });
      const t2 = TaskEntity.create({
        id: taskId("t2"),
        name: "Task 2",
        dependencies: [taskId("t1")],
      });

      const runResult = ExecutionRun.create({
        id: runId("run-cycle"),
        goal: "Cyclic workflow",
        workflow: { id: workflowId("wf-1"), name: "Cycle Workflow" },
        tasks: [t1, t2],
      });

      expect(runResult.ok).toBe(false);
      if (!runResult.ok) {
        expect(runResult.error).toBeInstanceOf(DagCycleError);
      }
    });
  });

  describe("Lifecycle State Transitions", () => {
    it("transitions pending -> running and emits run_started event", () => {
      const run = createValidRun();

      const startRes = run.start();
      expect(startRes.ok).toBe(true);
      expect(run.status).toBe("running");

      const events = run.pullEvents();
      expect(events.some((e) => e.type === "run_started")).toBe(true);
    });

    it("enforces INV-RUN-04: rejects completion when tasks are uncompleted", () => {
      const run = createValidRun();

      run.start();
      const compRes = run.complete("Premature finish");
      expect(compRes.ok).toBe(false);
      if (!compRes.ok) {
        expect(compRes.error).toBeInstanceOf(InvalidStateTransitionError);
        expect(compRes.error.message).toContain("not completed");
      }
      expect(run.status).toBe("running");
    });

    it("completes run when all tasks are completed and sets progress to 100%", () => {
      const t1 = TaskEntity.create({ id: taskId("t1"), name: "Task 1" });
      const run = createValidRun("Test run", [t1]);

      run.start();
      run.scheduleTask(taskId("t1"));
      run.startTask(taskId("t1"), workerId("wrk-1"));
      run.completeTask(taskId("t1"), "Artifact produced");

      const compRes = run.complete("Run all done");
      expect(compRes.ok).toBe(true);
      expect(run.status).toBe("completed");
      expect(run.calculateProgress()).toBe(100);

      const events = run.pullEvents();
      expect(events.some((e) => e.type === "run_completed")).toBe(true);
    });

    it("enforces INV-RUN-06: explicit cascading cancellation to non-terminal tasks", () => {
      const t1 = TaskEntity.create({ id: taskId("t1"), name: "Task 1" });
      const t2 = TaskEntity.create({ id: taskId("t2"), name: "Task 2" });
      const t3 = TaskEntity.create({ id: taskId("t3"), name: "Task 3" });

      const run = createValidRun("Cascade test", [t1, t2, t3], runId("run-cascade"));

      run.start();
      // t1: completed before cancel
      run.scheduleTask(taskId("t1"));
      run.startTask(taskId("t1"));
      run.completeTask(taskId("t1"));

      // t2: running when cancel occurs
      run.scheduleTask(taskId("t2"));
      run.startTask(taskId("t2"));

      // t3: still pending when cancel occurs

      // Cancel the run
      const cancelRes = run.cancel("Operator aborted");
      expect(cancelRes.ok).toBe(true);
      expect(run.status).toBe("cancelled");

      // Check task cascade
      expect(run.getTask("t1")?.status).toBe("completed"); // Terminal task remains completed!
      expect(run.getTask("t2")?.status).toBe("cancelled"); // Running task was cancelled
      expect(run.getTask("t3")?.status).toBe("cancelled"); // Pending task was cancelled

      const events = run.pullEvents();
      const taskCancelledEvents = events.filter(
        (e): e is TaskCancelledDomainEvent => e.type === "task_cancelled",
      );
      expect(taskCancelledEvents).toHaveLength(2);
      expect(taskCancelledEvents.map((e) => e.taskId)).toContain("t2");
      expect(taskCancelledEvents.map((e) => e.taskId)).toContain("t3");
      expect(events.some((e) => e.type === "run_cancelled")).toBe(true);
    });

    it("enforces INV-RUN-03: terminal run immutability with TerminalStateError", () => {
      const run = createValidRun("Terminal test", [], runId("run-term"));

      run.start();
      run.complete();
      expect(run.isTerminal()).toBe(true);

      const cancelRes = run.cancel("Attempt cancel on completed");
      expect(cancelRes.ok).toBe(false);
      if (!cancelRes.ok) {
        expect(cancelRes.error).toBeInstanceOf(TerminalStateError);
      }
    });
  });

  describe("Snapshot & Reconstitution", () => {
    it("serializes to snapshot and reconstitutes faithfully", () => {
      const tasks = createSampleTasks();
      const run = createValidRun("Persistence test", tasks, runId("run-reconst"));

      run.start();
      run.scheduleTask(taskId("t1"));
      run.startTask(taskId("t1"));
      run.completeTask(taskId("t1"));

      const snapshot = run.toSnapshot();
      expect(snapshot.id).toBe("run-reconst");
      expect(snapshot.status).toBe("running");
      expect(snapshot.progress).toBe(50);
      expect(snapshot.tasks).toHaveLength(2);
      expect(snapshot.tasks[0]?.status).toBe("completed");

      const reconstituted = ExecutionRun.reconstitute(snapshot);
      expect(reconstituted.id).toBe("run-reconst");
      expect(reconstituted.status).toBe("running");
      expect(reconstituted.calculateProgress()).toBe(50);
      expect(reconstituted.tasks[0]?.status).toBe("completed");
      expect(reconstituted.pullEvents()).toHaveLength(0); // Clean event buffer on reconstitution
    });

    it("records tool_invoked domain event and pulls it cleanly", () => {
      const run = createValidRun();
      run.start();
      run.recordToolInvocation("echo", { text: "hello" }, { echoed: "hello" }, undefined, taskId("t1"));

      const events = run.pullEvents();
      expect(events.some((e) => e.type === "tool_invoked")).toBe(true);

      const toolEvent = events.find((e) => e.type === "tool_invoked");
      expect(toolEvent).toBeDefined();
      if (toolEvent) {
        expect(toolEvent.toolName).toBe("echo");
        expect(toolEvent.input).toEqual({ text: "hello" });
        expect(toolEvent.output).toEqual({ echoed: "hello" });
        expect(toolEvent.taskId).toBe("t1");
      }
    });
  });
});

