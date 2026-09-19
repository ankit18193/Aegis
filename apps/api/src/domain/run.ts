/**
 * ExecutionRun aggregate root.
 * Manages run identity, lifecycle transitions, task collection, progress calculation,
 * explicit cascading cancellation, and domain event collection.
 */

import type { Result, RunId, TaskId, WorkerId, WorkflowId } from "@aegis/types";
import { err, ok } from "@aegis/types";

import type { DomainError } from "./errors.js";
import { InvalidStateTransitionError, TaskNotFoundError } from "./errors.js";
import type { DomainEvent } from "./events.js";
import type { RunStatus } from "./lifecycle.js";
import { assertValidRunTransition, isTerminalRunStatus } from "./lifecycle.js";
import type { TaskSnapshot } from "./task.js";
import { TaskEntity } from "./task.js";
import { TaskDag } from "./taskDag.js";

export type { TaskSnapshot } from "./task.js";


export interface WorkflowSpec {
  readonly id: WorkflowId;
  readonly name: string;
}

export interface RunArtifactSnapshot {
  readonly name: string;
  readonly type: string;
  readonly path: string;
  readonly sizeBytes?: number | undefined;
}

export interface RunMetricsSnapshot {
  readonly durationMs: number;
  readonly tasksTotal: number;
  readonly tasksCompleted: number;
  readonly toolInvocations: number;
}

export interface RunResultSnapshot {
  readonly summary: string;
  readonly reportMarkdown?: string | undefined;
  readonly metrics?: RunMetricsSnapshot | undefined;
  readonly artifacts?: readonly RunArtifactSnapshot[] | undefined;
}

export interface RunSnapshot {
  readonly id: RunId;
  readonly goal: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly progress: number;
  readonly workflow: {
    readonly id: WorkflowId;
    readonly name: string;
    readonly tasks: readonly TaskSnapshot[];
  };
  readonly tasks: readonly TaskSnapshot[];
  readonly result?: RunResultSnapshot | undefined;
}

export interface CreateRunProps {
  readonly id: RunId;
  readonly goal: string;
  readonly workflow: WorkflowSpec;
  readonly tasks: readonly TaskEntity[];
  readonly createdAt?: string | undefined;
}

export class ExecutionRun {
  private _status: RunStatus;
  private _updatedAt: string;
  private _tasks: Map<string, TaskEntity>;
  private _events: DomainEvent[] = [];
  private _result?: RunResultSnapshot | undefined;

  private constructor(
    readonly id: RunId,
    readonly goal: string,
    readonly workflow: WorkflowSpec,
    tasks: readonly TaskEntity[],
    status: RunStatus = "pending",
    readonly createdAt: string = new Date().toISOString(),
    updatedAt: string = createdAt,
    result?: RunResultSnapshot | undefined,
  ) {
    this._status = status;
    this._updatedAt = updatedAt;
    this._tasks = new Map(tasks.map((t) => [t.id, t]));
    this._result = result;
  }

  /**
   * Factory method to instantiate a new ExecutionRun aggregate.
   * Validates DAG integrity and records the run_created domain event.
   */
  static create(props: CreateRunProps): Result<ExecutionRun, DomainError> {
    if (!props.id || (props.id as string).trim() === "") {
      return err(
        new InvalidStateTransitionError("run", "none", "pending", "Run ID cannot be empty"),
      );
    }

    // Validate DAG invariants
    const dagResult = TaskDag.build(props.tasks);
    if (!dagResult.ok) {
      return dagResult;
    }

    const createdAt = props.createdAt ?? new Date().toISOString();
    const run = new ExecutionRun(
      props.id,
      props.goal,
      props.workflow,
      props.tasks,
      "pending",
      createdAt,
      createdAt,
    );

    run.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: run.id,
      type: "run_created",
      timestamp: createdAt,
      goal: run.goal,
      taskCount: props.tasks.length,
    });

    return ok(run);
  }

  /**
   * Reconstitutes an ExecutionRun aggregate from a persistent snapshot.
   */
  static reconstitute(snapshot: RunSnapshot): ExecutionRun {
    const tasks = snapshot.tasks.map((t) => TaskEntity.reconstitute(t));
    return new ExecutionRun(
      snapshot.id,
      snapshot.goal,
      { id: snapshot.workflow.id, name: snapshot.workflow.name },
      tasks,
      snapshot.status,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.result,
    );
  }

  get status(): RunStatus {
    return this._status;
  }

  get updatedAt(): string {
    return this._updatedAt;
  }

  get tasks(): readonly TaskEntity[] {
    return Array.from(this._tasks.values());
  }

  get result(): RunResultSnapshot | undefined {
    return this._result;
  }

  getTask(id: TaskId | string): TaskEntity | undefined {
    return this._tasks.get(id);
  }

  isTerminal(): boolean {
    return isTerminalRunStatus(this._status);
  }

  /**
   * Calculates current progress percentage [0 - 100].
   * INV-RUN-05: Completed runs always report 100%.
   */
  calculateProgress(): number {
    if (this._status === "completed") {
      return 100;
    }

    const taskList = Array.from(this._tasks.values());
    if (taskList.length === 0) {
      return 0;
    }

    const completed = taskList.filter((t) => t.status === "completed").length;
    return Math.floor((completed / taskList.length) * 100);
  }

  /**
   * Pulls and clears all uncommitted domain events.
   */
  pullEvents(): readonly DomainEvent[] {
    const events = [...this._events];
    this._events = [];
    return events;
  }

  private recordEvent(event: DomainEvent): void {
    this._events.push(event);
  }

  /**
   * Transitions run from pending to running.
   */
  start(startedAt: string = new Date().toISOString()): Result<void, DomainError> {
    const check = assertValidRunTransition(this._status, "running");
    if (!check.ok) {
      return check;
    }

    this._status = "running";
    this._updatedAt = startedAt;

    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "run_started",
      timestamp: startedAt,
    });

    return ok(undefined);
  }

  /**
   * Transitions run from running to completed.
   * INV-RUN-04: Cannot complete unless all tasks are completed.
   */
  complete(
    summary?: string | undefined,
    completedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const check = assertValidRunTransition(this._status, "completed");
    if (!check.ok) {
      return check;
    }

    const uncompletedTasks = Array.from(this._tasks.values()).filter(
      (t) => t.status !== "completed",
    );
    if (uncompletedTasks.length > 0) {
      return err(
        new InvalidStateTransitionError(
          "run",
          this._status,
          "completed",
          `${uncompletedTasks.length.toString()} task(s) are not completed`,
        ),
      );
    }

    this._status = "completed";
    this._updatedAt = completedAt;
    this._result = {
      summary: summary ?? `Execution run completed successfully`,
      metrics: {
        durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(this.createdAt).getTime()),
        tasksTotal: this._tasks.size,
        tasksCompleted: this._tasks.size,
        toolInvocations: 0,
      },
    };

    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "run_completed",
      timestamp: completedAt,
      summary: this._result.summary,
    });

    return ok(undefined);
  }

  /**
   * Transitions run to failed.
   */
  fail(
    errorMessage: string,
    failedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const check = assertValidRunTransition(this._status, "failed");
    if (!check.ok) {
      return check;
    }

    this._status = "failed";
    this._updatedAt = failedAt;
    this._result = {
      summary: `Run failed: ${errorMessage}`,
    };

    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "run_failed",
      timestamp: failedAt,
      error: errorMessage,
    });

    return ok(undefined);
  }

  /**
   * Transitions run to cancelled and explicitly cascades cancellation to all non-terminal tasks.
   * INV-RUN-06: Non-terminal tasks are cancelled; terminal tasks remain unaffected.
   */
  cancel(
    reason?: string | undefined,
    cancelledAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const check = assertValidRunTransition(this._status, "cancelled");
    if (!check.ok) {
      return check;
    }

    this._status = "cancelled";
    this._updatedAt = cancelledAt;

    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "run_cancelled",
      timestamp: cancelledAt,
      reason,
    });

    // Explicit cascading cancellation
    for (const task of this._tasks.values()) {
      if (!task.isTerminal()) {
        task.cancel(reason, cancelledAt);
        this.recordEvent({
          id: `evt-${crypto.randomUUID()}`,
          runId: this.id,
          type: "task_cancelled",
          timestamp: cancelledAt,
          taskId: task.id,
          taskName: task.name,
          reason,
        });
      }
    }

    return ok(undefined);
  }

  /**
   * Transitions a task to queued status within the aggregate.
   */
  scheduleTask(taskId: TaskId): Result<void, DomainError> {
    const task = this._tasks.get(taskId);
    if (!task) {
      return err(new TaskNotFoundError(taskId));
    }

    const res = task.markQueued();
    if (!res.ok) {
      return res;
    }

    this._updatedAt = new Date().toISOString();
    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "task_scheduled",
      timestamp: this._updatedAt,
      taskId: task.id,
      taskName: task.name,
    });

    return ok(undefined);
  }

  /**
   * Transitions a task to running status within the aggregate.
   */
  startTask(
    taskId: TaskId,
    worker?: WorkerId | undefined,
    startedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const task = this._tasks.get(taskId);
    if (!task) {
      return err(new TaskNotFoundError(taskId));
    }

    const res = task.start(worker, startedAt);
    if (!res.ok) {
      return res;
    }

    this._updatedAt = startedAt;
    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "task_started",
      timestamp: startedAt,
      taskId: task.id,
      taskName: task.name,
      worker,
    });

    return ok(undefined);
  }

  /**
   * Transitions a task to completed status within the aggregate.
   */
  completeTask(
    taskId: TaskId,
    output?: string | undefined,
    completedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const task = this._tasks.get(taskId);
    if (!task) {
      return err(new TaskNotFoundError(taskId));
    }

    const res = task.complete(output, completedAt);
    if (!res.ok) {
      return res;
    }

    this._updatedAt = completedAt;
    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "task_completed",
      timestamp: completedAt,
      taskId: task.id,
      taskName: task.name,
      output,
    });

    return ok(undefined);
  }

  /**
   * Transitions a task to failed status within the aggregate.
   */
  failTask(
    taskId: TaskId,
    errorMessage: string,
    completedAt: string = new Date().toISOString(),
  ): Result<void, DomainError> {
    const task = this._tasks.get(taskId);
    if (!task) {
      return err(new TaskNotFoundError(taskId));
    }

    const res = task.fail(errorMessage, completedAt);
    if (!res.ok) {
      return res;
    }

    this._updatedAt = completedAt;
    this.recordEvent({
      id: `evt-${crypto.randomUUID()}`,
      runId: this.id,
      type: "task_failed",
      timestamp: completedAt,
      taskId: task.id,
      taskName: task.name,
      error: errorMessage,
    });

    return ok(undefined);
  }

  toSnapshot(): RunSnapshot {
    const taskSnapshots = Array.from(this._tasks.values()).map((t) => t.toSnapshot());
    return {
      id: this.id,
      goal: this.goal,
      status: this._status,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
      progress: this.calculateProgress(),
      workflow: {
        id: this.workflow.id,
        name: this.workflow.name,
        tasks: taskSnapshots,
      },
      tasks: taskSnapshots,
      result: this._result,
    };
  }
}
