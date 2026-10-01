import type {
  ITaskExecutor,
  ITaskResultPublisher,
  TaskAssignment,
  TaskExecutionContext,
  TaskExecutionError,
  TaskExecutionResult,
} from "@aegis/contracts";
import { createTaskExecutionError } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result, WorkerId } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { ConcurrencyGate } from "./concurrencyGate.js";

export interface TaskExecutionServiceOptions {
  readonly workerId: WorkerId;
  readonly executor: ITaskExecutor;
  readonly publisher: ITaskResultPublisher;
  readonly maxConcurrentTasks?: number | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * TaskExecutionService coordinates the worker-side execution pipeline:
 * 1. Bounds concurrency via ConcurrencyGate
 * 2. Prepares TaskExecutionContext
 * 3. Delegates execution to ITaskExecutor (AgentRuntime)
 * 4. Publishes canonical TaskExecutionResult to aegis.tasks.results
 * 5. Returns Result to allow caller to enforce Result-Before-Offset-Commit semantics
 * 6. Supports graceful draining during shutdown
 */
export class TaskExecutionService {
  private readonly workerId: WorkerId;
  private readonly executor: ITaskExecutor;
  private readonly publisher: ITaskResultPublisher;
  private readonly gate: ConcurrencyGate;
  private readonly logger?: Logger | undefined;

  private inFlightExecutions = 0;
  private _isDraining = false;

  constructor(options: TaskExecutionServiceOptions) {
    this.workerId = options.workerId;
    this.executor = options.executor;
    this.publisher = options.publisher;
    this.gate = new ConcurrencyGate(options.maxConcurrentTasks ?? 1);
    this.logger = options.logger;
  }

  public get activeExecutionCount(): number {
    return this.inFlightExecutions;
  }

  public get isDraining(): boolean {
    return this._isDraining;
  }

  public get maxConcurrency(): number {
    return this.gate.maxConcurrency;
  }

  /**
   * Executes an accepted task assignment through the AgentRuntime and reports the outcome.
   * Returns ok(executionResult) ONLY IF the task execution completed AND result publication succeeded.
   */
  public async executeAndReport(
    assignment: TaskAssignment,
    envelopeMetadata: { readonly correlationId?: string | undefined; readonly causationId?: string | undefined },
  ): Promise<Result<TaskExecutionResult, TaskExecutionError>> {
    if (this._isDraining) {
      return err(
        createTaskExecutionError(
          "TASK_EXECUTION_FAILED",
          `Worker '${this.workerId}' is currently draining; rejecting new execution for task '${assignment.taskId}'.`,
        ),
      );
    }

    this.inFlightExecutions++;

    try {
      return await this.gate.runBounded(async () => {
        const context: TaskExecutionContext = {
          workerId: this.workerId,
          taskId: assignment.taskId,
          runId: assignment.runId,
          assignmentId: assignment.assignmentId,
          startedAt: new Date().toISOString(),
        };

        this.logger?.info("Executing task via AgentRuntime", {
          taskId: assignment.taskId,
          runId: assignment.runId,
          assignmentId: assignment.assignmentId,
          workerId: this.workerId,
        });

        // 1. Execute task through Agent Runtime
        const execResult = await this.executor.execute(assignment, context);

        this.logger?.info("Task execution finished; reporting result", {
          taskId: execResult.taskId,
          status: execResult.status,
          assignmentId: execResult.assignmentId,
        });

        // 2. Publish canonical task result to aegis.tasks.results
        const publishResult = await this.publisher.publish(execResult, {
          correlationId: envelopeMetadata.correlationId,
          causationId: envelopeMetadata.causationId,
        });

        if (!publishResult.ok) {
          this.logger?.error("Task result publication failed", {
            taskId: execResult.taskId,
            status: execResult.status,
            error: publishResult.error.message,
          });
          return err(publishResult.error);
        }

        this.logger?.info("Task result published successfully", {
          taskId: execResult.taskId,
          resultEventId: publishResult.value.id,
          status: execResult.status,
        });

        return ok(execResult);
      });
    } finally {
      this.inFlightExecutions--;
    }
  }

  /**
   * Gracefully drains in-flight task executions up to timeoutMs.
   */
  public async drain(timeoutMs: number): Promise<void> {
    this._isDraining = true;
    this.logger?.info("TaskExecutionService draining active executions", {
      activeCount: this.inFlightExecutions,
      timeoutMs,
    });

    const start = Date.now();
    while (this.inFlightExecutions > 0 && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (this.inFlightExecutions > 0) {
      this.logger?.warn("TaskExecutionService drain timeout exceeded with tasks remaining", {
        activeCount: this.inFlightExecutions,
      });
    } else {
      this.logger?.info("TaskExecutionService drained all active executions cleanly");
    }
  }
}
