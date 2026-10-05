import type {
  EventSeverity,
  EventType,
  LeaseError,
  Run,
  RunEvent,
  RunStatus,
  RunSummary,
  Task,
  TaskLease,
  TaskStateUpdate,
} from "@aegis/contracts";
import type { LeaseId, Result, RunId, TaskId, WorkerId } from "@aegis/types";

import type { ConcurrencyConflictError, DomainError } from "../domain/errors.js";

export interface RunFilterOptions {
  status?: RunStatus | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  query?: string | undefined;
}

export interface EventFilterOptions {
  severity?: EventSeverity | undefined;
  type?: EventType | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface FindAllRunsResult {
  items: RunSummary[];
  totalCount: number;
  hasMore?: boolean;
}

export interface IRunRepository {
  findById(id: RunId): Promise<Run | null>;
  findAll(options?: RunFilterOptions): Promise<FindAllRunsResult>;
  /**
   * Persists a run and its tasks.
   * If events are provided, persists the run, tasks, and events within a single atomic boundary.
   */
  save(run: Run, events?: readonly RunEvent[]): Promise<void>;
  findEvents(runId: RunId, options?: EventFilterOptions): Promise<RunEvent[]>;
  saveEvent(event: RunEvent): Promise<void>;
  resetToDefaults(): Promise<void>;

  /**
   * Atomically updates a task's durable execution state with optimistic concurrency control.
   * If event is provided, atomically inserts the domain event and outbox record within the same transaction.
   * Returns a typed error if the task is not found, in a terminal state, or has a version conflict.
   */
  updateTaskState(
    taskId: TaskId,
    update: TaskStateUpdate,
    expectedVersion: number,
    event?: RunEvent,
  ): Promise<Result<{ readonly newVersion: number }, ConcurrencyConflictError | DomainError>>;

  /**
   * Acquires a lease for a running task guarded by expectedVersion.
   */
  acquireTaskLease(
    taskId: TaskId,
    workerId: WorkerId,
    leaseDurationMs: number,
    expectedVersion: number,
  ): Promise<Result<TaskLease, LeaseError>>;

  /**
   * Renews an active lease for a running task guarded by expectedVersion and leaseId.
   */
  renewTaskLease(
    taskId: TaskId,
    leaseId: LeaseId,
    workerId: WorkerId,
    leaseDurationMs: number,
    expectedVersion: number,
  ): Promise<Result<TaskLease, LeaseError>>;

  /**
   * Explicitly releases an active lease guarded by expectedVersion and leaseId.
   */
  releaseTaskLease(
    taskId: TaskId,
    leaseId: LeaseId,
    workerId: WorkerId,
    expectedVersion: number,
  ): Promise<Result<void, LeaseError>>;

  /**
   * Queries tasks with expired leases without mutating them (pure read-only).
   */
  getExpiredTaskLeases(cutoff: Date, limit?: number): Promise<Task[]>;

  /**
   * Atomically marks a task's lease as expired guarded by expectedVersion and lease_until < expiredAt.
   * If event is provided, atomically inserts the domain event and outbox record within the same transaction.
   * Returns true if successfully marked expired, or false if already mutated or version conflict.
   * INVARIANT: Task remains in 'running' status; worker identity is preserved.
   */
  markTaskLeaseExpired(
    taskId: TaskId,
    expectedVersion: number,
    expiredAt: Date,
    event?: RunEvent,
  ): Promise<boolean>;
}

