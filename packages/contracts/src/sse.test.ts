import { eventId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { RunEvent } from "./events.js";
import {
  createSseClosedEnvelope,
  createSseConnectedEnvelope,
  createSseErrorEnvelope,
  createSseExecutionEnvelope,
  createSseHeartbeatEnvelope,
  SSE_PROTOCOL_VERSION,
  sseClosedEnvelopeSchema,
  sseConnectedEnvelopeSchema,
  sseErrorEnvelopeSchema,
  sseExecutionEnvelopeSchema,
  sseHeartbeatEnvelopeSchema,
  sseTransportEnvelopeSchema,
  validateSseEnvelope,
  type SseTransportEnvelope,
} from "./sse.js";

function createValidRunEvent(): RunEvent {
  return {
    id: eventId("evt-domain-100"),
    runId: runId("run-test-100"),
    type: "task_started",
    severity: "info",
    timestamp: "2026-10-15T00:00:00.000Z",
    message: "Task execution started",
    taskId: taskId("task-100-1"),
    taskName: "Compile Model",
    worker: workerId("worker-node-1"),
    metadata: { attempt: 1 },
  };
}

describe("Canonical SSE Transport Contracts (Phase 13B)", () => {
  describe("Protocol Version and Constants", () => {
    it("defines SSE_PROTOCOL_VERSION as '1.0'", () => {
      expect(SSE_PROTOCOL_VERSION).toBe("1.0");
    });
  });

  describe("Schema Validation for Envelope Types", () => {
    it("validates a well-formed connected envelope", () => {
      const envelope = {
        id: eventId("sse-conn-1"),
        specVersion: "1.0",
        type: "connected",
        timestamp: "2026-10-15T00:00:00.000Z",
        runId: runId("run-100"),
        payload: {
          streamId: "stream-abc-123",
          serverTime: "2026-10-15T00:00:00.000Z",
          heartbeatIntervalMs: 15000,
          runId: runId("run-100"),
          capabilities: ["replay", "compression"],
        },
      };

      const result = sseConnectedEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("connected");
        expect(result.data.payload.streamId).toBe("stream-abc-123");
        expect(result.data.payload.heartbeatIntervalMs).toBe(15000);
      }
    });

    it("validates a well-formed heartbeat envelope", () => {
      const envelope = {
        id: eventId("sse-hb-1"),
        specVersion: "1.0",
        type: "heartbeat",
        timestamp: "2026-10-15T00:00:15.000Z",
        payload: {
          serverTime: "2026-10-15T00:00:15.000Z",
          sequenceNumber: 42,
        },
      };

      const result = sseHeartbeatEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("heartbeat");
        expect(result.data.payload.sequenceNumber).toBe(42);
      }
    });

    it("validates a well-formed execution envelope wrapping a canonical RunEvent", () => {
      const runEvent = createValidRunEvent();
      const envelope = {
        id: runEvent.id,
        specVersion: "1.0",
        type: "execution",
        timestamp: runEvent.timestamp,
        runId: runEvent.runId,
        taskId: runEvent.taskId,
        payload: runEvent,
      };

      const result = sseExecutionEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("execution");
        expect(result.data.payload.type).toBe("task_started");
        expect(result.data.payload.worker).toBe("worker-node-1");
      }
    });

    it("validates a well-formed error envelope", () => {
      const envelope = {
        id: eventId("sse-err-1"),
        specVersion: "1.0",
        type: "error",
        timestamp: "2026-10-15T00:00:05.000Z",
        runId: runId("run-100"),
        payload: {
          code: "RUN_NOT_FOUND",
          message: "Execution run 'run-100' does not exist or has expired.",
          retryable: false,
          details: { attemptedRunId: "run-100" },
        },
      };

      const result = sseErrorEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("error");
        expect(result.data.payload.code).toBe("RUN_NOT_FOUND");
        expect(result.data.payload.retryable).toBe(false);
      }
    });

    it("validates a well-formed closed envelope", () => {
      const envelope = {
        id: eventId("sse-close-1"),
        specVersion: "1.0",
        type: "closed",
        timestamp: "2026-10-15T00:00:20.000Z",
        runId: runId("run-100"),
        payload: {
          reason: "Run execution reached terminal status 'completed'.",
          terminal: true,
          runId: runId("run-100"),
        },
      };

      const result = sseClosedEnvelopeSchema.safeParse(envelope);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe("closed");
        expect(result.data.payload.terminal).toBe(true);
      }
    });
  });

  describe("Discriminated Union Schema (sseTransportEnvelopeSchema)", () => {
    it("parses and discriminates all envelope types correctly", () => {
      const runEvent = createValidRunEvent();
      const envelopes = [
        createSseConnectedEnvelope({
          id: eventId("c-1"),
          streamId: "st-1",
          heartbeatIntervalMs: 10000,
        }),
        createSseHeartbeatEnvelope({
          id: eventId("h-1"),
          sequenceNumber: 1,
        }),
        createSseExecutionEnvelope(runEvent),
        createSseErrorEnvelope({
          id: eventId("e-1"),
          code: "STREAM_TIMEOUT",
          message: "Timed out",
          retryable: true,
        }),
        createSseClosedEnvelope({
          id: eventId("cl-1"),
          reason: "Terminated",
          terminal: false,
        }),
      ];

      for (const env of envelopes) {
        const parsed = sseTransportEnvelopeSchema.safeParse(env);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.type).toBe(env.type);
        }
      }
    });

    it("rejects unknown message types", () => {
      const invalid = {
        id: eventId("sse-bad-1"),
        specVersion: "1.0",
        type: "unknown_future_type",
        timestamp: "2026-10-15T00:00:00.000Z",
        payload: {},
      };

      const parsed = sseTransportEnvelopeSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);
    });
  });

  describe("Malformed Payloads & Schema Violations", () => {
    it("rejects unsupported protocol versions", () => {
      const invalid = {
        id: eventId("sse-ver-1"),
        specVersion: "2.0",
        type: "heartbeat",
        timestamp: "2026-10-15T00:00:00.000Z",
        payload: { serverTime: "2026-10-15T00:00:00.000Z" },
      };

      const parsed = sseTransportEnvelopeSchema.safeParse(invalid);
      expect(parsed.success).toBe(false);

      const validation = validateSseEnvelope(invalid);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.error.code).toBe("INVALID_PROTOCOL_VERSION");
      }
    });

    it("rejects missing envelope identifiers", () => {
      const missingId = {
        specVersion: "1.0",
        type: "heartbeat",
        timestamp: "2026-10-15T00:00:00.000Z",
        payload: { serverTime: "2026-10-15T00:00:00.000Z" },
      };

      const validation = validateSseEnvelope(missingId);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.error.code).toBe("MALFORMED_PAYLOAD");
        expect(validation.error.issues.some((i) => i.includes("id"))).toBe(true);
      }
    });

    it("rejects invalid error codes in error envelope", () => {
      const invalidError = {
        id: eventId("sse-e-1"),
        specVersion: "1.0",
        type: "error",
        timestamp: "2026-10-15T00:00:00.000Z",
        payload: {
          code: "NOT_A_REAL_ERROR_CODE",
          message: "Something broke",
          retryable: true,
        },
      };

      const validation = validateSseEnvelope(invalidError);
      expect(validation.ok).toBe(false);
    });

    it("rejects non-positive heartbeat interval", () => {
      const invalidConnected = {
        id: eventId("sse-c-1"),
        specVersion: "1.0",
        type: "connected",
        timestamp: "2026-10-15T00:00:00.000Z",
        payload: {
          streamId: "str-1",
          serverTime: "2026-10-15T00:00:00.000Z",
          heartbeatIntervalMs: 0,
        },
      };

      const validation = validateSseEnvelope(invalidConnected);
      expect(validation.ok).toBe(false);
    });

    it("rejects invalid RunEvent in execution envelope", () => {
      const invalidExecution = {
        id: eventId("sse-ex-1"),
        specVersion: "1.0",
        type: "execution",
        timestamp: "2026-10-15T00:00:00.000Z",
        payload: {
          // Missing required RunEvent fields (type, severity, message, etc.)
          id: "evt-broken",
        },
      };

      const validation = validateSseEnvelope(invalidExecution);
      expect(validation.ok).toBe(false);
    });
  });

  describe("Validation & Factory Helpers", () => {
    it("validates envelope successfully with validateSseEnvelope()", () => {
      const runEvent = createValidRunEvent();
      const envelope = createSseExecutionEnvelope(runEvent);

      const validation = validateSseEnvelope(envelope);
      expect(validation.ok).toBe(true);
      if (validation.ok) {
        const parsed: SseTransportEnvelope = validation.value;
        expect(parsed.type).toBe("execution");
        if (parsed.type === "execution") {
          expect(parsed.payload.id).toBe(runEvent.id);
          expect(parsed.payload.type).toBe("task_started");
        }
      }
    });

    it("creates valid envelopes via all factory functions", () => {
      const conn = createSseConnectedEnvelope({
        id: eventId("c-10"),
        streamId: "stream-999",
        heartbeatIntervalMs: 20000,
        runId: runId("run-999"),
        capabilities: ["filtering"],
      });
      expect(validateSseEnvelope(conn).ok).toBe(true);

      const hb = createSseHeartbeatEnvelope({
        id: eventId("h-10"),
        sequenceNumber: 7,
      });
      expect(validateSseEnvelope(hb).ok).toBe(true);

      const errEnv = createSseErrorEnvelope({
        id: eventId("e-10"),
        code: "UNAUTHORIZED",
        message: "Missing token",
        retryable: false,
        runId: runId("run-999"),
      });
      expect(validateSseEnvelope(errEnv).ok).toBe(true);

      const closed = createSseClosedEnvelope({
        id: eventId("cl-10"),
        reason: "Client request completed",
        terminal: true,
        runId: runId("run-999"),
      });
      expect(validateSseEnvelope(closed).ok).toBe(true);
    });
  });

  describe("Compatibility with Phase 13A Client Abstraction", () => {
    it("execution envelope unboxes directly into a canonical RunEvent", () => {
      const runEvent = createValidRunEvent();
      const envelope = createSseExecutionEnvelope(runEvent);

      // The payload must be structurally identical to RunEvent
      const unboxed: RunEvent = envelope.payload;
      expect(unboxed.id).toBe(runEvent.id);
      expect(unboxed.runId).toBe(runEvent.runId);
      expect(unboxed.type).toBe("task_started");
      expect(unboxed.message).toBe("Task execution started");
    });

    it("error envelope payload maps cleanly to ExecutionStreamError structure", () => {
      const errorEnv = createSseErrorEnvelope({
        id: eventId("e-map-1"),
        code: "INTERNAL_TRANSPORT_ERROR",
        message: "Underlying stream pipe broke",
        retryable: true,
        details: { code: 500 },
      });

      const clientError = {
        code: errorEnv.payload.code,
        message: errorEnv.payload.message,
        retryable: errorEnv.payload.retryable,
      };

      expect(clientError.code).toBe("INTERNAL_TRANSPORT_ERROR");
      expect(clientError.message).toBe("Underlying stream pipe broke");
      expect(clientError.retryable).toBe(true);
    });
  });
});
