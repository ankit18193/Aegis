import type {
  ITaskExecutor,
  ITaskLeaseClient,
  ITaskResultPublisher,
  TaskAssignment,
  TaskExecutionContext,
  TaskExecutionError,
  TaskExecutionResult,
  TaskLeaseConfig,
} from "@aegis/contracts";
import { createTaskExecutionError } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result, WorkerId } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { ConcurrencyGate } from "./concurrencyGate.js";
import { WorkerTaskLeaseManager } from "./leaseManager.js";

export interface TaskExecutionServiceOptions {
  readonly workerId: WorkerId;
  readonly executor: ITaskExecutor;
  readonly publisher: ITaskResultPublisher;
  readonly maxConcurrentTasks?: number | undefined;
  readonly logger?: Logger | undefined;
  readonly leaseClient?: ITaskLeaseClient | undefined;
  readonly leaseConfig?: Partial<TaskLeaseConfig> | undefined;
}

/**
 * TaskExecutionService coordinates the worker-side execution pipeline:
 * 1. Bounds concurrency via ConcurrencyGate
 * 2. Manages task execution lease lifecycle via WorkerTaskLeaseManager (if leaseClient provided)
 * 3. Prepares TaskExecutionContext
 * 4. Delegates execution to ITaskExecutor (AgentRuntime)
 * 5. Publishes canonical TaskExecutionResult to aegis.tasks.results
 * 6. Returns Result to allow caller to enforce Result-Before-Offset-Commit semantics
 * 7. Supports graceful draining during shutdown
 */
export class TaskExecutionService {
  private readonly workerId: WorkerId;
  private readonly executor: ITaskExecutor;
  private readonly publisher: ITaskResultPublisher;
  private readonly gate: ConcurrencyGate;
  private readonly logger?: Logger | undefined;
  private readonly leaseClient?: ITaskLeaseClient | undefined;
  private readonly leaseConfig?: Partial<TaskLeaseConfig> | undefined;

  private inFlightExecutions = 0;
  private _isDraining = false;

  constructor(options: TaskExecutionServiceOptions) {
    this.workerId = options.workerId;
    this.executor = options.executor;
    this.publisher = options.publisher;
    this.gate = new ConcurrencyGate(options.maxConcurrentTasks ?? 1);
    this.logger = options.logger;
    this.leaseClient = options.leaseClient;
    this.leaseConfig = options.leaseConfig;
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

        let leaseManager: WorkerTaskLeaseManager | undefined;

        if (this.leaseClient) {
          const expectedVersion = assignment.task.version;
          const acqRes = await this.leaseClient.acquire({
            taskId: assignment.taskId,
            workerId: this.workerId,
            leaseDurationMs: this.leaseConfig?.leaseDurationMs ?? 30000,
            expectedVersion,
          });

          if (!acqRes.ok) {
            this.logger?.warn("Failed to acquire initial task lease; rejecting execution", {
              taskId: assignment.taskId,
              error: acqRes.error.message,
            });
            return err(
              createTaskExecutionError(
                "TASK_EXECUTION_FAILED",
                `Failed to acquire execution lease for task '${assignment.taskId}': ${acqRes.error.message}`,
              ),
            );
          }

          leaseManager = new WorkerTaskLeaseManager({
            leaseClient: this.leaseClient,
            taskId: assignment.taskId,
            workerId: this.workerId,
            initialLease: acqRes.value,
            config: this.leaseConfig,
            logger: this.logger,
            onLeaseLost: (leaseErr) => {
              this.logger?.error("Task lease lost during execution", {
                taskId: assignment.taskId,
                error: leaseErr.message,
              });
            },
          });
          leaseManager.start();
        }

        try {
          // 1. Execute task through Agent Runtime
          const execResult = await this.executor.execute(assignment, context);

          // Invariant: If lease was lost or expired during execution, suppress late result!
          if (leaseManager && !leaseManager.isLeaseActive()) {
            this.logger?.warn("Discarding execution result because task lease expired or was lost", {
              taskId: assignment.taskId,
              assignmentId: assignment.assignmentId,
            });
            return err(
              createTaskExecutionError(
                "TASK_EXECUTION_FAILED",
                `Execution discarded: lease for task '${assignment.taskId}' was lost or expired during execution.`,
              ),
            );
          }

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
        } finally {
          if (leaseManager) {
            await leaseManager.stop();
          }
        }
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
