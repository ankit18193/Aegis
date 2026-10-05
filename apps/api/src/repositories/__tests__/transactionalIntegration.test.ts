import * as net from "node:net";

import type { EventEnvelope, Run, RunEvent, Task } from "@aegis/contracts";
import {
  assignmentId,
  eventId,
  runId,
  taskId,
  workerId,
  workflowId,
} from "@aegis/types";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../../db/client.js";
import { runMigrations } from "../../db/migrator.js";
import {
  outboxEventsTable,
  runEventsTable,
  runsTable,
  tasksTable,
} from "../../db/schema.js";
import { TaskLeaseMonitor } from "../../dispatch/leaseMonitor.js";
import { TaskResultConsumer } from "../../dispatch/resultConsumer.js";
import { InMemoryOutboxRepository } from "../inMemoryOutboxRepository.js";
import { InMemoryRunRepository } from "../inMemoryRunRepository.js";
import { PostgresRunRepository } from "../postgresRunRepository.js";

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

function createSampleRun(rIdStr: string, tIdStr: string): { run: Run; events: RunEvent[] } {
  const rId = runId(rIdStr);
  const tId = taskId(tIdStr);
  const now = new Date().toISOString();

  const task: Task = {
    id: tId,
    runId: rId,
    name: "Sample Step",
    description: "Step description",
    status: "running",
    attemptCount: 1,
    workerId: workerId("worker-test-1"),
    version: 1,
    startedAt: now,
  };

  const run: Run = {
    id: rId,
    goal: "Transactional Outbox Verification Run",
    status: "running",
    progress: 25,
    workflow: {
      id: workflowId(`wf-${rIdStr}`),
      name: "Outbox Workflow",
      tasks: [task],
    },
    tasks: [task],
    createdAt: now,
    updatedAt: now,
  };

  const events: RunEvent[] = [
    {
      id: eventId(`evt-created-${rIdStr}`),
      runId: rId,
      type: "run_created",
      severity: "info",
      timestamp: now,
      message: "Run created",
    },
    {
      id: eventId(`evt-started-${tIdStr}`),
      runId: rId,
      type: "task_started",
      severity: "info",
      timestamp: now,
      message: "Task started",
      taskId: tId,
      taskName: task.name,
    },
  ];

  return { run, events };
}

describe("Transactional Outbox Integration (Phase 12C — Commit 3)", () => {
  describe("InMemoryRunRepository Outbox Integration", () => {
    it("records outbox events during save() and propagates to attached outboxRepo", async () => {
      const outboxRepo = new InMemoryOutboxRepository();
      const runRepo = new InMemoryRunRepository(false, outboxRepo);

      const { run, events } = createSampleRun("run-mem-1", "task-mem-1");
      await runRepo.save(run, events);

      // Verify internal inMemoryRunRepository outbox events
      const internalOutbox = runRepo.getOutboxEvents();
      expect(internalOutbox).toHaveLength(2);
      expect(internalOutbox[0]?.eventType).toBe("run_created");
      expect(internalOutbox[0]?.status).toBe("pending");
      expect(internalOutbox[0]?.payload.aggregateId).toBe("run-mem-1");
      expect(internalOutbox[1]?.eventType).toBe("task_started");

      // Verify propagation to attached InMemoryOutboxRepository
      const pendingCount = await outboxRepo.getPendingCount();
      expect(pendingCount).toBe(2);
    });

    it("records outbox events during updateTaskState()", async () => {
      const outboxRepo = new InMemoryOutboxRepository();
      const runRepo = new InMemoryRunRepository(false, outboxRepo);

      const { run, events } = createSampleRun("run-mem-2", "task-mem-2");
      await runRepo.save(run, events);

      const completionEvent: RunEvent = {
        id: eventId("evt-completed-mem-2"),
        runId: run.id,
        type: "task_completed",
        severity: "success",
        timestamp: new Date().toISOString(),
        message: "Task completed successfully",
        taskId: taskId("task-mem-2"),
      };

      const res = await runRepo.updateTaskState(
        taskId("task-mem-2"),
        {
          status: "completed",
          completedAt: new Date().toISOString(),
          output: "Success output",
        },
        1,
        completionEvent,
      );

      expect(res.ok).toBe(true);
      expect(runRepo.getOutboxEvents()).toHaveLength(3);

      const outboxRecord = runRepo.getOutboxEvents().find((e) => e.eventType === "task_completed");
      expect(outboxRecord).toBeDefined();
      expect(outboxRecord?.payload.type).toBe("task_completed");
      expect(outboxRecord?.payload.aggregateId).toBe("run-mem-2");
    });
  });

  describe("PostgresRunRepository Live Transactional Outbox Integration", () => {
    let dbCtx: DatabaseContext | null = null;
    let repo: PostgresRunRepository;
    const testPrefix = `tx-test-${Date.now().toString()}-${Math.floor(Math.random() * 10000).toString()}`;

    beforeAll(async () => {
      const reachable = await isDatabaseReachable(5433);
      if (!reachable) {
        return;
      }

      dbCtx = createDatabaseContext();
      await runMigrations(dbCtx.db);
      repo = new PostgresRunRepository(dbCtx.db);
    });

    afterAll(async () => {
      if (dbCtx) {
        await dbCtx.close();
      }
    });

    it("confirms database connectivity for transactional integration tests", () => {
      expect(dbCtx).not.toBeNull();
    });

    it("atomically persists run, tasks, run_events, AND outbox_events in a single transaction during save()", async () => {
      if (!dbCtx) return;

      const rId = `${testPrefix}-run-1`;
      const tId = `${testPrefix}-task-1`;
      const { run, events } = createSampleRun(rId, tId);

      await repo.save(run, events);

      // 1. Verify runsTable
      const [runRow] = await dbCtx.db.select().from(runsTable).where(eq(runsTable.id, rId)).limit(1);
      expect(runRow).toBeDefined();
      expect(runRow?.status).toBe("running");

      // 2. Verify tasksTable
      const [taskRow] = await dbCtx.db.select().from(tasksTable).where(eq(tasksTable.id, tId)).limit(1);
      expect(taskRow).toBeDefined();
      expect(taskRow?.status).toBe("running");
      expect(taskRow?.version).toBe(1);

      // 3. Verify runEventsTable
      const eventRows = await dbCtx.db.select().from(runEventsTable).where(eq(runEventsTable.runId, rId));
      expect(eventRows).toHaveLength(2);

      // 4. Verify outboxEventsTable
      const outboxRows = await dbCtx.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.aggregateId, rId));
      expect(outboxRows).toHaveLength(2);

      const createdOutbox = outboxRows.find((r) => r.eventType === "run_created");
      expect(createdOutbox).toBeDefined();
      expect(createdOutbox?.status).toBe("pending");
      expect(createdOutbox?.attemptCount).toBe(0);
      expect(createdOutbox?.payload).toBeDefined();
      expect((createdOutbox?.payload as EventEnvelope).aggregateId).toBe(rId);

      const startedOutbox = outboxRows.find((r) => r.eventType === "task_started");
      expect(startedOutbox).toBeDefined();
      expect(startedOutbox?.status).toBe("pending");
      expect(startedOutbox?.attemptCount).toBe(0);
    });

    it("atomically updates task state AND inserts outbox_events in a single transaction during updateTaskState()", async () => {
      if (!dbCtx) return;

      const rId = `${testPrefix}-run-2`;
      const tId = `${testPrefix}-task-2`;
      const { run, events } = createSampleRun(rId, tId);

      await repo.save(run, events);

      const now = new Date().toISOString();
      const completionEvent: RunEvent = {
        id: eventId(`evt-completed-${tId}`),
        runId: run.id,
        type: "task_completed",
        severity: "success",
        timestamp: now,
        message: "Step completed successfully",
        taskId: taskId(tId),
        taskName: "Sample Step",
      };

      const updateRes = await repo.updateTaskState(
        taskId(tId),
        {
          status: "completed",
          completedAt: now,
          output: "Task output result",
        },
        1,
        completionEvent,
      );

      expect(updateRes.ok).toBe(true);
      if (!updateRes.ok) return;
      expect(updateRes.value.newVersion).toBe(2);

      // Verify task row was updated
      const [taskRow] = await dbCtx.db.select().from(tasksTable).where(eq(tasksTable.id, tId)).limit(1);
      expect(taskRow?.status).toBe("completed");
      expect(taskRow?.version).toBe(2);
      expect(taskRow?.output).toBe("Task output result");

      // Verify outbox record was written atomically
      const [outboxRow] = await dbCtx.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.id, completionEvent.id))
        .limit(1);

      expect(outboxRow).toBeDefined();
      expect(outboxRow?.eventType).toBe("task_completed");
      expect(outboxRow?.status).toBe("pending");
      expect(outboxRow?.aggregateId).toBe(rId);
      expect((outboxRow?.payload as EventEnvelope).data.type).toBe("task_completed");
    });

    it("rolls back transaction and writes ZERO outbox records upon OCC version conflict in updateTaskState()", async () => {
      if (!dbCtx) return;

      const rId = `${testPrefix}-run-3`;
      const tId = `${testPrefix}-task-3`;
      const { run, events } = createSampleRun(rId, tId);

      await repo.save(run, events);

      const conflictEvent: RunEvent = {
        id: eventId(`evt-conflict-${tId}`),
        runId: run.id,
        type: "task_completed",
        severity: "success",
        timestamp: new Date().toISOString(),
        message: "Conflict step",
        taskId: taskId(tId),
      };

      // Stale expectedVersion = 999 instead of actual 1
      const updateRes = await repo.updateTaskState(
        taskId(tId),
        { status: "completed" },
        999,
        conflictEvent,
      );

      expect(updateRes.ok).toBe(false);
      if (updateRes.ok) return;
      expect(updateRes.error.code).toBe("CONCURRENCY_CONFLICT");

      // Verify task remains in status 'running' and version 1
      const [taskRow] = await dbCtx.db.select().from(tasksTable).where(eq(tasksTable.id, tId)).limit(1);
      expect(taskRow?.status).toBe("running");
      expect(taskRow?.version).toBe(1);

      // Verify conflict event was NOT written to runEventsTable or outboxEventsTable
      const [outboxRow] = await dbCtx.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.id, conflictEvent.id))
        .limit(1);

      expect(outboxRow).toBeUndefined();
    });

    it("atomically marks lease expired AND inserts outbox_events in a single transaction in markTaskLeaseExpired()", async () => {
      if (!dbCtx) return;

      const rId = `${testPrefix}-run-4`;
      const tId = `${testPrefix}-task-4`;
      const { run, events } = createSampleRun(rId, tId);

      // Set lease in the past
      const pastLease = new Date(Date.now() - 10000).toISOString();
      const firstTask = run.tasks[0];
      if (firstTask) {
        firstTask.leaseUntil = pastLease;
      }
      await repo.save(run, events);

      const now = new Date();
      const expEvent: RunEvent = {
        id: eventId(`evt-lease-exp-${tId}`),
        runId: run.id,
        type: "task_lease_expired",
        severity: "warn",
        timestamp: now.toISOString(),
        message: "Worker lease expired",
        taskId: taskId(tId),
      };

      const marked = await repo.markTaskLeaseExpired(
        taskId(tId),
        1,
        now,
        expEvent,
      );

      expect(marked).toBe(true);

      // Verify task row
      const [taskRow] = await dbCtx.db.select().from(tasksTable).where(eq(tasksTable.id, tId)).limit(1);
      expect(taskRow?.status).toBe("running"); // preserved status per Phase 12B invariant
      expect(taskRow?.version).toBe(2);
      expect(taskRow?.leaseExpiredAt).not.toBeNull();

      // Verify outbox record
      const [outboxRow] = await dbCtx.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.id, expEvent.id))
        .limit(1);

      expect(outboxRow).toBeDefined();
      expect(outboxRow?.eventType).toBe("task_lease_expired");
      expect(outboxRow?.status).toBe("pending");
    });

    it("integrates TaskResultConsumer with atomic outbox persistence", async () => {
      if (!dbCtx) return;

      const rId = `${testPrefix}-run-5`;
      const tId = `${testPrefix}-task-5`;
      const { run, events } = createSampleRun(rId, tId);
      await repo.save(run, events);

      const consumer = new TaskResultConsumer({
        runRepository: repo,
      });

      const handled = await consumer.handleMessage({
        id: eventId(`res-${tId}`),
        specVersion: "1.0",
        type: "task_result",
        source: "aegis.worker",
        time: new Date().toISOString(),
        aggregateId: taskId(tId),
        aggregateType: "TaskResult",
        correlationId: rId,
        data: {
          taskId: taskId(tId),
          runId: runId(rId),
          assignmentId: assignmentId(`asgn-${tId}`),
          status: "SUCCEEDED",
          startedAt: new Date().toISOString(),
          output: { resultSummary: "Batch compute complete" },
          completedAt: new Date().toISOString(),
          workerId: workerId("worker-test-1"),
        },
      });

      expect(handled).toBe(true);

      // Verify task completed in DB
      const [taskRow] = await dbCtx.db.select().from(tasksTable).where(eq(tasksTable.id, tId)).limit(1);
      expect(taskRow?.status).toBe("completed");
      expect(taskRow?.version).toBe(2);

      // Verify task_completed outbox record was written
      const outboxRows = await dbCtx.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.aggregateId, rId));

      const completedRecord = outboxRows.find((r) => r.eventType === "task_completed");
      expect(completedRecord).toBeDefined();
      expect(completedRecord?.status).toBe("pending");
      expect((completedRecord?.payload as EventEnvelope).data.taskId).toBe(tId);
    });

    it("integrates TaskLeaseMonitor with atomic outbox persistence", async () => {
      if (!dbCtx) return;

      const rId = `${testPrefix}-run-6`;
      const tId = `${testPrefix}-task-6`;
      const { run, events } = createSampleRun(rId, tId);
      const firstTask = run.tasks[0];
      if (firstTask) {
        firstTask.leaseUntil = new Date(Date.now() - 5000).toISOString();
      }
      await repo.save(run, events);

      const monitor = new TaskLeaseMonitor({
        repository: repo,
      });

      const sweepResult = await monitor.sweepOnce(new Date());
      expect(sweepResult.checkedCandidates).toBe(1);
      expect(sweepResult.expiredMarked).toBe(1);

      // Verify task_lease_expired outbox record was written
      const outboxRows = await dbCtx.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.aggregateId, rId));

      const leaseExpRecord = outboxRows.find((r) => r.eventType === "task_lease_expired");
      expect(leaseExpRecord).toBeDefined();
      expect(leaseExpRecord?.status).toBe("pending");
      expect((leaseExpRecord?.payload as EventEnvelope).data.taskId).toBe(tId);
    });
  });
});
