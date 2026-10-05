/**
 * Task entity representing an execution unit within an Aegis execution run.
 * Encapsulates lifecycle transitions, terminal immutability, and state snapshotting.
 */

import type { TaskLease } from "@aegis/contracts";
import {
  LeaseError,
  LeaseExpiredError,
  LeaseOwnershipConflictError,
  StaleLeaseError,
} from "@aegis/contracts";
import type { LeaseId, Result, TaskId, WorkerId } from "@aegis/types";
import { err, leaseId, ok } from "@aegis/types";

import type { DomainError } from "./errors.js";
import {
  assertValidTaskTransition,
  isTerminalTaskStatus,
} from "./lifecycle.js";
import type { TaskStatus } from "./lifecycle.js";

export interface TaskSnapshot {
  readonly id: TaskId;
  readonly name: string;
  readonly status: TaskStatus;
  readonly description?: string | undefined;
  readonly worker?: WorkerId | undefined;
  readonly workerId?: WorkerId | undefined;
  readonly version?: number | undefined;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly attemptCount: number;
  readonly input?: Record<string, unknown> | string | undefined;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly dependencies?: readonly TaskId[] | undefined;
  readonly leaseId?: LeaseId | undefined;
  readonly leaseUntil?: string | undefined;
  readonly leaseExpiredAt?: string | undefined;
}

export interface CreateTaskProps {
  readonly id: TaskId;
  readonly name: string;
  readonly description?: string | undefined;
  readonly dependencies?: readonly TaskId[] | undefined;
  readonly input?: Record<string, unknown> | string | undefined;
}

export class TaskEntity {
  private _status: TaskStatus;
  private _worker?: WorkerId | undefined;
  private _version: number;
  private _startedAt?: string | undefined;
  private _completedAt?: string | undefined;
  private _attemptCount: number;
  private _input?: Record<string, unknown> | string | undefined;
  private _output?: string | undefined;
  private _error?: string | undefined;
  private _leaseId?: LeaseId | undefined;
  private _leaseUntil?: string | undefined;
  private _leaseExpiredAt?: string | undefined;

  constructor(
    readonly id: TaskId,
    readonly name: string,
    readonly description = "",
    readonly dependencies: readonly TaskId[] = [],
    status: TaskStatus = "pending",
    attemptCount = 0,
    worker?: WorkerId,
    startedAt?: string,
    completedAt?: string,
    output?: string,
    error?: string,
    input?: Record<string, unknown> | string,
    version = 1,
    leaseId?: LeaseId,
    leaseUntil?: string,
    leaseExpiredAt?: string,
  ) {
    this._status = status;
    this._attemptCount = attemptCount;
    this._worker = worker;
    this._version = version;
    this._startedAt = startedAt;
    this._completedAt = completedAt;
    this._output = output;
    this._error = error;
    this._input = input;
    this._leaseId = leaseId;
    this._leaseUntil = leaseUntil;
    this._leaseExpiredAt = leaseExpiredAt;
  }

  static create(props: CreateTaskProps): TaskEntity {
    return new TaskEntity(
      props.id,
      props.name,
      props.description ?? "",
      props.dependencies ?? [],
      "pending",
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      props.input,
      1,
    );
  }

  static reconstitute(snapshot: TaskSnapshot): TaskEntity {
    return new TaskEntity(
      snapshot.id,
      snapshot.name,
      snapshot.description ?? "",
      snapshot.dependencies ?? [],
      snapshot.status,
      snapshot.attemptCount,
      snapshot.workerId ?? snapshot.worker,
      snapshot.startedAt,
      snapshot.completedAt,
      snapshot.output,
      snapshot.error,
      snapshot.input,
      snapshot.version ?? 1,
      snapshot.leaseId,
      snapshot.leaseUntil,
      snapshot.leaseExpiredAt,
    );
  }

  get status(): TaskStatus {
    return this._status;
  }

  get worker(): WorkerId | undefined {
    return this._worker;
  }

  get workerId(): WorkerId | undefined {
    return this._worker;
  }

  get version(): number {
    return this._version;
  }

  get startedAt(): string | undefined {
    return this._startedAt;
  }

  get completedAt(): string | undefined {
    return this._completedAt;
  }

  get attemptCount(): number {
    return this._attemptCount;
  }

  get leaseId(): LeaseId | undefined {
    return this._leaseId;
  }

  get leaseUntil(): string | undefined {
    return this._leaseUntil;
  }

  get leaseExpiredAt(): string | undefined {
    return this._leaseExpiredAt;
  }

  get input(): Record<string, unknown> | string | undefined {
    return this._input;
  }

  get output(): string | undefined {
    return this._output;
  }

  get error(): string | undefined {
    return this._error;
  }

  isTerminal(): boolean {
    return isTerminalTaskStatus(this._status);
  }

  /**
   * Transitions task from pending to queued (eligible for worker execution).
   */
  markQueued(): Result<void, DomainError> {
    const check = assertValidTaskTransition(this._status, "queued");
    if (!check.ok) {
      return check;
    }
    this._status = "queued";
    this._version += 1;
    return ok(undefined);
  }

  /**
   * Transitions task from queued to running.
   */
  start(
    worker?: WorkerId,
    startedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const check = assertValidTaskTransition(this._status, "running");
    if (!check.ok) {
      return check;
    }
    this._status = "running";
    this._worker = worker;
    this._startedAt = startedAt;
    this._attemptCount += 1;
    this._version += 1;
    return ok(undefined);
  }

  /**
   * Transitions task from running to completed.
   */
  complete(
    output?: string,
    completedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const check = assertValidTaskTransition(this._status, "completed");
    if (!check.ok) {
      return check;
    }
    this._status = "completed";
    this._completedAt = completedAt;
    this._output = output;
    this._version += 1;
    return ok(undefined);
  }

  /**
   * Transitions task from queued or running to failed.
   */
  fail(
    errorMessage: string,
    completedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const check = assertValidTaskTransition(this._status, "failed");
    if (!check.ok) {
      return check;
    }
    this._status = "failed";
    this._completedAt = completedAt;
    this._error = errorMessage;
    this._version += 1;
    return ok(undefined);
  }

  /**
   * Transitions non-terminal task (pending, queued, or running) to cancelled.
   */
  cancel(
    reason?: string,
    completedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const check = assertValidTaskTransition(this._status, "cancelled");
    if (!check.ok) {
      return check;
    }
    this._status = "cancelled";
    this._completedAt = completedAt;
    if (reason) {
      this._error = reason;
    }
    this._version += 1;
    return ok(undefined);
  }

  /**
   * Acquires an execution lease for this task.
   */
  acquireLease(
    workerId: WorkerId,
    leaseDurationMs: number,
    now: Date = new Date(),
  ): Result<TaskLease, LeaseError> {
    if (this._status !== "running") {
      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Cannot acquire lease for task '${this.id}' in status '${this._status}'. Task must be running.`,
          this.id,
          workerId,
        ),
      );
    }

    const nowIso = now.toISOString();
    if (
      this._leaseId &&
      this._worker &&
      this._worker !== workerId &&
      this._leaseUntil &&
      this._leaseUntil > nowIso &&
      !this._leaseExpiredAt
    ) {
      return err(new LeaseOwnershipConflictError(this.id, this._worker, workerId));
    }

    const newLeaseId = leaseId(`lease-${crypto.randomUUID()}`);
    const leaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();

    this._leaseId = newLeaseId;
    this._worker = workerId;
    this._leaseUntil = leaseUntil;
    this._leaseExpiredAt = undefined;
    this._version += 1;

    return ok({
      leaseId: newLeaseId,
      taskId: this.id,
      workerId,
      acquiredAt: nowIso,
      leaseUntil,
      version: this._version,
    });
  }

  /**
   * Renews an existing execution lease.
   */
  renewLease(
    workerId: WorkerId,
    expectedLeaseId: LeaseId,
    leaseDurationMs: number,
    now: Date = new Date(),
  ): Result<TaskLease, LeaseError> {
    if (this._status !== "running") {
      return err(
        new LeaseError(
          "CONCURRENCY_CONFLICT",
          `Cannot renew lease for task '${this.id}' in status '${this._status}'. Task must be running.`,
          this.id,
          workerId,
          expectedLeaseId,
        ),
      );
    }

    if (!this._leaseId || this._leaseId !== expectedLeaseId) {
      return err(new StaleLeaseError(this.id, expectedLeaseId, this._leaseId));
    }

    if (this._worker && this._worker !== workerId) {
      return err(
        new LeaseOwnershipConflictError(
          this.id,
          this._worker,
          workerId,
        ),
      );
    }

    const nowIso = now.toISOString();
    if (this._leaseExpiredAt || (this._leaseUntil && this._leaseUntil < nowIso)) {
      return err(new LeaseExpiredError(this.id, expectedLeaseId, workerId));
    }

    const newLeaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();
    this._leaseUntil = newLeaseUntil;
    this._version += 1;

    return ok({
      leaseId: expectedLeaseId,
      taskId: this.id,
      workerId,
      acquiredAt: this._startedAt ?? nowIso,
      leaseUntil: newLeaseUntil,
      version: this._version,
    });
  }

  /**
   * Explicitly releases an active lease upon completion or graceful shutdown.
   */
  releaseLease(workerId: WorkerId, expectedLeaseId: LeaseId): Result<void, LeaseError> {
    if (this._leaseId && this._leaseId !== expectedLeaseId) {
      return err(new StaleLeaseError(this.id, expectedLeaseId, this._leaseId));
    }

    if (this._worker && this._worker !== workerId) {
      return err(
        new LeaseOwnershipConflictError(
          this.id,
          this._worker,
          workerId,
        ),
      );
    }

    this._leaseId = undefined;
    this._leaseUntil = undefined;
    this._version += 1;
    return ok(undefined);
  }

  /**
   * Marks this task's lease as expired.
   * INVARIANT: Task remains in 'running' status! Worker identity is preserved.
   */
  expireLease(expiredAt: Date = new Date()): Result<void, DomainError> {
    if (this._leaseExpiredAt) {
      return ok(undefined);
    }

    this._leaseExpiredAt = expiredAt.toISOString();
    this._version += 1;
    return ok(undefined);
  }

  toSnapshot(): TaskSnapshot {
    return {
      id: this.id,
      name: this.name,
      status: this._status,
      description: this.description,
      worker: this._worker,
      workerId: this._worker,
      version: this._version,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      attemptCount: this._attemptCount,
      input: this._input,
      output: this._output,
      error: this._error,
      dependencies: [...this.dependencies],
      leaseId: this._leaseId,
      leaseUntil: this._leaseUntil,
      leaseExpiredAt: this._leaseExpiredAt,
    };
  }
}

