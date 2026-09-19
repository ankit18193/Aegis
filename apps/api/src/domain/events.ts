/**
 * Domain events emitted by the Aegis domain layer.
 * Pure in-memory event definitions representing facts that occurred within the ExecutionRun aggregate.
 */

import type { RunId, TaskId, WorkerId } from "@aegis/types";

export type DomainEventType =
  | "run_created"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "run_cancelled"
  | "task_scheduled"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_cancelled";

export interface BaseDomainEvent {
  readonly id: string;
  readonly runId: RunId;
  readonly type: DomainEventType;
  readonly timestamp: string;
}

export interface RunCreatedDomainEvent extends BaseDomainEvent {
  readonly type: "run_created";
  readonly goal: string;
  readonly taskCount: number;
}

export interface RunStartedDomainEvent extends BaseDomainEvent {
  readonly type: "run_started";
}

export interface RunCompletedDomainEvent extends BaseDomainEvent {
  readonly type: "run_completed";
  readonly summary?: string | undefined;
}

export interface RunFailedDomainEvent extends BaseDomainEvent {
  readonly type: "run_failed";
  readonly error: string;
}

export interface RunCancelledDomainEvent extends BaseDomainEvent {
  readonly type: "run_cancelled";
  readonly reason?: string | undefined;
}

export interface TaskScheduledDomainEvent extends BaseDomainEvent {
  readonly type: "task_scheduled";
  readonly taskId: TaskId;
  readonly taskName: string;
}

export interface TaskStartedDomainEvent extends BaseDomainEvent {
  readonly type: "task_started";
  readonly taskId: TaskId;
  readonly taskName: string;
  readonly worker?: WorkerId | undefined;
}

export interface TaskCompletedDomainEvent extends BaseDomainEvent {
  readonly type: "task_completed";
  readonly taskId: TaskId;
  readonly taskName: string;
  readonly output?: string | undefined;
}

export interface TaskFailedDomainEvent extends BaseDomainEvent {
  readonly type: "task_failed";
  readonly taskId: TaskId;
  readonly taskName: string;
  readonly error: string;
}

export interface TaskCancelledDomainEvent extends BaseDomainEvent {
  readonly type: "task_cancelled";
  readonly taskId: TaskId;
  readonly taskName: string;
  readonly reason?: string | undefined;
}

export type DomainEvent =
  | RunCreatedDomainEvent
  | RunStartedDomainEvent
  | RunCompletedDomainEvent
  | RunFailedDomainEvent
  | RunCancelledDomainEvent
  | TaskScheduledDomainEvent
  | TaskStartedDomainEvent
  | TaskCompletedDomainEvent
  | TaskFailedDomainEvent
  | TaskCancelledDomainEvent;
