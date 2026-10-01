import type {
  EventConsumerErrorContract,
  EventEnvelope,
  EventHandler,
  RunEvent,
} from "@aegis/contracts";
import { eventId, ok, runId, taskId } from "@aegis/types";
import type { Consumer, EachMessagePayload, KafkaMessage } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryDeduplicator } from "../../../events/deduplicator.js";
import { serializeEnvelope, toEventEnvelope } from "../../../events/envelope.js";
import {
  ConsumerNotConnectedError,
  DispatchError,
  HandlerExecutionError,
  SubscriptionError,
} from "../../../events/errors.js";
import { KafkaClientManager } from "../client.js";
import { KafkaEventConsumer, translateConsumerError } from "../consumer.js";
import { EventDispatcher } from "../dispatcher.js";

function toBuffer(envelope: EventEnvelope): Buffer {
  const res = serializeEnvelope(envelope);
  if (!res.ok) throw res.error;
  return Buffer.from(res.value, "utf8");
}

function createMockMessage(overrides: Partial<KafkaMessage> = {}): KafkaMessage {
  return {
    key: null,
    value: null,
    timestamp: "1727180000000",
    attributes: 0,
    offset: "0",
    headers: {},
    ...overrides,
  } as unknown as KafkaMessage;
}

describe("Kafka Event Consumer & Dispatcher (Phase 10B)", () => {
  let sampleEvent: RunEvent;

  beforeEach(() => {
    sampleEvent = {
      id: eventId("evt-kafka-101"),
      runId: runId("run-kafka-202"),
      type: "task_started",
      severity: "info",
      timestamp: "2026-09-24T12:00:00.000Z",
      message: "Task started",
      taskId: taskId("task-303"),
      taskName: "Execute Step",
    };
  });

  describe("translateConsumerError", () => {
    it("preserves existing EventConsumerError instances", () => {
      const original = new ConsumerNotConnectedError("Already disconnected");
      expect(translateConsumerError(original)).toBe(original);
    });

    it("translates disconnection messages to ConsumerNotConnectedError", () => {
      const err = translateConsumerError(new Error("Consumer is not connected"));
      expect(err).toBeInstanceOf(ConsumerNotConnectedError);
      expect(err.code).toBe("CONSUMER_NOT_CONNECTED");
    });

    it("translates subscription messages to SubscriptionError", () => {
      const err = translateConsumerError(new Error("Failed subscription topic authorization"));
      expect(err).toBeInstanceOf(SubscriptionError);
      expect(err.code).toBe("SUBSCRIPTION_FAILED");
    });

    it("translates unknown generic errors to DispatchError", () => {
      const err = translateConsumerError(new Error("Unknown broker anomaly"));
      expect(err).toBeInstanceOf(DispatchError);
      expect(err.code).toBe("DISPATCH_ERROR");
    });
  });

  describe("EventDispatcher", () => {
    it("routes to specific and wildcard handlers", async () => {
      const dispatcher = new EventDispatcher();
      const specificHandler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));
      const wildcardHandler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));

      dispatcher.subscribe("task_started", specificHandler);
      dispatcher.subscribe("*", wildcardHandler);

      expect(dispatcher.hasSubscriptions()).toBe(true);
      expect(dispatcher.getHandlerCount("task_started")).toBe(1);
      expect(dispatcher.getHandlerCount("*")).toBe(1);
      expect(dispatcher.getSubscribedTypes()).toContain("task_started");
      expect(dispatcher.getSubscribedTypes()).toContain("*");

      const envelope = toEventEnvelope(sampleEvent);
      const metadata = {
        topic: "aegis.events",
        partition: 0,
        offset: "10",
        timestamp: "12345",
      };

      const res = await dispatcher.dispatch(envelope, metadata);
      expect(res.ok).toBe(true);
      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);
    });

    it("unsubscribes handlers cleanly", async () => {
      const dispatcher = new EventDispatcher();
      const handler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));

      dispatcher.subscribe("task_started", handler);
      expect(dispatcher.getHandlerCount("task_started")).toBe(1);

      dispatcher.unsubscribe("task_started", handler);
      expect(dispatcher.getHandlerCount("task_started")).toBe(0);

      const envelope = toEventEnvelope(sampleEvent);
      const metadata = {
        topic: "aegis.events",
        partition: 0,
        offset: "10",
        timestamp: "12345",
      };

      const res = await dispatcher.dispatch(envelope, metadata);
      expect(res.ok).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });

    it("catches synchronous thrown errors in handlers and returns HandlerExecutionError", async () => {
      const dispatcher = new EventDispatcher();
      const badHandler: EventHandler = vi.fn().mockImplementation(() => {
        throw new Error("Handler exploded");
      });

      dispatcher.subscribe("task_started", badHandler);

      const envelope = toEventEnvelope(sampleEvent);
      const metadata = {
        topic: "aegis.events",
        partition: 0,
        offset: "10",
        timestamp: "12345",
      };

      const res = await dispatcher.dispatch(envelope, metadata);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("HANDLER_FAILED");
        expect(res.error).toBeInstanceOf(HandlerExecutionError);
        expect(res.error.message).toContain("Handler exploded");
      }
    });
  });

  describe("KafkaClientManager getConsumer", () => {
    it("creates and caches a consumer instance", () => {
      const manager = new KafkaClientManager({
        config: {
          brokers: ["localhost:9092"],
          clientId: "client-test",
          eventsTopic: "aegis.events",
          connectionTimeoutMs: 5000,
          requestTimeoutMs: 30000,
          maxRetries: 3,
          retryInitialDelayMs: 100,
          retryMaxDelayMs: 1000,
          groupId: "test-group",
          sessionTimeoutMs: 30000,
          heartbeatIntervalMs: 3000,
          shutdownTimeoutMs: 10000,
          fromBeginning: false,
        },
      });

      const consumer1 = manager.getConsumer();
      const consumer2 = manager.getConsumer();
      expect(consumer1).toBeDefined();
      expect(consumer1).toBe(consumer2);
    });
  });

  describe("KafkaEventConsumer", () => {
    let mockConsumer: {
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      subscribe: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      run: ReturnType<typeof vi.fn>;
      commitOffsets: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      events: {
        REBALANCING: string;
        GROUP_JOIN: string;
        CRASH: string;
      };
    };

    beforeEach(() => {
      mockConsumer = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        run: vi.fn().mockResolvedValue(undefined),
        commitOffsets: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
        events: {
          REBALANCING: "consumer.rebalancing",
          GROUP_JOIN: "consumer.group_join",
          CRASH: "consumer.crash",
        },
      };
    });

    it("registers subscriptions before start (independent registration)", async () => {
      const consumer = new KafkaEventConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.events",
      });

      const handler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));

      // Register BEFORE start
      consumer.subscribe("task_started", handler);
      expect(consumer.isRunning).toBe(false);

      const startRes = await consumer.start();
      expect(startRes.ok).toBe(true);
      expect(consumer.isRunning).toBe(true);

      expect(mockConsumer.connect).toHaveBeenCalledTimes(1);
      expect(mockConsumer.subscribe).toHaveBeenCalledWith({
        topic: "aegis.events",
        fromBeginning: false,
      });
      expect(mockConsumer.run).toHaveBeenCalledWith(
        expect.objectContaining({
          autoCommit: false,
        }),
      );

      const stopRes = await consumer.stop();
      expect(stopRes.ok).toBe(true);
      expect(consumer.isRunning).toBe(false);
      expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
      expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
    });

    it("handles start() connection failure without crashing", async () => {
      mockConsumer.connect.mockRejectedValue(new Error("Connection refused"));

      const consumer = new KafkaEventConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.events",
      });

      const startRes = await consumer.start();
      expect(startRes.ok).toBe(false);
      expect(consumer.isRunning).toBe(false);
      if (!startRes.ok) {
        expect(startRes.error.code).toBe("DISPATCH_ERROR");
      }
    });

    describe("processMessage pipeline", () => {
      it("processes valid event, invokes handler, and commits next offset (offset + 1)", async () => {
        const consumer = new KafkaEventConsumer({
          consumer: mockConsumer as unknown as Consumer,
          topic: "aegis.events",
        });

        const handler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));
        consumer.subscribe("task_started", handler);

        const envelope = toEventEnvelope(sampleEvent);
        const payload: EachMessagePayload = {
          topic: "aegis.events",
          partition: 1,
          message: createMockMessage({
            key: Buffer.from("key-run-1"),
            value: toBuffer(envelope),
            offset: "42",
          }),
          heartbeat: vi.fn(),
          pause: vi.fn(),
        };

        const committed = await consumer.processMessage(payload);
        expect(committed).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(
          envelope,
          expect.objectContaining({
            topic: "aegis.events",
            partition: 1,
            offset: "42",
            key: "key-run-1",
          }),
        );

        // Next offset to commit must be 43
        expect(mockConsumer.commitOffsets).toHaveBeenCalledTimes(1);
        expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
          {
            topic: "aegis.events",
            partition: 1,
            offset: "43",
          },
        ]);
      });

      it("does NOT commit offset when handler execution fails", async () => {
        const consumer = new KafkaEventConsumer({
          consumer: mockConsumer as unknown as Consumer,
          topic: "aegis.events",
        });

        const failingHandler: EventHandler = vi.fn().mockResolvedValue({
          ok: false,
          error: {
            code: "HANDLER_FAILED",
            message: "Database down",
          } satisfies EventConsumerErrorContract,
        });

        consumer.subscribe("task_started", failingHandler);

        const envelope = toEventEnvelope(sampleEvent);
        const payload: EachMessagePayload = {
          topic: "aegis.events",
          partition: 0,
          message: createMockMessage({
            value: toBuffer(envelope),
            offset: "100",
          }),
          heartbeat: vi.fn(),
          pause: vi.fn(),
        };

        const committed = await consumer.processMessage(payload);
        expect(committed).toBe(false);
        expect(failingHandler).toHaveBeenCalledTimes(1);
        // Offset MUST NOT be committed
        expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
      });

      it("quarantines poison pill (invalid JSON / schema violation) and commits offset to prevent partition blocking", async () => {
        const consumer = new KafkaEventConsumer({
          consumer: mockConsumer as unknown as Consumer,
          topic: "aegis.events",
        });

        const handler: EventHandler = vi.fn();
        consumer.subscribe("task_started", handler);

        const payload: EachMessagePayload = {
          topic: "aegis.events",
          partition: 0,
          message: createMockMessage({
            value: Buffer.from("NOT_VALID_JSON{{{"),
            offset: "77",
          }),
          heartbeat: vi.fn(),
          pause: vi.fn(),
        };

        const committed = await consumer.processMessage(payload);
        expect(committed).toBe(true);
        expect(handler).not.toHaveBeenCalled();
        // Offset is committed so partition moves forward
        expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
          {
            topic: "aegis.events",
            partition: 0,
            offset: "78",
          },
        ]);
      });

      it("handles empty or null message value by committing offset and skipping dispatch", async () => {
        const consumer = new KafkaEventConsumer({
          consumer: mockConsumer as unknown as Consumer,
          topic: "aegis.events",
        });

        const handler: EventHandler = vi.fn();
        consumer.subscribe("task_started", handler);

        const payload: EachMessagePayload = {
          topic: "aegis.events",
          partition: 2,
          message: createMockMessage({
            value: null,
            offset: "99",
          }),
          heartbeat: vi.fn(),
          pause: vi.fn(),
        };

        const committed = await consumer.processMessage(payload);
        expect(committed).toBe(true);
        expect(handler).not.toHaveBeenCalled();
        expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
          {
            topic: "aegis.events",
            partition: 2,
            offset: "100",
          },
        ]);
      });

      it("suppresses duplicate events with in-memory deduplicator, commits offset, and does not re-invoke handler", async () => {
        const deduplicator = new InMemoryDeduplicator(100);
        const consumer = new KafkaEventConsumer({
          consumer: mockConsumer as unknown as Consumer,
          topic: "aegis.events",
          deduplicator,
        });

        const handler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));
        consumer.subscribe("task_started", handler);

        const envelope = toEventEnvelope(sampleEvent);
        const raw = toBuffer(envelope);

        const payload1: EachMessagePayload = {
          topic: "aegis.events",
          partition: 0,
          message: createMockMessage({
            value: raw,
            offset: "10",
          }),
          heartbeat: vi.fn(),
          pause: vi.fn(),
        };

        // First message (new event)
        const committed1 = await consumer.processMessage(payload1);
        expect(committed1).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
          {
            topic: "aegis.events",
            partition: 0,
            offset: "11",
          },
        ]);

        // Second message with identical event ID (duplicate redelivery)
        const payload2: EachMessagePayload = {
          topic: "aegis.events",
          partition: 0,
          message: createMockMessage({
            value: raw,
            offset: "11",
          }),
          heartbeat: vi.fn(),
          pause: vi.fn(),
        };

        const committed2 = await consumer.processMessage(payload2);
        expect(committed2).toBe(true);
        // Handler was NOT invoked a second time
        expect(handler).toHaveBeenCalledTimes(1);
        // Offset was still committed so broker progresses
        expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
          {
            topic: "aegis.events",
            partition: 0,
            offset: "12",
          },
        ]);
      });
    });
  });
});
