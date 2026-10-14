import type { TaskResultEnvelope } from "@aegis/contracts";
import { assignmentId, eventId, runId, taskId, workerId, workflowId } from "@aegis/types";
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
      source: "aegis/worker/worker-node-1",
      specVersion: "1.0",
      time: "2026-10-05T12:05:00.000Z",
      aggregateId: taskId("task-104"),
      aggregateType: "TaskResult",
      correlationId: "corr-126",
      data: {
        taskId: taskId("task-104"),
        runId: runId("run-001"),
        assignmentId: assignmentId("asgn-104"),
        workerId: workerId("worker-node-1"),
        status: "SUCCEEDED",
        startedAt: "2026-10-05T12:00:00.000Z",
        completedAt: "2026-10-05T12:05:00.000Z",
      },
    };

    const firstHandled = await consumer.handleMessage(envelope);
    expect(firstHandled).toBe(true);

    // 2. Duplicate second completion arrives
    const secondHandled = await consumer.handleMessage(envelope);
    expect(secondHandled).toBe(false); // Gracefully rejected due to task no longer being running

    // Status remains completed, not corrupted
    const run = await repository.findById(runId("run-001"));
    const task = run?.tasks.find((t) => t.id === "task-104");
    expect(task?.status).toBe("completed");
  });

  it("strictly rejects late result from superseded worker after task reassignment (Lock 9)", async () => {
    // Save a run where task-reassign is currently running under worker-node-2
    const now = new Date().toISOString();
    await repository.save({
      id: runId("run-reassign-test"),
      goal: "Test late result rejection",
      status: "running",
      progress: 50,
      createdAt: now,
      updatedAt: now,
      workflow: {
        id: workflowId("wf-test"),
        name: "Test Workflow",
        tasks: [
          {
            id: taskId("task-reassign-test"),
            name: "Test Task",
            status: "running",
            description: "Test task",
            worker: workerId("worker-node-2"),
            workerId: workerId("worker-node-2"),
            version: 2,
            attemptCount: 2,
          },
        ],
      },
      tasks: [
        {
          id: taskId("task-reassign-test"),
          name: "Test Task",
          status: "running",
          description: "Test task",
          worker: workerId("worker-node-2"),
          workerId: workerId("worker-node-2"),
          version: 2,
          attemptCount: 2,
        },
      ],
    });

    // Stale result arrives late from worker-node-1 (superseded worker)
    const lateEnvelope: TaskResultEnvelope = {
      id: eventId("evt-res-late-1"),
      type: "task_result",
      source: "aegis/worker/worker-node-1",
      specVersion: "1.0",
      time: "2026-10-05T12:15:00.000Z",
      aggregateId: taskId("task-reassign-test"),
      aggregateType: "TaskResult",
      correlationId: "corr-late",
      data: {
        taskId: taskId("task-reassign-test"),
        runId: runId("run-reassign-test"),
        assignmentId: assignmentId("asgn-late"),
        workerId: workerId("worker-node-1"), // superseded worker!
        status: "SUCCEEDED",
        startedAt: "2026-10-05T12:00:00.000Z",
        completedAt: "2026-10-05T12:15:00.000Z",
        output: { result: "late output from dead worker" },
      },
    };

    const handled = await consumer.handleMessage(lateEnvelope);
    expect(handled).toBe(false);

    // Task remains running under worker-node-2, unmodified
    const run = await repository.findById(runId("run-reassign-test"));
    const task = run?.tasks.find((t) => t.id === "task-reassign-test");
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe("worker-node-2");
    expect(task?.version).toBe(2);
  });

  it("strictly rejects result when task is not in running state (e.g. pending)", async () => {
    // task-105 in run-001 has status: "pending"
    const envelope: TaskResultEnvelope = {
      id: eventId("evt-res-pending"),
      type: "task_result",
      source: "aegis/worker/worker-node-1",
      specVersion: "1.0",
      time: "2026-10-05T12:05:00.000Z",
      aggregateId: taskId("task-105"),
      aggregateType: "TaskResult",
      correlationId: "corr-pending",
      data: {
        taskId: taskId("task-105"),
        runId: runId("run-001"),
        assignmentId: assignmentId("asgn-105"),
        workerId: workerId("worker-node-1"),
        status: "SUCCEEDED",
        startedAt: "2026-10-05T12:00:00.000Z",
        completedAt: "2026-10-05T12:05:00.000Z",
      },
    };

    const handled = await consumer.handleMessage(envelope);
    expect(handled).toBe(false);

    const run = await repository.findById(runId("run-001"));
    const task = run?.tasks.find((t) => t.id === "task-105");
    expect(task?.status).toBe("pending");
  });
});
