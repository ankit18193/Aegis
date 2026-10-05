import * as net from "node:net";

import type { CreateOutboxRecord, Run, RunEvent, Task } from "@aegis/contracts";
import {
  eventId,
  leaseId,
  outboxEventId,
  runId,
  taskId,
  workerId,
  workflowId,
} from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";

import { InMemoryOutboxRepository } from "./inMemoryOutboxRepository.js";
import { InMemoryRunRepository } from "./inMemoryRunRepository.js";
import { PostgresOutboxRepository } from "./postgresOutboxRepository.js";
import { PostgresRunRepository } from "./postgresRunRepository.js";
import type { IRunRepository } from "./runRepository.js";

async function isDatabaseReachable(port = 5433, host = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function createOrphanedTestRun(
  rId: string,
  tId: string,
  wId: string,
  expiredAt: string,
  initialVersion = 1,
): Run {
  const t: Task = {
    id: taskId(tId),
    name: "Execution Unit 1",
    status: "running",
    description: "Recovery integration test task",
    attemptCount: 1,
    worker: workerId(wId),
    workerId: workerId(wId),
    version: initialVersion,
    leaseId: "lease-expired-original",
    leaseUntil: new Date(Date.now() - 10000).toISOString(),
    leaseExpiredAt: expiredAt,
    startedAt: new Date(Date.now() - 60000).toISOString(),
  };

  return {
    id: runId(rId),
    goal: "Test orphan recovery and reassignment persistence",
    status: "running",
    progress: 20,
    createdAt: new Date(Date.now() - 120000).toISOString(),
    updatedAt: expiredAt,
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Recovery Pipeline",
      tasks: [t],
    },
    tasks: [t],
  };
}

describe("Durable Orphan Recovery State Transitions (Phase 12D — Commit 2)", () => {
  const dbAvailablePromise = isDatabaseReachable();

  describe("InMemoryRunRepository Recovery Implementation", () => {
    let repo: InMemoryRunRepository;
    let outboxRepo: InMemoryOutboxRepository;

    beforeEach(() => {
      outboxRepo = new InMemoryOutboxRepository();
      repo = new InMemoryRunRepository(false, outboxRepo);
    });

    executeRecoveryPersistenceTests(
      () => repo,
      () => outboxRepo,
    );
  });

  describe("PostgresRunRepository Real PostgreSQL Integration", () => {
    let ctx: DatabaseContext | undefined;
    let repo: PostgresRunRepository;
    let outboxRepo: PostgresOutboxRepository;
    let dbAvailable = false;

    beforeAll(async () => {
      dbAvailable = await dbAvailablePromise;
      if (!dbAvailable) return;

      ctx = createDatabaseContext({
        url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5433/aegis",
        poolMin: 1,
        poolMax: 3,
      });
      await runMigrations(ctx.db);
      outboxRepo = new PostgresOutboxRepository(ctx.db);
      repo = new PostgresRunRepository(ctx);
    }, 30000);

    beforeEach(async () => {
      if (!dbAvailable) return;
      await repo.resetToDefaults();
    });

    afterAll(async () => {
      await ctx?.close();
    });

    executeRecoveryPersistenceTests(
      () => repo,
      () => outboxRepo,
      () => dbAvailable,
    );
  });
});

function executeRecoveryPersistenceTests(
  getRepo: () => IRunRepository,
  getOutboxRepo: () => InMemoryOutboxRepository | PostgresOutboxRepository,
  isAvailable: () => boolean = () => true,
): void {
  describe("findOrphanedTasks (Lock 2: Strict Orphan Predicate)", () => {
    it("returns only running tasks with lease_expired_at set, sorted oldest first", async () => {
      if (!isAvailable()) return;
      const repo = getRepo();

      const time1 = "2026-10-06T10:00:00.000Z";
      const time2 = "2026-10-06T10:05:00.000Z";

      // 1. Genuine orphan 1 (older)
      const orphan1 = createOrphanedTestRun("run-orp-1", "task-orp-1", "worker-a", time1, 1);
      // 2. Genuine orphan 2 (newer)
      const orphan2 = createOrphanedTestRun("run-orp-2", "task-orp-2", "worker-b", time2, 1);
      // 3. Running task with active lease (leaseExpiredAt is undefined)
      const activeRun: Run = {
        id: runId("run-active-1"),
        goal: "Active task",
        status: "running",
        progress: 10,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workflow: {
          id: workflowId("wf-active"),
          name: "Active WF",
          tasks: [
            {
              id: taskId("task-active-1"),
              name: "Active task",
              status: "running",
              description: "Healthy running task",
              attemptCount: 1,
              worker: workerId("worker-c"),
              workerId: workerId("worker-c"),
              version: 1,
              leaseId: "lease-valid-1",
              leaseUntil: new Date(Date.now() + 20000).toISOString(),
              startedAt: new Date().toISOString(),
            },
          ],
        },
        tasks: [
          {
            id: taskId("task-active-1"),
            name: "Active task",
            status: "running",
            description: "Healthy running task",
            attemptCount: 1,
            worker: workerId("worker-c"),
            workerId: workerId("worker-c"),
            version: 1,
            leaseId: "lease-valid-1",
            leaseUntil: new Date(Date.now() + 20000).toISOString(),
            startedAt: new Date().toISOString(),
          },
        ],
      };
      // 4. Completed task with leftover expired marker
      const completedRun: Run = {
        id: runId("run-comp-1"),
        goal: "Completed task",
        status: "completed",
        progress: 100,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workflow: {
          id: workflowId("wf-comp"),
          name: "Completed WF",
          tasks: [
            {
              id: taskId("task-comp-1"),
              name: "Completed task",
              status: "completed",
              description: "Finished task",
              attemptCount: 1,
              version: 2,
              leaseExpiredAt: time1,
            },
          ],
        },
        tasks: [
          {
            id: taskId("task-comp-1"),
            name: "Completed task",
            status: "completed",
            description: "Finished task",
            attemptCount: 1,
            version: 2,
            leaseExpiredAt: time1,
          },
        ],
      };

      await repo.save(orphan2);
      await repo.save(orphan1);
      await repo.save(activeRun);
      await repo.save(completedRun);

      const orphans = await repo.findOrphanedTasks(10);
      expect(orphans.length).toBe(2);
      expect(orphans[0]?.id).toBe(taskId("task-orp-1"));
      expect(orphans[1]?.id).toBe(taskId("task-orp-2"));
    });

    it("respects the limit argument", async () => {
      if (!isAvailable()) return;
      const repo = getRepo();

      const time = new Date().toISOString();
      await repo.save(createOrphanedTestRun("run-lim-1", "task-lim-1", "worker-a", time, 1));
      await repo.save(createOrphanedTestRun("run-lim-2", "task-lim-2", "worker-b", time, 1));

      const orphans = await repo.findOrphanedTasks(1);
      expect(orphans.length).toBe(1);
    });
  });

  describe("reassignTask (Locks 3, 4, 5, 8: Atomic OCC Reassignment & Outbox)", () => {
    it("atomically updates task ownership, increments attemptCount and version, and inserts outbox records", async () => {
      if (!isAvailable()) return;
      const repo = getRepo();

      const expiredAt = "2026-10-06T11:00:00.000Z";
      const testRun = createOrphanedTestRun("run-reassign-1", "task-reassign-1", "worker-old", expiredAt, 1);
      await repo.save(testRun);

      const reassignEvent: RunEvent = {
        id: eventId("evt-reassign-1"),
        runId: runId("run-reassign-1"),
        type: "task_reassigned",
        severity: "info",
        timestamp: new Date().toISOString(),
        message: "Task reassigned from worker-old to worker-new",
        taskId: taskId("task-reassign-1"),
        taskName: "Execution Unit 1",
        worker: workerId("worker-new"),
      };

      const outboxRecords: CreateOutboxRecord[] = [
        {
          id: outboxEventId("outbox-reassign-evt-1"),
          aggregateId: "run-reassign-1",
          aggregateType: "ExecutionRun",
          eventType: "task_reassigned",
          topic: "aegis.events",
          payload: {
            id: eventId("evt-reassign-1"),
            type: "task_reassigned",
            source: "aegis.recovery",
            specVersion: "1.0",
            time: reassignEvent.timestamp,
            aggregateId: runId("run-reassign-1"),
            aggregateType: "ExecutionRun",
            correlationId: "run-reassign-1",
            data: reassignEvent,
          },
        },
        {
          id: outboxEventId("outbox-assign-worker-1"),
          aggregateId: "task-reassign-1",
          aggregateType: "TaskAssignment",
          eventType: "task_assigned",
          topic: "aegis.tasks.assign.worker-new",
          payload: {
            id: eventId("evt-assign-payload-1"),
            type: "task_assigned",
            source: "aegis.recovery",
            specVersion: "1.0",
            time: reassignEvent.timestamp,
            aggregateId: taskId("task-reassign-1"),
            aggregateType: "TaskAssignment",
            correlationId: "task-reassign-1",
            data: {
              assignmentId: "asgn-new-1",
              taskId: taskId("task-reassign-1"),
              runId: runId("run-reassign-1"),
              workerId: workerId("worker-new"),
              assignedAt: reassignEvent.timestamp,
            },
          },
        },
      ];

      const result = await repo.reassignTask(
        {
          taskId: taskId("task-reassign-1"),
          expectedVersion: 1,
          newWorkerId: workerId("worker-new"),
          newLeaseId: "lease-new-456",
          leaseDurationMs: 30000,
          event: reassignEvent,
        },
        outboxRecords,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const updated = result.value;
      expect(updated.workerId).toBe(workerId("worker-new"));
      expect(updated.leaseId).toBe(leaseId("lease-new-456"));
      expect(updated.leaseExpiredAt).toBeUndefined();
      expect(updated.attemptCount).toBe(2);
      expect(updated.leaseUntil).toBeDefined();
      if (!updated.leaseUntil) return;
      expect(new Date(updated.leaseUntil).getTime()).toBeGreaterThan(Date.now() + 20000);

      // Verify task in DB
      const loadedRun = await repo.findById(runId("run-reassign-1"));
      const dbTask = loadedRun?.tasks.find((t) => t.id === taskId("task-reassign-1"));
      expect(dbTask?.workerId).toBe(workerId("worker-new"));
      expect(dbTask?.version).toBe(2);
      expect(dbTask?.attemptCount).toBe(2);
      expect(dbTask?.leaseExpiredAt).toBeUndefined();

      // Verify no longer discovered as orphan
      const orphans = await repo.findOrphanedTasks(10);
      expect(orphans.some((t) => t.id === taskId("task-reassign-1"))).toBe(false);
    });

    it("rejects reassignment with RecoveryConflictError when version does not match (Lock 3)", async () => {
      if (!isAvailable()) return;
      const repo = getRepo();

      const expiredAt = "2026-10-06T11:00:00.000Z";
      const testRun = createOrphanedTestRun("run-conflict-1", "task-conflict-1", "worker-old", expiredAt, 2);
      await repo.save(testRun);

      const result = await repo.reassignTask({
        taskId: taskId("task-conflict-1"),
        expectedVersion: 1, // Stale version
        newWorkerId: workerId("worker-new"),
        newLeaseId: "lease-new-456",
        leaseDurationMs: 30000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("RECOVERY_CONFLICT");
    });

    it("rejects reassignment with TaskNotRecoverableError when task is not orphaned (Lock 2)", async () => {
      if (!isAvailable()) return;
      const repo = getRepo();

      const notOrphanedRun: Run = {
        id: runId("run-active-test"),
        goal: "Active task",
        status: "running",
        progress: 10,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workflow: {
          id: workflowId("wf-active-test"),
          name: "Active WF",
          tasks: [
            {
              id: taskId("task-active-test"),
              name: "Active task",
              status: "running",
              description: "Healthy",
              attemptCount: 1,
              worker: workerId("worker-c"),
              version: 1,
              leaseId: "lease-valid-1",
              leaseUntil: new Date(Date.now() + 20000).toISOString(),
            },
          ],
        },
        tasks: [
          {
            id: taskId("task-active-test"),
            name: "Active task",
            status: "running",
            description: "Healthy",
            attemptCount: 1,
            worker: workerId("worker-c"),
            version: 1,
            leaseId: "lease-valid-1",
            leaseUntil: new Date(Date.now() + 20000).toISOString(),
          },
        ],
      };

      await repo.save(notOrphanedRun);

      const result = await repo.reassignTask({
        taskId: taskId("task-active-test"),
        expectedVersion: 1,
        newWorkerId: workerId("worker-new"),
        newLeaseId: "lease-new-456",
        leaseDurationMs: 30000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("TASK_NOT_RECOVERABLE");
    });
  });

  describe("failExhaustedTask (Lock 6: Bounded Retries Terminal Transition)", () => {
    it("atomically transitions task to 'failed' status and updates version", async () => {
      if (!isAvailable()) return;
      const repo = getRepo();

      const expiredAt = "2026-10-06T11:00:00.000Z";
      const testRun = createOrphanedTestRun("run-exhaust-1", "task-exhaust-1", "worker-old", expiredAt, 3);
      await repo.save(testRun);

      const failEvent: RunEvent = {
        id: eventId("evt-fail-1"),
        runId: runId("run-exhaust-1"),
        type: "task_failed",
        severity: "error",
        timestamp: new Date().toISOString(),
        message: "Execution retry limit exceeded (attempts: 3)",
        taskId: taskId("task-exhaust-1"),
      };

      const result = await repo.failExhaustedTask({
        taskId: taskId("task-exhaust-1"),
        expectedVersion: 3,
        reason: "Execution retry limit exceeded (attempts: 3)",
        event: failEvent,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const failedTask = result.value;
      expect(failedTask.status).toBe("failed");
      expect(failedTask.error).toContain("retry limit exceeded");
      expect(failedTask.completedAt).toBeDefined();
      expect(failedTask.version).toBe(4);

      // Verify no longer discovered as orphan
      const orphans = await repo.findOrphanedTasks(10);
      expect(orphans.some((t) => t.id === taskId("task-exhaust-1"))).toBe(false);
    });

    it("rejects failExhaustedTask on version conflict (Lock 3)", async () => {
      if (!isAvailable()) return;
      const repo = getRepo();

      const expiredAt = "2026-10-06T11:00:00.000Z";
      const testRun = createOrphanedTestRun("run-fail-conflict", "task-fail-conflict", "worker-old", expiredAt, 2);
      await repo.save(testRun);

      const result = await repo.failExhaustedTask({
        taskId: taskId("task-fail-conflict"),
        expectedVersion: 1, // Stale version
        reason: "Retry limit reached",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("RECOVERY_CONFLICT");
    });
  });

  describe("Outbox Multi-Topic Support", () => {
    it("stores and claims outbox records preserving optional topic field", async () => {
      if (!isAvailable()) return;
      const outbox = getOutboxRepo();

      const sampleTime = new Date().toISOString();
      const records: CreateOutboxRecord[] = [
        {
          id: outboxEventId("outbox-topic-test-1"),
          aggregateId: "task-1",
          aggregateType: "TaskAssignment",
          eventType: "task_assigned",
          topic: "aegis.tasks.assign.worker-node-1",
          payload: {
            id: eventId("evt-payload-1"),
            type: "task_assigned",
            source: "aegis.recovery",
            specVersion: "1.0",
            time: sampleTime,
            aggregateId: taskId("task-1"),
            aggregateType: "TaskAssignment",
            correlationId: "task-1",
            data: { test: true },
          },
        },
        {
          id: outboxEventId("outbox-topic-test-2"),
          aggregateId: "run-1",
          aggregateType: "ExecutionRun",
          eventType: "task_reassigned",
          topic: "aegis.events",
          payload: {
            id: eventId("evt-payload-2"),
            type: "task_reassigned",
            source: "aegis.recovery",
            specVersion: "1.0",
            time: sampleTime,
            aggregateId: runId("run-1"),
            aggregateType: "ExecutionRun",
            correlationId: "run-1",
            data: {
              id: eventId("evt-payload-2"),
              runId: runId("run-1"),
              type: "task_reassigned",
              severity: "info",
              timestamp: sampleTime,
              message: "reassigned",
            },
          },
        },
      ];

      await outbox.insert(records);

      const claimed = await outbox.claimPending({
        batchSize: 10,
        lockDurationMs: 30000,
        workerId: "publisher-worker-1",
      });

      const claimedRecord1 = claimed.find((r) => r.id === outboxEventId("outbox-topic-test-1"));
      const claimedRecord2 = claimed.find((r) => r.id === outboxEventId("outbox-topic-test-2"));

      expect(claimedRecord1).toBeDefined();
      expect(claimedRecord1?.topic).toBe("aegis.tasks.assign.worker-node-1");

      expect(claimedRecord2).toBeDefined();
      expect(claimedRecord2?.topic).toBe("aegis.events");
    });
  });
}
