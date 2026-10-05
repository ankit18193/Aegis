import { ok, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { eventTypeSchema } from "./events.js";
import type { IRecoveryCoordinator } from "./recovery.js";
import {
  DEFAULT_RECOVERY_POLICY,
  NoEligibleWorkerError,
  RecoveryConflictError,
  RecoveryError,
  RetryLimitExceededError,
  TaskNotRecoverableError,
  orphanTaskSchema,
  recoveryActionSchema,
  recoveryDecisionSchema,
  recoveryPolicySchema,
  recoveryResultSchema,
  recoverySweepResultSchema,
} from "./recovery.js";

describe("Orphan Recovery Contracts & Schemas (Phase 12D)", () => {
  const sampleTaskId = taskId("task-recovery-test-1");
  const sampleRunId = runId("run-alpha");
  const sampleWorkerA = workerId("worker-node-a");
  const sampleWorkerB = workerId("worker-node-b");
  const sampleTime = "2026-10-06T12:00:00.000Z";

  describe("orphanTaskSchema (Lock 2: Strict Orphan Predicate)", () => {
    it("validates a genuine orphaned task with status='running' and leaseExpiredAt present", () => {
      const task = orphanTaskSchema.parse({
        id: sampleTaskId,
        runId: sampleRunId,
        name: "data_ingestion_task",
        status: "running",
        workerId: sampleWorkerA,
        leaseId: "lease-old-123",
        leaseUntil: "2026-10-06T11:59:30.000Z",
        leaseExpiredAt: sampleTime,
        attemptCount: 1,
        version: 2,
        input: { file: "records.csv" },
        dependencies: [],
      });

      expect(task.id).toBe(sampleTaskId);
      expect(task.status).toBe("running");
      expect(task.workerId).toBe(sampleWorkerA);
      expect(task.leaseExpiredAt).toBe(sampleTime);
      expect(task.attemptCount).toBe(1);
      expect(task.version).toBe(2);
    });

    it("rejects task with status other than 'running'", () => {
      expect(() =>
        orphanTaskSchema.parse({
          id: sampleTaskId,
          runId: sampleRunId,
          name: "data_ingestion_task",
          status: "completed",
          workerId: sampleWorkerA,
          leaseExpiredAt: sampleTime,
          attemptCount: 1,
          version: 2,
        }),
      ).toThrow();

      expect(() =>
        orphanTaskSchema.parse({
          id: sampleTaskId,
          runId: sampleRunId,
          name: "data_ingestion_task",
          status: "failed",
          workerId: sampleWorkerA,
          leaseExpiredAt: sampleTime,
          attemptCount: 1,
          version: 2,
        }),
      ).toThrow();
    });

    it("rejects task without leaseExpiredAt", () => {
      expect(() =>
        orphanTaskSchema.parse({
          id: sampleTaskId,
          runId: sampleRunId,
          name: "data_ingestion_task",
          status: "running",
          workerId: sampleWorkerA,
          attemptCount: 1,
          version: 2,
        }),
      ).toThrow();
    });

    it("rejects non-positive version or negative attempt count", () => {
      expect(() =>
        orphanTaskSchema.parse({
          id: sampleTaskId,
          runId: sampleRunId,
          name: "data_ingestion_task",
          status: "running",
          workerId: sampleWorkerA,
          leaseExpiredAt: sampleTime,
          attemptCount: -1,
          version: 1,
        }),
      ).toThrow();

      expect(() =>
        orphanTaskSchema.parse({
          id: sampleTaskId,
          runId: sampleRunId,
          name: "data_ingestion_task",
          status: "running",
          workerId: sampleWorkerA,
          leaseExpiredAt: sampleTime,
          attemptCount: 0,
          version: 0,
        }),
      ).toThrow();
    });
  });

  describe("recoveryPolicySchema & DEFAULT_RECOVERY_POLICY (Lock 6: Bounded Retries)", () => {
    it("validates default recovery policy constants", () => {
      const parsed = recoveryPolicySchema.parse(DEFAULT_RECOVERY_POLICY);
      expect(parsed.maxAttempts).toBe(3);
      expect(parsed.recoveryScanIntervalMs).toBe(5000);
      expect(parsed.leaseDurationMs).toBe(30000);
      expect(parsed.backoffBaseMs).toBe(1000);
      expect(parsed.backoffMaxMs).toBe(30000);
    });

    it("is frozen and immutable", () => {
      expect(Object.isFrozen(DEFAULT_RECOVERY_POLICY)).toBe(true);
    });

    it("rejects non-positive maxAttempts or recoveryScanIntervalMs", () => {
      expect(() =>
        recoveryPolicySchema.parse({
          ...DEFAULT_RECOVERY_POLICY,
          maxAttempts: 0,
        }),
      ).toThrow();

      expect(() =>
        recoveryPolicySchema.parse({
          ...DEFAULT_RECOVERY_POLICY,
          recoveryScanIntervalMs: -500,
        }),
      ).toThrow();
    });
  });

  describe("recoveryDecisionSchema", () => {
    it("validates a reassign decision (Lock 4 & 5)", () => {
      const decision = recoveryDecisionSchema.parse({
        action: "reassign",
        taskId: sampleTaskId,
        runId: sampleRunId,
        currentWorkerId: sampleWorkerA,
        newWorkerId: sampleWorkerB,
        newLeaseId: "lease-new-456",
        attemptCount: 2,
        expectedVersion: 2,
        reason: "Worker A lease expired; reassigned to Worker B",
      });

      expect(decision.action).toBe("reassign");
      if (decision.action === "reassign") {
        expect(decision.newWorkerId).toBe(sampleWorkerB);
        expect(decision.newLeaseId).toBe("lease-new-456");
        expect(decision.attemptCount).toBe(2);
        expect(decision.expectedVersion).toBe(2);
      }
    });

    it("validates a fail decision when retries are exhausted (Lock 6)", () => {
      const decision = recoveryDecisionSchema.parse({
        action: "fail",
        taskId: sampleTaskId,
        runId: sampleRunId,
        currentWorkerId: sampleWorkerA,
        attemptCount: 3,
        expectedVersion: 3,
        reason: "Execution retry limit exceeded (attempts: 3)",
      });

      expect(decision.action).toBe("fail");
      if (decision.action === "fail") {
        expect(decision.attemptCount).toBe(3);
        expect(decision.reason).toContain("retry limit exceeded");
      }
    });

    it("validates a skip decision when no healthy workers or concurrent lock", () => {
      const decision = recoveryDecisionSchema.parse({
        action: "skip",
        taskId: sampleTaskId,
        runId: sampleRunId,
        reason: "No capable workers available in registry",
      });

      expect(decision.action).toBe("skip");
      if (decision.action === "skip") {
        expect(decision.reason).toBe("No capable workers available in registry");
      }
    });

    it("rejects unknown action discriminator", () => {
      expect(() =>
        recoveryDecisionSchema.parse({
          action: "unknown_action",
          taskId: sampleTaskId,
          runId: sampleRunId,
          reason: "invalid",
        }),
      ).toThrow();
    });
  });

  describe("recoveryResultSchema & recoverySweepResultSchema", () => {
    it("validates recoveryActionSchema values", () => {
      expect(recoveryActionSchema.parse("reassigned")).toBe("reassigned");
      expect(recoveryActionSchema.parse("failed")).toBe("failed");
      expect(recoveryActionSchema.parse("skipped")).toBe("skipped");
      expect(() => recoveryActionSchema.parse("unknown")).toThrow();
    });

    it("validates successful reassignment result", () => {
      const result = recoveryResultSchema.parse({
        success: true,
        taskId: sampleTaskId,
        runId: sampleRunId,
        action: "reassigned",
        previousWorkerId: sampleWorkerA,
        assignedWorkerId: sampleWorkerB,
        newLeaseId: "lease-new-789",
        attemptCount: 2,
        version: 3,
        reason: "Reassigned to healthy Worker B",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("reassigned");
      expect(result.assignedWorkerId).toBe(sampleWorkerB);
      expect(result.attemptCount).toBe(2);
      expect(result.version).toBe(3);
    });

    it("validates sweep summary result", () => {
      const sweep = recoverySweepResultSchema.parse({
        scannedCount: 5,
        reassignedCount: 3,
        failedCount: 1,
        skippedCount: 1,
        results: [
          {
            success: true,
            taskId: sampleTaskId,
            runId: sampleRunId,
            action: "reassigned",
            attemptCount: 2,
          },
        ],
        durationMs: 42.5,
      });

      expect(sweep.scannedCount).toBe(5);
      expect(sweep.reassignedCount).toBe(3);
      expect(sweep.failedCount).toBe(1);
      expect(sweep.skippedCount).toBe(1);
      expect(sweep.results.length).toBe(1);
      expect(sweep.durationMs).toBe(42.5);
    });
  });

  describe("Typed Recovery Errors", () => {
    it("instantiates base RecoveryError with code and taskId", () => {
      const err = new RecoveryError("RECOVERY_FAILED", "Failed unexpectedly", sampleTaskId);
      expect(err.code).toBe("RECOVERY_FAILED");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.message).toBe("Failed unexpectedly");
      expect(err.name).toBe("RecoveryError");
    });

    it("instantiates TaskNotRecoverableError (Lock 2)", () => {
      const err = new TaskNotRecoverableError(sampleTaskId, "Task status is completed");
      expect(err.code).toBe("TASK_NOT_RECOVERABLE");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.message).toContain("not recoverable: Task status is completed");
      expect(err.name).toBe("TaskNotRecoverableError");
    });

    it("instantiates RecoveryConflictError (Lock 3)", () => {
      const err = new RecoveryConflictError(sampleTaskId, 2, 3);
      expect(err.code).toBe("RECOVERY_CONFLICT");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.message).toContain("expected version 2, actual version is 3");
      expect(err.name).toBe("RecoveryConflictError");
    });

    it("instantiates RetryLimitExceededError (Lock 6)", () => {
      const err = new RetryLimitExceededError(sampleTaskId, 3, 3);
      expect(err.code).toBe("RETRY_LIMIT_EXCEEDED");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.message).toContain("3 attempts made, maximum allowed is 3");
      expect(err.name).toBe("RetryLimitExceededError");
    });

    it("instantiates NoEligibleWorkerError with excluded worker (Lock 7)", () => {
      const err = new NoEligibleWorkerError(sampleTaskId, sampleWorkerA);
      expect(err.code).toBe("NO_ELIGIBLE_WORKER");
      expect(err.taskId).toBe(sampleTaskId);
      expect(err.message).toContain(`excluding failed worker '${sampleWorkerA}'`);
      expect(err.name).toBe("NoEligibleWorkerError");
    });
  });

  describe("IRecoveryCoordinator Contract Shape", () => {
    it("allows an implementation to satisfy IRecoveryCoordinator interface", async () => {
      const coordinator: IRecoveryCoordinator = {
        recoverOrphan: (tid) =>
          Promise.resolve(
            ok({
              success: true,
              taskId: tid,
              runId: sampleRunId,
              action: "reassigned",
              attemptCount: 2,
            }),
          ),
        sweepOrphans: () =>
          Promise.resolve(
            ok({
              scannedCount: 0,
              reassignedCount: 0,
              failedCount: 0,
              skippedCount: 0,
              results: [],
              durationMs: 0,
            }),
          ),
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        isRunning: true,
      };

      expect(coordinator).toBeDefined();
      expect(typeof coordinator.recoverOrphan).toBe("function");
      expect(typeof coordinator.sweepOrphans).toBe("function");
      expect(coordinator.isRunning).toBe(true);

      const res = await coordinator.recoverOrphan(sampleTaskId);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.taskId).toBe(sampleTaskId);
      }
    });
  });

  describe("eventTypeSchema includes task_reassigned", () => {
    it("accepts task_reassigned as a canonical event type", () => {
      expect(eventTypeSchema.parse("task_reassigned")).toBe("task_reassigned");
    });
  });
});
