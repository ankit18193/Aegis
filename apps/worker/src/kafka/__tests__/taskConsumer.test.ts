import type {
  ITaskExecutor,
  ITaskResultPublisher,
  TaskAssignmentEnvelope,
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
import type { Consumer, EachMessagePayload, KafkaMessage } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskAssignmentHandler } from "../../assignment/handler.js";
import { AssignmentTracker } from "../../assignment/tracker.js";
import { TaskAssignmentValidator } from "../../assignment/validator.js";
import { TaskExecutionService } from "../../execution/executionService.js";
import { WorkerTaskConsumer } from "../taskConsumer.js";

function createMockMessage(overrides: Record<string, unknown> = {}): KafkaMessage {
  return {
    key: null,
    value: null,
    timestamp: "1727827200000",
    attributes: 0,
    offset: "0",
    size: 0,
    ...overrides,
  };
}

describe("WorkerTaskConsumer (Phase 11B — Commit 3)", () => {
  const currentWorkerId = workerId("worker-local-1");
  let mockConsumer: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    commitOffsets: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    events: {
      REBALANCING: string;
      GROUP_JOIN: string;
      CRASH: string;
    };
  };

  let tracker: AssignmentTracker;
  let validator: TaskAssignmentValidator;
  let handler: TaskAssignmentHandler;
  let consumer: WorkerTaskConsumer;

  const validEnvelope: TaskAssignmentEnvelope = {
    id: eventId("assign-evt-1"),
    source: "aegis.workflow.engine",
    type: "task_assigned",
    specVersion: "1.0",
    time: "2026-10-02T00:00:00.000Z",
    aggregateType: "TaskAssignment",
    aggregateId: taskId("task-123"),
    correlationId: "corr-123",
    data: {
      assignmentId: assignmentId("asgn-01J9K0ABCD"),
      taskId: taskId("task-123"),
      runId: runId("run-456"),
      workerId: currentWorkerId,
      task: {
        id: taskId("task-123"),
        name: "test_task",
        status: "queued",
        description: "",
        attemptCount: 0,
        input: { key: "value" },
      },
      assignedAt: "2026-10-02T00:00:00.000Z",
    },
  };

  beforeEach(() => {
    mockConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      commitOffsets: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      events: {
        REBALANCING: "consumer.rebalancing",
        GROUP_JOIN: "consumer.group_join",
        CRASH: "consumer.crash",
      },
    };

    tracker = new AssignmentTracker();
    validator = new TaskAssignmentValidator({
      workerId: currentWorkerId,
      capabilities: {
        taskTypes: ["*"],
        tools: [],
        maxConcurrency: 1,
      },
    });
    handler = new TaskAssignmentHandler({
      validator,
      tracker,
    });

    consumer = new WorkerTaskConsumer({
      consumer: mockConsumer as unknown as Consumer,
      topic: "aegis.tasks.assign",
      handler,
    });
  });

  it("connects and subscribes to topic on start()", async () => {
    const res = await consumer.start();
    expect(res.ok).toBe(true);
    expect(mockConsumer.connect).toHaveBeenCalledTimes(1);
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topic: "aegis.tasks.assign",
      fromBeginning: false,
    });
    expect(mockConsumer.run).toHaveBeenCalledWith(
      expect.objectContaining({ autoCommit: false }),
    );
    expect(consumer.isRunning).toBe(true);
  });

  it("stops and disconnects consumer on stop()", async () => {
    await consumer.start();
    const res = await consumer.stop();
    expect(res.ok).toBe(true);
    expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
    expect(consumer.isRunning).toBe(false);
  });

  it("processes a valid targeted assignment and commits offset", async () => {
    const payload: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockMessage({
        key: Buffer.from("task-123"),
        value: Buffer.from(JSON.stringify(validEnvelope)),
        offset: "100",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const committed = await consumer.processMessage(payload);
    expect(committed).toBe(true);
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
      {
        topic: "aegis.tasks.assign",
        partition: 0,
        offset: "101",
      },
    ]);

    expect(tracker.isDuplicate("asgn-01J9K0ABCD")).toBe(true);
    expect(tracker.get("asgn-01J9K0ABCD")?.status).toBe("accepted");
  });

  it("quarantines empty message and commits offset to avoid head-of-line blocking", async () => {
    const payload: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 1,
      message: createMockMessage({
        key: null,
        value: null,
        offset: "205",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const committed = await consumer.processMessage(payload);
    expect(committed).toBe(true);
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
      {
        topic: "aegis.tasks.assign",
        partition: 1,
        offset: "206",
      },
    ]);
  });

  it("quarantines poison pill (malformed JSON) and commits offset", async () => {
    const payload: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 2,
      message: createMockMessage({
        key: null,
        value: Buffer.from("malformed { not valid json"),
        offset: "300",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const committed = await consumer.processMessage(payload);
    expect(committed).toBe(true);
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
      {
        topic: "aegis.tasks.assign",
        partition: 2,
        offset: "301",
      },
    ]);
  });

  it("does NOT commit offset for wrong-worker assignment (ignored_not_targeted) to prevent losing work in shared group", async () => {
    const wrongWorkerEnvelope: TaskAssignmentEnvelope = {
      ...validEnvelope,
      data: {
        ...validEnvelope.data,
        assignmentId: assignmentId("asgn-diff-worker"),
        workerId: workerId("worker-different-99"),
      },
    };

    const payload: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockMessage({
        key: Buffer.from("task-123"),
        value: Buffer.from(JSON.stringify(wrongWorkerEnvelope)),
        offset: "400",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const committed = await consumer.processMessage(payload);
    expect(committed).toBe(false);
    // Offset must NOT be committed so other workers in shared group can consume it
    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    // And it must NOT be recorded as accepted
    expect(tracker.isDuplicate("asgn-diff-worker")).toBe(false);
  });

  it("suppresses duplicate assignment and commits offset", async () => {
    const payload: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockMessage({
        key: Buffer.from("task-123"),
        value: Buffer.from(JSON.stringify(validEnvelope)),
        offset: "500",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    // First arrival
    const firstCommitted = await consumer.processMessage(payload);
    expect(firstCommitted).toBe(true);

    mockConsumer.commitOffsets.mockClear();

    // Duplicate redelivery
    const duplicatePayload: EachMessagePayload = {
      ...payload,
      message: createMockMessage({
        ...payload.message,
        offset: "501",
      }),
    };

    const secondCommitted = await consumer.processMessage(duplicatePayload);
    expect(secondCommitted).toBe(true);
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
      {
        topic: "aegis.tasks.assign",
        partition: 0,
        offset: "502",
      },
    ]);
  });

  describe("TaskExecutionService integration (Phase 11C)", () => {
    const sampleExecResult: TaskExecutionResult = {
      taskId: validEnvelope.data.taskId,
      runId: validEnvelope.data.runId,
      assignmentId: validEnvelope.data.assignmentId,
      workerId: currentWorkerId,
      status: "SUCCEEDED",
      output: { summary: "ok" },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const sampleResultEnvelope: TaskResultEnvelope = {
      id: eventId("evt-result-test-1"),
      source: `aegis.worker.${currentWorkerId}`,
      type: "task_result",
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateType: "TaskResult",
      aggregateId: validEnvelope.data.taskId,
      correlationId: validEnvelope.correlationId,
      causationId: validEnvelope.id,
      data: sampleExecResult,
    };

    it("executes accepted assignment and commits offset strictly after result is published", async () => {
      const mockExecute = vi.fn().mockResolvedValue(sampleExecResult);
      const mockPublish = vi.fn().mockResolvedValue(ok(sampleResultEnvelope));
      const mockExecutor: ITaskExecutor = {
        execute: mockExecute,
      };
      const mockPublisher: ITaskResultPublisher = {
        publish: mockPublish,
      };

      const executionService = new TaskExecutionService({
        workerId: currentWorkerId,
        executor: mockExecutor,
        publisher: mockPublisher,
      });

      const consumerWithExec = new WorkerTaskConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.tasks.assign",
        handler,
        executionService,
      });

      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 0,
        message: createMockMessage({
          key: Buffer.from("task-123"),
          value: Buffer.from(JSON.stringify(validEnvelope)),
          offset: "600",
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const committed = await consumerWithExec.processMessage(payload);
      expect(committed).toBe(true);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        {
          topic: "aegis.tasks.assign",
          partition: 0,
          offset: "601",
        },
      ]);
    });

    it("leaves offset uncommitted if result publication fails", async () => {
      const mockExecute = vi.fn().mockResolvedValue(sampleExecResult);
      const publishError = createTaskExecutionError(
        "TASK_RESULT_PUBLICATION_FAILED",
        "Broker disconnected",
      );
      const mockPublish = vi.fn().mockResolvedValue(err(publishError));
      const mockExecutor: ITaskExecutor = {
        execute: mockExecute,
      };
      const mockPublisher: ITaskResultPublisher = {
        publish: mockPublish,
      };

      const executionService = new TaskExecutionService({
        workerId: currentWorkerId,
        executor: mockExecutor,
        publisher: mockPublisher,
      });

      const consumerWithExec = new WorkerTaskConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.tasks.assign",
        handler,
        executionService,
      });

      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 0,
        message: createMockMessage({
          key: Buffer.from("task-123"),
          value: Buffer.from(JSON.stringify(validEnvelope)),
          offset: "700",
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const committed = await consumerWithExec.processMessage(payload);
      expect(committed).toBe(false);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockPublish).toHaveBeenCalledTimes(1);
      // Offset must NOT be committed
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    });

    it("drains executionService when stopping", async () => {
      const mockExecutor: ITaskExecutor = {
        execute: vi.fn().mockResolvedValue(sampleExecResult),
      };
      const mockPublisher: ITaskResultPublisher = {
        publish: vi.fn().mockResolvedValue(ok(sampleResultEnvelope)),
      };

      const executionService = new TaskExecutionService({
        workerId: currentWorkerId,
        executor: mockExecutor,
        publisher: mockPublisher,
      });

      const drainSpy = vi.spyOn(executionService, "drain");

      const consumerWithExec = new WorkerTaskConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.tasks.assign",
        handler,
        executionService,
        drainTimeoutMs: 500,
      });

      await consumerWithExec.start();
      await consumerWithExec.stop();

      expect(drainSpy).toHaveBeenCalledWith(500);
    });
  });
});

