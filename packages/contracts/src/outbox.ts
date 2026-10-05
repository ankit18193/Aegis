/**
 * Outbox Contracts & Schemas — Phase 12C: Transactional Outbox Pattern
 * Defines contracts, schemas, typed errors, and repository interfaces for
 * durable event publication between PostgreSQL and Kafka.
 *
 * Invariant Locks:
 * - Lock 1: PostgreSQL authoritative outbox store.
 * - Lock 2: State mutation and outbox insertion in single transaction.
 * - Lock 3: Durability bridge, reusing canonical EventEnvelope.
 * - Lock 4: Stable event identity across retries.
 * - Lock 5: At-least-once delivery semantics.
 * - Lock 6: Explicit durable lifecycle states.
 */

import type { OutboxEventId } from "@aegis/types";
import { outboxEventId } from "@aegis/types";
import { z } from "zod";

import { eventEnvelopeSchema } from "./events.js";
import { taskAssignmentEnvelopeSchema } from "./taskAssignment.js";

// ─────────────────────────────────────────────────────────────────────────────
// Outbox Status & Nominal Branded Types
// ─────────────────────────────────────────────────────────────────────────────

export const outboxStatusSchema = z.enum([
  "pending",
  "publishing",
  "published",
  "failed",
]);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const outboxEventIdSchema = z.string().min(1).transform((v) => outboxEventId(v));

export const outboxPayloadSchema = z.union([
  eventEnvelopeSchema,
  taskAssignmentEnvelopeSchema,
  z.record(z.unknown()),
]);
export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Outbox Record Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const outboxRecordSchema = z.object({
  id: outboxEventIdSchema,
  aggregateId: z.string().min(1),
  aggregateType: z.string().min(1),
  eventType: z.string().min(1),
  topic: z.string().min(1).nullable().optional(),
  payload: eventEnvelopeSchema,
  status: outboxStatusSchema,
  attemptCount: z.number().int().min(0).default(0),
  lockedUntil: z.string().nullable().optional(),
  lockedBy: z.string().nullable().optional(),
  publishedAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
});

export interface GenericEnvelope<TData = unknown> {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly specVersion: string;
  readonly time: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly data: TData;
}

export type OutboxRecord<TData = unknown> = Omit<z.infer<typeof outboxRecordSchema>, "payload"> & {
  readonly payload: GenericEnvelope<TData>;
};

export const createOutboxRecordSchema = z.object({
  id: outboxEventIdSchema.optional(),
  aggregateId: z.string().min(1),
  aggregateType: z.string().min(1),
  eventType: z.string().min(1),
  topic: z.string().min(1).nullable().optional(),
  payload: outboxPayloadSchema,
  status: outboxStatusSchema.default("pending"),
  attemptCount: z.number().int().min(0).default(0),
  createdAt: z.string().optional(),
});

export type CreateOutboxRecord<TData = unknown> = Omit<z.input<typeof createOutboxRecordSchema>, "payload"> & {
  readonly payload: GenericEnvelope<TData>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Outbox Claiming & Configuration Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const outboxClaimRequestSchema = z.object({
  batchSize: z.number().int().positive().default(100),
  lockDurationMs: z.number().int().positive().default(30000),
  workerId: z.string().min(1),
});
export type OutboxClaimRequest = z.infer<typeof outboxClaimRequestSchema>;

export const outboxConfigSchema = z.object({
  /** Interval in milliseconds between publisher poll sweeps (default 500ms). */
  pollIntervalMs: z.number().int().positive().default(500),
  /** Maximum number of records claimed per sweep (default 100). */
  batchSize: z.number().int().positive().default(100),
  /** Duration in milliseconds that a claimed record remains locked (default 30,000ms). */
  lockDurationMs: z.number().int().positive().default(30000),
  /** Maximum delivery attempts before marking a record failed (default 5). */
  maxAttempts: z.number().int().positive().default(5),
  /** Initial backoff delay in milliseconds on transient failure (default 1,000ms). */
  backoffBaseMs: z.number().int().positive().default(1000),
  /** Maximum backoff delay in milliseconds on transient failure (default 60,000ms). */
  backoffMaxMs: z.number().int().positive().default(60000),
});
export type OutboxConfig = z.infer<typeof outboxConfigSchema>;

export const DEFAULT_OUTBOX_CONFIG: OutboxConfig = Object.freeze({
  pollIntervalMs: 500,
  batchSize: 100,
  lockDurationMs: 30000,
  maxAttempts: 5,
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Typed Outbox Errors
// ─────────────────────────────────────────────────────────────────────────────

export type OutboxErrorCode =
  | "OUTBOX_INSERT_FAILED"
  | "OUTBOX_CLAIM_FAILED"
  | "OUTBOX_RECORD_NOT_FOUND"
  | "OUTBOX_SERIALIZATION_FAILED"
  | "OUTBOX_CONCURRENCY_CONFLICT"
  | "OUTBOX_PUBLISH_FAILED";

export class OutboxError extends Error {
  constructor(
    readonly code: OutboxErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "OutboxError";
  }
}

export class OutboxClaimConflictError extends OutboxError {
  constructor(message: string, cause?: unknown) {
    super("OUTBOX_CLAIM_FAILED", message, cause);
    this.name = "OutboxClaimConflictError";
  }
}

export class OutboxSerializationError extends OutboxError {
  constructor(message: string, cause?: unknown) {
    super("OUTBOX_SERIALIZATION_FAILED", message, cause);
    this.name = "OutboxSerializationError";
  }
}

export class OutboxRecordNotFoundError extends OutboxError {
  constructor(readonly outboxId: OutboxEventId) {
    super("OUTBOX_RECORD_NOT_FOUND", `Outbox record '${outboxId}' was not found.`);
    this.name = "OutboxRecordNotFoundError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbox Repository Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface IOutboxRepository {
  /**
   * Persists outbox records. When tx is provided, inserts within an active transaction.
   */
  insert(records: readonly CreateOutboxRecord[], tx?: unknown): Promise<void>;

  /**
   * Atomically claims up to batchSize pending (or expired locked) records using SKIP LOCKED,
   * transitioning them to 'publishing' status guarded by lockDurationMs.
   */
  claimPending(request: OutboxClaimRequest): Promise<OutboxRecord[]>;

  /**
   * Atomically marks claimed records as successfully published.
   */
  markPublished(ids: readonly OutboxEventId[], publishedAt?: Date): Promise<void>;

  /**
   * Records a publication failure for a record, updating attemptCount, lastError,
   * and releasing the lock for retry with backoff.
   */
  markFailed(id: OutboxEventId, error: string, nextAttemptAt?: Date): Promise<void>;

  /**
   * Retrieves the current count of pending records in the outbox.
   */
  getPendingCount(): Promise<number>;

  /**
   * Retrieves the current count of failed records in the outbox.
   */
  getFailedCount(): Promise<number>;
}
