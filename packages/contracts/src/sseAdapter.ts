/**
 * Canonical Execution Event to SSE Transport Adapter — Phase 13C (Commit 1)
 *
 * Implements a transport-independent adapter that maps canonical Aegis execution
 * events (RunEvent, EventEnvelope, TaskAssignmentEnvelope) into validated
 * Phase 13B SSE execution envelopes (SseExecutionEnvelope).
 *
 * Guarantees & Architectural Invariants:
 * 1. Transport Decoupling: Zero dependencies on Fastify, HTTP, DOM, or SSE connection state.
 * 2. Identity Preservation: Strictly preserves original event IDs and timestamps; never fabricates identity.
 * 3. Type Safety: Validates all outgoing envelopes against canonical sseExecutionEnvelopeSchema.
 * 4. Deterministic Errors: Structured SseAdapterError for unsupported event types and malformed payloads.
 * 5. Comprehensive Event Support: Supports run, task, assignment, failure, and recovery events.
 */

import { err, ok, type Result } from "@aegis/types";

import {
  eventEnvelopeSchema,
  runEventSchema,
  type EventEnvelope,
  type RunEvent,
} from "./events.js";
import {
  createSseExecutionEnvelope,
  sseExecutionEnvelopeSchema,
  type SseExecutionEnvelope,
} from "./sse.js";
import {
  taskAssignmentEnvelopeSchema,
  type TaskAssignmentEnvelope,
} from "./taskAssignment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Supported Event Types
// ─────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_EXECUTION_EVENT_TYPES = [
  "run_created",
  "workflow_started",
  "task_scheduled",
  "task_started",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "task_lease_expired",
  "task_reassigned",
  "tool_invoked",
  "run_completed",
  "run_failed",
  "run_cancelled",
] as const;

export type SupportedExecutionEventType =
  (typeof SUPPORTED_EXECUTION_EVENT_TYPES)[number];

/**
 * Type guard verifying if an arbitrary event type string is a recognized Aegis execution event.
 */
export function isSupportedExecutionEventType(
  type: string,
): type is SupportedExecutionEventType {
  return (SUPPORTED_EXECUTION_EVENT_TYPES as readonly string[]).includes(type);
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter Error Contracts
// ─────────────────────────────────────────────────────────────────────────────

export type SseAdapterErrorCode =
  | "UNSUPPORTED_EVENT_TYPE"
  | "MALFORMED_EVENT_PAYLOAD"
  | "INVALID_JSON"
  | "VALIDATION_FAILED";

export interface SseAdapterError {
  readonly code: SseAdapterErrorCode;
  readonly message: string;
  readonly issues?: readonly string[];
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Mapping Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates and maps a canonical domain `RunEvent` to a validated `SseExecutionEnvelope`.
 * Strictly preserves `event.id` and `event.timestamp`.
 */
export function mapRunEventToSseEnvelope(
  event: RunEvent,
): Result<SseExecutionEnvelope, SseAdapterError> {
  // 1. Verify that event type is supported
  if (!isSupportedExecutionEventType(event.type)) {
    return err({
      code: "UNSUPPORTED_EVENT_TYPE",
      message: `Event type '${String(event.type)}' is not a supported Aegis execution event for SSE delivery.`,
    });
  }

  // 2. Validate incoming domain event against canonical schema
  const parsedEvent = runEventSchema.safeParse(event);
  if (!parsedEvent.success) {
    const issues = parsedEvent.error.issues.map(
      (i) => `${i.path.join(".") || "root"}: ${i.message}`,
    );
    return err({
      code: "MALFORMED_EVENT_PAYLOAD",
      message: `Invalid RunEvent schema: ${issues.join("; ")}`,
      issues,
    });
  }

  // 3. Construct canonical Phase 13B SSE execution envelope preserving identity
  const envelope = createSseExecutionEnvelope(parsedEvent.data);

  // 4. Validate outgoing envelope against canonical SSE execution schema
  const validatedEnvelope = sseExecutionEnvelopeSchema.safeParse(envelope);
  if (!validatedEnvelope.success) {
    const issues = validatedEnvelope.error.issues.map(
      (i) => `${i.path.join(".") || "root"}: ${i.message}`,
    );
    return err({
      code: "VALIDATION_FAILED",
      message: `Failed to construct valid SseExecutionEnvelope: ${issues.join("; ")}`,
      issues,
    });
  }

  return ok(validatedEnvelope.data);
}

/**
 * Validates and maps an Aegis CloudEvents-style `EventEnvelope` containing a `RunEvent`
 * to a validated `SseExecutionEnvelope`.
 */
export function mapEventEnvelopeToSseEnvelope(
  envelope: EventEnvelope,
): Result<SseExecutionEnvelope, SseAdapterError> {
  const parsedEnvelope = eventEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    const issues = parsedEnvelope.error.issues.map(
      (i) => `${i.path.join(".") || "root"}: ${i.message}`,
    );
    return err({
      code: "MALFORMED_EVENT_PAYLOAD",
      message: `Invalid EventEnvelope schema: ${issues.join("; ")}`,
      issues,
    });
  }

  // Check event type
  if (!isSupportedExecutionEventType(parsedEnvelope.data.type)) {
    return err({
      code: "UNSUPPORTED_EVENT_TYPE",
      message: `EventEnvelope type '${String(parsedEnvelope.data.type)}' is not a supported Aegis execution event.`,
    });
  }

  return mapRunEventToSseEnvelope(parsedEnvelope.data.data);
}

/**
 * Maps a canonical `TaskAssignmentEnvelope` (`task_assigned` event from Kafka / outbox)
 * to a canonical `task_scheduled` execution event in an `SseExecutionEnvelope`.
 */
export function mapTaskAssignmentToSseEnvelope(
  envelope: TaskAssignmentEnvelope,
): Result<SseExecutionEnvelope, SseAdapterError> {
  const parsedEnvelope = taskAssignmentEnvelopeSchema.safeParse(envelope);
  if (!parsedEnvelope.success) {
    const issues = parsedEnvelope.error.issues.map(
      (i) => `${i.path.join(".") || "root"}: ${i.message}`,
    );
    return err({
      code: "MALFORMED_EVENT_PAYLOAD",
      message: `Invalid TaskAssignmentEnvelope schema: ${issues.join("; ")}`,
      issues,
    });
  }

  const assignment = parsedEnvelope.data.data;

  // Synthesize canonical RunEvent for task scheduling while strictly preserving original event identity
  const synthesizedEvent: RunEvent = {
    id: parsedEnvelope.data.id,
    runId: assignment.runId,
    type: "task_scheduled",
    severity: "info",
    timestamp: parsedEnvelope.data.time,
    message: `Task '${assignment.task.name}' scheduled for execution`,
    taskId: assignment.taskId,
    taskName: assignment.task.name,
    ...(assignment.workerId !== undefined ? { worker: assignment.workerId } : {}),
    metadata: {
      assignmentId: assignment.assignmentId,
      taskStatus: assignment.task.status,
      assignedAt: assignment.assignedAt,
    },
  };

  return mapRunEventToSseEnvelope(synthesizedEvent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Polymorphic Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Universal adapter parsing, validating, and converting arbitrary incoming execution
 * event payloads (JSON strings, raw objects, RunEvent, EventEnvelope, TaskAssignmentEnvelope)
 * into a canonical Phase 13B `SseExecutionEnvelope`.
 *
 * Never throws exceptions; returns a deterministic Result.
 */
export function mapExecutionEventToSseEnvelope(
  raw: unknown,
): Result<SseExecutionEnvelope, SseAdapterError> {
  let payload: unknown = raw;

  // 1. Handle JSON string input
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch (parseError) {
      return err({
        code: "INVALID_JSON",
        message: `Failed to parse execution event JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        cause: parseError,
      });
    }
  }

  // 2. Validate object structure
  if (typeof payload !== "object" || payload === null) {
    return err({
      code: "MALFORMED_EVENT_PAYLOAD",
      message: "Execution event payload must be a non-null object.",
    });
  }

  const candidate = payload as Record<string, unknown>;

  // 3. Fast-path unsupported type detection if type is present
  if (typeof candidate["type"] === "string") {
    const rawType = candidate["type"];
    if (rawType === "task_assigned") {
      return mapTaskAssignmentToSseEnvelope(
        payload as unknown as TaskAssignmentEnvelope,
      );
    }
    if (!isSupportedExecutionEventType(rawType)) {
      return err({
        code: "UNSUPPORTED_EVENT_TYPE",
        message: `Event type '${rawType}' is not a supported Aegis execution event for SSE delivery.`,
      });
    }
  }

  // 4. Discriminate CloudEvents EventEnvelope (has aggregateType and data object)
  if (
    candidate["aggregateType"] === "ExecutionRun" &&
    typeof candidate["data"] === "object" &&
    candidate["data"] !== null
  ) {
    return mapEventEnvelopeToSseEnvelope(payload as unknown as EventEnvelope);
  }

  // 5. Discriminate canonical RunEvent (has severity, message, timestamp, runId)
  if (
    "runId" in candidate &&
    "severity" in candidate &&
    "message" in candidate &&
    "timestamp" in candidate
  ) {
    return mapRunEventToSseEnvelope(payload as unknown as RunEvent);
  }

  // 6. If data property is present, check if data is a RunEvent
  if (typeof candidate["data"] === "object" && candidate["data"] !== null) {
    const innerData = candidate["data"] as Record<string, unknown>;
    if (
      "runId" in innerData &&
      "severity" in innerData &&
      "message" in innerData
    ) {
      return mapRunEventToSseEnvelope(innerData as unknown as RunEvent);
    }
  }

  return err({
    code: "MALFORMED_EVENT_PAYLOAD",
    message:
      "Unrecognized execution event format. Payload matches neither RunEvent, EventEnvelope, nor TaskAssignmentEnvelope.",
  });
}
