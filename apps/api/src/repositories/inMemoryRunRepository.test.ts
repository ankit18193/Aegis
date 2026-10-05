import { runId, taskId, workerId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import { ConcurrencyConflictError, TaskNotFoundError, TerminalStateError } from "../domain/errors.js";

import { InMemoryRunRepository } from "./inMemoryRunRepository.js";

describe("InMemoryRunRepository updateTaskState (Phase 12A)", () => {
  let repository: InMemoryRunRepository;

  beforeEach(() => {
    repository = new InMemoryRunRepository(true);
  });

  it("atomically updates task state and increments version", async () => {
    // Seed task-104 is initially queued with version 1
    const updateRes = await repository.updateTaskState(
      taskId("task-104"),
      {
        status: "running",
        workerId: workerId("worker-node-1"),
        startedAt: "2026-10-05T12:00:00.000Z",
      },
      1,
    );

    expect(updateRes.ok).toBe(true);
    if (updateRes.ok) {
      expect(updateRes.value.newVersion).toBe(2);
    }

    const run = await repository.findById(runId("run-001"));
    const task = run?.tasks.find((t) => t.id === "task-104");
    expect(task).toBeDefined();
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe("worker-node-1");
    expect(task?.version).toBe(2);
  });

  it("rejects update when expectedVersion does not match current version (Concurrency Conflict)", async () => {
    // Current version is 1, caller provides 2
    const conflictRes = await repository.updateTaskState(
      taskId("task-104"),
      { status: "running" },
      2,
    );

    expect(conflictRes.ok).toBe(false);
    if (!conflictRes.ok) {
      expect(conflictRes.error).toBeInstanceOf(ConcurrencyConflictError);
      expect(conflictRes.error.code).toBe("CONCURRENCY_CONFLICT");
      const err = conflictRes.error as ConcurrencyConflictError;
      expect(err.expectedVersion).toBe(2);
      expect(err.actualVersion).toBe(1);
    }
  });

  it("enforces terminal state immutability with TerminalStateError", async () => {
    // 1. Advance queued task-104 to running then completed (version 1 -> 2 -> 3)
    await repository.updateTaskState(taskId("task-104"), { status: "running" }, 1);
    const completeRes = await repository.updateTaskState(
      taskId("task-104"),
      { status: "completed", output: "All done" },
      2,
    );
    expect(completeRes.ok).toBe(true);

    // 2. Attempt to transition completed task back to running
    const illegalRes = await repository.updateTaskState(
      taskId("task-104"),
      { status: "running" },
      3,
    );
    expect(illegalRes.ok).toBe(false);
    if (!illegalRes.ok) {
      expect(illegalRes.error).toBeInstanceOf(TerminalStateError);
      expect(illegalRes.error.code).toBe("TERMINAL_STATE_ERROR");
    }
  });

  it("returns TaskNotFoundError when task ID does not exist", async () => {
    const notFoundRes = await repository.updateTaskState(
      taskId("task-non-existent"),
      { status: "running" },
      1,
    );

    expect(notFoundRes.ok).toBe(false);
    if (!notFoundRes.ok) {
      expect(notFoundRes.error).toBeInstanceOf(TaskNotFoundError);
      expect(notFoundRes.error.code).toBe("TASK_NOT_FOUND");
    }
  });

  it("preserves independent task versions in parallel executions", async () => {
    // task-105 is pending (version 1), task-104 is queued (version 1)
    const res1 = await repository.updateTaskState(taskId("task-105"), { status: "queued" }, 1);
    const res2 = await repository.updateTaskState(taskId("task-104"), { status: "running" }, 1);

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    if (res1.ok) expect(res1.value.newVersion).toBe(2);
    if (res2.ok) expect(res2.value.newVersion).toBe(2);

    // Further update to task-105 advances only task-105
    const res1b = await repository.updateTaskState(taskId("task-105"), { status: "running" }, 2);
    expect(res1b.ok).toBe(true);
    if (res1b.ok) expect(res1b.value.newVersion).toBe(3);

    // task-104 is still at version 2
    const res2b = await repository.updateTaskState(taskId("task-104"), { status: "completed" }, 2);
    expect(res2b.ok).toBe(true);
    if (res2b.ok) expect(res2b.value.newVersion).toBe(3);
  });
});
