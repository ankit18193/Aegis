import * as net from "node:net";

import type { Run, Task } from "@aegis/contracts";
import { leaseId, runId, taskId, workerId, workflowId } from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";

import { InMemoryRunRepository } from "./inMemoryRunRepository.js";
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

function createRunningTestRun(rId: string, tId: string, wId: string, initialVersion = 1): Run {
  const t: Task = {
    id: taskId(tId),
    name: "Execution Unit 1",
    status: "running",
    description: "Lease integration test task",
    attemptCount: 1,
    worker: workerId(wId),
    workerId: workerId(wId),
    version: initialVersion,
    startedAt: new Date().toISOString(),
  };

  return {
    id: runId(rId),
    goal: "Test lease persistence and ownership",
    status: "running",
    progress: 25,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Lease Pipeline",
      tasks: [t],
    },
    tasks: [t],
  };
}

describe("Durable Task Lease Persistence (Phase 12B — Commit 2)", () => {
  const dbAvailablePromise = isDatabaseReachable();

  describe("InMemoryRunRepository Lease Implementation", () => {
    let repo: InMemoryRunRepository;

    beforeEach(async () => {
      repo = new InMemoryRunRepository(false);
      const testRun = createRunningTestRun("run-lease-mem-1", "task-lease-mem-1", "worker-alpha", 1);
      await repo.save(testRun);
    });

    executeLeaseTests(() => repo, "task-lease-mem-1", "run-lease-mem-1");
  });

  describe("PostgresRunRepository Real PostgreSQL Integration", () => {
    let ctx: DatabaseContext | undefined;
    let repo: PostgresRunRepository;
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
      repo = new PostgresRunRepository(ctx);
    }, 30000);

    beforeEach(async () => {
      if (!dbAvailable) return;
      await repo.resetToDefaults();
      const testRun = createRunningTestRun("run-lease-pg-1", "task-lease-pg-1", "worker-alpha", 1);
      await repo.save(testRun);
    });

    afterAll(async () => {
      await ctx?.close();
    });

    it("verifies real PostgreSQL execution when database is reachable", async () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }
      const run = await repo.findById(runId("run-lease-pg-1"));
      expect(run).not.toBeNull();
      expect(run?.tasks[0]?.id).toBe(taskId("task-lease-pg-1"));
    });

    executeLeaseTests(() => repo, "task-lease-pg-1", "run-lease-pg-1", () => dbAvailable);
  });
});

function executeLeaseTests(
  getRepo: () => IRunRepository,
  targetTaskId: string,
  targetRunId: string,
  shouldRun?: () => boolean,
) {
  const tId = taskId(targetTaskId);
  const rId = runId(targetRunId);
  const workerAlpha = workerId("worker-alpha");
  const workerBeta = workerId("worker-beta");

  it("acquires lease on a running task and increments version", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const result = await repo.acquireTaskLease(tId, workerAlpha, 30000, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.taskId).toBe(tId);
    expect(result.value.workerId).toBe(workerAlpha);
    expect(result.value.version).toBe(2);
    expect(result.value.leaseId).toBeDefined();

    // Verify row state
    const run = await repo.findById(rId);
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task).toBeDefined();
    expect(task?.version).toBe(2);
    expect(task?.leaseId).toBe(result.value.leaseId);
    expect(task?.leaseUntil).toBeDefined();
    expect(task?.leaseExpiredAt).toBeUndefined();
  });

  it("rejects lease acquisition when expectedVersion does not match", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const result = await repo.acquireTaskLease(tId, workerAlpha, 30000, 999);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("CONCURRENCY_CONFLICT");
  });

  it("rejects lease acquisition by another worker while unexpired", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const acq = await repo.acquireTaskLease(tId, workerAlpha, 30000, 1);
    expect(acq.ok).toBe(true);

    const conflict = await repo.acquireTaskLease(tId, workerBeta, 30000, 2);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;

    expect(conflict.error.code).toBe("LEASE_OWNERSHIP_CONFLICT");
  });

  it("renews an active lease successfully with matching leaseId and version", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const acq = await repo.acquireTaskLease(tId, workerAlpha, 30000, 1);
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;

    const renewResult = await repo.renewTaskLease(tId, acq.value.leaseId, workerAlpha, 45000, 2);
    expect(renewResult.ok).toBe(true);
    if (!renewResult.ok) return;

    expect(renewResult.value.version).toBe(3);
    expect(renewResult.value.leaseId).toBe(acq.value.leaseId);

    const run = await repo.findById(rId);
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.version).toBe(3);
  });

  it("rejects lease renewal with stale leaseId", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const acq = await repo.acquireTaskLease(tId, workerAlpha, 30000, 1);
    expect(acq.ok).toBe(true);

    const staleLease = leaseId("lease-stale-999");
    const renewResult = await repo.renewTaskLease(tId, staleLease, workerAlpha, 30000, 2);
    expect(renewResult.ok).toBe(false);
    if (renewResult.ok) return;

    expect(renewResult.error.code).toBe("STALE_LEASE");
  });

  it("releases active lease and clears leaseId and leaseUntil", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const acq = await repo.acquireTaskLease(tId, workerAlpha, 30000, 1);
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;

    const releaseResult = await repo.releaseTaskLease(tId, acq.value.leaseId, workerAlpha, 2);
    expect(releaseResult.ok).toBe(true);

    const run = await repo.findById(rId);
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.version).toBe(3);
    expect(task?.leaseId).toBeUndefined();
    expect(task?.leaseUntil).toBeUndefined();
  });

  it("getExpiredTaskLeases is strictly read-only and returns candidate tasks", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    // Acquire lease expiring in 100ms
    const acq = await repo.acquireTaskLease(tId, workerAlpha, 100, 1);
    expect(acq.ok).toBe(true);

    // Wait 150ms for lease to pass cutoff
    await new Promise((resolve) => setTimeout(resolve, 150));

    const cutoff = new Date();
    const expiredList = await repo.getExpiredTaskLeases(cutoff);
    expect(expiredList.some((t) => t.id === tId)).toBe(true);

    // Verify read-only: version unchanged at 2
    const run = await repo.findById(rId);
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.version).toBe(2);
    expect(task?.leaseExpiredAt).toBeUndefined();
  });

  it("markTaskLeaseExpired performs atomic mutation and preserves 'running' status (12D invariant)", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    // Acquire lease expiring in 100ms
    const acq = await repo.acquireTaskLease(tId, workerAlpha, 100, 1);
    expect(acq.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const expiredAt = new Date();
    // Monitor 1 marks expired
    const marked1 = await repo.markTaskLeaseExpired(tId, 2, expiredAt);
    expect(marked1).toBe(true);

    // Monitor 2 racing with old version 2 returns false
    const marked2 = await repo.markTaskLeaseExpired(tId, 2, expiredAt);
    expect(marked2).toBe(false);

    // Monitor 3 with new version 3 also returns false because leaseExpiredAt IS NOT NULL
    const marked3 = await repo.markTaskLeaseExpired(tId, 3, expiredAt);
    expect(marked3).toBe(false);

    // Verify task row invariant: status REMAINS running! Not failed!
    const run = await repo.findById(rId);
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe(workerAlpha);
    expect(task?.leaseExpiredAt).toBeDefined();
    expect(task?.version).toBe(3);
  });
}
