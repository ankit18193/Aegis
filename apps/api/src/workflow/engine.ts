/**
 * Core Workflow Engine for Aegis.
 * Coordinates deterministic DAG execution, task readiness scheduling,
 * dependency output resolution, and lifecycle state transitions on ExecutionRun.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import type { ExecutionRun } from "../domain/run.js";

import { DependencyResolver } from "./dependency-resolver.js";
import {
  InvalidWorkflowError,
  WorkflowCancelledError,
  WorkflowError,
  WorkflowExecutionFailedError,
} from "./errors.js";
import { WorkflowScheduler } from "./scheduler.js";
import { WorkflowTaskExecutor } from "./task-executor.js";
import type {
  ITaskExecutor,
  IWorkflowEngine,
  WorkflowDefinition,
  WorkflowExecutionContext,
  WorkflowExecutionResult,
} from "./types.js";
import { validateWorkflowDefinition } from "./validation.js";

export interface WorkflowEngineOptions {
  readonly scheduler?: WorkflowScheduler | undefined;
  readonly dependencyResolver?: DependencyResolver | undefined;
  readonly taskExecutor?: ITaskExecutor | undefined;
}

export class WorkflowEngine implements IWorkflowEngine {
  private readonly scheduler: WorkflowScheduler;
  private readonly dependencyResolver: DependencyResolver;
  private readonly taskExecutor: ITaskExecutor;

  constructor(options: WorkflowEngineOptions = {}) {
    this.scheduler = options.scheduler ?? new WorkflowScheduler();
    this.dependencyResolver =
      options.dependencyResolver ?? new DependencyResolver();
    this.taskExecutor = options.taskExecutor ?? new WorkflowTaskExecutor();
  }

  async execute(
    workflow: WorkflowDefinition,
    run: ExecutionRun,
    context?: WorkflowExecutionContext,
  ): Promise<Result<WorkflowExecutionResult, WorkflowError>> {
    const startTime = Date.now();

    // 1. Validate workflow DAG definition
    const validationResult = validateWorkflowDefinition(workflow);
    if (!validationResult.ok) {
      return validationResult;
    }

    // 2. Check cancellation or terminal state before starting
    if (run.isTerminal()) {
      return err(
        new InvalidWorkflowError(
          `Cannot execute workflow on run '${run.id}' with terminal status '${run.status}'`,
        ),
      );
    }

    if (context?.abortSignal?.aborted) {
      const reason =
        typeof context.abortSignal.reason === "string"
          ? context.abortSignal.reason
          : "Execution cancelled by signal";
      run.cancel(reason);
      return err(new WorkflowCancelledError(run.id, reason));
    }

    // 3. Advance run from pending to running
    if (run.status === "pending") {
      const startResult = run.start();
      if (!startResult.ok) {
        return err(new InvalidWorkflowError(startResult.error.message));
      }
    }

    // 4. Orchestration loop
    while (!run.isTerminal()) {
      // Check cancellation signal before each task selection
      if (context?.abortSignal?.aborted) {
        const reason =
          typeof context.abortSignal.reason === "string"
            ? context.abortSignal.reason
            : "Execution cancelled by operator";
        run.cancel(reason);
        break;
      }

      const report = this.scheduler.getReadinessReport(run.tasks);

      // 4a. Check successful completion
      if (report.isComplete) {
        run.complete("Workflow executed successfully");
        break;
      }

      // 4b. Check failure or blocked state (LOCK 6 & Correction #2)
      if (this.scheduler.isWorkflowFailed(run.tasks)) {
        const failedTask = run.tasks.find((t) => t.status === "failed");
        const errorDetail = failedTask?.error ?? "Workflow contains blocked tasks and cannot proceed";
        run.fail(errorDetail);
        break;
      }

      // 4c. Select next ready task in canonical deterministic order
      if (report.readyTasks.length > 0) {
        const nextTask = report.readyTasks[0];
        if (!nextTask) {
          break;
        }

        // Schedule task
        const schedRes = run.scheduleTask(nextTask.id);
        if (!schedRes.ok) {
          run.fail(schedRes.error.message);
          break;
        }
        await context?.onTaskScheduled?.(nextTask);

        // Start task
        const startTaskRes = run.startTask(nextTask.id);
        if (!startTaskRes.ok) {
          run.fail(startTaskRes.error.message);
          break;
        }
        await context?.onTaskStarted?.(nextTask);

        // Resolve input dependencies
        const inputResult = this.dependencyResolver.resolveExecutionInput(
          nextTask,
          run.tasks,
        );

        if (!inputResult.ok) {
          run.failTask(nextTask.id, inputResult.error.message);
          run.fail(`Failed resolving inputs for task '${nextTask.id}': ${inputResult.error.message}`);
          break;
        }

        // Execute task via boundary
        const execOutput = await this.taskExecutor.execute(
          inputResult.value,
          context?.abortSignal,
        );

        // Handle cancellation post-execution
        if (context?.abortSignal?.aborted) {
          const cancelReason =
            typeof context.abortSignal.reason === "string"
              ? context.abortSignal.reason
              : "Execution cancelled";
          run.cancel(cancelReason);
          break;
        }

        if (execOutput.success) {
          run.completeTask(nextTask.id, execOutput.output);
          await context?.onTaskCompleted?.(nextTask, execOutput.output);
        } else {
          // Task failure (LOCK 6 & Correction #2: task fails -> dependent tasks blocked -> run fails)
          const errorMsg = execOutput.error ?? "Task execution failed";
          run.failTask(nextTask.id, errorMsg);
          await context?.onTaskFailed?.(nextTask, errorMsg);

          // Terminate run deterministically upon task failure
          run.fail(`Workflow failed at task '${nextTask.id}': ${errorMsg}`);
          break;
        }
      } else {
        // No ready tasks, not complete, not failed -> Deadlock guard
        run.fail("Workflow reached deadlocked state with no eligible ready tasks");
        break;
      }
    }

    const durationMs = Date.now() - startTime;
    const taskList = run.tasks;
    const tasksCompleted = taskList.filter((t) => t.status === "completed").length;
    const tasksFailed = taskList.filter((t) => t.status === "failed").length;

    const executionResult: WorkflowExecutionResult = {
      runId: run.id,
      status: run.status,
      tasksTotal: taskList.length,
      tasksCompleted,
      tasksFailed,
      summary: run.result?.summary,
      error: run.status === "failed" ? (run.result?.summary ?? "Workflow execution failed") : undefined,
      durationMs,
    };

    if (run.status === "cancelled") {
      return err(new WorkflowCancelledError(run.id, "Workflow was cancelled"));
    }

    if (run.status === "failed") {
      const failedTask = taskList.find((t) => t.status === "failed");
      return err(
        new WorkflowExecutionFailedError(
          run.id,
          failedTask?.id ?? "unknown",
          run.result?.summary ?? "Workflow failed",
        ),
      );
    }

    return ok(executionResult);
  }
}
