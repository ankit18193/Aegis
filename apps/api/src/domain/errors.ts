/**
 * Domain errors taxonomy for Aegis execution and lifecycle rules.
 * Pure, discriminated errors returned as Result<T, DomainError>.
 */

export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown or returned when an invalid state transition is attempted on a Run or Task.
 */
export class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION" as const;

  constructor(
    readonly entityType: "run" | "task",
    readonly from: string,
    readonly to: string,
    readonly reason?: string,
  ) {
    const detail = reason ? ` (${reason})` : "";
    super(`Cannot transition ${entityType} from '${from}' to '${to}'${detail}`);
  }
}

/**
 * Thrown or returned when an operation or transition is attempted on a terminal entity.
 */
export class TerminalStateError extends DomainError {
  readonly code = "TERMINAL_STATE_ERROR" as const;

  constructor(
    readonly entityType: "run" | "task",
    readonly currentStatus: string,
    readonly attemptedTransition?: string,
  ) {
    const action = attemptedTransition ? ` to '${attemptedTransition}'` : "";
    super(`Cannot transition ${entityType} in terminal status '${currentStatus}'${action}`);
  }
}

/**
 * Thrown or returned when a circular dependency is detected in a task graph.
 */
export class DagCycleError extends DomainError {
  readonly code = "DAG_CYCLE_ERROR" as const;

  constructor(readonly cyclePath: readonly string[]) {
    const pathStr = cyclePath.join(" -> ");
    super(`Cycle detected in task dependencies: ${pathStr}`);
  }
}

/**
 * Thrown or returned when a task references a dependency that does not exist in the workflow.
 */
export class MissingDependencyError extends DomainError {
  readonly code = "MISSING_DEPENDENCY_ERROR" as const;

  constructor(
    readonly taskId: string,
    readonly missingDependencyId: string,
  ) {
    super(`Task '${taskId}' declares non-existent dependency '${missingDependencyId}'`);
  }
}

/**
 * Thrown or returned when a task declares a dependency on itself.
 */
export class SelfDependencyError extends DomainError {
  readonly code = "SELF_DEPENDENCY_ERROR" as const;

  constructor(readonly taskId: string) {
    super(`Task '${taskId}' cannot depend on itself`);
  }
}

/**
 * Thrown or returned when a task declares duplicate dependencies.
 */
export class DuplicateDependencyError extends DomainError {
  readonly code = "DUPLICATE_DEPENDENCY" as const;

  constructor(
    readonly taskId: string,
    readonly dependencyId: string,
  ) {
    super(`Task '${taskId}' declares duplicate dependency '${dependencyId}'`);
  }
}

/**
 * Thrown or returned when duplicate task IDs are found in a task graph.
 */
export class DuplicateTaskIdError extends DomainError {
  readonly code = "DUPLICATE_TASK_ID" as const;

  constructor(readonly taskId: string) {
    super(`Duplicate task ID '${taskId}' found in workflow`);
  }
}

/**
 * Thrown or returned when a task is requested but not found within an aggregate.
 */
export class TaskNotFoundError extends DomainError {
  readonly code = "TASK_NOT_FOUND" as const;

  constructor(readonly taskId: string) {
    super(`Task '${taskId}' not found in execution run`);
  }
}

