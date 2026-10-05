import type { TaskAssignmentEnvelope } from "@aegis/contracts";
import { assignmentId, eventId, runId, taskId, workerId } from "@aegis/types";
import type { Consumer, EachMessagePayload, KafkaMessage } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskAssignmentHandler } from "../assignment/handler.js";
import { AssignmentTracker } from "../assignment/tracker.js";
import { TaskAssignmentValidator } from "../assignment/validator.js";
import { WorkerTaskConsumer } from "../kafka/taskConsumer.js";
import { createWorkerFromConfig } from "../worker/bootstrap.js";

function createMockKafkaMessage(overrides: Record<string, unknown> = {}): KafkaMessage {
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

describe("Distributed Task Assignment End-to-End Integration (Phase 11B — Commit 5)", () => {
  const currentWorkerId = workerId("worker-integration-1");
  let mockKafkaConsumer: {
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
  let taskConsumer: WorkerTaskConsumer;

  const validEnvelope: TaskAssignmentEnvelope = {
    id: eventId("assign-evt-e2e-1"),
    source: "aegis.workflow.engine",
    type: "task_assigned",
    specVersion: "1.0",
    time: "2026-10-02T00:00:00.000Z",
    aggregateType: "TaskAssignment",
    aggregateId: taskId("task-e2e-100"),
    correlationId: "corr-e2e-100",
    data: {
      assignmentId: assignmentId("asgn-e2e-alpha"),
      taskId: taskId("task-e2e-100"),
      runId: runId("run-e2e-200"),
      workerId: currentWorkerId,
      task: {
        id: taskId("task-e2e-100"),
        name: "data_analysis",
        status: "queued",
        description: "Analyze dataset",
        attemptCount: 0,
        version: 1,
        input: { dataset: "sales_q3.csv" },
      },
      assignedAt: "2026-10-02T00:00:00.000Z",
    },
  };

  beforeEach(() => {
    mockKafkaConsumer = {
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

    tracker = new AssignmentTracker({ maxCapacity: 100 });
    validator = new TaskAssignmentValidator({
      workerId: currentWorkerId,
      capabilities: {
        taskTypes: ["data_analysis", "report_generation"],
        tools: ["calculator", "file_reader"],
        maxConcurrency: 1,
      },
    });
    handler = new TaskAssignmentHandler({
      validator,
      tracker,
    });

    taskConsumer = new WorkerTaskConsumer({
      consumer: mockKafkaConsumer as unknown as Consumer,
      topic: "aegis.tasks.assign",
      handler,
    });
  });

  it("coordinates worker runtime lifecycle and executes full task assignment consumption matrix", async () => {
    // 1. Bootstrap worker runtime with attached consumer
    const runtime = createWorkerFromConfig({
      config: {
        workerId: currentWorkerId,
        workerName: "IntegrationWorker-1",
        maxConcurrency: 1,
        taskTypes: ["data_analysis", "report_generation"],
        tools: ["calculator", "file_reader"],
        shutdownTimeoutMs: 10000,
        kafkaBrokers: ["localhost:9092"],
        taskAssignmentTopic: "aegis.tasks.assign",
        workerConsumerGroupId: "aegis-workers",
        taskResultTopic: "aegis.tasks.results",
        maxConcurrentTasks: 1,
        workerHeartbeatIntervalMs: 10000,
        workerHeartbeatTimeoutMs: 30000,
        workerHeartbeatTopic: "aegis.workers.heartbeat",
        workerPresenceConsumerGroup: "aegis-worker-presence",
      },
      consumer: taskConsumer,
    });

    expect(runtime.getState()).toBe("starting");

    // 2. Start worker runtime -> starts consumer
    const startRes = await runtime.start();
    expect(startRes.ok).toBe(true);
    expect(runtime.getState()).toBe("ready");
    expect(runtime.isRunning).toBe(true);
    expect(taskConsumer.isRunning).toBe(true);
    expect(mockKafkaConsumer.connect).toHaveBeenCalledTimes(1);
    expect(mockKafkaConsumer.subscribe).toHaveBeenCalledWith({
      topic: "aegis.tasks.assign",
      fromBeginning: false,
    });

    // 3. Process valid targeted assignment
    const msg1: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        offset: "100",
        value: Buffer.from(JSON.stringify(validEnvelope)),
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const res1 = await taskConsumer.processMessage(msg1);
    expect(res1).toBe(true);
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: "aegis.tasks.assign", partition: 0, offset: "101" },
    ]);
    expect(tracker.isDuplicate("asgn-e2e-alpha")).toBe(true);
    expect(tracker.get("asgn-e2e-alpha")?.status).toBe("accepted");

    // 4. Duplicate assignment arrival -> suppressed and offset committed
    mockKafkaConsumer.commitOffsets.mockClear();
    const msg2: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        offset: "101",
        value: Buffer.from(JSON.stringify(validEnvelope)),
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const res2 = await taskConsumer.processMessage(msg2);
    expect(res2).toBe(true);
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: "aegis.tasks.assign", partition: 0, offset: "102" },
    ]);

    // 5. Wrong-worker assignment -> ignored_not_targeted, offset NOT committed (Phase 11C shared group rule)
    mockKafkaConsumer.commitOffsets.mockClear();
    const wrongWorkerEnvelope: TaskAssignmentEnvelope = {
      ...validEnvelope,
      id: eventId("assign-evt-wrong-worker"),
      data: {
        ...validEnvelope.data,
        assignmentId: assignmentId("asgn-e2e-beta"),
        workerId: workerId("worker-other-99"),
      },
    };
    const msg3: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 1,
      message: createMockKafkaMessage({
        offset: "200",
        value: Buffer.from(JSON.stringify(wrongWorkerEnvelope)),
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const res3 = await taskConsumer.processMessage(msg3);
    expect(res3).toBe(false);
    expect(mockKafkaConsumer.commitOffsets).not.toHaveBeenCalled();
    // Must NOT be accepted in tracker
    expect(tracker.isDuplicate("asgn-e2e-beta")).toBe(false);

    // 6. Capability mismatch -> rejected with status recorded, offset committed
    mockKafkaConsumer.commitOffsets.mockClear();
    const unsupportedTaskEnvelope: TaskAssignmentEnvelope = {
      ...validEnvelope,
      id: eventId("assign-evt-unsupported"),
      data: {
        ...validEnvelope.data,
        assignmentId: assignmentId("asgn-e2e-gamma"),
        task: {
          ...validEnvelope.data.task,
          id: taskId("task-unsupported-1"),
          name: "unsupported_video_encoding",
        },
      },
    };
    const msg4: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        offset: "300",
        value: Buffer.from(JSON.stringify(unsupportedTaskEnvelope)),
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const res4 = await taskConsumer.processMessage(msg4);
    expect(res4).toBe(true);
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: "aegis.tasks.assign", partition: 0, offset: "301" },
    ]);
    expect(tracker.get("asgn-e2e-gamma")?.status).toBe("rejected");

    // 7. Poison pill (malformed JSON) -> quarantined and offset committed
    mockKafkaConsumer.commitOffsets.mockClear();
    const msg5: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        offset: "400",
        value: Buffer.from("{ malformed json"),
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const res5 = await taskConsumer.processMessage(msg5);
    expect(res5).toBe(true);
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: "aegis.tasks.assign", partition: 0, offset: "401" },
    ]);

    // 8. Graceful shutdown -> stops consumer and transitions runtime to stopped
    const stopRes = await runtime.stop();
    expect(stopRes.ok).toBe(true);
    expect(runtime.getState()).toBe("stopped");
    expect(taskConsumer.isRunning).toBe(false);
    expect(mockKafkaConsumer.stop).toHaveBeenCalledTimes(1);
    expect(mockKafkaConsumer.disconnect).toHaveBeenCalledTimes(1);
  });
});
