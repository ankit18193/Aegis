/**
 * Pure task readiness evaluation engine.
 * Computes readiness state (ready, waiting, blocked) from current task graph states.
 * INVARIANT: evaluateTaskReadiness is completely pure and NEVER mutates TaskEntity state.
 */

import type { TaskId } from "@aegis/types";

import type { TaskEntity } from "./task.js";

export type ReadinessClassification = "ready" | "waiting" | "blocked";

export interface BlockedTaskInfo {
  readonly task: TaskEntity;
  readonly reason: "dependency_failed" | "dependency_cancelled";
  readonly blockerId: TaskId;
}

export interface TaskReadinessReport {
  readonly readyTasks: readonly TaskEntity[];
  readonly waitingTasks: readonly TaskEntity[];
  readonly blockedTasks: readonly BlockedTaskInfo[];
  readonly isTerminal: boolean;
}

/**
 * Purely evaluates task readiness without altering any task status or aggregate state.
 */
export function evaluateTaskReadiness(
  tasks: readonly TaskEntity[],
): TaskReadinessReport {
  const tasksById = new Map<string, TaskEntity>();
  for (const t of tasks) {
    tasksById.set(t.id, t);
  }

  const readyTasks: TaskEntity[] = [];
  const waitingTasks: TaskEntity[] = [];
  const blockedTasks: BlockedTaskInfo[] = [];

  for (const task of tasks) {
    // Only pending tasks are evaluated for readiness eligibility
    if (task.status !== "pending") {
      continue;
    }

    if (task.dependencies.length === 0) {
      readyTasks.push(task);
      continue;
    }

    let isBlocked = false;
    let isWaiting = false;

    for (const depId of task.dependencies) {
      const dep = tasksById.get(depId);
      if (!dep) {
        blockedTasks.push({
          task,
          reason: "dependency_failed",
          blockerId: depId,
        });
        isBlocked = true;
        break;
      }

      if (dep.status === "failed") {
        blockedTasks.push({
          task,
          reason: "dependency_failed",
          blockerId: dep.id,
        });
        isBlocked = true;
        break;
      }

      if (dep.status === "cancelled") {
        blockedTasks.push({
          task,
          reason: "dependency_cancelled",
          blockerId: dep.id,
        });
        isBlocked = true;
        break;
      }

      if (dep.status !== "completed") {
        // Upstream dependency is still pending, queued, or running
        isWaiting = true;
      }
    }

    if (isBlocked) {
      continue;
    }

    if (isWaiting) {
      waitingTasks.push(task);
    } else {
      // All dependencies are successfully completed
      readyTasks.push(task);
    }
  }

  const isTerminal = tasks.length > 0 && tasks.every((t) => t.isTerminal());

  return {
    readyTasks,
    waitingTasks,
    blockedTasks,
    isTerminal,
  };
}
