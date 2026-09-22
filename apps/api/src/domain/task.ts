/**
 * Task entity representing an execution unit within an Aegis execution run.
 * Encapsulates lifecycle transitions, terminal immutability, and state snapshotting.
 */

import type { Result, TaskId, WorkerId } from "@aegis/types";
import { ok } from "@aegis/types";

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
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly attemptCount: number;
  readonly input?: Record<string, unknown> | string | undefined;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly dependencies?: readonly TaskId[] | undefined;
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
  private _startedAt?: string | undefined;
  private _completedAt?: string | undefined;
  private _attemptCount: number;
  private _input?: Record<string, unknown> | string | undefined;
  private _output?: string | undefined;
  private _error?: string | undefined;

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
  ) {
    this._status = status;
    this._attemptCount = attemptCount;
    this._worker = worker;
    this._startedAt = startedAt;
    this._completedAt = completedAt;
    this._output = output;
    this._error = error;
    this._input = input;
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
      snapshot.worker,
      snapshot.startedAt,
      snapshot.completedAt,
      snapshot.output,
      snapshot.error,
      snapshot.input,
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
      input: this._input,
      output: this._output,
      error: this._error,
      dependencies: [...this.dependencies],
    };
  }
}
