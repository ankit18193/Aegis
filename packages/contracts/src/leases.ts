import type { LeaseId, Result, TaskId, WorkerId } from "@aegis/types";
import { leaseId } from "@aegis/types";
import { z } from "zod";

import { taskIdSchema, workerIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lease Schemas & Nominal Branded Types
// ─────────────────────────────────────────────────────────────────────────────

export const leaseIdSchema = z.string().min(1).transform((v) => leaseId(v));

export const taskLeaseSchema = z.object({
  leaseId: leaseIdSchema,
  taskId: taskIdSchema,
  workerId: workerIdSchema,
  acquiredAt: z.string(),
  leaseUntil: z.string(),
  leaseExpiredAt: z.string().optional(),
  version: z.number().int().min(1),
});
export type TaskLease = z.infer<typeof taskLeaseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Lease Request Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const taskLeaseAcquireRequestSchema = z.object({
  taskId: taskIdSchema,
  workerId: workerIdSchema,
  leaseDurationMs: z.number().int().positive().default(30000),
  expectedVersion: z.number().int().positive(),
});
export type TaskLeaseAcquireRequest = z.infer<typeof taskLeaseAcquireRequestSchema>;

export const taskLeaseRenewRequestSchema = z.object({
  taskId: taskIdSchema,
  leaseId: leaseIdSchema,
  workerId: workerIdSchema,
  leaseDurationMs: z.number().int().positive().default(30000),
  expectedVersion: z.number().int().positive(),
});
export type TaskLeaseRenewRequest = z.infer<typeof taskLeaseRenewRequestSchema>;

export const taskLeaseReleaseRequestSchema = z.object({
  taskId: taskIdSchema,
  leaseId: leaseIdSchema,
  workerId: workerIdSchema,
  expectedVersion: z.number().int().positive(),
});
export type TaskLeaseReleaseRequest = z.infer<typeof taskLeaseReleaseRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Lease Timing Configuration
// ─────────────────────────────────────────────────────────────────────────────

export const taskLeaseConfigSchema = z.object({
  /** Total valid duration of an acquired or renewed lease (default 30,000ms). */
  leaseDurationMs: z.number().int().positive().default(30000),
  /** Cadence at which the active worker attempts renewal (default 10,000ms). */
  renewalIntervalMs: z.number().int().positive().default(10000),
  /** Grace period allowed before marking a lease strictly orphaned (default 5,000ms). */
  gracePeriodMs: z.number().int().min(0).default(5000),
  /** Cadence at which control plane monitors for expired leases (default 5,000ms). */
  sweepIntervalMs: z.number().int().positive().default(5000),
});
export type TaskLeaseConfig = z.infer<typeof taskLeaseConfigSchema>;

export const DEFAULT_TASK_LEASE_CONFIG: TaskLeaseConfig = Object.freeze({
  leaseDurationMs: 30000,
  renewalIntervalMs: 10000,
  gracePeriodMs: 5000,
  sweepIntervalMs: 5000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Typed Lease Errors
// ─────────────────────────────────────────────────────────────────────────────

export type LeaseErrorCode =
  | "LEASE_EXPIRED"
  | "LEASE_OWNERSHIP_CONFLICT"
  | "STALE_LEASE"
  | "TASK_NOT_FOUND"
  | "CONCURRENCY_CONFLICT";

export class LeaseError extends Error {
  constructor(
    readonly code: LeaseErrorCode,
    message: string,
    readonly taskId: TaskId,
    readonly workerId?: WorkerId,
    readonly leaseId?: LeaseId,
  ) {
    super(message);
    this.name = "LeaseError";
  }
}

export class LeaseExpiredError extends LeaseError {
  constructor(taskId: TaskId, leaseId?: LeaseId, workerId?: WorkerId) {
    super(
      "LEASE_EXPIRED",
      `Task lease for task '${taskId}' has expired. Renewal or release rejected.`,
      taskId,
      workerId,
      leaseId,
    );
    this.name = "LeaseExpiredError";
  }
}

export class LeaseOwnershipConflictError extends LeaseError {
  constructor(taskId: TaskId, currentWorkerId: WorkerId, attemptingWorkerId: WorkerId) {
    super(
      "LEASE_OWNERSHIP_CONFLICT",
      `Task '${taskId}' is currently leased by worker '${currentWorkerId}'. Worker '${attemptingWorkerId}' cannot acquire lease.`,
      taskId,
      attemptingWorkerId,
    );
    this.name = "LeaseOwnershipConflictError";
  }
}

export class StaleLeaseError extends LeaseError {
  constructor(taskId: TaskId, expectedLeaseId: LeaseId, actualLeaseId?: LeaseId) {
    super(
      "STALE_LEASE",
      `Stale lease ID for task '${taskId}': expected '${expectedLeaseId}', actual active lease is '${actualLeaseId ?? "none"}'.`,
      taskId,
      undefined,
      expectedLeaseId,
    );
    this.name = "StaleLeaseError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lease Client Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface for worker-side lease acquisition, renewal, and release.
 * Abstracts direct PostgreSQL, HTTP/RPC, or in-memory control-plane backends.
 */
export interface ITaskLeaseClient {
  /**
   * Acquires a new execution lease for a running task.
   */
  acquire(request: TaskLeaseAcquireRequest): Promise<Result<TaskLease, LeaseError>>;

  /**
   * Renews an active execution lease before it expires.
   */
  renew(request: TaskLeaseRenewRequest): Promise<Result<TaskLease, LeaseError>>;

  /**
   * Explicitly releases an active execution lease upon task completion or graceful shutdown.
   */
  release(request: TaskLeaseReleaseRequest): Promise<Result<void, LeaseError>>;
}
