/**
 * Integration test suite for Kafka Consumer & Subscription Backbone (Phase 10B).
 *
 * Provides two testing tiers:
 * 1. Hermetic Consumer Pipeline: Always executes with zero external dependencies,
 *    verifying end-to-end event flow, handler dispatching, deduplication suppression,
 *    and contract parity between InMemoryEventSubscriber and KafkaEventConsumer.
 * 2. Live Broker Consumer Integration: Skips cleanly when Kafka is unreachable on port 9092,
 *    protecting hermetic CI while enabling live end-to-end verification when Docker Kafka is up.
 */

import * as net from "node:net";

import type {
  ConsumerRecordMetadata,
  EventEnvelope,
  EventHandler,
  IEventSubscriber,
  RunEvent,
} from "@aegis/contracts";
import type { EventId, RunId } from "@aegis/types";
import { ok, taskId } from "@aegis/types";
import type { Consumer, EachMessagePayload, KafkaMessage } from "kafkajs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { InMemoryDeduplicator } from "../../../events/deduplicator.js";
import {
  serializeEnvelope,
  toEventEnvelope,
} from "../../../events/envelope.js";
import { InMemoryEventSubscriber } from "../../../events/inMemorySubscriber.js";
import { KafkaClientManager } from "../client.js";
import { KafkaEventConsumer } from "../consumer.js";
import { KafkaEventPublisher } from "../publisher.js";

async function isKafkaReachable(port = 9092, host = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(800);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const kafkaAvailable = await isKafkaReachable();

function createSampleEvent(type: RunEvent["type"], idStr: string, rIdStr: string): RunEvent {
  return {
    id: idStr as EventId,
    runId: rIdStr as RunId,
    type,
    severity: "info",
    timestamp: new Date().toISOString(),
    message: `Sample event ${type}`,
    taskId: taskId("task-step-1"),
  };
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

describe("Hermetic Consumer Event Pipeline Integration (Zero External Dependencies)", () => {
  it("enforces canonical IEventSubscriber contract parity between implementations", () => {
    const inMemory: IEventSubscriber = new InMemoryEventSubscriber();
    const mockConsumer = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      run: vi.fn(),
      stop: vi.fn(),
      commitOffsets: vi.fn(),
      on: vi.fn(),
      events: { REBALANCING: "rebalance", GROUP_JOIN: "group_join", CRASH: "crash" },
    } as unknown as Consumer;
    const kafkaConsumer: IEventSubscriber = new KafkaEventConsumer({
      consumer: mockConsumer,
      topic: "aegis.events",
    });

    expect(typeof inMemory.subscribe).toBe("function");
    expect(typeof inMemory.unsubscribe).toBe("function");
    expect(typeof inMemory.start).toBe("function");
    expect(typeof inMemory.stop).toBe("function");
    expect(typeof inMemory.isRunning).toBe("boolean");

    expect(typeof kafkaConsumer.subscribe).toBe("function");
    expect(typeof kafkaConsumer.unsubscribe).toBe("function");
    expect(typeof kafkaConsumer.start).toBe("function");
    expect(typeof kafkaConsumer.stop).toBe("function");
    expect(typeof kafkaConsumer.isRunning).toBe("boolean");
  });

  it("executes full end-to-end dispatching with independent registration, wildcards, and metadata", async () => {
    const subscriber = new InMemoryEventSubscriber();
    const receivedEvents: EventEnvelope[] = [];
    const receivedMetadata: ConsumerRecordMetadata[] = [];

    const specificHandler: EventHandler = (envelope, metadata) => {
      receivedEvents.push(envelope);
      receivedMetadata.push(metadata);
      return Promise.resolve(ok(undefined));
    };

    const wildcardEvents: EventEnvelope[] = [];
    const wildcardHandler: EventHandler = (envelope) => {
      wildcardEvents.push(envelope);
      return Promise.resolve(ok(undefined));
    };

    // Independent registration: register BEFORE starting
    subscriber.subscribe("task_started", specificHandler);
    subscriber.subscribe("*", wildcardHandler);

    await subscriber.start();

    const event1 = createSampleEvent("task_started", "evt-int-1", "run-int-1");
    const envelope1 = toEventEnvelope(event1);

    const event2 = createSampleEvent("task_completed", "evt-int-2", "run-int-1");
    const envelope2 = toEventEnvelope(event2);

    await subscriber.dispatch(envelope1, {
      topic: "aegis.events",
      partition: 2,
      offset: "15",
    });
    await subscriber.dispatch(envelope2, {
      topic: "aegis.events",
      partition: 2,
      offset: "16",
    });

    // specificHandler only received task_started
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]?.id).toBe("evt-int-1");
    expect(receivedMetadata[0]?.offset).toBe("15");
    expect(receivedMetadata[0]?.partition).toBe(2);

    // wildcardHandler received both
    expect(wildcardEvents).toHaveLength(2);
    expect(wildcardEvents.map((e) => e.id)).toEqual(["evt-int-1", "evt-int-2"]);

    await subscriber.stop();
  });

  it("suppresses duplicate events across redeliveries while advancing offset", async () => {
    const deduplicator = new InMemoryDeduplicator(1000);
    const mockKafkaConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      commitOffsets: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      events: { REBALANCING: "rebalance", GROUP_JOIN: "group_join", CRASH: "crash" },
    };

    const consumer = new KafkaEventConsumer({
      consumer: mockKafkaConsumer as unknown as Consumer,
      topic: "aegis.events",
      deduplicator,
    });

    let handlerCalls = 0;
    const countingHandler: EventHandler = () => {
      handlerCalls++;
      return Promise.resolve(ok(undefined));
    };

    consumer.subscribe("task_started", countingHandler);

    const sample = createSampleEvent("task_started", "evt-dedup-999", "run-dedup-1");
    const envelope = toEventEnvelope(sample);
    const serRes = serializeEnvelope(envelope);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) throw serRes.error;

    const rawMessage = Buffer.from(serRes.value, "utf8");

    // Delivery 1 (Original)
    const payload1: EachMessagePayload = {
      topic: "aegis.events",
      partition: 0,
      message: createMockKafkaMessage({
        value: rawMessage,
        offset: "100",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const res1 = await consumer.processMessage(payload1);
    expect(res1).toBe(true);
    expect(handlerCalls).toBe(1);
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: "aegis.events", partition: 0, offset: "101" },
    ]);

    // Delivery 2 (Duplicate redelivery with identical eventId)
    const payload2: EachMessagePayload = {
      topic: "aegis.events",
      partition: 0,
      message: createMockKafkaMessage({
        value: rawMessage,
        offset: "101",
      }),
      heartbeat: vi.fn(),
      pause: vi.fn(),
    };

    const res2 = await consumer.processMessage(payload2);
    expect(res2).toBe(true);
    // Handler was NOT executed again (duplicate suppressed)
    expect(handlerCalls).toBe(1);
    // Offset was committed to avoid getting stuck on duplicate
    expect(mockKafkaConsumer.commitOffsets).toHaveBeenCalledWith([
      { topic: "aegis.events", partition: 0, offset: "102" },
    ]);
  });
});

describe.runIf(kafkaAvailable)("Live Kafka Broker Consumer Integration (Optional Live Broker)", () => {
  let clientManager: KafkaClientManager;
  let publisher: KafkaEventPublisher;
  let consumer: KafkaEventConsumer;
  const testTopic = `aegis.events.consumer-integration-${String(Date.now())}`;
  const testGroupId = `aegis-consumer-test-group-${String(Date.now())}`;

  beforeAll(async () => {
    clientManager = new KafkaClientManager({
      config: {
        brokers: ["localhost:9092"],
        clientId: "aegis-consumer-integration-client",
        eventsTopic: testTopic,
        connectionTimeoutMs: 5000,
        requestTimeoutMs: 15000,
        maxRetries: 3,
        retryInitialDelayMs: 100,
        retryMaxDelayMs: 1000,
        groupId: testGroupId,
        sessionTimeoutMs: 30000,
        heartbeatIntervalMs: 3000,
        shutdownTimeoutMs: 10000,
        fromBeginning: true,
      },
    });

    publisher = new KafkaEventPublisher({
      producer: clientManager.getProducer(),
      topic: testTopic,
    });

    consumer = new KafkaEventConsumer({
      consumer: clientManager.getConsumer(),
      topic: testTopic,
      fromBeginning: true,
    });

    await publisher.connect();
  });

  afterAll(async () => {
    await consumer.stop();
    await publisher.disconnect();
  });

  it("publishes and consumes real event envelope with broker partition and offset metadata", async () => {
    const receivedEnvelopes: EventEnvelope[] = [];
    let resolveReceived: () => void;
    const receivedPromise = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    consumer.subscribe("workflow_started", (envelope, metadata) => {
      receivedEnvelopes.push(envelope);
      expect(metadata.topic).toBe(testTopic);
      expect(metadata.partition).toBeGreaterThanOrEqual(0);
      expect(metadata.offset).toBeDefined();
      resolveReceived();
      return Promise.resolve(ok(undefined));
    });

    await consumer.start();

    const sample = createSampleEvent("workflow_started", `evt-live-${String(Date.now())}`, `run-live-${String(Date.now())}`);
    const envelope = toEventEnvelope(sample);

    const pubRes = await publisher.publish(envelope);
    expect(pubRes.ok).toBe(true);

    // Await message consumption with 10s timeout
    await Promise.race([
      receivedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Consumer timeout")), 10000)),
    ]);

    expect(receivedEnvelopes).toHaveLength(1);
    expect(receivedEnvelopes[0]?.id).toBe(envelope.id);
    expect(receivedEnvelopes[0]?.aggregateId).toBe(envelope.aggregateId);
  });
});
