import type { Run, Task, WorkerDescriptor } from "@aegis/contracts";
import {
  DEFAULT_RECOVERY_POLICY,
  RecoveryConflictError,
  TaskNotRecoverableError,
} from "@aegis/contracts";
import { runId, taskId, workerId, workflowId } from "@aegis/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryWorkerRegistry } from "../../presence/workerRegistry.js";
import { InMemoryOutboxRepository } from "../../repositories/inMemoryOutboxRepository.js";
import { InMemoryRunRepository } from "../../repositories/inMemoryRunRepository.js";
import { OrphanRecoveryCoordinator } from "../recoveryCoordinator.js";
import { DeterministicWorkerSelector } from "../workerSelector.js";

describe("OrphanRecoveryCoordinator (Phase 12D — Commit 3)", () => {
  let repository: InMemoryRunRepository;
  let outboxRepo: InMemoryOutboxRepository;
  let workerRegistry: InMemoryWorkerRegistry;
  let workerSelector: DeterministicWorkerSelector;

  function createTestWorker(
    id: string,
    overrides?: Partial<WorkerDescriptor>,
  ): WorkerDescriptor {
    return {
      workerId: workerId(id),
      lifecycleState: "ready",
      presenceState: "HEALTHY",
      capabilities: {
        taskTypes: ["*"],
        tools: ["python", "bash"],
        maxConcurrency: 4,
      },
      activeTaskCount: 0,
      maxConcurrentTasks: 4,
      registeredAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function createOrphanedTestRun(
    rId: string,
    tId: string,
    failedWorkerId: string,
    expiredAt?: string,
    attemptCount = 1,
    version = 1,
    taskOverrides?: Partial<Task>,
  ): Run {
    const t: Task = {
      id: taskId(tId),
      runId: runId(rId),
      name: "data_analysis",
      status: "running",
      description: "Perform heavy analysis",
      attemptCount,
      worker: workerId(failedWorkerId),
      workerId: workerId(failedWorkerId),
      version,
      leaseId: `lease-old-${tId}`,
      leaseUntil: new Date(Date.now() - 15000).toISOString(),
      leaseExpiredAt: expiredAt,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      dependencies: [],
      ...taskOverrides,
    };

    return {
      id: runId(rId),
      goal: "Test orphan recovery",
      status: "running",
      progress: 20,
      createdAt: new Date(Date.now() - 120000).toISOString(),
      updatedAt: expiredAt ?? new Date().toISOString(),
      workflow: {
        id: workflowId(`wf-${rId}`),
        name: "Test Recovery Workflow",
        tasks: [t],
      },
      tasks: [t],
    };
  }

  beforeEach(() => {
    outboxRepo = new InMemoryOutboxRepository();
    repository = new InMemoryRunRepository(false, outboxRepo);
    workerRegistry = new InMemoryWorkerRegistry();
    workerSelector = new DeterministicWorkerSelector();
  });

  describe("Contract Shape & Lifecycle", () => {
    it("satisfies IRecoveryCoordinator interface and exposes lifecycle methods", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
        policy: {
          maxAttempts: 3,
          recoveryScanIntervalMs: 2500,
          leaseDurationMs: 20000,
        },
      });

      expect(coordinator.isRunning).toBe(false);
      expect(coordinator.sweepsCount).toBe(0);
      expect(coordinator.currentPolicy.maxAttempts).toBe(3);
      expect(coordinator.currentPolicy.recoveryScanIntervalMs).toBe(2500);
      expect(coordinator.currentPolicy.leaseDurationMs).toBe(20000);

      await coordinator.start();
      expect(coordinator.isRunning).toBe(true);

      // Idempotent start
      await coordinator.start();
      expect(coordinator.isRunning).toBe(true);

      await coordinator.stop();
      expect(coordinator.isRunning).toBe(false);
    });

    it("applies DEFAULT_RECOVERY_POLICY defaults when optional policy omitted", () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      expect(coordinator.currentPolicy.maxAttempts).toBe(DEFAULT_RECOVERY_POLICY.maxAttempts);
      expect(coordinator.currentPolicy.recoveryScanIntervalMs).toBe(
        DEFAULT_RECOVERY_POLICY.recoveryScanIntervalMs,
      );
      expect(coordinator.currentPolicy.leaseDurationMs).toBe(
        DEFAULT_RECOVERY_POLICY.leaseDurationMs,
      );
    });
  });

  describe("Lock 2: Strict Orphan Predicate Invariant", () => {
    it("rejects non-existent tasks with TaskNotRecoverableError", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      const res = await coordinator.recoverOrphan(taskId("non-existent-task"));
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.error).toBeInstanceOf(TaskNotRecoverableError);
      expect(res.error.code).toBe("TASK_NOT_RECOVERABLE");
      expect(res.error.message).toContain("not currently in 'running' status with an expired lease");
    });

    it("rejects completed tasks with TaskNotRecoverableError", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      const run = createOrphanedTestRun(
        "run-comp",
        "task-comp",
        "worker-a",
        new Date().toISOString(),
        1,
        1,
        { status: "completed" },
      );
      await repository.save(run);

      const res = await coordinator.recoverOrphan(taskId("task-comp"));
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.error).toBeInstanceOf(TaskNotRecoverableError);
      expect(res.error.code).toBe("TASK_NOT_RECOVERABLE");
    });

    it("rejects active running tasks with valid leases (leaseExpiredAt missing)", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      const run = createOrphanedTestRun(
        "run-active",
        "task-active",
        "worker-a",
        undefined,
        1,
        1,
        {
          leaseExpiredAt: undefined,
          leaseUntil: new Date(Date.now() + 30000).toISOString(),
        },
      );
      await repository.save(run);

      const res = await coordinator.recoverOrphan(taskId("task-active"));
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.error).toBeInstanceOf(TaskNotRecoverableError);
    });
  });

  describe("Lock 7: Failed Worker Exclusion & Reassignment", () => {
    it("strictly excludes the failed worker and reassigns to an alternative healthy worker", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
        policy: { maxAttempts: 3, leaseDurationMs: 25000 },
        baseAssignmentTopic: "aegis.tasks.assign",
        eventsTopic: "aegis.events",
      });

      // Register failed Worker A and healthy alternative Worker B
      const workerA = createTestWorker("worker-a");
      const workerB = createTestWorker("worker-b");
      workerRegistry.register(workerA);
      workerRegistry.register(workerB);

      // Save orphaned task owned by worker-a
      const expiredAt = "2026-10-06T12:00:00.000Z";
      const testRun = createOrphanedTestRun("run-101", "task-101", "worker-a", expiredAt, 1, 1);
      await repository.save(testRun);

      const recoveryRes = await coordinator.recoverOrphan(taskId("task-101"));
      expect(recoveryRes.ok).toBe(true);
      if (!recoveryRes.ok) return;

      const result = recoveryRes.value;
      expect(result.success).toBe(true);
      expect(result.action).toBe("reassigned");
      expect(result.previousWorkerId).toBe(workerId("worker-a"));
      expect(result.assignedWorkerId).toBe(workerId("worker-b"));
      expect(result.newLeaseId).toMatch(/^lease-[a-f0-9-]+$/);
      expect(result.attemptCount).toBe(2); // Lock 5: monotonic increment
      expect(result.version).toBe(2);

      // Verify authoritative persistent state in repository
      const updatedRun = await repository.findById(runId("run-101"));
      expect(updatedRun).toBeDefined();
      if (!updatedRun) return;

      const updatedTask = updatedRun.tasks.find((t) => t.id === taskId("task-101"));
      expect(updatedTask).toBeDefined();
      if (!updatedTask) return;

      expect(updatedTask.workerId).toBe(workerId("worker-b"));
      expect(updatedTask.leaseExpiredAt).toBeUndefined();
      expect(updatedTask.attemptCount).toBe(2);
      expect(updatedTask.version).toBe(2);
      expect(updatedTask.leaseId).toBe(result.newLeaseId);

      // Verify transactional outbox records inserted (Lock 8)
      const pendingOutbox = await outboxRepo.claimPending({
        batchSize: 10,
        lockDurationMs: 60000,
        workerId: "test-consumer",
      });
      expect(pendingOutbox.length).toBe(2);

      // Outbox Record 1: task_reassigned event to aegis.events
      const eventRecord = pendingOutbox.find((r) => r.eventType === "task_reassigned");
      expect(eventRecord).toBeDefined();
      if (!eventRecord) return;
      expect(eventRecord.topic).toBe("aegis.events");
      expect(eventRecord.aggregateId).toBe("run-101");
      expect(eventRecord.payload.data).toMatchObject({
        type: "task_reassigned",
        taskId: taskId("task-101"),
        worker: workerId("worker-b"),
      });

      // Outbox Record 2: task_assigned envelope to dedicated worker topic (Lock 8 multi-topic routing)
      const assignmentRecord = pendingOutbox.find((r) => r.eventType === "task_assigned");
      expect(assignmentRecord).toBeDefined();
      if (!assignmentRecord) return;
      expect(assignmentRecord.topic).toBe("aegis.tasks.assign.worker-b");
      expect(assignmentRecord.aggregateId).toBe("task-101");
      expect(assignmentRecord.payload.data).toMatchObject({
        taskId: taskId("task-101"),
        workerId: workerId("worker-b"),
      });
    });

    it("evaluates deterministic tie-break across multiple eligible workers", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      // Worker B has active load 2; Worker C has active load 1. Worker C should be selected.
      const workerA = createTestWorker("worker-a");
      const workerB = createTestWorker("worker-b", { activeTaskCount: 2 });
      const workerC = createTestWorker("worker-c", { activeTaskCount: 1 });
      workerRegistry.register(workerA);
      workerRegistry.register(workerB);
      workerRegistry.register(workerC);

      const testRun = createOrphanedTestRun(
        "run-tie",
        "task-tie",
        "worker-a",
        new Date().toISOString(),
        1,
        1,
      );
      await repository.save(testRun);

      const res = await coordinator.recoverOrphan(taskId("task-tie"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.assignedWorkerId).toBe(workerId("worker-c"));
    });
  });

  describe("Lock 6: Bounded Retries & Terminal Failure Guard", () => {
    it("permanently fails the task when attemptCount has reached maxAttempts", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
        policy: { maxAttempts: 3 },
      });

      // Register healthy worker B, but task attemptCount is already 3
      const workerB = createTestWorker("worker-b");
      workerRegistry.register(workerB);

      const expiredAt = "2026-10-06T12:00:00.000Z";
      const testRun = createOrphanedTestRun("run-exhausted", "task-exhausted", "worker-a", expiredAt, 3, 3);
      await repository.save(testRun);

      const res = await coordinator.recoverOrphan(taskId("task-exhausted"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const result = res.value;
      expect(result.success).toBe(true);
      expect(result.action).toBe("failed");
      expect(result.attemptCount).toBe(3);
      expect(result.reason).toContain("retry limit exceeded");
      expect(result.version).toBe(4);

      // Verify task in repository transitioned to 'failed' status
      const updatedRun = await repository.findById(runId("run-exhausted"));
      expect(updatedRun).toBeDefined();
      if (!updatedRun) return;

      const updatedTask = updatedRun.tasks.find((t) => t.id === taskId("task-exhausted"));
      expect(updatedTask).toBeDefined();
      if (!updatedTask) return;

      expect(updatedTask.status).toBe("failed");
      expect(updatedTask.error).toContain("retry limit exceeded");
      expect(updatedTask.completedAt).toBeDefined();

      // Verify task is no longer returned by findOrphanedTasks
      const orphans = await repository.findOrphanedTasks(10);
      expect(orphans.some((t) => t.id === taskId("task-exhausted"))).toBe(false);

      // Verify outbox record inserted for audit event
      const pendingOutbox = await outboxRepo.claimPending({
        batchSize: 10,
        lockDurationMs: 60000,
        workerId: "test-consumer",
      });
      const failRecord = pendingOutbox.find((r) => r.eventType === "task_failed");
      expect(failRecord).toBeDefined();
      if (!failRecord) return;
      expect(failRecord.topic).toBe("aegis.events");
    });
  });

  describe("Worker Selection Failure & Isolation (No Eligible Worker Available)", () => {
    it("skips recovery and leaves task durably orphaned when only the failed worker is registered (Lock 7)", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      // Only failed worker-a is in registry
      workerRegistry.register(createTestWorker("worker-a"));

      const testRun = createOrphanedTestRun(
        "run-only-a",
        "task-only-a",
        "worker-a",
        new Date().toISOString(),
        1,
        1,
      );
      await repository.save(testRun);

      const res = await coordinator.recoverOrphan(taskId("task-only-a"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const result = res.value;
      expect(result.success).toBe(false);
      expect(result.action).toBe("skipped");
      expect(result.error).toBe("NO_ELIGIBLE_WORKER");

      // Verify task remains running and untouched in repository
      const run = await repository.findById(runId("run-only-a"));
      expect(run).toBeDefined();
      if (!run) return;

      const task = run.tasks.find((t) => t.id === taskId("task-only-a"));
      expect(task).toBeDefined();
      if (!task) return;

      expect(task.status).toBe("running");
      expect(task.version).toBe(1);
      expect(task.attemptCount).toBe(1);
      expect(task.leaseExpiredAt).toBeDefined();

      // Verify it is still discovered as an orphan for next sweep
      const orphans = await repository.findOrphanedTasks(10);
      expect(orphans.some((t) => t.id === taskId("task-only-a"))).toBe(true);
    });

    it("skips recovery when alternative worker is STALE or OFFLINE", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      workerRegistry.register(createTestWorker("worker-a"));
      workerRegistry.register(
        createTestWorker("worker-b", { presenceState: "STALE" }),
      );

      const testRun = createOrphanedTestRun(
        "run-stale-b",
        "task-stale-b",
        "worker-a",
        new Date().toISOString(),
        1,
        1,
      );
      await repository.save(testRun);

      const res = await coordinator.recoverOrphan(taskId("task-stale-b"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.action).toBe("skipped");
      expect(res.value.error).toBe("NO_ELIGIBLE_WORKER");
    });

    it("skips recovery when alternative worker lacks required capabilities", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      workerRegistry.register(createTestWorker("worker-a"));
      workerRegistry.register(
        createTestWorker("worker-b", {
          capabilities: {
            taskTypes: ["other_type_only"],
            tools: ["unrelated_tool"],
            maxConcurrency: 2,
          },
        }),
      );

      const testRun = createOrphanedTestRun(
        "run-incapable",
        "task-incapable",
        "worker-a",
        new Date().toISOString(),
        1,
        1,
      );
      await repository.save(testRun);

      const res = await coordinator.recoverOrphan(taskId("task-incapable"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.action).toBe("skipped");
      expect(res.value.error).toBe("NO_ELIGIBLE_WORKER");
    });

    it("skips recovery when alternative worker is at maximum concurrency capacity", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      workerRegistry.register(createTestWorker("worker-a"));
      workerRegistry.register(
        createTestWorker("worker-b", {
          activeTaskCount: 4,
          maxConcurrentTasks: 4,
        }),
      );

      const testRun = createOrphanedTestRun(
        "run-busy",
        "task-busy",
        "worker-a",
        new Date().toISOString(),
        1,
        1,
      );
      await repository.save(testRun);

      const res = await coordinator.recoverOrphan(taskId("task-busy"));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.action).toBe("skipped");
      expect(res.value.error).toBe("NO_ELIGIBLE_WORKER");
    });
  });

  describe("Lock 3: OCC Concurrency Conflict Lockout", () => {
    it("handles concurrency conflict error during atomic reassignment", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      workerRegistry.register(createTestWorker("worker-b"));

      // Simulate a conflict by mocking repository.reassignTask to return RecoveryConflictError
      vi.spyOn(repository, "reassignTask").mockResolvedValueOnce({
        ok: false,
        error: new RecoveryConflictError(taskId("task-occ"), 1, 2),
      });

      const testRun = createOrphanedTestRun(
        "run-occ",
        "task-occ",
        "worker-a",
        new Date().toISOString(),
        1,
        1,
      );
      await repository.save(testRun);

      const res = await coordinator.recoverOrphan(taskId("task-occ"));
      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.error).toBeInstanceOf(RecoveryConflictError);
      expect(res.error.code).toBe("RECOVERY_CONFLICT");
    });
  });

  describe("Orphan Sweep Execution (sweepOrphans)", () => {
    it("sweeps multiple orphans, executing reassignments, terminal failures, and skips in a single pass", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
        policy: { maxAttempts: 3 },
      });

      // Register worker-b (alternative worker)
      workerRegistry.register(createTestWorker("worker-b"));

      const now = new Date().toISOString();

      // Orphan 1: recoverable, should reassign to worker-b
      const run1 = createOrphanedTestRun("run-s1", "task-s1", "worker-a", now, 1, 1);
      // Orphan 2: retry limit reached (3 attempts), should fail
      const run2 = createOrphanedTestRun("run-s2", "task-s2", "worker-a", now, 3, 2);
      // Orphan 3: failed on worker-b, so worker-b is excluded and no other worker exists -> should skip
      const run3 = createOrphanedTestRun("run-s3", "task-s3", "worker-b", now, 1, 1);

      await repository.save(run1);
      await repository.save(run2);
      await repository.save(run3);

      const sweepRes = await coordinator.sweepOrphans(10);
      expect(sweepRes.ok).toBe(true);
      if (!sweepRes.ok) return;

      const summary = sweepRes.value;
      expect(summary.scannedCount).toBe(3);
      expect(summary.reassignedCount).toBe(1);
      expect(summary.failedCount).toBe(1);
      expect(summary.skippedCount).toBe(1);
      expect(summary.results.length).toBe(3);
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);

      // Verify internal coordinator counters
      expect(coordinator.sweepsCount).toBe(1);
      expect(coordinator.reassignedCount).toBe(1);
      expect(coordinator.failedCount).toBe(1);
      expect(coordinator.skippedCount).toBe(1);
    });

    it("handles OCC conflicts during sweep by gracefully recording skip without throwing", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      workerRegistry.register(createTestWorker("worker-b"));

      const run = createOrphanedTestRun("run-sw-occ", "task-sw-occ", "worker-a", new Date().toISOString());
      await repository.save(run);

      // Mock recoverOrphan to return OCC conflict for sweep
      vi.spyOn(repository, "reassignTask").mockResolvedValueOnce({
        ok: false,
        error: new RecoveryConflictError(taskId("task-sw-occ"), 1, 2),
      });

      const sweepRes = await coordinator.sweepOrphans(10);
      expect(sweepRes.ok).toBe(true);
      if (!sweepRes.ok) return;

      expect(sweepRes.value.scannedCount).toBe(1);
      expect(sweepRes.value.reassignedCount).toBe(0);
      expect(sweepRes.value.skippedCount).toBe(1);

      const firstResult = sweepRes.value.results[0];
      expect(firstResult).toBeDefined();
      if (!firstResult) return;
      expect(firstResult.action).toBe("skipped");
      expect(firstResult.error).toBe("RECOVERY_CONFLICT");
    });

    it("returns zero counts when persistent store has no orphans", async () => {
      const coordinator = new OrphanRecoveryCoordinator({
        repository,
        workerRegistry,
        workerSelector,
      });

      const sweepRes = await coordinator.sweepOrphans(50);
      expect(sweepRes.ok).toBe(true);
      if (!sweepRes.ok) return;

      expect(sweepRes.value.scannedCount).toBe(0);
      expect(sweepRes.value.reassignedCount).toBe(0);
      expect(sweepRes.value.failedCount).toBe(0);
      expect(sweepRes.value.skippedCount).toBe(0);
      expect(sweepRes.value.results).toEqual([]);
    });
  });
});
