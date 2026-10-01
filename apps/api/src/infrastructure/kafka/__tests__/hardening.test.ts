import type {
  EventEnvelope,
  EventHandler,
  RunEvent,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { err, eventId, ok, runId, taskId } from "@aegis/types";
import type { Consumer, EachMessagePayload, KafkaMessage } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryDeduplicator } from "../../../events/deduplicator.js";
import { serializeEnvelope, toEventEnvelope } from "../../../events/envelope.js";
import {
  HandlerExecutionError,
  KafkaNotConnectedError,
} from "../../../events/errors.js";
import { InMemoryEventPublisher } from "../../../events/inMemoryPublisher.js";
import { EventPublicationService } from "../../../events/publicationService.js";
import { InMemoryRunRepository } from "../../../repositories/inMemoryRunRepository.js";
import { AgentRunService } from "../../../services/agentRunService.js";
import { KafkaEventConsumer } from "../consumer.js";

function toBuffer(envelope: EventEnvelope): Buffer {
  const res = serializeEnvelope(envelope);
  if (!res.ok) throw res.error;
  return Buffer.from(res.value, "utf8");
}

function createMockKafkaMessage(overrides: Partial<KafkaMessage> = {}): KafkaMessage {
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

describe("Event Backbone Hardening & Failure Boundaries (Phase 10C — Commit 4)", () => {
  let sampleEvent: RunEvent;
  let mockConsumer: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    commitOffsets: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    events: {
      REBALANCING: string;
      GROUP_JOIN: string;
      CRASH: string;
    };
  };

  beforeEach(() => {
    sampleEvent = {
      id: eventId("evt-harden-001"),
      runId: runId("run-harden-101"),
      type: "task_started",
      severity: "info",
      timestamp: "2026-10-01T21:00:00.000Z",
      message: "Hardening test task started",
      taskId: taskId("task-harden-1"),
      taskName: "Hardening Validation",
    };

    mockConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      commitOffsets: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      events: {
        REBALANCING: "consumer.rebalancing",
        GROUP_JOIN: "consumer.group_join",
        CRASH: "consumer.crash",
      },
    };
  });

  describe("1. Publisher Failure Boundary", () => {
    it("preserves PostgreSQL as source of truth and succeeds API response when Kafka publish fails", async () => {
      const repository = new InMemoryRunRepository(false);
      const publisher = new InMemoryEventPublisher();
      publisher.simulateFailure(new KafkaNotConnectedError("Kafka broker cluster unreachable"));

      const warnSpy = vi.fn();
      const mockLogger: Logger = {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as unknown as Logger;

      const publicationService = new EventPublicationService(publisher, {
        logger: mockLogger,
      });

      const service = new AgentRunService(repository, mockLogger, {
        autoExecute: false,
        eventPublicationService: publicationService,
      });

      const result = await service.createRun({
        goal: "Verify PostgreSQL authority under Kafka outage",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const runIdVal = result.value.run.id;

      // Assert PostgreSQL persistence succeeded
      const persisted = await repository.findById(runIdVal);
      expect(persisted).not.toBeNull();
      expect(persisted?.goal).toBe("Verify PostgreSQL authority under Kafka outage");
      expect(persisted?.status).toBe("pending");

      // Assert structured failure containment warning was emitted
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Post-commit event publication failed"),
        expect.objectContaining({
          errorCode: "KAFKA_NOT_CONNECTED",
        }),
      );
    });
  });

  describe("2. Consumer Handler Failure Boundary", () => {
    it("does NOT commit offset when handler fails, allowing Kafka consumer-group redelivery", async () => {
      const consumer = new KafkaEventConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.events",
      });

      // Handler fails with structured HandlerExecutionError
      const failingHandler: EventHandler = vi.fn().mockResolvedValue(
        err(new HandlerExecutionError("Transient downstream failure")),
      );
      consumer.subscribe("task_started", failingHandler);

      const envelope = toEventEnvelope(sampleEvent);
      const payload: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({
          key: Buffer.from("run-harden-101"),
          value: toBuffer(envelope),
          offset: "100",
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const committed = await consumer.processMessage(payload);

      // Offset must NOT be committed
      expect(committed).toBe(false);
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
      expect(failingHandler).toHaveBeenCalledTimes(1);

      // Verify that upon redelivery / retry where handler succeeds, offset IS committed
      const successHandler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));
      consumer.unsubscribe("task_started", failingHandler);
      consumer.subscribe("task_started", successHandler);

      const retryCommitted = await consumer.processMessage(payload);
      expect(retryCommitted).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 0, offset: "101" },
      ]);
    });
  });

  describe("3. Poison Message Boundary", () => {
    it("quarantines unparseable JSON and commits offset to avoid partition head-of-line blocking", async () => {
      const errorSpy = vi.fn();
      const mockLogger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: errorSpy,
        debug: vi.fn(),
      } as unknown as Logger;

      const consumer = new KafkaEventConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.events",
        logger: mockLogger,
      });

      const payload: EachMessagePayload = {
        topic: "aegis.events",
        partition: 2,
        message: createMockKafkaMessage({
          key: Buffer.from("run-poison"),
          value: Buffer.from("{ malformed-json: [corrupted-bytes", "utf8"),
          offset: "555",
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const committed = await consumer.processMessage(payload);

      // Offset must be committed to prevent head-of-line stall
      expect(committed).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 2, offset: "556" },
      ]);

      // Error must be logged identifying poison pill
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Poison pill detected: message failed deserialization"),
        expect.objectContaining({
          topic: "aegis.events",
          partition: 2,
          offset: "555",
        }),
      );
    });

    it("quarantines messages violating EventEnvelope schema and commits offset", async () => {
      const consumer = new KafkaEventConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.events",
      });

      // Valid JSON but invalid envelope schema (missing aggregateId, specVersion, etc.)
      const invalidEnvelopeJson = JSON.stringify({
        id: "evt-invalid",
        type: "unknown_event_type",
        randomField: 12345,
      });

      const payload: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({
          value: Buffer.from(invalidEnvelopeJson, "utf8"),
          offset: "777",
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const committed = await consumer.processMessage(payload);

      expect(committed).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 0, offset: "778" },
      ]);
    });
  });

  describe("4. Duplicate Message Boundary", () => {
    it("suppresses duplicate events with in-memory deduplicator, commits offset, and avoids re-executing handler", async () => {
      const deduplicator = new InMemoryDeduplicator(100);
      const consumer = new KafkaEventConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.events",
        deduplicator,
      });

      const handler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));
      consumer.subscribe("task_started", handler);

      const envelope = toEventEnvelope(sampleEvent);
      const payload1: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({
          key: Buffer.from("key-run"),
          value: toBuffer(envelope),
          offset: "201",
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      // First delivery: executed & committed
      const firstResult = await consumer.processMessage(payload1);
      expect(firstResult).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 0, offset: "202" },
      ]);

      mockConsumer.commitOffsets.mockClear();

      // Second delivery (redelivery of identical envelope ID):
      const payload2: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({
          key: Buffer.from("key-run"),
          value: toBuffer(envelope),
          offset: "202",
        }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };

      const secondResult = await consumer.processMessage(payload2);
      expect(secondResult).toBe(true);
      // Handler was NOT called a second time
      expect(handler).toHaveBeenCalledTimes(1);
      // Offset was committed to advance consumer position
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 0, offset: "203" },
      ]);
    });
  });

  describe("5. Mixed Stream Pipeline Resilience", () => {
    it("processes a sequence of valid, poison, duplicate, and failing messages correctly", async () => {
      const deduplicator = new InMemoryDeduplicator(100);
      const consumer = new KafkaEventConsumer({
        consumer: mockConsumer as unknown as Consumer,
        topic: "aegis.events",
        deduplicator,
      });

      const processedEventIds: string[] = [];
      const handler: EventHandler = vi.fn().mockImplementation((env: EventEnvelope) => {
        if (env.type === "task_failed") {
          return Promise.resolve(err(new HandlerExecutionError("Handler forced error")));
        }
        processedEventIds.push(env.id);
        return Promise.resolve(ok(undefined));
      });

      consumer.subscribe("task_started", handler);
      consumer.subscribe("task_failed", handler);

      const eventA = toEventEnvelope({ ...sampleEvent, id: eventId("evt-stream-A") });
      const eventFailing = toEventEnvelope({
        ...sampleEvent,
        id: eventId("evt-stream-fail"),
        type: "task_failed",
      });

      // 1. Valid Message A
      const p1: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({ value: toBuffer(eventA), offset: "10" }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };
      expect(await consumer.processMessage(p1)).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 0, offset: "11" },
      ]);

      // 2. Poison Pill
      const p2: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({ value: Buffer.from("bad-json", "utf8"), offset: "11" }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };
      expect(await consumer.processMessage(p2)).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 0, offset: "12" },
      ]);

      // 3. Duplicate Message A
      const p3: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({ value: toBuffer(eventA), offset: "12" }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };
      expect(await consumer.processMessage(p3)).toBe(true);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([
        { topic: "aegis.events", partition: 0, offset: "13" },
      ]);

      // 4. Failing Handler Message
      mockConsumer.commitOffsets.mockClear();
      const p4: EachMessagePayload = {
        topic: "aegis.events",
        partition: 0,
        message: createMockKafkaMessage({ value: toBuffer(eventFailing), offset: "13" }),
        heartbeat: vi.fn(),
        pause: vi.fn(),
      };
      expect(await consumer.processMessage(p4)).toBe(false);
      // Offset was NOT committed for the failing message
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();

      // Only Message A was processed by the business logic handler
      expect(processedEventIds).toEqual(["evt-stream-A"]);
    });
  });
});
