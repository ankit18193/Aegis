import type { Result } from "@aegis/types";
import { z } from "zod";

import { eventIdSchema, runIdSchema, taskIdSchema, workerIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Event Types and Severity Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const eventTypeSchema = z.enum([
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
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventSeveritySchema = z.enum(["info", "warn", "error", "success"]);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Run Event Contract
// ─────────────────────────────────────────────────────────────────────────────

export const runEventSchema = z.object({
  id: eventIdSchema,
  runId: runIdSchema,
  type: eventTypeSchema,
  severity: eventSeveritySchema,
  timestamp: z.string(),
  message: z.string().min(1),
  taskId: taskIdSchema.optional(),
  taskName: z.string().optional(),
  worker: workerIdSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Event Envelope Contract (Aegis canonical envelope with CloudEvents-inspired metadata)
// ─────────────────────────────────────────────────────────────────────────────

export const eventEnvelopeSchema = z.object({
  id: eventIdSchema,
  type: eventTypeSchema,
  source: z.string().min(1),
  specVersion: z.literal("1.0"),
  time: z.string().min(1),
  aggregateId: runIdSchema,
  aggregateType: z.literal("ExecutionRun"),
  correlationId: z.string().min(1),
  causationId: z.string().optional(),
  data: runEventSchema,
});
export type EventEnvelope<T = RunEvent> = Omit<z.infer<typeof eventEnvelopeSchema>, "data"> & {
  readonly data: T;
};

// ─────────────────────────────────────────────────────────────────────────────
// Event Publisher Contracts & Errors
// ─────────────────────────────────────────────────────────────────────────────

export const eventPublishErrorCodeSchema = z.enum([
  "KAFKA_NOT_CONNECTED",
  "KAFKA_CONNECTION_FAILED",
  "KAFKA_PUBLISH_TIMEOUT",
  "SERIALIZATION_FAILED",
  "DESERIALIZATION_FAILED",
  "INVALID_ENVELOPE",
  "BROKER_UNAVAILABLE",
]);
export type EventPublishErrorCode = z.infer<typeof eventPublishErrorCodeSchema>;

export interface EventPublishErrorContract {
  readonly code: EventPublishErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export const eventPublishResultSchema = z.object({
  success: z.boolean(),
  topic: z.string().min(1),
  partition: z.number().int().nonnegative().optional(),
  offset: z.string().optional(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});
export type EventPublishResult = z.infer<typeof eventPublishResultSchema>;

/**
 * Single canonical contract for publishing events across the Aegis platform.
 */
export interface IEventPublisher {
  publish(envelope: EventEnvelope): Promise<Result<EventPublishResult, EventPublishErrorContract>>;
  publishBatch(
    envelopes: readonly EventEnvelope[],
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>>;
}

