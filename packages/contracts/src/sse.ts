/**
 * Canonical Server-Sent Events (SSE) Transport Contracts — Phase 13B (Commit 1)
 *
 * Defines the typed, validated wire protocol for real-time execution event streaming.
 * Provides transport envelopes, protocol versioning, lifecycle discrimination,
 * heartbeat frames, structured error payloads, and factory functions.
 *
 * Boundary Discipline:
 * - Transport is NOT domain persistence: does not alter database or outbox schemas.
 * - Transport is NOT the event gateway: does not subscribe to Kafka or manage workers.
 * - Decoupled from HTTP framework: completely independent of Fastify and React.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │                   Aegis SSE Transport Wire Architecture                │
 * ├────────────────────────────────────────────────────────────────────────┤
 * │                                                                        │
 * │   [ Domain Engine ]                                                    │
 * │         │                                                              │
 * │         ▼ (RunEvent: task_started, run_completed, etc.)                │
 * │   ┌─────────────────────────────────────────────────────────────┐      │
 * │   │              SseTransportEnvelope (specVersion: "1.0")      │      │
 * │   │ ┌─────────────────────────────────────────────────────────┐ │      │
 * │   │ │ id: EventId | timestamp: ISO8601 | runId? | taskId?     │ │      │
 * │   │ ├─────────────────────────────────────────────────────────┤ │      │
 * │   │ │ type: "connected"  │ payload: { streamId, heartbeatMs } │ │      │
 * │   │ │ type: "heartbeat"  │ payload: { serverTime, seq? }      │ │      │
 * │   │ │ type: "execution"  │ payload: RunEvent (canonical)      │ │      │
 * │   │ │ type: "error"      │ payload: { code, message, retry }  │ │      │
 * │   │ │ type: "closed"     │ payload: { reason, terminal }      │ │      │
 * │   │ └─────────────────────────────────────────────────────────┘ │      │
 * │   └───────────────────────────────┬─────────────────────────────┘      │
 * │                                   │                                    │
 * │                                   ▼                                    │
 * │              [ Standard SSE Framing: id / event / data ]               │
 * │                                   │                                    │
 * │                                   ▼                                    │
 * │        Browser Client / Aegis Console (IExecutionStreamClient)         │
 * └────────────────────────────────────────────────────────────────────────┘
 */

import { err, ok, type Result } from "@aegis/types";
import { z } from "zod";

import { runEventSchema, type RunEvent } from "./events.js";
import { eventIdSchema, runIdSchema, taskIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Protocol Version and Transport Message Types
// ─────────────────────────────────────────────────────────────────────────────

export const SSE_PROTOCOL_VERSION = "1.0" as const;
export const sseProtocolVersionSchema = z.literal(SSE_PROTOCOL_VERSION);
export type SseProtocolVersion = z.infer<typeof sseProtocolVersionSchema>;

export const sseMessageTypeSchema = z.enum([
  "connected",
  "heartbeat",
  "execution",
  "error",
  "closed",
]);
export type SseMessageType = z.infer<typeof sseMessageTypeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Transport Error Codes & Payload
// ─────────────────────────────────────────────────────────────────────────────

export const sseErrorCodeSchema = z.enum([
  "STREAM_TIMEOUT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RUN_NOT_FOUND",
  "INTERNAL_TRANSPORT_ERROR",
  "CLIENT_DISCONNECTED",
  "RATE_LIMITED",
  "INVALID_PROTOCOL_VERSION",
  "MALFORMED_PAYLOAD",
  "CONNECTION_ABORTED",
  "BUFFER_OVERFLOW",
  "REPLAY_GAP_DETECTED",
]);
export type SseErrorCode = z.infer<typeof sseErrorCodeSchema>;

export const sseErrorPayloadSchema = z.object({
  code: sseErrorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
});
export type SseErrorPayload = z.infer<typeof sseErrorPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle and Heartbeat Payloads
// ─────────────────────────────────────────────────────────────────────────────

export const sseConnectedPayloadSchema = z.object({
  streamId: z.string().min(1),
  serverTime: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive(),
  runId: runIdSchema.optional(),
  capabilities: z.array(z.string()).readonly().optional(),
});
export type SseConnectedPayload = z.infer<typeof sseConnectedPayloadSchema>;

export const sseClosedPayloadSchema = z.object({
  reason: z.string().min(1),
  terminal: z.boolean(),
  runId: runIdSchema.optional(),
});
export type SseClosedPayload = z.infer<typeof sseClosedPayloadSchema>;

export const sseHeartbeatPayloadSchema = z.object({
  serverTime: z.string().min(1),
  sequenceNumber: z.number().int().nonnegative().optional(),
});
export type SseHeartbeatPayload = z.infer<typeof sseHeartbeatPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Execution Payload (Strictly reuses canonical RunEvent)
// ─────────────────────────────────────────────────────────────────────────────

export const sseExecutionPayloadSchema = runEventSchema;
export type SseExecutionPayload = RunEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Discriminated SSE Envelopes
// ─────────────────────────────────────────────────────────────────────────────

const baseEnvelopeFields = {
  id: eventIdSchema,
  specVersion: sseProtocolVersionSchema,
  timestamp: z.string().min(1),
  runId: runIdSchema.optional(),
  taskId: taskIdSchema.optional(),
};

export const sseConnectedEnvelopeSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("connected"),
  payload: sseConnectedPayloadSchema,
});
export type SseConnectedEnvelope = z.infer<typeof sseConnectedEnvelopeSchema>;

export const sseHeartbeatEnvelopeSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("heartbeat"),
  payload: sseHeartbeatPayloadSchema,
});
export type SseHeartbeatEnvelope = z.infer<typeof sseHeartbeatEnvelopeSchema>;

export const sseExecutionEnvelopeSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("execution"),
  payload: sseExecutionPayloadSchema,
});
export type SseExecutionEnvelope = z.infer<typeof sseExecutionEnvelopeSchema>;

export const sseErrorEnvelopeSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("error"),
  payload: sseErrorPayloadSchema,
});
export type SseErrorEnvelope = z.infer<typeof sseErrorEnvelopeSchema>;

export const sseClosedEnvelopeSchema = z.object({
  ...baseEnvelopeFields,
  type: z.literal("closed"),
  payload: sseClosedPayloadSchema,
});
export type SseClosedEnvelope = z.infer<typeof sseClosedEnvelopeSchema>;

export const sseTransportEnvelopeSchema = z.discriminatedUnion("type", [
  sseConnectedEnvelopeSchema,
  sseHeartbeatEnvelopeSchema,
  sseExecutionEnvelopeSchema,
  sseErrorEnvelopeSchema,
  sseClosedEnvelopeSchema,
]);
export type SseTransportEnvelope = z.infer<typeof sseTransportEnvelopeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Validation & Factory Helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface SseValidationError {
  readonly code: "MALFORMED_PAYLOAD" | "INVALID_PROTOCOL_VERSION";
  readonly message: string;
  readonly issues: readonly string[];
}

/**
 * Validates a raw JavaScript object against the canonical SSE transport envelope schema.
 * Returns a Result with the typed SseTransportEnvelope or a structured SseValidationError.
 */
export function validateSseEnvelope(
  raw: unknown,
): Result<SseTransportEnvelope, SseValidationError> {
  const parseResult = sseTransportEnvelopeSchema.safeParse(raw);
  if (parseResult.success) {
    return ok(parseResult.data);
  }

  const issues = parseResult.error.issues.map(
    (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
  );

  const isVersionError = parseResult.error.issues.some(
    (issue) => issue.path.includes("specVersion"),
  );

  return err({
    code: isVersionError ? "INVALID_PROTOCOL_VERSION" : "MALFORMED_PAYLOAD",
    message: `SSE transport envelope validation failed: ${issues.join("; ")}`,
    issues,
  });
}

/**
 * Factory for creating a canonical connected envelope.
 */
export function createSseConnectedEnvelope(params: {
  id: SseConnectedEnvelope["id"];
  streamId: string;
  serverTime?: string;
  heartbeatIntervalMs: number;
  runId?: SseConnectedEnvelope["runId"];
  capabilities?: readonly string[];
}): SseConnectedEnvelope {
  const timestamp = params.serverTime ?? new Date().toISOString();
  return {
    id: params.id,
    specVersion: SSE_PROTOCOL_VERSION,
    type: "connected",
    timestamp,
    runId: params.runId,
    payload: {
      streamId: params.streamId,
      serverTime: timestamp,
      heartbeatIntervalMs: params.heartbeatIntervalMs,
      runId: params.runId,
      capabilities: params.capabilities,
    },
  };
}

/**
 * Factory for creating a canonical heartbeat envelope.
 */
export function createSseHeartbeatEnvelope(params: {
  id: SseHeartbeatEnvelope["id"];
  serverTime?: string;
  sequenceNumber?: number;
  runId?: SseHeartbeatEnvelope["runId"];
}): SseHeartbeatEnvelope {
  const timestamp = params.serverTime ?? new Date().toISOString();
  return {
    id: params.id,
    specVersion: SSE_PROTOCOL_VERSION,
    type: "heartbeat",
    timestamp,
    runId: params.runId,
    payload: {
      serverTime: timestamp,
      sequenceNumber: params.sequenceNumber,
    },
  };
}

/**
 * Factory for creating a canonical execution envelope from a domain RunEvent.
 */
export function createSseExecutionEnvelope(event: RunEvent): SseExecutionEnvelope {
  return {
    id: event.id,
    specVersion: SSE_PROTOCOL_VERSION,
    type: "execution",
    timestamp: event.timestamp,
    runId: event.runId,
    taskId: event.taskId,
    payload: event,
  };
}

/**
 * Factory for creating a canonical transport error envelope.
 */
export function createSseErrorEnvelope(params: {
  id: SseErrorEnvelope["id"];
  code: SseErrorCode;
  message: string;
  retryable: boolean;
  runId?: SseErrorEnvelope["runId"];
  details?: Record<string, unknown> | undefined;
  timestamp?: string | undefined;
}): SseErrorEnvelope {
  const timestamp = params.timestamp ?? new Date().toISOString();
  return {
    id: params.id,
    specVersion: SSE_PROTOCOL_VERSION,
    type: "error",
    timestamp,
    runId: params.runId,
    payload: {
      code: params.code,
      message: params.message,
      retryable: params.retryable,
      details: params.details,
    },
  };
}

/**
 * Factory for creating a canonical stream closed envelope.
 */
export function createSseClosedEnvelope(params: {
  id: SseClosedEnvelope["id"];
  reason: string;
  terminal: boolean;
  runId?: SseClosedEnvelope["runId"];
  timestamp?: string;
}): SseClosedEnvelope {
  const timestamp = params.timestamp ?? new Date().toISOString();
  return {
    id: params.id,
    specVersion: SSE_PROTOCOL_VERSION,
    type: "closed",
    timestamp,
    runId: params.runId,
    payload: {
      reason: params.reason,
      terminal: params.terminal,
      runId: params.runId,
    },
  };
}
