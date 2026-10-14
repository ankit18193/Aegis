import { randomUUID } from "node:crypto";

import type {
  CreateOutboxRecord,
  IRecoveryCoordinator,
  IWorkerRegistry,
  IWorkerSelector,
  RecoveryPolicy,
  RecoveryResult,
  RecoverySweepResult,
  RunEvent,
  Task,
} from "@aegis/contracts";
import {
  DEFAULT_RECOVERY_POLICY,
  RecoveryError,
  resolveWorkerAssignmentTopic,
  TaskNotRecoverableError,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result, TaskId } from "@aegis/types";
import { err, eventId, ok, outboxEventId, runId, taskId } from "@aegis/types";

import { toEventEnvelope } from "../events/envelope.js";
import type { IRunRepository } from "../repositories/runRepository.js";

import { buildTaskAssignment } from "./assignmentBuilder.js";
import type { OrphanRecoveryCoordinatorOptions } from "./types.js";

/**
 * OrphanRecoveryCoordinator — Control-plane coordinator for orphaned task detection,
 * retry policy enforcement, deterministic reassignment, and terminal exhaustion transitions.
 *
 * Implements Phase 12D recovery pipeline:
 * 1. Lock 1: PostgreSQL authoritative recovery state queried via IRunRepository.
 * 2. Lock 2: Strict orphan predicate (status = 'running' AND lease_expired_at IS NOT NULL).
 * 3. Lock 3: OCC-safe concurrency via version-gated repository updates.
 * 4. Lock 4: Distinct ownership identity (fresh leaseId and incremented version).
 * 5. Lock 5: Monotonic attempt count tracking across reassignments.
 * 6. Lock 6: Bounded retries: terminal transition to 'failed' when attemptCount >= maxAttempts.
 * 7. Lock 7: Failed worker exclusion: worker that lost lease is strictly excluded from candidates.
 * 8. Lock 8: Single atomic transaction committing task update + runEvent + multi-topic outbox records.
 * 9. Lock 10: Idempotent recovery operations via optimistic concurrency lockout.
 */
export class OrphanRecoveryCoordinator implements IRecoveryCoordinator {
  private readonly repository: IRunRepository;
  private readonly workerRegistry: IWorkerRegistry;
  private readonly workerSelector: IWorkerSelector;
  private readonly policy: RecoveryPolicy;
  private readonly baseAssignmentTopic: string;
  private readonly eventsTopic: string;
  private readonly logger?: Logger | undefined;

  private timer: NodeJS.Timeout | null = null;
  private _isRunning = false;
  private _sweepsCount = 0;
  private _reassignedCount = 0;
  private _failedCount = 0;
  private _skippedCount = 0;

  constructor(options: OrphanRecoveryCoordinatorOptions) {
    this.repository = options.repository;
    this.workerRegistry = options.workerRegistry;
    this.workerSelector = options.workerSelector;
    this.policy = {
      ...DEFAULT_RECOVERY_POLICY,
      ...options.policy,
    };
    this.baseAssignmentTopic = options.baseAssignmentTopic ?? "aegis.tasks.assign";
    this.eventsTopic = options.eventsTopic ?? "aegis.events";
    this.logger = options.logger;
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  public get sweepsCount(): number {
    return this._sweepsCount;
  }

  public get reassignedCount(): number {
    return this._reassignedCount;
  }

  public get failedCount(): number {
    return this._failedCount;
  }

  public get skippedCount(): number {
    return this._skippedCount;
  }

  public get currentPolicy(): RecoveryPolicy {
    return this.policy;
  }

  /**
   * Starts the periodic orphan recovery background loop.
   */
  public start(): Promise<void> {
    if (this._isRunning) {
      return Promise.resolve();
    }
    this._isRunning = true;

    this.logger?.info("Starting control-plane OrphanRecoveryCoordinator", {
      recoveryScanIntervalMs: this.policy.recoveryScanIntervalMs,
      maxAttempts: this.policy.maxAttempts,
      leaseDurationMs: this.policy.leaseDurationMs,
    });

    this.timer = setInterval(() => {
      void this.sweepOrphans().catch((err: unknown) => {
        this.logger?.error("Error in orphan recovery sweep cycle", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.policy.recoveryScanIntervalMs);

    this.timer.unref();
    return Promise.resolve();
  }

  /**
   * Stops the periodic orphan recovery background loop gracefully.
   */
  public stop(): Promise<void> {
    this._isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger?.info("Stopped control-plane OrphanRecoveryCoordinator");
    return Promise.resolve();
  }

  /**
   * Sweeps the persistent store for genuinely orphaned tasks (status = 'running' AND lease_expired_at IS NOT NULL),
   * attempting recovery for each candidate.
   */
  public async sweepOrphans(limit = 50): Promise<Result<RecoverySweepResult, RecoveryError>> {
    this._sweepsCount++;
    const startTime = Date.now();

    let orphans: Task[];
    try {
      orphans = await this.repository.findOrphanedTasks(limit);
    } catch (queryError: unknown) {
      return err(
        new RecoveryError(
          "RECOVERY_FAILED",
          `Failed to query orphaned tasks: ${queryError instanceof Error ? queryError.message : String(queryError)}`,
          taskId("unknown"),
          queryError,
        ),
      );
    }

    let reassignedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    const results: RecoveryResult[] = [];

    for (const task of orphans) {
      const recoveryRes = await this.recoverOrphan(task.id, task);
      if (recoveryRes.ok) {
        const res = recoveryRes.value;
        results.push(res);
        if (res.action === "reassigned") {
          reassignedCount++;
          this._reassignedCount++;
        } else if (res.action === "failed") {
          failedCount++;
          this._failedCount++;
        } else {
          skippedCount++;
          this._skippedCount++;
        }
      } else {
        // Concurrency conflict from competing coordinator instance or unrecoverable error
        skippedCount++;
        this._skippedCount++;
        results.push({
          success: false,
          taskId: task.id,
          runId: task.runId ?? runId(`run-${task.id}`),
          action: "skipped",
          previousWorkerId: task.workerId,
          attemptCount: task.attemptCount,
          version: task.version,
          reason: recoveryRes.error.message,
          error: recoveryRes.error.code,
        });
      }
    }

    const durationMs = Math.max(0, Date.now() - startTime);
    return ok({
      scannedCount: orphans.length,
      reassignedCount,
      failedCount,
      skippedCount,
      results,
      durationMs,
    });
  }

  /**
   * Attempts to recover a single identified orphaned task.
   * Evaluates retry limits, selects an alternative healthy worker (excluding failed worker),
   * and atomically commits reassignment or terminal failure through repository + outbox.
   */
  public async recoverOrphan(
    targetTaskId: TaskId,
    taskHint?: Task,
  ): Promise<Result<RecoveryResult, RecoveryError>> {
    // 1. Resolve task candidate
    let task = taskHint?.id === targetTaskId ? taskHint : undefined;
    if (!task) {
      const orphans = await this.repository.findOrphanedTasks(100);
      task = orphans.find((t) => t.id === targetTaskId);
    }

    // Lock 2: Strict orphan predicate
    if (task?.status !== "running" || !task.leaseExpiredAt) {
      return err(
        new TaskNotRecoverableError(
          targetTaskId,
          "Task is not currently in 'running' status with an expired lease",
        ),
      );
    }

    const effectiveRunId = task.runId ?? runId(`run-${task.id}`);

    // Lock 6: Bounded Retries & Terminal Failure Guard
    if (task.attemptCount >= this.policy.maxAttempts) {
      const reason = `Execution retry limit exceeded (${String(task.attemptCount)} attempts made, maximum allowed is ${String(this.policy.maxAttempts)})`;
      const failEvent: RunEvent = {
        id: eventId(`evt-fail-${task.id}-${String(task.version + 1)}`),
        runId: effectiveRunId,
        type: "task_failed",
        severity: "error",
        timestamp: new Date().toISOString(),
        message: `Execution retry limit exceeded (attempts: ${String(task.attemptCount)})`,
        taskId: task.id,
        taskName: task.name,
        worker: task.workerId,
        metadata: {
          attempts: task.attemptCount,
          maxAttempts: this.policy.maxAttempts,
          previousWorkerId: task.workerId,
        },
      };

      const envelope = toEventEnvelope(failEvent, {
        source: "aegis.recovery",
        correlationId: effectiveRunId,
      });

      const outboxRecord: CreateOutboxRecord = {
        id: outboxEventId(`outbox-fail-${failEvent.id}`),
        aggregateId: effectiveRunId,
        aggregateType: "ExecutionRun",
        eventType: "task_failed",
        topic: this.eventsTopic,
        payload: envelope,
        status: "pending",
        attemptCount: 0,
        createdAt: failEvent.timestamp,
      };

      const failResult = await this.repository.failExhaustedTask(
        {
          taskId: task.id,
          expectedVersion: task.version,
          reason,
          event: failEvent,
        },
        [outboxRecord],
      );

      if (!failResult.ok) {
        return err(failResult.error);
      }

      const failedTask = failResult.value;
      this.logger?.warn("Orphaned task permanently failed due to retry exhaustion", {
        taskId: task.id,
        runId: effectiveRunId,
        attempts: task.attemptCount,
        maxAttempts: this.policy.maxAttempts,
        newVersion: failedTask.version,
      });

      return ok({
        success: true,
        taskId: task.id,
        runId: effectiveRunId,
        action: "failed",
        previousWorkerId: task.workerId,
        attemptCount: task.attemptCount,
        version: failedTask.version,
        reason,
      });
    }

    // Lock 7: Failed Worker Exclusion on Reassignment
    const allWorkers = this.workerRegistry.list();
    const candidatePool = allWorkers.filter((w) => w.workerId !== task.workerId);

    const selection = this.workerSelector.selectWorker(task, candidatePool);
    if (!selection.selectedWorker) {
      this.logger?.warn("Orphan recovery skipped: no eligible alternative worker available", {
        taskId: task.id,
        failedWorkerId: task.workerId,
        reason: selection.failureReason,
        evaluatedCandidates: selection.evaluatedWorkerCount,
      });

      return ok({
        success: false,
        taskId: task.id,
        runId: effectiveRunId,
        action: "skipped",
        previousWorkerId: task.workerId,
        attemptCount: task.attemptCount,
        version: task.version,
        reason:
          selection.failureReason ??
          `No eligible worker available (excluding failed worker '${String(task.workerId)}')`,
        error: "NO_ELIGIBLE_WORKER",
      });
    }

    const selectedWorker = selection.selectedWorker;
    const newWorkerId = selectedWorker.workerId;
    const newLeaseId = `lease-${randomUUID()}`;

    // Build canonical TaskAssignment + TaskAssignmentEnvelope
    const { assignment, envelope: assignmentEnvelope } = buildTaskAssignment({
      task,
      workerId: newWorkerId,
      runId: effectiveRunId,
    });

    const reassignEvent: RunEvent = {
      id: eventId(`evt-reassign-${task.id}-${String(task.version + 1)}`),
      runId: effectiveRunId,
      type: "task_reassigned",
      severity: "info",
      timestamp: new Date().toISOString(),
      message: `Task '${task.name}' reassigned from worker '${task.workerId ?? "unknown"}' to '${newWorkerId}' (attempt ${String(task.attemptCount + 1)})`,
      taskId: task.id,
      taskName: task.name,
      worker: newWorkerId,
      metadata: {
        previousWorkerId: task.workerId,
        newWorkerId,
        newLeaseId,
        assignmentId: assignment.assignmentId,
        attemptCount: task.attemptCount + 1,
        previousVersion: task.version,
      },
    };

    const reassignEventEnvelope = toEventEnvelope(reassignEvent, {
      source: "aegis.recovery",
      correlationId: effectiveRunId,
    });

    let targetTopic: string;
    try {
      targetTopic = resolveWorkerAssignmentTopic(this.baseAssignmentTopic, newWorkerId);
    } catch {
      targetTopic = `${this.baseAssignmentTopic}.${newWorkerId}`;
    }

    const outboxRecords: CreateOutboxRecord[] = [
      {
        id: outboxEventId(`outbox-evt-${reassignEvent.id}`),
        aggregateId: effectiveRunId,
        aggregateType: "ExecutionRun",
        eventType: "task_reassigned",
        topic: this.eventsTopic,
        payload: reassignEventEnvelope,
        status: "pending",
        attemptCount: 0,
        createdAt: reassignEvent.timestamp,
      },
      {
        id: outboxEventId(`outbox-asgn-${assignmentEnvelope.id}`),
        aggregateId: task.id,
        aggregateType: "TaskAssignment",
        eventType: "task_assigned",
        topic: targetTopic,
        payload: assignmentEnvelope,
        status: "pending",
        attemptCount: 0,
        createdAt: assignmentEnvelope.time,
      },
    ];

    // Lock 8 & Lock 3: Atomic OCC reassign in single transaction
    const reassignResult = await this.repository.reassignTask(
      {
        taskId: task.id,
        expectedVersion: task.version,
        newWorkerId,
        newLeaseId,
        leaseDurationMs: this.policy.leaseDurationMs,
        event: reassignEvent,
      },
      outboxRecords,
    );

    if (!reassignResult.ok) {
      return err(reassignResult.error);
    }

    const updatedTask = reassignResult.value;
    this.logger?.info("Orphaned task successfully reassigned", {
      taskId: task.id,
      runId: effectiveRunId,
      previousWorkerId: task.workerId,
      newWorkerId,
      newLeaseId,
      attemptCount: updatedTask.attemptCount,
      newVersion: updatedTask.version,
    });

    return ok({
      success: true,
      taskId: task.id,
      runId: effectiveRunId,
      action: "reassigned",
      previousWorkerId: task.workerId,
      assignedWorkerId: newWorkerId,
      newLeaseId,
      attemptCount: updatedTask.attemptCount,
      version: updatedTask.version,
      reason: `Reassigned to worker '${newWorkerId}'`,
    });
  }
}
