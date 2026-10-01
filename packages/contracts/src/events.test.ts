import { eventId, runId, taskId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  consumerRecordMetadataSchema,
  eventConsumerErrorCodeSchema,
  eventEnvelopeSchema,
  eventPublishErrorCodeSchema,
  eventPublishResultSchema,
  eventSeveritySchema,
  eventTypeSchema,
  runEventSchema,
  type EventEnvelope,
  type RunEvent,
} from "./events.js";

describe("Event Contracts & Schemas", () => {
  describe("eventTypeSchema & eventSeveritySchema", () => {
    it("validates all canonical event types", () => {
      const types = [
        "run_created",
        "workflow_started",
        "task_scheduled",
        "task_started",
        "task_completed",
        "task_failed",
        "task_cancelled",
        "tool_invoked",
        "run_completed",
        "run_failed",
        "run_cancelled",
      ];
      for (const type of types) {
        expect(eventTypeSchema.parse(type)).toBe(type);
      }
      expect(() => eventTypeSchema.parse("invalid_event")).toThrow();
    });

    it("validates all canonical severity levels", () => {
      const severities = ["info", "warn", "error", "success"];
      for (const s of severities) {
        expect(eventSeveritySchema.parse(s)).toBe(s);
      }
      expect(() => eventSeveritySchema.parse("critical")).toThrow();
    });
  });

  describe("runEventSchema", () => {
    it("parses valid run event", () => {
      const raw = {
        id: eventId("evt-123"),
        runId: runId("run-456"),
        type: "task_started",
        severity: "info",
        timestamp: "2026-09-24T12:00:00.000Z",
        message: "Task started",
        taskId: taskId("task-1"),
        taskName: "Build",
      };
      const parsed = runEventSchema.parse(raw);
      expect(parsed.id).toBe(eventId("evt-123"));
      expect(parsed.type).toBe("task_started");
    });
  });

  describe("eventEnvelopeSchema", () => {
    it("validates well-formed Aegis canonical event envelope", () => {
      const data: RunEvent = {
        id: eventId("evt-123"),
        runId: runId("run-456"),
        type: "run_created",
        severity: "info",
        timestamp: "2026-09-24T12:00:00.000Z",
        message: "Run created",
      };

      const envelope: EventEnvelope = {
        id: eventId("evt-123"),
        type: "run_created",
        source: "aegis.api",
        specVersion: "1.0",
        time: "2026-09-24T12:00:00.000Z",
        aggregateId: runId("run-456"),
        aggregateType: "ExecutionRun",
        correlationId: "run-456",
        data,
      };

      const parsed = eventEnvelopeSchema.parse(envelope);
      expect(parsed.id).toBe(eventId("evt-123"));
      expect(parsed.specVersion).toBe("1.0");
      expect(parsed.aggregateType).toBe("ExecutionRun");
      expect(parsed.correlationId).toBe("run-456");
      expect(parsed.data.message).toBe("Run created");
    });

    it("rejects envelope with invalid specVersion", () => {
      const invalid = {
        id: eventId("evt-123"),
        type: "run_created",
        source: "aegis.api",
        specVersion: "2.0", // Only "1.0" is allowed
        time: "2026-09-24T12:00:00.000Z",
        aggregateId: runId("run-456"),
        aggregateType: "ExecutionRun",
        correlationId: "run-456",
        data: {
          id: eventId("evt-123"),
          runId: runId("run-456"),
          type: "run_created",
          severity: "info",
          timestamp: "2026-09-24T12:00:00.000Z",
          message: "Run created",
        },
      };
      expect(() => eventEnvelopeSchema.parse(invalid)).toThrow();
    });

    it("rejects envelope with invalid aggregateType", () => {
      const invalid = {
        id: eventId("evt-123"),
        type: "run_created",
        source: "aegis.api",
        specVersion: "1.0",
        time: "2026-09-24T12:00:00.000Z",
        aggregateId: runId("run-456"),
        aggregateType: "TaskAggregate", // Only "ExecutionRun" is allowed
        correlationId: "run-456",
        data: {
          id: eventId("evt-123"),
          runId: runId("run-456"),
          type: "run_created",
          severity: "info",
          timestamp: "2026-09-24T12:00:00.000Z",
          message: "Run created",
        },
      };
      expect(() => eventEnvelopeSchema.parse(invalid)).toThrow();
    });
  });

  describe("eventPublishResultSchema & error codes", () => {
    it("validates eventPublishResultSchema with optional messageId and partition", () => {
      const res = eventPublishResultSchema.parse({
        success: true,
        topic: "aegis.events",
        partition: 2,
        offset: "1054",
      });
      expect(res.success).toBe(true);
      expect(res.topic).toBe("aegis.events");
      expect(res.partition).toBe(2);
      expect(res.offset).toBe("1054");
      expect(res.messageId).toBeUndefined();
    });

    it("validates all canonical event publish error codes", () => {
      const codes = [
        "KAFKA_NOT_CONNECTED",
        "KAFKA_CONNECTION_FAILED",
        "KAFKA_PUBLISH_TIMEOUT",
        "SERIALIZATION_FAILED",
        "DESERIALIZATION_FAILED",
        "INVALID_ENVELOPE",
        "BROKER_UNAVAILABLE",
      ];
      for (const code of codes) {
        expect(eventPublishErrorCodeSchema.parse(code)).toBe(code);
      }
      expect(() => eventPublishErrorCodeSchema.parse("UNKNOWN_CODE")).toThrow();
    });
  });

  describe("Consumer Contracts & Schemas (Phase 10B)", () => {
    it("validates consumerRecordMetadataSchema with optional key", () => {
      const metadata = consumerRecordMetadataSchema.parse({
        topic: "aegis.events",
        partition: 0,
        offset: "42",
        timestamp: "2026-09-24T12:00:00.000Z",
        key: "run-123",
      });
      expect(metadata.topic).toBe("aegis.events");
      expect(metadata.partition).toBe(0);
      expect(metadata.offset).toBe("42");
      expect(metadata.key).toBe("run-123");

      const withoutKey = consumerRecordMetadataSchema.parse({
        topic: "aegis.events",
        partition: 1,
        offset: "100",
        timestamp: "2026-09-24T12:00:00.000Z",
      });
      expect(withoutKey.key).toBeUndefined();
    });

    it("validates all canonical event consumer error codes", () => {
      const codes = [
        "CONSUMER_NOT_CONNECTED",
        "SUBSCRIPTION_FAILED",
        "HANDLER_FAILED",
        "DESERIALIZATION_FAILED",
        "INVALID_ENVELOPE",
        "DUPLICATE_EVENT",
        "DISPATCH_ERROR",
      ];
      for (const code of codes) {
        expect(eventConsumerErrorCodeSchema.parse(code)).toBe(code);
      }
      expect(() => eventConsumerErrorCodeSchema.parse("INVALID_CODE")).toThrow();
    });
  });
});
