import type { RunEvent } from "@aegis/contracts";
import { eventId, runId, taskId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import {
  deserializeEnvelope,
  serializeEnvelope,
  toEventEnvelope,
} from "../envelope.js";
import { EventPublishError } from "../errors.js";
import { InMemoryEventPublisher } from "../inMemoryPublisher.js";

describe("Event Transport Contracts & Serialization Boundary", () => {
  let sampleRunEvent: RunEvent;

  beforeEach(() => {
    sampleRunEvent = {
      id: eventId("evt-uuid-101"),
      runId: runId("run-uuid-202"),
      type: "task_completed",
      severity: "success",
      timestamp: "2026-09-24T12:30:00.000Z",
      message: "Task completed successfully",
      taskId: taskId("task-303"),
      taskName: "Build Artifact",
      metadata: { durationMs: 450 },
    };
  });

  describe("toEventEnvelope", () => {
    it("wraps canonical RunEvent with CloudEvents-inspired metadata", () => {
      const envelope = toEventEnvelope(sampleRunEvent);

      expect(envelope.id).toBe(eventId("evt-uuid-101"));
      expect(envelope.type).toBe("task_completed");
      expect(envelope.source).toBe("aegis.api");
      expect(envelope.specVersion).toBe("1.0");
      expect(envelope.time).toBe("2026-09-24T12:30:00.000Z");
      expect(envelope.aggregateId).toBe(runId("run-uuid-202"));
      expect(envelope.aggregateType).toBe("ExecutionRun");
      expect(envelope.correlationId).toBe("run-uuid-202");
      expect(envelope.causationId).toBeUndefined();
      expect(envelope.data).toEqual(sampleRunEvent);
    });

    it("respects custom source, correlationId, and causationId options", () => {
      const envelope = toEventEnvelope(sampleRunEvent, {
        source: "aegis.worker.node-1",
        correlationId: "corr-999",
        causationId: "evt-prior-000",
      });

      expect(envelope.source).toBe("aegis.worker.node-1");
      expect(envelope.correlationId).toBe("corr-999");
      expect(envelope.causationId).toBe("evt-prior-000");
    });
  });

  describe("Explicit JSON Serialization Boundary", () => {
    it("serializes and deserializes cleanly roundtrip", () => {
      const envelope = toEventEnvelope(sampleRunEvent);
      const serRes = serializeEnvelope(envelope);
      expect(serRes.ok).toBe(true);

      if (!serRes.ok) throw new Error("Serialization failed");
      const json = serRes.value;
      expect(typeof json).toBe("string");

      const deserRes = deserializeEnvelope(json);
      expect(deserRes.ok).toBe(true);
      if (!deserRes.ok) throw new Error("Deserialization failed");

      expect(deserRes.value).toEqual(envelope);
    });

    it("handles serialization failure gracefully when circular reference is present", () => {
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;

      const badEvent: RunEvent = {
        ...sampleRunEvent,
        metadata: circular,
      };
      const envelope = toEventEnvelope(badEvent);

      const res = serializeEnvelope(envelope);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("SERIALIZATION_FAILED");
      }
    });

    it("rejects unparseable non-JSON strings with DeserializationError", () => {
      const res = deserializeEnvelope("invalid json content {");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DESERIALIZATION_FAILED");
      }
    });

    it("rejects valid JSON that violates the EventEnvelope schema with InvalidEnvelopeError", () => {
      const invalidEnvelopeJson = JSON.stringify({
        id: "evt-123",
        type: "unknown_event_type",
        specVersion: "1.0",
        // missing required fields: source, time, aggregateId, aggregateType, correlationId, data
      });

      const res = deserializeEnvelope(invalidEnvelopeJson);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_ENVELOPE");
      }
    });
  });

  describe("InMemoryEventPublisher", () => {
    let publisher: InMemoryEventPublisher;

    beforeEach(() => {
      publisher = new InMemoryEventPublisher("aegis.test.events");
    });

    it("publishes an envelope and records it in memory", async () => {
      const envelope = toEventEnvelope(sampleRunEvent);
      const result = await publisher.publish(envelope);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Publish failed");

      expect(result.value.success).toBe(true);
      expect(result.value.topic).toBe("aegis.test.events");
      expect(result.value.partition).toBe(0);
      expect(result.value.offset).toBe("0");

      const published = publisher.getPublishedEnvelopes();
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual(envelope);
    });

    it("publishes batches of envelopes preserving order and assigning sequential offsets", async () => {
      const env1 = toEventEnvelope(sampleRunEvent);
      const env2 = toEventEnvelope({
        ...sampleRunEvent,
        id: eventId("evt-uuid-102"),
        type: "run_completed",
      });

      const result = await publisher.publishBatch([env1, env2]);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Batch publish failed");

      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.offset).toBe("0");
      expect(result.value[1]?.offset).toBe("1");

      const published = publisher.getPublishedEnvelopes();
      expect(published).toHaveLength(2);
      expect(published[0]?.id).toBe(eventId("evt-uuid-101"));
      expect(published[1]?.id).toBe(eventId("evt-uuid-102"));
    });

    it("supports simulated failure for testing failure containment", async () => {
      const envelope = toEventEnvelope(sampleRunEvent);
      const simError = new EventPublishError("KAFKA_PUBLISH_TIMEOUT", "Simulated broker timeout");
      publisher.simulateFailure(simError);

      const res = await publisher.publish(envelope);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("KAFKA_PUBLISH_TIMEOUT");
        expect(res.error.message).toContain("Simulated broker timeout");
      }

      // Buffer remains empty on simulated failure
      expect(publisher.getPublishedEnvelopes()).toHaveLength(0);

      // Clearing simulated failure restores normal operation
      publisher.simulateFailure(null);
      const okRes = await publisher.publish(envelope);
      expect(okRes.ok).toBe(true);
      expect(publisher.getPublishedEnvelopes()).toHaveLength(1);
    });

    it("clears published envelopes on clear()", async () => {
      await publisher.publish(toEventEnvelope(sampleRunEvent));
      expect(publisher.getPublishedEnvelopes()).toHaveLength(1);

      publisher.clear();
      expect(publisher.getPublishedEnvelopes()).toHaveLength(0);
    });
  });
});
