import type { RunEvent } from "@aegis/contracts";
import type { EventId, RunId } from "@aegis/types";
import type { Producer, RecordMetadata } from "kafkajs";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toEventEnvelope } from "../../../events/envelope.js";
import { KafkaClientManager } from "../client.js";
import { KafkaEventPublisher, translateKafkaError } from "../publisher.js";

interface MockProducerBundle {
  readonly producer: Producer;
  readonly connectSpy: Mock<() => Promise<void>>;
  readonly disconnectSpy: Mock<() => Promise<void>>;
  readonly sendSpy: Mock<(record: { topic: string; messages: { key: string; value: string; headers?: Record<string, string> }[] }) => Promise<RecordMetadata[]>>;
}

function createMockProducerBundle(): MockProducerBundle {
  const connectSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const disconnectSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const sendSpy = vi.fn<(record: { topic: string; messages: { key: string; value: string; headers?: Record<string, string> }[] }) => Promise<RecordMetadata[]>>()
    .mockImplementation((record) => {
      const metas: RecordMetadata[] = record.messages.map((_, idx) => ({
        topicName: record.topic,
        partition: 0,
        offset: String(idx + 100),
        errorCode: 0,
      }));
      return Promise.resolve(metas);
    });

  const producer = {
    connect: connectSpy,
    disconnect: disconnectSpy,
    send: sendSpy,
    sendBatch: vi.fn(),
    isIdempotent: vi.fn().mockReturnValue(true),
    events: {},
    on: vi.fn(),
    logger: vi.fn(),
    transaction: vi.fn(),
  } as unknown as Producer;

  return {
    producer,
    connectSpy,
    disconnectSpy,
    sendSpy,
  };
}

function createSampleEvent(runId = "run-101", eventId = "evt-202"): RunEvent {
  return {
    id: eventId as EventId,
    runId: runId as RunId,
    type: "run_created",
    timestamp: "2026-09-24T18:00:00.000Z",
    severity: "info",
    message: "Run initialized",
    metadata: { test: true },
  };
}

describe("Kafka Infrastructure Subsystem", () => {
  describe("KafkaClientManager", () => {
    it("initializes client and lazily creates a producer", () => {
      const manager = new KafkaClientManager({
        config: {
          brokers: ["localhost:9092"],
          clientId: "test-client",
          eventsTopic: "test.events",
          connectionTimeoutMs: 5000,
          requestTimeoutMs: 30000,
          maxRetries: 3,
          retryInitialDelayMs: 100,
          retryMaxDelayMs: 1000,
        },
      });

      expect(manager.getConfig().clientId).toBe("test-client");
      expect(manager.getKafka()).toBeDefined();

      const producer1 = manager.getProducer();
      const producer2 = manager.getProducer();
      expect(producer1).toBe(producer2);
    });
  });

  describe("translateKafkaError", () => {
    it("translates disconnection errors to KAFKA_NOT_CONNECTED", () => {
      const err = translateKafkaError(new Error("The producer is disconnected"));
      expect(err.code).toBe("KAFKA_NOT_CONNECTED");
    });

    it("translates timeout errors to KAFKA_PUBLISH_TIMEOUT", () => {
      const err = translateKafkaError(new Error("Request timed out after 30000ms"));
      expect(err.code).toBe("KAFKA_PUBLISH_TIMEOUT");
    });

    it("translates broker errors to BROKER_UNAVAILABLE", () => {
      const err = translateKafkaError(new Error("Broker not available: ECONNREFUSED"));
      expect(err.code).toBe("BROKER_UNAVAILABLE");
    });

    it("translates generic error to KAFKA_CONNECTION_FAILED", () => {
      const err = translateKafkaError(new Error("Unexpected protocol error"));
      expect(err.code).toBe("KAFKA_CONNECTION_FAILED");
    });
  });

  describe("KafkaEventPublisher", () => {
    let bundle: MockProducerBundle;
    let publisher: KafkaEventPublisher;

    beforeEach(() => {
      bundle = createMockProducerBundle();
      publisher = new KafkaEventPublisher({
        producer: bundle.producer,
        topic: "aegis.events",
      });
    });

    it("rejects publishing when producer is not connected", async () => {
      const envelope = toEventEnvelope(createSampleEvent());
      const result = await publisher.publish(envelope);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("KAFKA_NOT_CONNECTED");
      }
      expect(bundle.sendSpy).not.toHaveBeenCalled();
    });

    it("connects and disconnects cleanly", async () => {
      expect(publisher.connected).toBe(false);

      const connRes = await publisher.connect();
      expect(connRes.ok).toBe(true);
      expect(publisher.connected).toBe(true);
      expect(bundle.connectSpy).toHaveBeenCalledTimes(1);

      // Idempotent connect
      await publisher.connect();
      expect(bundle.connectSpy).toHaveBeenCalledTimes(1);

      const discRes = await publisher.disconnect();
      expect(discRes.ok).toBe(true);
      expect(publisher.connected).toBe(false);
      expect(bundle.disconnectSpy).toHaveBeenCalledTimes(1);
    });

    it("publishes single event with strict FIFO key, JSON payload, and CloudEvents headers", async () => {
      await publisher.connect();

      const runEvent = createSampleEvent("run-target-1", "evt-target-1");
      const envelope = toEventEnvelope(runEvent, {
        source: "aegis.test",
        correlationId: "corr-123",
        causationId: "cause-456",
      });

      const res = await publisher.publish(envelope);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.success).toBe(true);
        expect(res.value.topic).toBe("aegis.events");
        expect(res.value.partition).toBe(0);
        expect(res.value.offset).toBe("100");
        expect(res.value.messageId).toBeUndefined(); // User safeguard 2
      }

      expect(bundle.sendSpy).toHaveBeenCalledTimes(1);
      const callArgs = bundle.sendSpy.mock.calls[0]?.[0];
      expect(callArgs?.topic).toBe("aegis.events");
      expect(callArgs?.messages).toHaveLength(1);

      const message = callArgs?.messages[0];
      // Key must strictly be runId / aggregateId
      expect(message?.key).toBe("run-target-1");

      // Payload must be valid JSON matching envelope
      const parsedBody = JSON.parse(message?.value ?? "{}") as { id: string; aggregateId: string };
      expect(parsedBody.id).toBe("evt-target-1");
      expect(parsedBody.aggregateId).toBe("run-target-1");

      // Headers must match CloudEvents mapping
      expect(message?.headers).toEqual({
        ce_specversion: "1.0",
        ce_id: "evt-target-1",
        ce_type: "run_created",
        ce_source: "aegis.test",
        ce_time: "2026-09-24T18:00:00.000Z",
        ce_subject: "run-target-1",
        ce_correlationid: "corr-123",
        ce_causationid: "cause-456",
      });
    });

    it("publishes batch of envelopes in a single Kafka producer call", async () => {
      await publisher.connect();

      const env1 = toEventEnvelope(createSampleEvent("run-batch-1", "evt-1"));
      const env2 = toEventEnvelope(createSampleEvent("run-batch-1", "evt-2"));

      const res = await publisher.publishBatch([env1, env2]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toHaveLength(2);
        expect(res.value[0]?.offset).toBe("100");
        expect(res.value[1]?.offset).toBe("101");
      }

      expect(bundle.sendSpy).toHaveBeenCalledTimes(1);
      const callArgs = bundle.sendSpy.mock.calls[0]?.[0];
      expect(callArgs?.messages).toHaveLength(2);
      expect(callArgs?.messages[0]?.key).toBe("run-batch-1");
      expect(callArgs?.messages[1]?.key).toBe("run-batch-1");
    });

    it("returns empty array for empty batch without calling producer", async () => {
      await publisher.connect();

      const res = await publisher.publishBatch([]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toEqual([]);
      }
      expect(bundle.sendSpy).not.toHaveBeenCalled();
    });

    it("handles producer send failure and returns translated error", async () => {
      await publisher.connect();
      bundle.sendSpy.mockRejectedValueOnce(
        new Error("Broker coordinator not available: ECONNREFUSED"),
      );

      const envelope = toEventEnvelope(createSampleEvent());
      const res = await publisher.publish(envelope);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("BROKER_UNAVAILABLE");
      }
    });

    it("handles batch producer send failure gracefully", async () => {
      await publisher.connect();
      bundle.sendSpy.mockRejectedValueOnce(new Error("Request timed out"));

      const env1 = toEventEnvelope(createSampleEvent());
      const res = await publisher.publishBatch([env1]);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("KAFKA_PUBLISH_TIMEOUT");
      }
    });

    it("fails fast if envelope cannot be serialized (e.g. circular reference)", async () => {
      await publisher.connect();

      const circular: Record<string, unknown> = { message: "circular" };
      circular["self"] = circular;

      const badEnvelope = {
        ...toEventEnvelope(createSampleEvent()),
        data: circular as unknown as RunEvent,
      };

      const res = await publisher.publish(badEnvelope);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("SERIALIZATION_FAILED");
      }
      expect(bundle.sendSpy).not.toHaveBeenCalled();
    });
  });
});
