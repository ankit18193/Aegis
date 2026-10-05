import {
  DefaultActionExecutor,
  DeterministicPlanner,
} from "@aegis/agent-runtime";
import type { TaskAssignmentEnvelope, TaskResultEnvelope } from "@aegis/contracts";
import {
  assignmentId,
  eventId,
  ok,
  runId,
  taskId,
  workerId,
} from "@aegis/types";
import type {
  Consumer,
  EachMessagePayload,
  KafkaMessage,
  Producer,
  ProducerRecord,
} from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskAssignmentHandler } from "../assignment/handler.js";
import { AssignmentTracker } from "../assignment/tracker.js";
import { TaskAssignmentValidator } from "../assignment/validator.js";
import { TaskExecutionService } from "../execution/executionService.js";
import { TaskExecutor } from "../execution/taskExecutor.js";
import { WorkerTaskConsumer } from "../kafka/taskConsumer.js";
import { KafkaTaskResultPublisher } from "../results/kafkaPublisher.js";

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

describe("Worker Task Execution & Result Reporting End-to-End Integration (Phase 11C — Commit 5)", () => {
  const currentWorkerId = workerId("worker-node-11c");
  const currentTaskId = taskId("task-11c-100");
  const currentRunId = runId("run-11c-200");
  const currentAssignmentId = assignmentId("asgn-11c-300");

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

  let mockKafkaProducer: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };

  let publishedRecords: ProducerRecord[];
  let tracker: AssignmentTracker;
  let validator: TaskAssignmentValidator;
  let handler: TaskAssignmentHandler;

  const validEnvelope: TaskAssignmentEnvelope = {
    id: eventId("assign-evt-11c-1"),
    source: "aegis.workflow.engine",
    type: "task_assigned",
    specVersion: "1.0",
    time: "2026-10-02T00:00:00.000Z",
    aggregateType: "TaskAssignment",
    aggregateId: currentTaskId,
    correlationId: "corr-11c-root",
    data: {
      assignmentId: currentAssignmentId,
      taskId: currentTaskId,
      runId: currentRunId,
      workerId: currentWorkerId,
      task: {
        id: currentTaskId,
        name: "math_computation",
        status: "queued",
        description: "Calculate metric and summarize",
        attemptCount: 0,
        version: 1,
        input: {
          expression: "42 * 2",
          goal: "Execute mathematical expression",
        },
      },
      assignedAt: "2026-10-02T00:00:00.000Z",
    },
  };

  beforeEach(() => {
    publishedRecords = [];

    mockKafkaConsumer = {
      connect: vi.fn(() => Promise.resolve()),
      subscribe: vi.fn(() => Promise.resolve()),
      run: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      commitOffsets: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      events: {
        REBALANCING: "consumer.rebalancing",
        GROUP_JOIN: "consumer.group_join",
        CRASH: "consumer.crash",
      },
    };

    mockKafkaProducer = {
      connect: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      send: vi.fn((record: ProducerRecord) => {
        publishedRecords.push(record);
        return Promise.resolve([
          { topicName: record.topic, partition: 0, errorCode: 0 },
        ]);
      }),
    };

    tracker = new AssignmentTracker({ maxCapacity: 100 });
    validator = new TaskAssignmentValidator({
      workerId: currentWorkerId,
      capabilities: {
        taskTypes: ["math_computation", "general"],
        tools: ["calculate", "echo"],
        maxConcurrency: 2,
      },
    });
    handler = new TaskAssignmentHandler({
      validator,
      tracker,
    });
  });

  it("completes full pipeline: consumes assignment -> executes through AgentRuntime -> publishes result to aegis.tasks.results -> commits offset", async () => {
    // 1. Configure AgentRuntime with a multi-step DeterministicPlanner
    const planner = new DeterministicPlanner([
      {
        type: "execute",
        action: {
          name: "calculate",
          payload: { expression: "42 * 2" },
        },
      },
      {
        type: "complete",
        summary: "Calculation successfully performed",
        output: "84",
      },
    ]);

    const executor = new TaskExecutor({
      planner,
      executor: new DefaultActionExecutor(),
      policy: { maxIterations: 5 },
    });

    const publisher = new KafkaTaskResultPublisher({
      producer: mockKafkaProducer as unknown as Producer,
      topic: "aegis.tasks.results",
    });
    await publisher.start();

    const executionService = new TaskExecutionService({
      workerId: currentWorkerId,
      executor,
      publisher,
      maxConcurrentTasks: 2,
    });

    const consumer = new WorkerTaskConsumer({
      consumer: mockKafkaConsumer as unknown as Consumer,
      topic: "aegis.tasks.assign",
      handler,
      executionService,
    });
    await consumer.start();

    // 2. Dispatch Kafka message to consumer
    const incomingMessage: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        key: Buffer.from(currentTaskId),
        value: Buffer.from(JSON.stringify(validEnvelope)),
        offset: "100",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const processResult = await consumer.processMessage(incomingMessage);
    expect(processResult).toBe(true);

    // 3. Verify task result was published to aegis.tasks.results before offset commit
    expect(publishedRecords).toHaveLength(1);
    const publishedRecord = publishedRecords[0];
    expect(publishedRecord?.topic).toBe("aegis.tasks.results");
    expect(publishedRecord?.messages).toHaveLength(1);

    const sentMessage = publishedRecord?.messages[0];
    expect(sentMessage?.key).toBe(currentTaskId);

    const headers = sentMessage?.headers as Record<string, string> | undefined;
    expect(headers?.["ce-correlationid"]).toBe("corr-11c-root");
    expect(headers?.["ce-type"]).toBe("task_result");

    const resultEnvelope = JSON.parse(
      sentMessage?.value?.toString() ?? "{}",
    ) as TaskResultEnvelope;

    expect(resultEnvelope.type).toBe("task_result");
    expect(resultEnvelope.aggregateId).toBe(currentTaskId);
    expect(resultEnvelope.correlationId).toBe("corr-11c-root");
    expect(resultEnvelope.causationId).toBe(validEnvelope.id);
    expect(resultEnvelope.data.status).toBe("SUCCEEDED");
    expect(resultEnvelope.data.taskId).toBe(currentTaskId);
    expect(resultEnvelope.data.runId).toBe(currentRunId);
    expect(resultEnvelope.data.assignmentId).toBe(currentAssignmentId);
    expect(resultEnvelope.data.workerId).toBe(currentWorkerId);
    expect(resultEnvelope.data.output).toBe("84");

    // 4. Verify assignment offset was committed strictly
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      {
        topic: "aegis.tasks.assign",
        partition: 0,
        offset: "101",
      },
    ]);

    await consumer.stop();
    await publisher.stop();
  });

  it("handles business task failure: reports FAILED result to aegis.tasks.results and commits offset", async () => {
    // Planner fails gracefully with an explicit failure reason
    const failingPlanner = new DeterministicPlanner([
      {
        type: "fail",
        reason: "Division by zero in input parameters",
      },
    ]);

    const executor = new TaskExecutor({
      planner: failingPlanner,
      executor: new DefaultActionExecutor(),
    });

    const publisher = new KafkaTaskResultPublisher({
      producer: mockKafkaProducer as unknown as Producer,
      topic: "aegis.tasks.results",
    });
    await publisher.start();

    const executionService = new TaskExecutionService({
      workerId: currentWorkerId,
      executor,
      publisher,
    });

    const consumer = new WorkerTaskConsumer({
      consumer: mockKafkaConsumer as unknown as Consumer,
      topic: "aegis.tasks.assign",
      handler,
      executionService,
    });

    const incomingMessage: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        key: Buffer.from(currentTaskId),
        value: Buffer.from(JSON.stringify(validEnvelope)),
        offset: "200",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const processResult = await consumer.processMessage(incomingMessage);
    expect(processResult).toBe(true);

    // Business failure result must be published
    expect(publishedRecords).toHaveLength(1);
    const sentMessage = publishedRecords[0]?.messages[0];
    const resultEnvelope = JSON.parse(
      sentMessage?.value?.toString() ?? "{}",
    ) as TaskResultEnvelope;

    expect(resultEnvelope.data.status).toBe("FAILED");
    expect(resultEnvelope.data.error?.message).toContain("Division by zero");

    // Offset must still be committed because the business failure was successfully handled & reported
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      {
        topic: "aegis.tasks.assign",
        partition: 0,
        offset: "201",
      },
    ]);
  });

  it("leaves assignment offset UNCOMMITTED if result publication encounters infrastructure failure", async () => {
    const planner = new DeterministicPlanner([
      {
        type: "complete",
        summary: "Completed",
        output: "done",
      },
    ]);

    const executor = new TaskExecutor({
      planner,
      executor: new DefaultActionExecutor(),
    });

    // Simulate Kafka transport failure during publish
    const failingProducer = {
      connect: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      send: vi.fn(() => Promise.reject(new Error("Kafka broker connection timeout"))),
    };

    const publisher = new KafkaTaskResultPublisher({
      producer: failingProducer as unknown as Producer,
      topic: "aegis.tasks.results",
    });

    const executionService = new TaskExecutionService({
      workerId: currentWorkerId,
      executor,
      publisher,
    });

    const consumer = new WorkerTaskConsumer({
      consumer: mockKafkaConsumer as unknown as Consumer,
      topic: "aegis.tasks.assign",
      handler,
      executionService,
    });

    const incomingMessage: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        key: Buffer.from(currentTaskId),
        value: Buffer.from(JSON.stringify(validEnvelope)),
        offset: "300",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const processResult = await consumer.processMessage(incomingMessage);
    expect(processResult).toBe(false);

    // Invariant: Result publication failed -> offset must remain UNCOMMITTED
    expect(mockKafkaConsumer.commitOffsets).not.toHaveBeenCalled();
  });

  it("does NOT commit offset when task is targeted to a different worker", async () => {
    const wrongWorkerEnvelope: TaskAssignmentEnvelope = {
      ...validEnvelope,
      id: eventId("assign-evt-other-worker"),
      data: {
        ...validEnvelope.data,
        assignmentId: assignmentId("asgn-other-worker"),
        workerId: workerId("worker-node-99"),
      },
    };

    const executor = new TaskExecutor({
      planner: new DeterministicPlanner([]),
      executor: new DefaultActionExecutor(),
    });

    const publisher = new KafkaTaskResultPublisher({
      producer: mockKafkaProducer as unknown as Producer,
      topic: "aegis.tasks.results",
    });

    const executionService = new TaskExecutionService({
      workerId: currentWorkerId,
      executor,
      publisher,
    });

    const consumer = new WorkerTaskConsumer({
      consumer: mockKafkaConsumer as unknown as Consumer,
      topic: "aegis.tasks.assign",
      handler,
      executionService,
    });

    const incomingMessage: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        key: Buffer.from("task-other"),
        value: Buffer.from(JSON.stringify(wrongWorkerEnvelope)),
        offset: "400",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const processResult = await consumer.processMessage(incomingMessage);
    expect(processResult).toBe(false);

    // Invariant (11C user rule): Target mismatch -> offset NOT committed
    expect(mockKafkaConsumer.commitOffsets).not.toHaveBeenCalled();
    expect(publishedRecords).toHaveLength(0);
  });

  it("gracefully drains in-flight execution upon consumer shutdown", async () => {
    let completeExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      completeExecution = resolve;
    });

    const customPlanner = {
      plan: async () => {
        await executionGate;
        return ok({
          type: "complete" as const,
          summary: "Drained task finished cleanly",
          output: "ok",
        });
      },
    };

    const executor = new TaskExecutor({
      planner: customPlanner,
      executor: new DefaultActionExecutor(),
    });

    const publisher = new KafkaTaskResultPublisher({
      producer: mockKafkaProducer as unknown as Producer,
      topic: "aegis.tasks.results",
    });

    const executionService = new TaskExecutionService({
      workerId: currentWorkerId,
      executor,
      publisher,
    });

    const consumer = new WorkerTaskConsumer({
      consumer: mockKafkaConsumer as unknown as Consumer,
      topic: "aegis.tasks.assign",
      handler,
      executionService,
      drainTimeoutMs: 500,
    });

    await consumer.start();

    const incomingMessage: EachMessagePayload = {
      topic: "aegis.tasks.assign",
      partition: 0,
      message: createMockKafkaMessage({
        key: Buffer.from(currentTaskId),
        value: Buffer.from(JSON.stringify(validEnvelope)),
        offset: "500",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    // 1. Start processing message (blocks on executionGate)
    const processPromise = consumer.processMessage(incomingMessage);
    expect(consumer.activeMessageCount).toBe(1);

    // 2. Initiate consumer shutdown
    const stopPromise = consumer.stop();

    // 3. Release the in-flight execution
    setTimeout(() => {
      completeExecution();
    }, 50);

    const [processResult, stopResult] = await Promise.all([
      processPromise,
      stopPromise,
    ]);

    expect(processResult).toBe(true);
    expect(stopResult.ok).toBe(true);
    expect(consumer.activeMessageCount).toBe(0);
    expect(publishedRecords).toHaveLength(1);
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      {
        topic: "aegis.tasks.assign",
        partition: 0,
        offset: "501",
      },
    ]);
  });
});
