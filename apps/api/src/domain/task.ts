/**
 * Task entity representing an execution unit within an Aegis execution run.
 * Encapsulates lifecycle transitions, terminal immutability, and state snapshotting.
 */

import { ok, type Result, type TaskId, type WorkerId } from "@aegis/types";
import {
  assertValidTaskTransition,
  isTerminalTaskStatus,
  type TaskStatus,
} from "./lifecycle.js";
import type { DomainError } from "./errors.js";

export interface TaskSnapshot {
  readonly id: TaskId;
  readonly name: string;
  readonly status: TaskStatus;
  readonly description?: string;
  readonly worker?: WorkerId;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly attemptCount: number;
  readonly output?: string;
  readonly error?: string;
  readonly dependencies?: readonly TaskId[];
}

export interface CreateTaskProps {
  readonly id: TaskId;
  readonly name: string;
  readonly description?: string;
  readonly dependencies?: readonly TaskId[];
}

export class TaskEntity {
  private _status: TaskStatus;
  private _worker?: WorkerId;
  private _startedAt?: string;
  private _completedAt?: string;
  private _attemptCount: number;
  private _output?: string;
  private _error?: string;

  constructor(
    readonly id: TaskId,
    readonly name: string,
    readonly description: string = "",
    readonly dependencies: readonly TaskId[] = [],
    status: TaskStatus = "pending",
    attemptCount: number = 0,
    worker?: WorkerId,
    startedAt?: string,
    completedAt?: string,
    output?: string,
    error?: string,
  ) {
    this._status = status;
    this._attemptCount = attemptCount;
    this._worker = worker;
    this._startedAt = startedAt;
    this._completedAt = completedAt;
    this._output = output;
    this._error = error;
  }

  static create(props: CreateTaskProps): TaskEntity {
    return new TaskEntity(
      props.id,
      props.name,
      props.description ?? "",
      props.dependencies ?? [],
      "pending",
      0,
    );
  }

  static reconstitute(snapshot: TaskSnapshot): TaskEntity {
    return new TaskEntity(
      snapshot.id,
      snapshot.name,
      snapshot.description ?? "",
      snapshot.dependencies ?? [],
      snapshot.status,
      snapshot.attemptCount ?? 0,
      snapshot.worker,
      snapshot.startedAt,
      snapshot.completedAt,
      snapshot.output,
      snapshot.error,
    );
  }

  get status(): TaskStatus {
    return this._status;
  }

  get worker(): WorkerId | undefined {
    return this._worker;
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
    return ok(undefined);
  }

  toSnapshot(): TaskSnapshot {
    return {
      id: this.id,
      name: this.name,
      status: this._status,
      description: this.description,
      worker: this._worker,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      attemptCount: this._attemptCount,
      output: this._output,
      error: this._error,
      dependencies: [...this.dependencies],
    };
  }
}
