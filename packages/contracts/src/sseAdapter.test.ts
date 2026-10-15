import { eventId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { EventEnvelope, RunEvent } from "./events.js";
import { validateSseEnvelope } from "./sse.js";
import {
  isSupportedExecutionEventType,
  mapEventEnvelopeToSseEnvelope,
  mapExecutionEventToSseEnvelope,
  mapRunEventToSseEnvelope,
  mapTaskAssignmentToSseEnvelope,
  SUPPORTED_EXECUTION_EVENT_TYPES,
  type SupportedExecutionEventType,
} from "./sseAdapter.js";
import { assignmentIdSchema, type TaskAssignmentEnvelope } from "./taskAssignment.js";

describe("Execution Event to SSE Transport Adapter — Phase 13C (Commit 1)", () => {
  const sampleRunId = runId("run-phase13c-001");
  const sampleTaskId = taskId("task-phase13c-001");
  const sampleWorkerId = workerId("worker-phase13c-001");
  const sampleTimestamp = "2026-10-15T12:00:00.000Z";

  const createSampleRunEvent = (
    type: SupportedExecutionEventType,
    idStr = "evt-13c-001",
  ): RunEvent => ({
    id: eventId(idStr),
    runId: sampleRunId,
    type,
    severity: type.includes("failed") ? "error" : type.includes("expired") ? "warn" : "info",
    timestamp: sampleTimestamp,
    message: `Sample event message for ${type}`,
    taskId: sampleTaskId,
    taskName: "Execute Step",
    worker: sampleWorkerId,
    metadata: { attempt: 1, step: "init" },
  });

  const createSampleEventEnvelope = (
    runEvent: RunEvent,
  ): EventEnvelope => ({
    id: runEvent.id,
    type: runEvent.type,
    source: "aegis.execution.engine",
    specVersion: "1.0",
    time: runEvent.timestamp,
    aggregateId: runEvent.runId,
    aggregateType: "ExecutionRun",
    correlationId: "corr-13c-001",
    data: runEvent,
  });

  const createSampleAssignmentEnvelope = (): TaskAssignmentEnvelope => ({
    id: eventId("evt-assign-001"),
    type: "task_assigned",
    source: "aegis.dispatcher",
    specVersion: "1.0",
    time: sampleTimestamp,
    aggregateId: sampleTaskId,
    aggregateType: "TaskAssignment",
    correlationId: "corr-assign-001",
    data: {
      assignmentId: assignmentIdSchema.parse("assign-001"),
      taskId: sampleTaskId,
      runId: sampleRunId,
      workerId: sampleWorkerId,
      task: {
        id: sampleTaskId,
        name: "Process Item",
        status: "queued",
        description: "Process step",
        version: 1,
        attemptCount: 1,
      },
      assignedAt: sampleTimestamp,
    },
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Supported Event Types
  // ───────────────────────────────────────────────────────────────────────────
  describe("Supported Execution Event Types", () => {
    it("recognizes all 13 canonical execution event types", () => {
      expect(SUPPORTED_EXECUTION_EVENT_TYPES).toHaveLength(13);

      for (const type of SUPPORTED_EXECUTION_EVENT_TYPES) {
        expect(isSupportedExecutionEventType(type)).toBe(true);
      }
    });

    it("rejects non-execution or arbitrary strings", () => {
      expect(isSupportedExecutionEventType("user_logged_in")).toBe(false);
      expect(isSupportedExecutionEventType("billing_charged")).toBe(false);
      expect(isSupportedExecutionEventType("system_backup")).toBe(false);
      expect(isSupportedExecutionEventType("")).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Direct RunEvent Mapping
  // ───────────────────────────────────────────────────────────────────────────
  describe("mapRunEventToSseEnvelope", () => {
    it.each(SUPPORTED_EXECUTION_EVENT_TYPES)(
      "successfully maps canonical event type: %s",
      (eventType) => {
        const event = createSampleRunEvent(eventType);
        const result = mapRunEventToSseEnvelope(event);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const envelope = result.value;
        expect(envelope.type).toBe("execution");
        expect(envelope.specVersion).toBe("1.0");
        expect(envelope.id).toBe(event.id);
        expect(envelope.timestamp).toBe(event.timestamp);
        expect(envelope.runId).toBe(event.runId);
        expect(envelope.taskId).toBe(event.taskId);
        expect(envelope.payload).toEqual(event);

        // Verify valid against Phase 13B transport schema
        const transportValidation = validateSseEnvelope(envelope);
        expect(transportValidation.ok).toBe(true);
      },
    );

    it("strictly preserves event ID and timestamp without fabricating identity", () => {
      const explicitId = eventId("custom-durable-event-id-999");
      const explicitTime = "2026-03-15T08:30:15.123Z";
      const event: RunEvent = {
        ...createSampleRunEvent("task_completed"),
        id: explicitId,
        timestamp: explicitTime,
      };

      const result = mapRunEventToSseEnvelope(event);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe(explicitId);
      expect(result.value.timestamp).toBe(explicitTime);
      expect(result.value.payload.id).toBe(explicitId);
      expect(result.value.payload.timestamp).toBe(explicitTime);
    });

    it("returns UNSUPPORTED_EVENT_TYPE for invalid event types", () => {
      const invalidEvent = {
        ...createSampleRunEvent("task_started"),
        type: "unknown_lifecycle_event" as unknown as SupportedExecutionEventType,
      };

      const result = mapRunEventToSseEnvelope(invalidEvent);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("UNSUPPORTED_EVENT_TYPE");
      expect(result.error.message).toContain("unknown_lifecycle_event");
    });

    it("returns MALFORMED_EVENT_PAYLOAD when missing required fields", () => {
      const malformed = {
        id: eventId("evt-malformed"),
        type: "task_started",
        // missing runId, timestamp, severity, message
      } as unknown as RunEvent;

      const result = mapRunEventToSseEnvelope(malformed);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("MALFORMED_EVENT_PAYLOAD");
      expect(result.error.issues).toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. EventEnvelope (CloudEvents) Mapping
  // ───────────────────────────────────────────────────────────────────────────
  describe("mapEventEnvelopeToSseEnvelope", () => {
    it("extracts and maps inner RunEvent from canonical EventEnvelope", () => {
      const runEvent = createSampleRunEvent("task_started");
      const eventEnvelope = createSampleEventEnvelope(runEvent);

      const result = mapEventEnvelopeToSseEnvelope(eventEnvelope);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe(eventEnvelope.id);
      expect(result.value.timestamp).toBe(eventEnvelope.time);
      expect(result.value.runId).toBe(eventEnvelope.aggregateId);
      expect(result.value.payload).toEqual(runEvent);
    });

    it("returns MALFORMED_EVENT_PAYLOAD for invalid EventEnvelope structure", () => {
      const badEnvelope = {
        id: "not-an-id",
        aggregateType: "ExecutionRun",
        // missing type, specVersion, time, data
      } as unknown as EventEnvelope;

      const result = mapEventEnvelopeToSseEnvelope(badEnvelope);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("MALFORMED_EVENT_PAYLOAD");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. TaskAssignmentEnvelope Mapping
  // ───────────────────────────────────────────────────────────────────────────
  describe("mapTaskAssignmentToSseEnvelope", () => {
    it("maps task_assigned envelope to task_scheduled SSE execution envelope", () => {
      const assignment = createSampleAssignmentEnvelope();
      const result = mapTaskAssignmentToSseEnvelope(assignment);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const envelope = result.value;
      expect(envelope.id).toBe(assignment.id);
      expect(envelope.timestamp).toBe(assignment.time);
      expect(envelope.runId).toBe(assignment.data.runId);
      expect(envelope.taskId).toBe(assignment.data.taskId);
      expect(envelope.payload.type).toBe("task_scheduled");
      expect(envelope.payload.worker).toBe(assignment.data.workerId);
      expect(envelope.payload.taskName).toBe("Process Item");
      expect(envelope.payload.metadata?.["assignmentId"]).toBe("assign-001");
    });

    it("returns MALFORMED_EVENT_PAYLOAD if TaskAssignmentEnvelope is invalid", () => {
      const invalidAssignment = {
        id: eventId("assign-invalid"),
        type: "task_assigned",
        // missing required CloudEvents and data fields
      } as unknown as TaskAssignmentEnvelope;

      const result = mapTaskAssignmentToSseEnvelope(invalidAssignment);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("MALFORMED_EVENT_PAYLOAD");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Polymorphic mapExecutionEventToSseEnvelope
  // ───────────────────────────────────────────────────────────────────────────
  describe("mapExecutionEventToSseEnvelope", () => {
    it("polymorphically maps direct RunEvent object", () => {
      const runEvent = createSampleRunEvent("workflow_started");
      const result = mapExecutionEventToSseEnvelope(runEvent);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.payload.type).toBe("workflow_started");
    });

    it("polymorphically maps CloudEvents EventEnvelope object", () => {
      const runEvent = createSampleRunEvent("run_completed");
      const envelope = createSampleEventEnvelope(runEvent);
      const result = mapExecutionEventToSseEnvelope(envelope);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.payload.type).toBe("run_completed");
    });

    it("polymorphically maps TaskAssignmentEnvelope object", () => {
      const assignment = createSampleAssignmentEnvelope();
      const result = mapExecutionEventToSseEnvelope(assignment);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.payload.type).toBe("task_scheduled");
    });

    it("parses and maps JSON string containing RunEvent", () => {
      const runEvent = createSampleRunEvent("task_reassigned");
      const json = JSON.stringify(runEvent);

      const result = mapExecutionEventToSseEnvelope(json);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.payload.type).toBe("task_reassigned");
      expect(result.value.id).toBe(runEvent.id);
    });

    it("parses and maps JSON string containing EventEnvelope", () => {
      const runEvent = createSampleRunEvent("task_lease_expired");
      const envelope = createSampleEventEnvelope(runEvent);
      const json = JSON.stringify(envelope);

      const result = mapExecutionEventToSseEnvelope(json);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.payload.type).toBe("task_lease_expired");
      expect(result.value.id).toBe(envelope.id);
    });

    it("returns INVALID_JSON for unparseable JSON string", () => {
      const badJson = '{"type": "task_started", "id":';
      const result = mapExecutionEventToSseEnvelope(badJson);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVALID_JSON");
      expect(result.error.message).toContain("Failed to parse execution event JSON");
    });

    it("returns MALFORMED_EVENT_PAYLOAD for null, non-objects, and primitives", () => {
      expect(mapExecutionEventToSseEnvelope(null).ok).toBe(false);
      expect(mapExecutionEventToSseEnvelope(undefined).ok).toBe(false);
      expect(mapExecutionEventToSseEnvelope(42).ok).toBe(false);
      expect(mapExecutionEventToSseEnvelope(true).ok).toBe(false);
      expect(mapExecutionEventToSseEnvelope([]).ok).toBe(false);
    });

    it("returns UNSUPPORTED_EVENT_TYPE for object with unhandled type property", () => {
      const unknownEvent = {
        type: "unknown_custom_event",
        id: "evt-999",
      };

      const result = mapExecutionEventToSseEnvelope(unknownEvent);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("UNSUPPORTED_EVENT_TYPE");
      expect(result.error.message).toContain("unknown_custom_event");
    });

    it("returns MALFORMED_EVENT_PAYLOAD for unrecognized object shapes", () => {
      const weirdObject = {
        foo: "bar",
        baz: 123,
      };

      const result = mapExecutionEventToSseEnvelope(weirdObject);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("MALFORMED_EVENT_PAYLOAD");
    });
  });
});
