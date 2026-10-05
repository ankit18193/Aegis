import type { TaskAssignmentEnvelope } from "@aegis/contracts";
import { assignmentId, eventId, runId, taskId, workerId } from "@aegis/types";
import type { Consumer, EachMessagePayload, KafkaMessage } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskAssignmentHandler } from "../../assignment/handler.js";
import { AssignmentTracker } from "../../assignment/tracker.js";
import { TaskAssignmentValidator } from "../../assignment/validator.js";
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

describe("Worker Task Consumer Hardening (Phase 11B — Commit 4)", () => {
  const currentWorkerId = workerId("worker-harden-1");
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
    id: eventId("assign-evt-harden-1"),
    source: "aegis.workflow.engine",
    type: "task_assigned",
    specVersion: "1.0",
    time: "2026-10-02T00:00:00.000Z",
    aggregateType: "TaskAssignment",
    aggregateId: taskId("task-harden-123"),
    correlationId: "corr-harden-123",
    data: {
      assignmentId: assignmentId("asgn-harden-abc"),
      taskId: taskId("task-harden-123"),
      runId: runId("run-harden-456"),
      workerId: currentWorkerId,
      task: {
        id: taskId("task-harden-123"),
        name: "test_task",
        status: "queued",
        description: "",
        attemptCount: 0,
        version: 1,
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
      drainTimeoutMs: 1000,
    });
  });

  describe("Poison pill quarantine", () => {
    it("quarantines empty message and commits offset to unblock partition", async () => {
      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 0,
        message: createMockMessage({
          offset: "10",
          value: null,
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const result = await consumer.processMessage(payload);
      expect(result).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        {
          topic: "aegis.tasks.assign",
          partition: 0,
          offset: "11",
        },
      ]);
    });

    it("quarantines malformed JSON without blocking partition", async () => {
      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 1,
        message: createMockMessage({
          offset: "25",
          value: Buffer.from("<<<not-json>>>"),
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const result = await consumer.processMessage(payload);
      expect(result).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        {
          topic: "aegis.tasks.assign",
          partition: 1,
          offset: "26",
        },
      ]);
    });

    it("quarantines invalid schema envelope without blocking partition", async () => {
      const corruptEnvelope = {
        id: "evt-corrupt",
        aggregateType: "WrongType",
        data: { missing: "everything" },
      };

      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 2,
        message: createMockMessage({
          offset: "30",
          value: Buffer.from(JSON.stringify(corruptEnvelope)),
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const result = await consumer.processMessage(payload);
      expect(result).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        {
          topic: "aegis.tasks.assign",
          partition: 2,
          offset: "31",
        },
      ]);
    });
  });

  describe("Target-mismatch acknowledgment semantics (Phase 11C)", () => {
    it("leaves offset uncommitted and does not accept task when assignment is targeted to different worker", async () => {
      const mismatchedEnvelope: TaskAssignmentEnvelope = {
        ...validEnvelope,
        data: {
          ...validEnvelope.data,
          assignmentId: assignmentId("asgn-mismatch-99"),
          workerId: workerId("worker-different-42"),
        },
      };

      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 0,
        message: createMockMessage({
          offset: "50",
          value: Buffer.from(JSON.stringify(mismatchedEnvelope)),
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const result = await consumer.processMessage(payload);
      expect(result).toBe(false);
      // Offset must NOT be committed to prevent losing work in shared aegis-workers consumer group
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
      expect(tracker.isDuplicate("asgn-mismatch-99")).toBe(false);
    });
  });

  describe("Unhandled handler exception containment", () => {
    it("leaves offset uncommitted when handler throws an unexpected error", async () => {
      vi.spyOn(handler, "handleAssignment").mockImplementationOnce(() => {
        throw new Error("Unexpected synchronous OOM / crash simulation");
      });

      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 0,
        message: createMockMessage({
          offset: "70",
          value: Buffer.from(JSON.stringify(validEnvelope)),
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const result = await consumer.processMessage(payload);
      expect(result).toBe(false);
      // Offset must NOT be committed so Kafka will redeliver
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    });
  });

  describe("Offset commit failure propagation", () => {
    it("rethrows error when Kafka commitOffsets rejects", async () => {
      mockConsumer.commitOffsets.mockRejectedValueOnce(
        new Error("Broker disconnected during commit"),
      );

      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 0,
        message: createMockMessage({
          offset: "80",
          value: Buffer.from(JSON.stringify(validEnvelope)),
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      await expect(consumer.processMessage(payload)).rejects.toThrow(
        "Broker disconnected during commit",
      );
    });
  });

  describe("Graceful shutdown in-flight drain", () => {
    it("waits for in-flight message processing to finish before disconnecting", async () => {
      await consumer.start();

      mockConsumer.commitOffsets.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 60)),
      );

      const payload: EachMessagePayload = {
        topic: "aegis.tasks.assign",
        partition: 0,
        message: createMockMessage({
          offset: "90",
          value: Buffer.from(JSON.stringify(validEnvelope)),
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      // Start processing message
      const processPromise = consumer.processMessage(payload);
      expect(consumer.activeMessageCount).toBe(1);

      // Trigger shutdown while message is still in flight
      const stopPromise = consumer.stop();

      // Both should complete cleanly
      const [processResult, stopResult] = await Promise.all([processPromise, stopPromise]);

      expect(processResult).toBe(true);
      expect(consumer.activeMessageCount).toBe(0);
      expect(stopResult.ok).toBe(true);
      expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
      expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
