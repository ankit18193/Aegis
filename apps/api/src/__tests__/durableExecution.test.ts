import * as net from "node:net";

import type { Run, TaskResultEnvelope } from "@aegis/contracts";
import { assignmentId, eventId, runId, taskId, workerId, workflowId } from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";
import { TaskResultConsumer } from "../dispatch/resultConsumer.js";
import { ConcurrencyConflictError, TerminalStateError } from "../domain/errors.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";
import { PostgresRunRepository } from "../repositories/postgresRunRepository.js";

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

const dbAvailable = await isDatabaseReachable();

describe("Phase 12A: Durable Execution Foundation & Crash Survival", () => {
  describe("In-Memory Contract Verification", () => {
    let repo: InMemoryRunRepository;

    beforeEach(() => {
      repo = new InMemoryRunRepository(true);
    });

    it("LOCK 1 & 4: updates durable task state with optimistic version control", async () => {
      const res = await repo.updateTaskState(
        taskId("task-104"),
        { status: "running", workerId: workerId("w-1") },
        1,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.newVersion).toBe(2);

      const conflictRes = await repo.updateTaskState(
        taskId("task-104"),
        { status: "completed" },
        1, // Stale version
      );
      expect(conflictRes.ok).toBe(false);
      if (!conflictRes.ok) {
        expect(conflictRes.error).toBeInstanceOf(ConcurrencyConflictError);
      }
    });

    it("LOCK 5: terminal state immutability rejects illegal transitions", async () => {
      await repo.updateTaskState(taskId("task-104"), { status: "running" }, 1);
      await repo.updateTaskState(taskId("task-104"), { status: "completed" }, 2);

      const res = await repo.updateTaskState(taskId("task-104"), { status: "running" }, 3);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBeInstanceOf(TerminalStateError);
      }
    });
  });

  describe.runIf(dbAvailable)("Live PostgreSQL Crash Survival Verification", () => {
    let ctx: DatabaseContext;
    let dbUrl: string;

    beforeAll(async () => {
      dbUrl = process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5433/aegis";
      ctx = createDatabaseContext({ url: dbUrl, poolMin: 1, poolMax: 5 });
      await runMigrations(ctx.db);
    });

    afterAll(async () => {
      await ctx.close();
    });

    it("State survives simulated process termination and cold restart", async () => {
      // 1. Process A: Initialize repo, create run with task
      const repoA = new PostgresRunRepository(ctx);
      await repoA.resetToDefaults();

      const testRun: Run = {
        id: runId("run-crash-test"),
        goal: "Verify process crash resilience",
        status: "running",
        progress: 0,
        workflow: { id: workflowId("wf-crash"), name: "Crash Workflow", tasks: [] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [
          {
            id: taskId("task-durable-1"),
            name: "Durable Computation",
            status: "queued",
            attemptCount: 0,
            version: 1,
            description: "Must survive crash",
          },
        ],
      };

      await repoA.save(testRun);

      // Advance task to running with assigned worker
      const startRes = await repoA.updateTaskState(
        taskId("task-durable-1"),
        {
          status: "running",
          workerId: workerId("worker-resilient-01"),
          startedAt: "2026-10-05T12:00:00.000Z",
        },
        1,
      );
      expect(startRes.ok).toBe(true);

      // 2. SIMULATE SUDDEN PROCESS CRASH
      // Discard repoA completely and close the connection pool
      await ctx.close();

      // 3. SIMULATE PROCESS RESTART
      // Cold boot: Brand new connection pool and fresh repository instance
      const freshCtx = createDatabaseContext({ url: dbUrl, poolMin: 1, poolMax: 3 });
      const repoB = new PostgresRunRepository(freshCtx);

      // Verify state was NOT lost
      const restoredRun = await repoB.findById(runId("run-crash-test"));
      expect(restoredRun).not.toBeNull();
      const restoredTask = restoredRun?.tasks.find((t) => t.id === "task-durable-1");
      expect(restoredTask).toBeDefined();
      expect(restoredTask?.status).toBe("running");
      expect(restoredTask?.workerId).toBe("worker-resilient-01");
      expect(restoredTask?.version).toBe(2);
      expect(restoredTask?.startedAt).toBe("2026-10-05T12:00:00.000Z");

      // 4. Ingest task completion via TaskResultConsumer in fresh process
      const consumer = new TaskResultConsumer({ runRepository: repoB });
      const completionEnvelope: TaskResultEnvelope = {
        id: eventId("evt-crash-complete"),
        type: "task_result",
        source: "aegis/worker/worker-resilient-01",
        specVersion: "1.0",
        time: "2026-10-05T12:10:00.000Z",
        aggregateId: taskId("task-durable-1"),
        aggregateType: "TaskResult",
        correlationId: "corr-crash-01",
        data: {
          taskId: taskId("task-durable-1"),
          runId: runId("run-crash-test"),
          assignmentId: assignmentId("asgn-crash-01"),
          workerId: workerId("worker-resilient-01"),
          status: "SUCCEEDED",
          startedAt: "2026-10-05T12:00:00.000Z",
          completedAt: "2026-10-05T12:10:00.000Z",
          output: { success: true, processedBytes: 1048576 },
        },
      };

      const handled = await consumer.handleMessage(completionEnvelope);
      expect(handled).toBe(true);

      // 5. Final state in PostgreSQL is completed with version 3
      const finalRun = await repoB.findById(runId("run-crash-test"));
      const finalTask = finalRun?.tasks.find((t) => t.id === "task-durable-1");
      expect(finalTask?.status).toBe("completed");
      expect(finalTask?.version).toBe(3);
      expect(finalTask?.output).toContain("processedBytes");

      // Cleanup fresh connection
      await freshCtx.close();

      // Restore outer ctx for afterAll
      ctx = createDatabaseContext({ url: dbUrl, poolMin: 1, poolMax: 1 });
    });

    it("LOCK 9: Parallel DAG tasks update independently without row-level interference", async () => {
      const repo = new PostgresRunRepository(ctx);
      await repo.resetToDefaults();

      const dagRun: Run = {
        id: runId("run-dag-parallel"),
        goal: "Verify parallel task updates",
        status: "running",
        progress: 0,
        workflow: { id: workflowId("wf-dag"), name: "DAG Workflow", tasks: [] },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [
          {
            id: taskId("task-branch-a"),
            name: "Branch A",
            description: "Branch A work",
            status: "queued",
            attemptCount: 0,
            version: 1,
          },
          {
            id: taskId("task-branch-b"),
            name: "Branch B",
            description: "Branch B work",
            status: "queued",
            attemptCount: 0,
            version: 1,
          },
        ],
      };

      await repo.save(dagRun);

      // Both branches transition concurrently in PostgreSQL
      const [resA, resB] = await Promise.all([
        repo.updateTaskState(
          taskId("task-branch-a"),
          { status: "running", workerId: workerId("worker-a") },
          1,
        ),
        repo.updateTaskState(
          taskId("task-branch-b"),
          { status: "running", workerId: workerId("worker-b") },
          1,
        ),
      ]);

      expect(resA.ok).toBe(true);
      expect(resB.ok).toBe(true);
      if (resA.ok) expect(resA.value.newVersion).toBe(2);
      if (resB.ok) expect(resB.value.newVersion).toBe(2);

      // Complete Branch A while Branch B remains running
      const completeA = await repo.updateTaskState(
        taskId("task-branch-a"),
        { status: "completed", output: "Branch A Success" },
        2,
      );
      expect(completeA.ok).toBe(true);
      if (completeA.ok) expect(completeA.value.newVersion).toBe(3);

      const checkRun = await repo.findById(runId("run-dag-parallel"));
      const tA = checkRun?.tasks.find((t) => t.id === "task-branch-a");
      const tB = checkRun?.tasks.find((t) => t.id === "task-branch-b");

      expect(tA?.status).toBe("completed");
      expect(tA?.version).toBe(3);
      expect(tB?.status).toBe("running");
      expect(tB?.version).toBe(2);
    });
  });
});
