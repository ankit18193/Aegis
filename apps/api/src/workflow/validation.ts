/**
 * Workflow definition validation.
 * Enforces DAG invariants, task identity uniqueness, dependency validity,
 * and cycle detection leveraging canonical TaskDag.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { TaskDag } from "../domain/taskDag.js";

import {
  InvalidDependencyError,
  InvalidWorkflowError,
  WorkflowCycleError,
  type WorkflowError,
} from "./errors.js";
import type { TaskDefinition, WorkflowDefinition } from "./types.js";

/**
 * Validates a workflow definition against all structural and topological invariants:
 * - Workflow ID and name must be non-empty
 * - Workflow must contain at least one task
 * - All task IDs must be non-empty and unique
 * - All task names must be non-empty
 * - All dependency references must exist within the workflow (no unknown dependencies)
 * - Tasks cannot depend on themselves (no self-dependencies)
 * - Tasks cannot declare duplicate dependencies
 * - Graph must be acyclic (no direct or indirect cycles)
 *
 * Returns a validated TaskDag<TaskDefinition> upon success.
 */
export function validateWorkflowDefinition(
  workflow: WorkflowDefinition,
): Result<TaskDag<TaskDefinition>, WorkflowError> {
  if (!workflow.id || (workflow.id as string).trim() === "") {
    return err(new InvalidWorkflowError("Workflow ID cannot be empty"));
  }

  if (!workflow.name || workflow.name.trim() === "") {
    return err(new InvalidWorkflowError("Workflow name cannot be empty"));
  }

  if (!Array.isArray(workflow.tasks) || workflow.tasks.length === 0) {
    return err(new InvalidWorkflowError("Workflow must contain at least one task"));
  }

  // Validate individual task fields
  for (const task of workflow.tasks) {
    if (!task.id || (task.id as string).trim() === "") {
      return err(new InvalidWorkflowError("Task ID cannot be empty"));
    }

    if (!task.name || task.name.trim() === "") {
      return err(new InvalidWorkflowError(`Task '${task.id}' must have a non-empty name`));
    }
  }

  // Delegate graph validation to canonical TaskDag
  const dagResult = TaskDag.build(workflow.tasks);
  if (!dagResult.ok) {
    const error = dagResult.error;
    switch (error.code) {
      case "DUPLICATE_TASK_ID":
        return err(new InvalidWorkflowError(`Duplicate task ID '${error.taskId}' found in workflow`));
      case "SELF_DEPENDENCY_ERROR":
        return err(new InvalidDependencyError(error.taskId, error.taskId, "self"));
      case "MISSING_DEPENDENCY_ERROR":
        return err(new InvalidDependencyError(error.taskId, error.missingDependencyId, "missing"));
      case "DUPLICATE_DEPENDENCY":
        return err(new InvalidDependencyError(error.taskId, error.dependencyId, "duplicate"));
      case "DAG_CYCLE_ERROR":
        return err(new WorkflowCycleError(error.cyclePath));
      default: {
        const exhaustiveCheck: never = error;
        return err(new InvalidWorkflowError(`Unknown graph error: ${String(exhaustiveCheck)}`));
      }
    }
  }

  return ok(dagResult.value);
}
