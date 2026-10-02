import type {
  IWorkerSelector,
  Task,
  TaskRequirements,
  WorkerDescriptor,
  WorkerSelectionResult,
} from "@aegis/contracts";
import {
  extractTaskRequirements,
  WorkerSelectionFailureReasonEnum,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";

import type { WorkerSelectorOptions } from "./types.js";

/**
 * DeterministicWorkerSelector — Deterministic capability- and capacity-aware worker selection.
 *
 * Implements Phase 11E selection pipeline:
 * 1. Presence Filter: Worker must be HEALTHY (strictly excludes STALE and OFFLINE).
 * 2. Lifecycle Filter: Worker must be in 'ready' or 'busy' state (excludes starting, draining, stopped, failed).
 * 3. Capability Filter: Worker must support task.name (wildcard '*' or case-insensitive) and all required tools.
 * 4. Capacity Filter: activeTaskCount < maxConcurrentTasks.
 * 5. Deterministic Selection (Lock 7): Primary sort by activeTaskCount ascending; tie-break by workerId ascending.
 */
export class DeterministicWorkerSelector implements IWorkerSelector {
  private readonly logger?: Logger | undefined;

  constructor(options?: WorkerSelectorOptions) {
    this.logger = options?.logger;
  }

  public selectWorker(
    task: Task,
    candidates: readonly WorkerDescriptor[],
    requirements?: TaskRequirements,
  ): WorkerSelectionResult {
    const totalCandidates = candidates.length;
    if (totalCandidates === 0) {
      this.logger?.debug("Worker selection failed: zero registered workers in registry.");
      return {
        failureReason: WorkerSelectionFailureReasonEnum.NO_REGISTERED_WORKERS,
        evaluatedWorkerCount: 0,
        eligibleWorkerCount: 0,
      };
    }

    const resolvedRequirements = requirements ?? extractTaskRequirements(task);

    // 1. Presence filter: Must be HEALTHY (strictly excludes STALE, OFFLINE)
    const healthyWorkers = candidates.filter((w) => w.presenceState === "HEALTHY");
    if (healthyWorkers.length === 0) {
      this.logger?.debug("Worker selection failed: no healthy workers available.", {
        totalCandidates,
      });
      return {
        failureReason: WorkerSelectionFailureReasonEnum.NO_HEALTHY_WORKERS,
        evaluatedWorkerCount: totalCandidates,
        eligibleWorkerCount: 0,
      };
    }

    // 2. Lifecycle filter: Worker must be active and receptive to tasks ('ready' or 'busy')
    const activeLifecycleWorkers = healthyWorkers.filter(
      (w) => w.lifecycleState === "ready" || w.lifecycleState === "busy",
    );

    // 3. Capability filter: Match task type and all required tools
    const capableWorkers = activeLifecycleWorkers.filter((w) => {
      const supportedTypes = w.capabilities.taskTypes;
      const matchesType =
        supportedTypes.includes("*") ||
        supportedTypes.some(
          (t) => t.toLowerCase() === resolvedRequirements.taskType.toLowerCase(),
        );

      if (!matchesType) {
        return false;
      }

      const supportedTools = w.capabilities.tools;
      const matchesTools = resolvedRequirements.requiredTools.every((reqTool) =>
        supportedTools.includes(reqTool),
      );

      return matchesTools;
    });

    if (capableWorkers.length === 0) {
      this.logger?.debug("Worker selection failed: no workers match required capabilities.", {
        requiredTaskType: resolvedRequirements.taskType,
        requiredTools: resolvedRequirements.requiredTools,
        evaluatedHealthy: healthyWorkers.length,
      });
      return {
        failureReason: WorkerSelectionFailureReasonEnum.NO_CAPABLE_WORKERS,
        evaluatedWorkerCount: totalCandidates,
        eligibleWorkerCount: 0,
      };
    }

    // 4. Capacity filter: activeTaskCount < maxConcurrentTasks
    const availableWorkers = capableWorkers.filter(
      (w) => w.activeTaskCount < w.maxConcurrentTasks,
    );

    if (availableWorkers.length === 0) {
      this.logger?.debug("Worker selection failed: all capable workers at maximum capacity.", {
        capableWorkersCount: capableWorkers.length,
      });
      return {
        failureReason: WorkerSelectionFailureReasonEnum.CAPACITY_EXHAUSTED,
        evaluatedWorkerCount: totalCandidates,
        eligibleWorkerCount: 0,
      };
    }

    // 5. Deterministic Selection (Lock 7):
    // Primary: Least activeTaskCount ascending (least-loaded worker)
    // Secondary: workerId lexicographical ascending (deterministic tie-break)
    const sorted = [...availableWorkers].sort((a, b) => {
      if (a.activeTaskCount !== b.activeTaskCount) {
        return a.activeTaskCount - b.activeTaskCount;
      }
      return a.workerId.localeCompare(b.workerId);
    });

    const selectedWorker = sorted[0];
    if (!selectedWorker) {
      return {
        failureReason: WorkerSelectionFailureReasonEnum.CAPACITY_EXHAUSTED,
        evaluatedWorkerCount: totalCandidates,
        eligibleWorkerCount: 0,
      };
    }

    this.logger?.debug("Worker deterministically selected for task dispatch", {
      taskId: task.id,
      selectedWorkerId: selectedWorker.workerId,
      activeLoad: selectedWorker.activeTaskCount,
      maxConcurrency: selectedWorker.maxConcurrentTasks,
      candidatePoolSize: availableWorkers.length,
    });

    return {
      selectedWorker,
      evaluatedWorkerCount: totalCandidates,
      eligibleWorkerCount: availableWorkers.length,
    };
  }
}
