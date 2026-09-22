/**
 * Core type definitions and contracts for the Aegis Workflow Engine.
 * Formulates the execution boundaries for workflow orchestration, task execution,
 * and dependency input/output propagation.
 */

import type { Result, RunId, TaskId, WorkflowId } from "@aegis/types";

import type { RunStatus } from "../domain/lifecycle.js";
import type { ExecutionRun } from "../domain/run.js";
import type { TaskEntity } from "../domain/task.js";

import type { WorkflowError } from "./errors.js";

/**
 * Supported data types for task input payloads.
 */
export type TaskInputData = Record<string, unknown> | string;

/**
 * Definition of an individual task node in a workflow DAG.
 */
export interface TaskDefinition {
  readonly id: TaskId;
  readonly name: string;
  readonly description?: string | undefined;
  readonly dependencies?: readonly TaskId[] | undefined;
  readonly input?: TaskInputData | undefined;
}

/**
 * Complete immutable definition of a workflow graph.
 */
export interface WorkflowDefinition {
  readonly id: WorkflowId;
  readonly name: string;
  readonly tasks: readonly TaskDefinition[];
}

/**
 * Resolved input context delivered to a task executor.
 * Combines declared static input with canonical outputs of upstream completed dependencies.
 */
export interface TaskExecutionInput {
  readonly taskId: TaskId;
  readonly name: string;
  readonly description: string;
  readonly staticInput?: TaskInputData | undefined;
  readonly dependencyOutputs: Readonly<Record<TaskId, string | undefined>>;
}

/**
 * Result produced by task execution.
 */
export interface TaskExecutionOutput {
  readonly taskId: TaskId;
  readonly success: boolean;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly durationMs: number;
}

/**
 * Boundary contract for executing an individual workflow task.
 */
export interface ITaskExecutor {
  execute(
    input: TaskExecutionInput,
    abortSignal?: AbortSignal,
  ): Promise<TaskExecutionOutput>;
}

/**
 * Optional execution hooks and signals for observing workflow execution.
 */
export interface WorkflowExecutionContext {
  readonly abortSignal?: AbortSignal | undefined;
  readonly onTaskScheduled?: (task: TaskEntity) => Promise<void> | void;
  readonly onTaskStarted?: (task: TaskEntity) => Promise<void> | void;
  readonly onTaskCompleted?: (task: TaskEntity, output?: string) => Promise<void> | void;
  readonly onTaskFailed?: (task: TaskEntity, error: string) => Promise<void> | void;
  readonly onTaskBlocked?: (task: TaskEntity, reason: string, blockerId: TaskId) => Promise<void> | void;
}

/**
 * Structured summary produced upon workflow execution completion.
 */
export interface WorkflowExecutionResult {
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly tasksTotal: number;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
  readonly durationMs: number;
}

/**
 * Primary boundary interface for the Aegis Workflow Engine.
 */
export interface IWorkflowEngine {
  execute(
    workflow: WorkflowDefinition,
    run: ExecutionRun,
    context?: WorkflowExecutionContext,
  ): Promise<Result<WorkflowExecutionResult, WorkflowError>>;
}
