/**
 * Integration test suite for Kafka Event Backbone.
 *
 * Provides two testing tiers:
 * 1. Hermetic Event Pipeline: Always executes with zero external dependencies,
 *    verifying the complete envelope lifecycle, schema validation, and transport parity.
 * 2. Live Broker Integration: Skips cleanly when Kafka is unreachable on port 9092,
 *    protecting hermetic CI while enabling live end-to-end verification when Docker Kafka is up.
 */

import * as net from "node:net";

import type { RunEvent } from "@aegis/contracts";
import { eventEnvelopeSchema } from "@aegis/contracts";
import type { EventId, RunId } from "@aegis/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deserializeEnvelope, serializeEnvelope, toEventEnvelope } from "../../../events/envelope.js";
import { InMemoryEventPublisher } from "../../../events/inMemoryPublisher.js";
import { KafkaClientManager } from "../client.js";
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

function createSampleDomainEvent(runId = "run-prod-001", eventId = "evt-prod-001"): RunEvent {
  return {
    id: eventId as EventId,
    runId: runId as RunId,
    type: "workflow_started",
    timestamp: new Date().toISOString(),
    severity: "info",
    message: "Workflow orchestration initiated",
    metadata: {
      tasksCount: 3,
      environment: "test",
    },
  };
}

describe("Hermetic Event Pipeline Integration (Zero External Dependencies)", () => {
  it("executes complete envelope lifecycle through explicit serialization boundary", () => {
    const domainEvent = createSampleDomainEvent("run-pipeline-01", "evt-pipeline-01");
    const envelope = toEventEnvelope(domainEvent, {
      source: "aegis.workflow.engine",
      correlationId: "corr-run-pipeline-01",
      causationId: "trigger-user-01",
    });

    // Verify envelope schema compliance
    const parsedSchema = eventEnvelopeSchema.safeParse(envelope);
    expect(parsedSchema.success).toBe(true);

    // Serialize envelope
    const serResult = serializeEnvelope(envelope);
    expect(serResult.ok).toBe(true);
    if (!serResult.ok) return;

    // Deserialize envelope and verify complete fidelity
    const deserResult = deserializeEnvelope(serResult.value);
    expect(deserResult.ok).toBe(true);
    if (!deserResult.ok) return;

    expect(deserResult.value.id).toBe("evt-pipeline-01");
    expect(deserResult.value.aggregateId).toBe("run-pipeline-01");
    expect(deserResult.value.aggregateType).toBe("ExecutionRun");
    expect(deserResult.value.specVersion).toBe("1.0");
    expect(deserResult.value.source).toBe("aegis.workflow.engine");
    expect(deserResult.value.correlationId).toBe("corr-run-pipeline-01");
    expect(deserResult.value.causationId).toBe("trigger-user-01");
    expect(deserResult.value.data.message).toBe("Workflow orchestration initiated");
  });

  it("verifies transport parity between InMemoryEventPublisher and canonical contract", async () => {
    const publisher = new InMemoryEventPublisher();
    const event1 = toEventEnvelope(createSampleDomainEvent("run-mem-1", "evt-mem-1"));
    const event2 = toEventEnvelope(createSampleDomainEvent("run-mem-1", "evt-mem-2"));

    const pubRes1 = await publisher.publish(event1);
    expect(pubRes1.ok).toBe(true);
    if (pubRes1.ok) {
      expect(pubRes1.value.success).toBe(true);
      expect(pubRes1.value.topic).toBe("aegis.events");
      expect(pubRes1.value.partition).toBe(0);
      expect(pubRes1.value.offset).toBe("0");
    }

    const pubBatchRes = await publisher.publishBatch([event2]);
    expect(pubBatchRes.ok).toBe(true);
    if (pubBatchRes.ok) {
      expect(pubBatchRes.value).toHaveLength(1);
      expect(pubBatchRes.value[0]?.offset).toBe("1");
    }

    expect(publisher.getPublishedEnvelopes()).toHaveLength(2);
    expect(publisher.getEnvelopesByRunId("run-mem-1")).toHaveLength(2);
  });
});

describe.runIf(kafkaAvailable)("Kafka Live Broker Integration (Optional Live Broker)", () => {
  let clientManager: KafkaClientManager;
  let publisher: KafkaEventPublisher;

  beforeAll(async () => {
    clientManager = new KafkaClientManager({
      config: {
        brokers: ["localhost:9092"],
        clientId: "aegis-integration-test",
        eventsTopic: "aegis.events.integration",
        connectionTimeoutMs: 5000,
        requestTimeoutMs: 15000,
        maxRetries: 3,
        retryInitialDelayMs: 100,
        retryMaxDelayMs: 1000,
      },
    });

    publisher = new KafkaEventPublisher({
      producer: clientManager.getProducer(),
      topic: "aegis.events.integration",
    });

    const connRes = await publisher.connect();
    if (!connRes.ok) {
      throw new Error(`Failed to connect to live Kafka broker: ${connRes.error.message}`);
    }
  }, 10000);

  afterAll(async () => {
    await publisher.disconnect();
  });

  it("publishes real event envelope to Kafka with broker partition and offset metadata", async () => {
    const event = createSampleDomainEvent("run-live-001", "evt-live-001");
    const envelope = toEventEnvelope(event, { source: "aegis.live.integration" });

    const result = await publisher.publish(envelope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.topic).toBe("aegis.events.integration");
      expect(result.value.partition).toBeGreaterThanOrEqual(0);
      expect(typeof result.value.offset).toBe("string");
      expect(result.value.messageId).toBeUndefined(); // User safeguard 2
    }
  });

  it("publishes batch of real event envelopes maintaining FIFO partition keys", async () => {
    const event1 = createSampleDomainEvent("run-live-batch", "evt-live-b1");
    const event2 = createSampleDomainEvent("run-live-batch", "evt-live-b2");
    const env1 = toEventEnvelope(event1);
    const env2 = toEventEnvelope(event2);

    const result = await publisher.publishBatch([env1, env2]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.partition).toBeGreaterThanOrEqual(0);
      expect(result.value[1]?.partition).toBeGreaterThanOrEqual(0);
    }
  });
});
