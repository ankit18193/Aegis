/**
 * Recovery Contracts & Schemas — Phase 12D: Orphan Task Recovery & Automatic Reassignment
 * Defines contracts, schemas, typed errors, and coordinator interfaces for
 * detecting orphaned tasks, enforcing retry policies, deterministic reassignment,
 * and OCC-guarded recovery transitions.
 *
 * Invariant Locks:
 * - Lock 1: PostgreSQL authoritative recovery state.
 * - Lock 2: Strict orphan predicate (status = 'running' AND lease_expired_at IS NOT NULL).
 * - Lock 3: OCC-safe concurrency via version gating.
 * - Lock 4: Distinct ownership identity (fresh leaseId and incremented version).
 * - Lock 5: Monotonic attempt count tracking.
 * - Lock 6: Bounded retries (terminal failure when attemptCount >= maxAttempts).
 * - Lock 7: Failed worker exclusion on reassignment.
 * - Lock 8: Transactional persistence via single atomic DB + Outbox transaction.
 * - Lock 9: Late old-worker result invalidation.
 * - Lock 10: Idempotent recovery operations.
 */

import type { Result, TaskId, WorkerId } from "@aegis/types";
import { z } from "zod";

import { runIdSchema, taskIdSchema, taskInputSchema, workerIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Orphan Task Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Represents a genuinely orphaned task discovered in the authoritative store.
 * Satisfies Lock 2: status = 'running' AND leaseExpiredAt IS NOT NULL.
 */
export const orphanTaskSchema = z.object({
  id: taskIdSchema,
  runId: runIdSchema,
  name: z.string().min(1),
  status: z.literal("running"),
  workerId: workerIdSchema,
  leaseId: z.string().min(1).optional(),
  leaseUntil: z.string().optional(),
  leaseExpiredAt: z.string().min(1),
  attemptCount: z.number().int().min(0),
  version: z.number().int().positive(),
  input: taskInputSchema.optional(),
  dependencies: z.array(taskIdSchema).optional(),
});
export type OrphanTask = z.infer<typeof orphanTaskSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Recovery Policy Schema & Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const recoveryPolicySchema = z.object({
  /** Maximum execution attempts before task is marked failed (default 3). */
  maxAttempts: z.number().int().positive().default(3),
  /** Cadence in ms at which control plane sweeps for orphaned tasks (default 5,000ms). */
  recoveryScanIntervalMs: z.number().int().positive().default(5000),
  /** Duration in ms granted to the newly assigned worker's initial lease (default 30,000ms). */
  leaseDurationMs: z.number().int().positive().default(30000),
  /** Base backoff delay in ms if rescheduling requires delay (default 1,000ms). */
  backoffBaseMs: z.number().int().positive().default(1000),
  /** Maximum backoff delay in ms (default 30,000ms). */
  backoffMaxMs: z.number().int().positive().default(30000),
});
export type RecoveryPolicy = z.infer<typeof recoveryPolicySchema>;

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = Object.freeze({
  maxAttempts: 3,
  recoveryScanIntervalMs: 5000,
  leaseDurationMs: 30000,
  backoffBaseMs: 1000,
  backoffMaxMs: 30000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Recovery Decision Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const recoveryReassignDecisionSchema = z.object({
  action: z.literal("reassign"),
  taskId: taskIdSchema,
  runId: runIdSchema,
  currentWorkerId: workerIdSchema,
  newWorkerId: workerIdSchema,
  newLeaseId: z.string().min(1),
  attemptCount: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().min(1),
});
export type RecoveryReassignDecision = z.infer<typeof recoveryReassignDecisionSchema>;

export const recoveryFailDecisionSchema = z.object({
  action: z.literal("fail"),
  taskId: taskIdSchema,
  runId: runIdSchema,
  currentWorkerId: workerIdSchema,
  attemptCount: z.number().int().positive(),
  expectedVersion: z.number().int().positive(),
  reason: z.string().min(1),
});
export type RecoveryFailDecision = z.infer<typeof recoveryFailDecisionSchema>;

export const recoverySkipDecisionSchema = z.object({
  action: z.literal("skip"),
  taskId: taskIdSchema,
  runId: runIdSchema,
  reason: z.string().min(1),
});
export type RecoverySkipDecision = z.infer<typeof recoverySkipDecisionSchema>;

export const recoveryDecisionSchema = z.discriminatedUnion("action", [
  recoveryReassignDecisionSchema,
  recoveryFailDecisionSchema,
  recoverySkipDecisionSchema,
]);
export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Recovery Result Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const recoveryActionSchema = z.enum(["reassigned", "failed", "skipped"]);
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const recoveryResultSchema = z.object({
  success: z.boolean(),
  taskId: taskIdSchema,
  runId: runIdSchema,
  action: recoveryActionSchema,
  previousWorkerId: workerIdSchema.optional(),
  assignedWorkerId: workerIdSchema.optional(),
  newLeaseId: z.string().optional(),
  attemptCount: z.number().int().min(0),
  version: z.number().int().positive().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});
export type RecoveryResult = z.infer<typeof recoveryResultSchema>;

export const recoverySweepResultSchema = z.object({
  scannedCount: z.number().int().min(0),
  reassignedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  results: z.array(recoveryResultSchema),
  durationMs: z.number().min(0),
});
export type RecoverySweepResult = z.infer<typeof recoverySweepResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Typed Recovery Errors
// ─────────────────────────────────────────────────────────────────────────────

export type RecoveryErrorCode =
  | "TASK_NOT_RECOVERABLE"
  | "RECOVERY_CONFLICT"
  | "RETRY_LIMIT_EXCEEDED"
  | "NO_ELIGIBLE_WORKER"
  | "RECOVERY_FAILED";

export class RecoveryError extends Error {
  constructor(
    readonly code: RecoveryErrorCode,
    message: string,
    readonly taskId: TaskId,
    override readonly cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "RecoveryError";
  }
}

/**
 * Thrown when a task is evaluated for recovery but does not meet the strict orphan predicate
 * (e.g. status is not 'running', or lease_expired_at is null). Satisfies Lock 2.
 */
export class TaskNotRecoverableError extends RecoveryError {
  constructor(taskId: TaskId, reason: string) {
    super(
      "TASK_NOT_RECOVERABLE",
      `Task '${taskId}' is not recoverable: ${reason}`,
      taskId,
    );
    this.name = "TaskNotRecoverableError";
  }
}

/**
 * Thrown when OCC version conflict occurs during recovery (e.g. another coordinator or worker
 * mutated the task state). Satisfies Lock 3.
 */
export class RecoveryConflictError extends RecoveryError {
  constructor(taskId: TaskId, expectedVersion: number, actualVersion?: number) {
    super(
      "RECOVERY_CONFLICT",
      `Recovery concurrency conflict on task '${taskId}': expected version ${String(expectedVersion)}, actual version is ${String(actualVersion ?? "unknown")}.`,
      taskId,
    );
    this.name = "RecoveryConflictError";
  }
}

/**
 * Thrown or recorded when a task has reached maxAttempts and cannot be reassigned. Satisfies Lock 6.
 */
export class RetryLimitExceededError extends RecoveryError {
  constructor(taskId: TaskId, attemptCount: number, maxAttempts: number) {
    super(
      "RETRY_LIMIT_EXCEEDED",
      `Execution retry limit exceeded for task '${taskId}': ${String(attemptCount)} attempts made, maximum allowed is ${String(maxAttempts)}.`,
      taskId,
    );
    this.name = "RetryLimitExceededError";
  }
}

/**
 * Thrown or recorded when no healthy, capable worker is available to receive reassignment.
 * The task remains durably recoverable for subsequent sweeps. Satisfies Lock 7.
 */
export class NoEligibleWorkerError extends RecoveryError {
  constructor(taskId: TaskId, excludedWorkerId?: WorkerId) {
    super(
      "NO_ELIGIBLE_WORKER",
      `No eligible worker available to recover task '${taskId}'${excludedWorkerId ? ` (excluding failed worker '${excludedWorkerId}')` : ""}.`,
      taskId,
    );
    this.name = "NoEligibleWorkerError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery Coordinator Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface IRecoveryCoordinator {
  /**
   * Attempts to recover a single identified orphaned task.
   * Evaluates retry limits, selects an alternative healthy worker (excluding failed worker),
   * and atomically commits reassignment or terminal failure through repository + outbox.
   */
  recoverOrphan(taskId: TaskId): Promise<Result<RecoveryResult, RecoveryError>>;

  /**
   * Sweeps the persistent store for orphaned tasks (status = 'running' AND lease_expired_at IS NOT NULL),
   * attempting recovery for each candidate.
   */
  sweepOrphans(limit?: number): Promise<Result<RecoverySweepResult, RecoveryError>>;

  /**
   * Starts the periodic orphan recovery background loop.
   */
  start(): Promise<void>;

  /**
   * Stops the periodic orphan recovery background loop gracefully.
   */
  stop(): Promise<void>;

  /**
   * Whether the recovery coordinator background loop is currently running.
   */
  readonly isRunning: boolean;
}
