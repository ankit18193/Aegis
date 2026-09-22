/**
 * Error hierarchy for the Aegis Workflow Engine.
 * Follows the domain error pattern extending DomainError with strongly-typed codes.
 */

import { DomainError } from "../domain/errors.js";

/**
 * Base abstract class for all workflow engine errors.
 */
export abstract class WorkflowError extends DomainError {}

/**
 * Thrown/returned when a workflow definition is structurally invalid.
 */
export class InvalidWorkflowError extends WorkflowError {
  readonly code = "INVALID_WORKFLOW" as const;

  constructor(readonly reason: string) {
    super(`Invalid workflow definition: ${reason}`);
  }
}

/**
 * Thrown/returned when a cycle is detected in task dependencies.
 */
export class WorkflowCycleError extends WorkflowError {
  readonly code = "CYCLE_DETECTED" as const;

  constructor(readonly cyclePath: readonly string[]) {
    super(`Cycle detected in workflow tasks: ${cyclePath.join(" -> ")}`);
  }
}

/**
 * Thrown/returned when a task references an invalid, unknown, or duplicate dependency.
 */
export class InvalidDependencyError extends WorkflowError {
  readonly code = "INVALID_DEPENDENCY" as const;

  constructor(
    readonly taskId: string,
    readonly dependencyId: string,
    readonly reason: "missing" | "self" | "duplicate",
  ) {
    const detail =
      reason === "self"
        ? "cannot depend on itself"
        : reason === "duplicate"
          ? `declares duplicate dependency on '${dependencyId}'`
          : `references unknown dependency '${dependencyId}'`;
    super(`Invalid dependency in task '${taskId}': ${detail}`);
  }
}

/**
 * Thrown/returned when a task cannot execute because upstream dependencies failed or were cancelled.
 */
export class TaskBlockedError extends WorkflowError {
  readonly code = "TASK_BLOCKED" as const;

  constructor(
    readonly taskId: string,
    readonly blockerId: string,
    readonly reason: "dependency_failed" | "dependency_cancelled",
  ) {
    super(`Task '${taskId}' is blocked due to ${reason} in upstream task '${blockerId}'`);
  }
}

/**
 * Thrown/returned when a workflow execution is aborted due to cancellation.
 */
export class WorkflowCancelledError extends WorkflowError {
  readonly code = "WORKFLOW_CANCELLED" as const;

  constructor(readonly runId: string, readonly reason?: string | undefined) {
    const detail = reason ? ` (Reason: ${reason})` : "";
    super(`Workflow execution for run '${runId}' was cancelled${detail}`);
  }
}

/**
 * Thrown/returned when a workflow fails during task execution.
 */
export class WorkflowExecutionFailedError extends WorkflowError {
  readonly code = "WORKFLOW_EXECUTION_FAILED" as const;

  constructor(
    readonly runId: string,
    readonly failedTaskId: string,
    readonly underlyingError: string,
  ) {
    super(
      `Workflow execution for run '${runId}' failed at task '${failedTaskId}': ${underlyingError}`,
    );
  }
}

/**
 * Thrown/returned when task input fails validation or resolution.
 */
export class InvalidTaskInputError extends WorkflowError {
  readonly code = "INVALID_TASK_INPUT" as const;

  constructor(readonly taskId: string, readonly reason: string) {
    super(`Invalid input for task '${taskId}': ${reason}`);
  }
}
