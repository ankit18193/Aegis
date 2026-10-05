import { taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { ConcurrencyConflictError, TerminalStateError } from "./errors.js";
import { TaskEntity } from "./task.js";

describe("TaskEntity Durable Execution (Phase 12A)", () => {
  it("initializes new task with version 1 and zero attemptCount", () => {
    const task = TaskEntity.create({
      id: taskId("task-1"),
      name: "Compute embedding",
    });

    expect(task.version).toBe(1);
    expect(task.attemptCount).toBe(0);
    expect(task.status).toBe("pending");
    expect(task.workerId).toBeUndefined();
  });

  it("monotonically increments version on each legal state transition", () => {
    const task = TaskEntity.create({
      id: taskId("task-1"),
      name: "ETL Job",
    });
    expect(task.version).toBe(1);

    // 1. Pending -> Queued
    const queuedRes = task.markQueued();
    expect(queuedRes.ok).toBe(true);
    expect(task.status).toBe("queued");
    expect(task.version).toBe(2);

    // 2. Queued -> Running
    const startRes = task.start(workerId("worker-alpha"), "2026-10-05T10:00:00.000Z");
    expect(startRes.ok).toBe(true);
    expect(task.status).toBe("running");
    expect(task.workerId).toBe("worker-alpha");
    expect(task.version).toBe(3);
    expect(task.attemptCount).toBe(1);

    // 3. Running -> Completed
    const completeRes = task.complete("done", "2026-10-05T10:05:00.000Z");
    expect(completeRes.ok).toBe(true);
    expect(task.status).toBe("completed");
    expect(task.version).toBe(4);
    expect(task.output).toBe("done");
  });

  it("increments version on task failure and cancellation", () => {
    const task1 = TaskEntity.create({ id: taskId("t-fail"), name: "Task 1" });
    task1.markQueued();
    task1.start(workerId("worker-1"));
    const failRes = task1.fail("Memory limit exceeded");
    expect(failRes.ok).toBe(true);
    expect(task1.status).toBe("failed");
    expect(task1.version).toBe(4);
    expect(task1.error).toBe("Memory limit exceeded");

    const task2 = TaskEntity.create({ id: taskId("t-cancel"), name: "Task 2" });
    const cancelRes = task2.cancel("User aborted");
    expect(cancelRes.ok).toBe(true);
    expect(task2.status).toBe("cancelled");
    expect(task2.version).toBe(2);
  });

  it("preserves version and workerId across snapshot and reconstitution", () => {
    const original = TaskEntity.create({
      id: taskId("task-snap"),
      name: "Transform Data",
    });
    original.markQueued();
    original.start(workerId("worker-node-42"));

    const snapshot = original.toSnapshot();
    expect(snapshot.version).toBe(3);
    expect(snapshot.workerId).toBe("worker-node-42");

    const reconstituted = TaskEntity.reconstitute(snapshot);
    expect(reconstituted.version).toBe(3);
    expect(reconstituted.workerId).toBe("worker-node-42");
    expect(reconstituted.status).toBe("running");
  });

  it("enforces terminal state immutability on completed task", () => {
    const task = TaskEntity.create({ id: taskId("t-terminal"), name: "Done Task" });
    task.markQueued();
    task.start();
    task.complete("result");

    expect(task.isTerminal()).toBe(true);
    const retryStart = task.start();
    expect(retryStart.ok).toBe(false);
    if (!retryStart.ok) {
      expect(retryStart.error).toBeInstanceOf(TerminalStateError);
      expect(retryStart.error.code).toBe("TERMINAL_STATE_ERROR");
    }
  });

  it("instantiates ConcurrencyConflictError with structured details", () => {
    const error = new ConcurrencyConflictError("task-42", 5, 6);
    expect(error.code).toBe("CONCURRENCY_CONFLICT");
    expect(error.taskId).toBe("task-42");
    expect(error.expectedVersion).toBe(5);
    expect(error.actualVersion).toBe(6);
    expect(error.message).toContain("expected version 5, actual version is 6");
  });
});
