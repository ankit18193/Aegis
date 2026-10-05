import type {
  ITaskExecutor,
  ITaskResultPublisher,
  TaskAssignment,
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultEnvelope,
} from "@aegis/contracts";
import { createTaskExecutionError } from "@aegis/contracts";
import {
  assignmentId,
  err,
  eventId,
  ok,
  runId,
  taskId,
  workerId,
} from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import { TaskExecutionService } from "../executionService.js";

describe("TaskExecutionService", () => {
  const currentWorkerId = workerId("worker-svc-1");

  const sampleAssignment: TaskAssignment = {
    assignmentId: assignmentId("asgn-svc-123"),
    taskId: taskId("task-svc-456"),
    runId: runId("run-svc-789"),
    workerId: currentWorkerId,
    task: {
      id: taskId("task-svc-456"),
      name: "generate_summary",
      status: "queued",
      description: "Generate summary task",
      attemptCount: 0,
      version: 1,
      input: { prompt: "Hello world" },
    },
    assignedAt: new Date().toISOString(),
  };

  const sampleExecResult: TaskExecutionResult = {
    taskId: sampleAssignment.taskId,
    runId: sampleAssignment.runId,
    assignmentId: sampleAssignment.assignmentId,
    workerId: currentWorkerId,
    status: "SUCCEEDED",
    output: { text: "Generated result" },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };

  const sampleResultEnvelope: TaskResultEnvelope = {
    id: eventId("evt-result-123"),
    source: `aegis.worker.${currentWorkerId}`,
    type: "task_result",
    specVersion: "1.0",
    time: new Date().toISOString(),
    aggregateType: "TaskResult",
    aggregateId: sampleAssignment.taskId,
    correlationId: "corr-123",
    causationId: "cause-123",
    data: sampleExecResult,
  };

  it("coordinates execution and publication successfully", async () => {
    const mockExecute = vi.fn().mockResolvedValue(sampleExecResult);
    const mockPublish = vi.fn().mockResolvedValue(ok(sampleResultEnvelope));
    const mockExecutor: ITaskExecutor = {
      execute: mockExecute,
    };
    const mockPublisher: ITaskResultPublisher = {
      publish: mockPublish,
    };

    const service = new TaskExecutionService({
      workerId: currentWorkerId,
      executor: mockExecutor,
      publisher: mockPublisher,
      maxConcurrentTasks: 2,
    });

    const result = await service.executeAndReport(sampleAssignment, {
      correlationId: "corr-123",
      causationId: "cause-123",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(sampleExecResult);
    }

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(
      sampleAssignment,
      expect.objectContaining({
        workerId: currentWorkerId,
        taskId: sampleAssignment.taskId,
        runId: sampleAssignment.runId,
        assignmentId: sampleAssignment.assignmentId,
      }),
    );

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(sampleExecResult, {
      correlationId: "corr-123",
      causationId: "cause-123",
    });
  });

  it("returns error if publisher fails and reports failure", async () => {
    const mockExecutor: ITaskExecutor = {
      execute: vi.fn().mockResolvedValue(sampleExecResult),
    };
    const publishError: TaskExecutionError = createTaskExecutionError(
      "TASK_RESULT_PUBLICATION_FAILED",
      "Kafka broker unreachable",
    );
    const mockPublisher: ITaskResultPublisher = {
      publish: vi.fn().mockResolvedValue(err(publishError)),
    };

    const service = new TaskExecutionService({
      workerId: currentWorkerId,
      executor: mockExecutor,
      publisher: mockPublisher,
    });

    const result = await service.executeAndReport(sampleAssignment, {
      correlationId: "corr-123",
      causationId: "cause-123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_RESULT_PUBLICATION_FAILED");
      expect(result.error.message).toContain("Kafka broker unreachable");
    }
  });

  it("rejects new executions when draining", async () => {
    const mockExecutor: ITaskExecutor = {
      execute: vi.fn().mockResolvedValue(sampleExecResult),
    };
    const mockPublisher: ITaskResultPublisher = {
      publish: vi.fn().mockResolvedValue(ok(sampleResultEnvelope)),
    };

    const service = new TaskExecutionService({
      workerId: currentWorkerId,
      executor: mockExecutor,
      publisher: mockPublisher,
    });

    // Initiate drain
    const drainPromise = service.drain(100);
    expect(service.isDraining).toBe(true);

    const result = await service.executeAndReport(sampleAssignment, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_EXECUTION_FAILED");
      expect(result.error.message).toContain("draining");
    }

    await drainPromise;
  });

  it("gracefully drains in-flight executions", async () => {
    let resolveExec!: () => void;
    const execPromise = new Promise<TaskExecutionResult>((res) => {
      resolveExec = () => res(sampleExecResult);
    });

    const mockExecutor: ITaskExecutor = {
      execute: vi.fn().mockReturnValue(execPromise),
    };
    const mockPublisher: ITaskResultPublisher = {
      publish: vi.fn().mockResolvedValue(ok(sampleResultEnvelope)),
    };

    const service = new TaskExecutionService({
      workerId: currentWorkerId,
      executor: mockExecutor,
      publisher: mockPublisher,
    });

    const inFlightPromise = service.executeAndReport(sampleAssignment, {});
    expect(service.activeExecutionCount).toBe(1);

    const drainPromise = service.drain(500);

    // After a short delay, complete the execution
    setTimeout(() => {
      resolveExec();
    }, 50);

    const [execOutcome] = await Promise.all([inFlightPromise, drainPromise]);
    expect(execOutcome.ok).toBe(true);
    expect(service.activeExecutionCount).toBe(0);
  });
});
