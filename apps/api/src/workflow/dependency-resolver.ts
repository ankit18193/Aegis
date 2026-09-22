/**
 * Dependency resolver for the Aegis Workflow Engine.
 * Resolves upstream dependency outputs and static inputs for ready tasks,
 * ensuring deterministic input propagation across DAG topologies.
 * INVARIANT: DependencyResolver is completely pure and does not mutate task state.
 */

import type { Result, TaskId } from "@aegis/types";
import { err, ok } from "@aegis/types";

import type { TaskEntity } from "../domain/task.js";

import {
  InvalidDependencyError,
  TaskBlockedError,
  type WorkflowError,
} from "./errors.js";
import type { TaskExecutionInput } from "./types.js";

function toTaskMap(
  tasks: readonly TaskEntity[] | ReadonlyMap<string, TaskEntity>,
): ReadonlyMap<string, TaskEntity> {
  if ("get" in tasks && typeof tasks.get === "function") {
    return tasks;
  }
  return new Map((tasks as readonly TaskEntity[]).map((t) => [t.id as string, t]));
}

export class DependencyResolver {
  /**
   * Resolves the complete execution input for a task from its static input
   * and the canonical outputs of its upstream completed dependencies.
   *
   * Enforces:
   * - All declared dependencies must exist in the task collection
   * - All declared dependencies must be in 'completed' status
   * - If any dependency failed or was cancelled, returns a TaskBlockedError
   */
  resolveExecutionInput(
    task: TaskEntity,
    allTasks: readonly TaskEntity[] | ReadonlyMap<string, TaskEntity>,
  ): Result<TaskExecutionInput, WorkflowError> {
    const tasksById = toTaskMap(allTasks);

    const dependencyOutputs: Record<TaskId, string | undefined> = {};

    for (const depId of task.dependencies) {
      const depTask = tasksById.get(depId);
      if (!depTask) {
        return err(new InvalidDependencyError(task.id, depId, "missing"));
      }

      if (depTask.status === "failed") {
        return err(
          new TaskBlockedError(task.id, depTask.id, "dependency_failed"),
        );
      }

      if (depTask.status === "cancelled") {
        return err(
          new TaskBlockedError(task.id, depTask.id, "dependency_cancelled"),
        );
      }

      if (depTask.status !== "completed") {
        return err(
          new TaskBlockedError(task.id, depTask.id, "dependency_failed"),
        );
      }

      dependencyOutputs[depId] = depTask.output;
    }

    return ok({
      taskId: task.id,
      name: task.name,
      description: task.description,
      staticInput: task.input,
      dependencyOutputs,
    });
  }

  /**
   * Checks whether all upstream dependencies for a given task have reached
   * the completed terminal status.
   */
  areDependenciesSatisfied(
    task: TaskEntity,
    allTasks: readonly TaskEntity[] | ReadonlyMap<string, TaskEntity>,
  ): boolean {
    const tasksById = toTaskMap(allTasks);

    if (task.dependencies.length === 0) {
      return true;
    }

    return task.dependencies.every((depId) => {
      const dep = tasksById.get(depId);
      return dep !== undefined && dep.status === "completed";
    });
  }

  /**
   * Helper to extract canonical outputs for all dependencies of a task.
   */
  getDependencyOutputs(
    task: TaskEntity,
    allTasks: readonly TaskEntity[] | ReadonlyMap<string, TaskEntity>,
  ): Readonly<Record<TaskId, string | undefined>> {
    const tasksById = toTaskMap(allTasks);

    const outputs: Record<TaskId, string | undefined> = {};
    for (const depId of task.dependencies) {
      const dep = tasksById.get(depId);
      if (dep && dep.status === "completed") {
        outputs[depId] = dep.output;
      }
    }
    return outputs;
  }
}
