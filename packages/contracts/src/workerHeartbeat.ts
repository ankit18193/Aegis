import type { HeartbeatId, Result, WorkerId } from "@aegis/types";
import { z } from "zod";

import { workerIdSchema } from "./runs.js";
import { workerCapabilitiesSchema } from "./worker.js";

// ─────────────────────────────────────────────────────────────────────────────
// Branded Identifiers & Observable State Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const heartbeatIdSchema = z.string().min(1) as unknown as z.ZodType<HeartbeatId>;

/**
 * Observable presence liveness state evaluated by WorkerRegistry and LivenessMonitor.
 * - HEALTHY: Heartbeat observed within workerHeartbeatTimeoutMs.
 * - STALE: No heartbeat observed within workerHeartbeatTimeoutMs (STALE != DEAD).
 * - OFFLINE: Worker explicitly deregistered or confirmed stopped.
 */
export const workerPresenceStateSchema = z.enum(["HEALTHY", "STALE", "OFFLINE"]);
export type WorkerPresenceState = z.infer<typeof workerPresenceStateSchema>;

export const WorkerPresenceStateEnum = {
  HEALTHY: "HEALTHY",
  STALE: "STALE",
  OFFLINE: "OFFLINE",
} as const;

/**
 * Observable worker execution state advertised in heartbeats.
 * Extends the 11A lifecycle states (starting, ready, draining, stopped, failed)
 * with the runtime observation state "busy" when activeTaskCount > 0.
 */
export const workerObservableStateSchema = z.enum([
  "starting",
  "ready",
  "busy",
  "draining",
  "stopped",
  "failed",
]);
export type WorkerObservableState = z.infer<typeof workerObservableStateSchema>;

export const WorkerObservableStateEnum = {
  STARTING: "starting",
  READY: "ready",
  BUSY: "busy",
  DRAINING: "draining",
  STOPPED: "stopped",
  FAILED: "failed",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Worker Heartbeat Payload & CloudEvents Transport Envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical heartbeat payload emitted by worker instances on aegis.workers.heartbeat.
 */
export const workerHeartbeatSchema = z.object({
  heartbeatId: heartbeatIdSchema,
  workerId: workerIdSchema,
  occurredAt: z.string().datetime(),
  lifecycleState: workerObservableStateSchema,
  activeTaskCount: z.number().int().nonnegative(),
  maxConcurrentTasks: z.number().int().positive(),
  capabilities: workerCapabilitiesSchema,
});
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

/**
 * CloudEvents-compliant transport envelope for aegis.workers.heartbeat.
 * Distinct event ID (heartbeatId != workerId), partitioned by workerId key.
 */
export const workerHeartbeatEnvelopeSchema = z.object({
  id: heartbeatIdSchema,
  type: z.literal("worker_heartbeat"),
  source: z.string().min(1),
  specVersion: z.literal("1.0"),
  time: z.string().datetime(),
  aggregateId: workerIdSchema,
  aggregateType: z.literal("Worker"),
  correlationId: z.string().min(1),
  causationId: z.string().optional(),
  data: workerHeartbeatSchema,
});
export type WorkerHeartbeatEnvelope = z.infer<typeof workerHeartbeatEnvelopeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Worker Presence Descriptor (Registry Entity)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory presence descriptor tracked within WorkerRegistry.
 */
export const workerDescriptorSchema = z.object({
  workerId: workerIdSchema,
  lifecycleState: workerObservableStateSchema,
  presenceState: workerPresenceStateSchema,
  capabilities: workerCapabilitiesSchema,
  activeTaskCount: z.number().int().nonnegative(),
  maxConcurrentTasks: z.number().int().positive(),
  registeredAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime(),
});
export type WorkerDescriptor = z.infer<typeof workerDescriptorSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat Error Model
// ─────────────────────────────────────────────────────────────────────────────

export const workerHeartbeatErrorCodeSchema = z.enum([
  "HEARTBEAT_PUBLICATION_FAILED",
  "HEARTBEAT_SERIALIZATION_FAILED",
  "HEARTBEAT_TIMER_ERROR",
  "INVALID_HEARTBEAT_ENVELOPE",
  "WORKER_NOT_FOUND",
]);
export type WorkerHeartbeatErrorCode = z.infer<typeof workerHeartbeatErrorCodeSchema>;

export interface WorkerHeartbeatError {
  readonly code: WorkerHeartbeatErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export function createWorkerHeartbeatError(
  code: WorkerHeartbeatErrorCode,
  message: string,
  cause?: unknown,
): WorkerHeartbeatError {
  return { code, message, cause };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces for Publisher & Presence Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transport-independent contract for emitting worker heartbeats.
 */
export interface IWorkerHeartbeatPublisher {
  publish(
    heartbeat: WorkerHeartbeat,
    metadata?: { readonly correlationId?: string | undefined; readonly causationId?: string | undefined },
  ): Promise<Result<WorkerHeartbeatEnvelope, WorkerHeartbeatError>>;
}

/**
 * Presence registry contract for tracking alive workers, presence states, and load.
 * NOTE: Registry is purely in-memory in Phase 11D; scheduling logic deferred to 11E.
 */
export interface IWorkerRegistry {
  register(worker: WorkerDescriptor): void;
  updateHeartbeat(heartbeat: WorkerHeartbeat): void;
  get(workerId: WorkerId): WorkerDescriptor | undefined;
  list(): WorkerDescriptor[];
  markStale(now: Date): WorkerId[];
  deregister(workerId: WorkerId): void;
}
