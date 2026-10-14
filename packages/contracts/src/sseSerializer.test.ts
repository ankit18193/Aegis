import { eventId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { RunEvent } from "./events.js";
import {
  createSseClosedEnvelope,
  createSseConnectedEnvelope,
  createSseErrorEnvelope,
  createSseExecutionEnvelope,
  createSseHeartbeatEnvelope,
} from "./sse.js";
import {
  deserializeSseEnvelope,
  formatSseComment,
  formatSseFrame,
  formatSseHeartbeatComment,
  parseSseFrame,
  serializeSseEnvelope,
} from "./sseSerializer.js";

function createTestRunEvent(): RunEvent {
  return {
    id: eventId("evt-ser-101"),
    runId: runId("run-ser-101"),
    type: "task_started",
    severity: "info",
    timestamp: "2026-10-15T00:00:00.000Z",
    message: "Worker started task processing",
    taskId: taskId("task-ser-101-1"),
    taskName: "Data Ingestion",
    worker: workerId("worker-alpha-1"),
    metadata: {
      batchSize: 500,
      description: "Multiline\nExecution\nLog",
    },
  };
}

describe("Deterministic SSE Frame Serialization (Phase 13B — Commit 2)", () => {
  describe("Low-Level Frame Formatting", () => {
    it("formats a standard SSE frame with id, event, and single-line data", () => {
      const res = formatSseFrame({
        id: "evt-1",
        event: "task_started",
        data: '{"status":"ok"}',
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(
          "id: evt-1\n" +
          "event: task_started\n" +
          'data: {"status":"ok"}\n\n'
        );
      }
    });

    it("formats an SSE frame with reconnect retry delay", () => {
      const res = formatSseFrame({
        id: "evt-2",
        event: "message",
        retry: 3000,
        data: "hello",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(
          "id: evt-2\n" +
          "event: message\n" +
          "retry: 3000\n" +
          "data: hello\n\n"
        );
      }
    });

    it("ensures frame ends with double newline per SSE specification", () => {
      const res = formatSseFrame({ data: "payload" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.endsWith("\n\n")).toBe(true);
      }
    });
  });

  describe("Multiline Data Handling", () => {
    it("splits multiline data across multiple data: lines", () => {
      const multiline = "Line 1: Initialize\nLine 2: Compute\r\nLine 3: Finalize";
      const res = formatSseFrame({
        id: "evt-multi",
        event: "log",
        data: multiline,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(
          "id: evt-multi\n" +
          "event: log\n" +
          "data: Line 1: Initialize\n" +
          "data: Line 2: Compute\n" +
          "data: Line 3: Finalize\n\n"
        );
      }
    });

    it("parses multiline data back into a single string with newlines preserved", () => {
      const wire =
        "id: 42\n" +
        "event: report\n" +
        "data: # Markdown Header\n" +
        "data: - Item 1\n" +
        "data: - Item 2\n\n";

      const parsed = parseSseFrame(wire);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.id).toBe("42");
        expect(parsed.value.event).toBe("report");
        expect(parsed.value.data).toBe(
          "# Markdown Header\n- Item 1\n- Item 2"
        );
      }
    });
  });

  describe("Heartbeat and Comment Frames", () => {
    it("formats standard keep-alive comment frames", () => {
      expect(formatSseHeartbeatComment()).toBe(": keep-alive\n\n");
      expect(formatSseComment("ping")).toBe(": ping\n\n");
    });

    it("handles multiline comments with each line prefixed by colon", () => {
      const comment = "Heartbeat Header\nTimestamp: 2026-10-15";
      expect(formatSseComment(comment)).toBe(
        ": Heartbeat Header\n: Timestamp: 2026-10-15\n\n"
      );
    });

    it("parses comment frames correctly with parseSseFrame", () => {
      const parsed = parseSseFrame(": ping-heartbeat\n\n");
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.comment).toBe("ping-heartbeat");
      }
    });
  });

  describe("Injection Safety and Malformed Input", () => {
    it("rejects newline in 'id' field with INVALID_FIELD_NEWLINE", () => {
      const res = formatSseFrame({
        id: "evt-inject\nevent: malicious",
        data: "test",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_FIELD_NEWLINE");
      }
    });

    it("rejects carriage return in 'event' field with INVALID_FIELD_NEWLINE", () => {
      const res = formatSseFrame({
        event: "bad\revent",
        data: "test",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_FIELD_NEWLINE");
      }
    });

    it("rejects negative retry values with INVALID_RETRY_VALUE", () => {
      const res = formatSseFrame({
        retry: -50,
        data: "test",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_RETRY_VALUE");
      }
    });

    it("rejects completely empty frame", () => {
      const res = formatSseFrame({});
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("EMPTY_FRAME");
      }
    });
  });

  describe("High-Level Envelope Serialization (serializeSseEnvelope)", () => {
    it("serializes an execution envelope containing a RunEvent", () => {
      const event = createTestRunEvent();
      const envelope = createSseExecutionEnvelope(event);

      const serialized = serializeSseEnvelope(envelope);
      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        expect(serialized.value).toContain(`id: ${event.id}\n`);
        expect(serialized.value).toContain("event: execution\n");
        expect(serialized.value).toContain('data: {"id":"evt-ser-101"');
        expect(serialized.value.endsWith("\n\n")).toBe(true);
      }
    });

    it("supports custom eventName override and retryMs option", () => {
      const event = createTestRunEvent();
      const envelope = createSseExecutionEnvelope(event);

      const serialized = serializeSseEnvelope(envelope, {
        eventName: "aegis.execution.task_started",
        retryMs: 5000,
      });

      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        expect(serialized.value).toContain("event: aegis.execution.task_started\n");
        expect(serialized.value).toContain("retry: 5000\n");
      }
    });

    it("rejects invalid envelope when validation is enabled", () => {
      const invalidEnvelope = {
        id: "not-a-valid-envelope",
        specVersion: "99.0", // Invalid specVersion
        type: "unknown",
      };

      const serialized = serializeSseEnvelope(invalidEnvelope);
      expect(serialized.ok).toBe(false);
      if (!serialized.ok) {
        expect(serialized.error.code).toBe("VALIDATION_FAILED");
        expect(serialized.error.validationIssues).toBeDefined();
      }
    });

    it("allows bypassing validation with validate: false option", () => {
      const rawEnvelope = {
        id: "raw-id-99",
        type: "custom_type",
        payload: { arbitrary: true },
      };

      const serialized = serializeSseEnvelope(rawEnvelope, { validate: false });
      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        expect(serialized.value).toContain("id: raw-id-99\n");
        expect(serialized.value).toContain("event: custom_type\n");
      }
    });
  });

  describe("Unicode and Special Character Preservation", () => {
    it("faithfully preserves Unicode characters and emojis across serialization and deserialization", () => {
      const event: RunEvent = {
        id: eventId("evt-unicode-🔥"),
        runId: runId("run-unicode-🚀"),
        type: "task_completed",
        severity: "success",
        timestamp: "2026-10-15T00:00:00.000Z",
        message: "Pipeline completed successfully! 🚀 実行完了 (Tokyo, 東京) — €100 & 100% ⚡",
        taskId: taskId("task-unicode-1"),
        metadata: {
          japanese: "エージェント実行完了",
          symbols: "∑(x_i) ≈ √π",
          quotes: 'Single \' and Double " in text',
        },
      };

      const envelope = createSseExecutionEnvelope(event);
      const serialized = serializeSseEnvelope(envelope);
      expect(serialized.ok).toBe(true);

      if (serialized.ok) {
        const deserialized = deserializeSseEnvelope(serialized.value);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(deserialized.value.type).toBe("execution");
          if (deserialized.value.type === "execution") {
            expect(deserialized.value.payload.message).toBe(
              "Pipeline completed successfully! 🚀 実行完了 (Tokyo, 東京) — €100 & 100% ⚡"
            );
            expect(deserialized.value.payload.metadata?.["japanese"]).toBe("エージェント実行完了");
            expect(deserialized.value.payload.metadata?.["symbols"]).toBe("∑(x_i) ≈ √π");
          }
        }
      }
    });
  });

  describe("End-to-End Round-Trip Fidelity for All Envelope Types", () => {
    it("round-trips SseConnectedEnvelope", () => {
      const env = createSseConnectedEnvelope({
        id: eventId("c-rt-1"),
        streamId: "stream-roundtrip-1",
        heartbeatIntervalMs: 15000,
        runId: runId("run-rt-1"),
        capabilities: ["replay", "filter"],
      });

      const serialized = serializeSseEnvelope(env);
      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        const deserialized = deserializeSseEnvelope(serialized.value);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(deserialized.value).toEqual(env);
        }
      }
    });

    it("round-trips SseHeartbeatEnvelope", () => {
      const env = createSseHeartbeatEnvelope({
        id: eventId("h-rt-1"),
        sequenceNumber: 108,
      });

      const serialized = serializeSseEnvelope(env);
      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        const deserialized = deserializeSseEnvelope(serialized.value);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(deserialized.value).toEqual(env);
        }
      }
    });

    it("round-trips SseErrorEnvelope", () => {
      const env = createSseErrorEnvelope({
        id: eventId("e-rt-1"),
        code: "UNAUTHORIZED",
        message: "Bearer token expired or invalid",
        retryable: false,
        runId: runId("run-rt-err"),
        details: { code: 401 },
      });

      const serialized = serializeSseEnvelope(env);
      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        const deserialized = deserializeSseEnvelope(serialized.value);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(deserialized.value).toEqual(env);
        }
      }
    });

    it("round-trips SseClosedEnvelope", () => {
      const env = createSseClosedEnvelope({
        id: eventId("cl-rt-1"),
        reason: "Run completed normally",
        terminal: true,
        runId: runId("run-rt-closed"),
      });

      const serialized = serializeSseEnvelope(env);
      expect(serialized.ok).toBe(true);
      if (serialized.ok) {
        const deserialized = deserializeSseEnvelope(serialized.value);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(deserialized.value).toEqual(env);
        }
      }
    });
  });
});
