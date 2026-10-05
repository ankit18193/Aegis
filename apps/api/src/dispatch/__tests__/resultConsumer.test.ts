import type { TaskResultEnvelope } from "@aegis/contracts";
import { assignmentId, eventId, runId, taskId, workerId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryRunRepository } from "../../repositories/inMemoryRunRepository.js";
import { TaskResultConsumer } from "../resultConsumer.js";

describe("TaskResultConsumer (Phase 12A)", () => {
  let repository: InMemoryRunRepository;
  let consumer: TaskResultConsumer;

  beforeEach(async () => {
    repository = new InMemoryRunRepository(true);
    consumer = new TaskResultConsumer({
      runRepository: repository,
    });

    // Advance task-104 to running so it can transition to completed/failed
    await repository.updateTaskState(
      taskId("task-104"),
      {
        status: "running",
        workerId: workerId("worker-node-1"),
        startedAt: "2026-10-05T12:00:00.000Z",
      },
      1,
    );
  });

  it("processes SUCCEEDED task result and updates task to completed with output", async () => {
    const envelope: TaskResultEnvelope = {
      id: eventId("evt-res-1"),
      type: "task_result",
      source: "aegis/worker/worker-node-1",
      specVersion: "1.0",
      time: "2026-10-05T12:05:00.000Z",
      aggregateId: taskId("task-104"),
      aggregateType: "TaskResult",
      correlationId: "corr-123",
      data: {
        taskId: taskId("task-104"),
        runId: runId("run-001"),
        assignmentId: assignmentId("asgn-104"),
        workerId: workerId("worker-node-1"),
        status: "SUCCEEDED",
        startedAt: "2026-10-05T12:00:00.000Z",
        completedAt: "2026-10-05T12:05:00.000Z",
        output: { processedItems: 100, status: "OK" },
      },
    };

    const handled = await consumer.handleMessage(envelope);
    expect(handled).toBe(true);

    const run = await repository.findById(runId("run-001"));
    const task = run?.tasks.find((t) => t.id === "task-104");
    expect(task).toBeDefined();
    expect(task?.status).toBe("completed");
    expect(task?.version).toBe(3); // 1 (queued) -> 2 (running) -> 3 (completed)
    expect(task?.completedAt).toBe("2026-10-05T12:05:00.000Z");
    expect(task?.output).toContain("processedItems");
  });

  it("processes FAILED task result and updates task to failed with error details", async () => {
    const envelope: TaskResultEnvelope = {
      id: eventId("evt-res-2"),
      type: "task_result",
      source: "aegis/worker/worker-node-1",
      specVersion: "1.0",
      time: "2026-10-05T12:06:00.000Z",
      aggregateId: taskId("task-104"),
      aggregateType: "TaskResult",
      correlationId: "corr-124",
      data: {
        taskId: taskId("task-104"),
        runId: runId("run-001"),
        assignmentId: assignmentId("asgn-104"),
        workerId: workerId("worker-node-1"),
        status: "FAILED",
        startedAt: "2026-10-05T12:00:00.000Z",
        completedAt: "2026-10-05T12:06:00.000Z",
        error: {
          code: "TASK_RUNTIME_ERROR",
          message: "Unhandled NullPointerException in agent executor",
        },
      },
    };

    const handled = await consumer.handleMessage(JSON.stringify(envelope));
    expect(handled).toBe(true);

    const run = await repository.findById(runId("run-001"));
    const task = run?.tasks.find((t) => t.id === "task-104");
    expect(task?.status).toBe("failed");
    expect(task?.version).toBe(3);
    expect(task?.error).toBe("Unhandled NullPointerException in agent executor");
  });

  it("safely ignores malformed or unparseable messages", async () => {
    const emptyHandled = await consumer.handleMessage("");
    expect(emptyHandled).toBe(false);

    const garbageHandled = await consumer.handleMessage("not-json");
    expect(garbageHandled).toBe(false);

    const invalidEnvelopeHandled = await consumer.handleMessage(
      JSON.stringify({ type: "unknown", data: {} }),
    );
    expect(invalidEnvelopeHandled).toBe(false);
  });

  it("returns false when target run or task does not exist", async () => {
    const envelope: TaskResultEnvelope = {
      id: eventId("evt-res-3"),
      type: "task_result",
      source: "aegis/worker/worker-1",
      specVersion: "1.0",
      time: "2026-10-05T12:05:00.000Z",
      aggregateId: taskId("task-missing"),
      aggregateType: "TaskResult",
      correlationId: "corr-125",
      data: {
        taskId: taskId("task-missing"),
        runId: runId("run-001"),
        assignmentId: assignmentId("asgn-missing"),
        workerId: workerId("worker-1"),
        status: "SUCCEEDED",
        startedAt: "2026-10-05T12:00:00.000Z",
        completedAt: "2026-10-05T12:05:00.000Z",
      },
    };

    const handled = await consumer.handleMessage(envelope);
    expect(handled).toBe(false);
  });

  it("gracefully ignores duplicate completion on terminal task without crashing", async () => {
    // 1. First completion succeeds
    const envelope: TaskResultEnvelope = {
      id: eventId("evt-res-4"),
      type: "task_result",
      source: "aegis/worker/worker-1",
      specVersion: "1.0",
      time: "2026-10-05T12:05:00.000Z",
      aggregateId: taskId("task-104"),
      aggregateType: "TaskResult",
      correlationId: "corr-126",
      data: {
        taskId: taskId("task-104"),
        runId: runId("run-001"),
        assignmentId: assignmentId("asgn-104"),
        workerId: workerId("worker-1"),
        status: "SUCCEEDED",
        startedAt: "2026-10-05T12:00:00.000Z",
        completedAt: "2026-10-05T12:05:00.000Z",
      },
    };

    const firstHandled = await consumer.handleMessage(envelope);
    expect(firstHandled).toBe(true);

    // 2. Duplicate second completion arrives
    const secondHandled = await consumer.handleMessage(envelope);
    expect(secondHandled).toBe(false); // Gracefully rejected due to TerminalStateError

    // Status remains completed, not corrupted
    const run = await repository.findById(runId("run-001"));
    const task = run?.tasks.find((t) => t.id === "task-104");
    expect(task?.status).toBe("completed");
  });
});
