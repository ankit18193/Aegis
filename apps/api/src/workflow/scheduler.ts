/**
 * Pure domain workflow scheduler for Aegis.
 * Connects validated TaskDag topological ordering and evaluateTaskReadiness,
 * enforcing deterministic ready task selection (sorted lexicographically by TaskId).
 * INVARIANT: WorkflowScheduler is completely pure and never mutates TaskEntity or ExecutionRun.
 */

import type { TaskId } from "@aegis/types";

import type { BlockedTaskInfo } from "../domain/readiness.js";
import { evaluateTaskReadiness } from "../domain/readiness.js";
import type { TaskEntity } from "../domain/task.js";
import type { TaskDag } from "../domain/taskDag.js";

import type { TaskDefinition } from "./types.js";

export interface WorkflowReadinessReport {
  readonly readyTasks: readonly TaskEntity[];
  readonly waitingTasks: readonly TaskEntity[];
  readonly blockedTasks: readonly BlockedTaskInfo[];
  readonly isTerminal: boolean;
  readonly isComplete: boolean;
  readonly hasFailures: boolean;
}

export class WorkflowScheduler {
  constructor(readonly dag?: TaskDag<TaskDefinition> | undefined) {}

  /**
   * Evaluates the readiness of tasks from an ExecutionRun or task collection.
   * Deterministically orders ready tasks by canonical TaskId to eliminate
   * scheduling ambiguity or dependency on Object/Promise iteration.
   */
  getReadinessReport(tasks: readonly TaskEntity[]): WorkflowReadinessReport {
    const rawReport = evaluateTaskReadiness(tasks);

    // Enforce LOCK 3: Deterministic scheduling via canonical TaskId ordering
    const sortedReadyTasks = [...rawReport.readyTasks].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const isComplete =
      tasks.length > 0 && tasks.every((t) => t.status === "completed");

    const hasFailures = tasks.some(
      (t) => t.status === "failed" || t.status === "cancelled",
    );

    return {
      readyTasks: sortedReadyTasks,
      waitingTasks: rawReport.waitingTasks,
      blockedTasks: rawReport.blockedTasks,
      isTerminal: rawReport.isTerminal,
      isComplete,
      hasFailures,
    };
  }

  /**
   * Retrieves the next eligible ready task according to canonical deterministic ordering.
   * Returns undefined if no tasks are currently ready.
   */
  getNextReadyTask(tasks: readonly TaskEntity[]): TaskEntity | undefined {
    const report = this.getReadinessReport(tasks);
    return report.readyTasks[0];
  }

  /**
   * Checks whether the workflow has achieved complete terminal success (all tasks completed).
   */
  isWorkflowComplete(tasks: readonly TaskEntity[]): boolean {
    return tasks.length > 0 && tasks.every((t) => t.status === "completed");
  }

  /**
   * Evaluates whether the workflow has encountered a terminal failure condition:
   * 1. Any task has failed, OR
   * 2. Blocked tasks exist and no non-terminal tasks are currently running or ready.
   */
  isWorkflowFailed(tasks: readonly TaskEntity[]): boolean {
    if (tasks.some((t) => t.status === "failed")) {
      return true;
    }

    const report = this.getReadinessReport(tasks);
    if (report.blockedTasks.length > 0) {
      const activeTasks = tasks.some(
        (t) => t.status === "running" || t.status === "queued",
      );
      if (!activeTasks && report.readyTasks.length === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks whether a specific task is currently blocked by an upstream dependency.
   */
  isTaskBlocked(taskId: TaskId, tasks: readonly TaskEntity[]): BlockedTaskInfo | undefined {
    const report = this.getReadinessReport(tasks);
    return report.blockedTasks.find((b) => b.task.id === taskId);
  }
}
