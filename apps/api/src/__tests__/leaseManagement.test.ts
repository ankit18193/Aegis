import * as net from "node:net";

import type { Run, Task } from "@aegis/contracts";
import { runId, taskId, workerId, workflowId } from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";
import { TaskLeaseMonitor } from "../dispatch/leaseMonitor.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";
import { PostgresRunRepository } from "../repositories/postgresRunRepository.js";
import type { IRunRepository } from "../repositories/runRepository.js";

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

function createRunningTestRun(rId: string, tId: string, wId: string, initialVersion = 1): Run {
  const t: Task = {
    id: taskId(tId),
    name: "Execution Unit 1",
    status: "running",
    description: "Lease E2E test task",
    attemptCount: 1,
    worker: workerId(wId),
    workerId: workerId(wId),
    version: initialVersion,
    startedAt: new Date().toISOString(),
  };

  return {
    id: runId(rId),
    goal: "Verify lease ownership and expiration lifecycle",
    status: "running",
    progress: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Lease Workflow",
      tasks: [t],
    },
    tasks: [t],
  };
}

function runLeaseLifecycleScenarios(getRepo: () => IRunRepository, prefix: string): void {
  it("Scenario 1: Happy Path Ownership Lifecycle (Acquire -> Renew -> Complete -> Release)", async () => {
    const repo = getRepo();
    const rId = `${prefix}-r1`;
    const tId = `${prefix}-t1`;
    const wId = `${prefix}-w1`;

    await repo.save(createRunningTestRun(rId, tId, wId, 1));

    // 1. Worker acquires lease
    const acqRes = await repo.acquireTaskLease(taskId(tId), workerId(wId), 30000, 1);
    expect(acqRes.ok).toBe(true);
    if (!acqRes.ok) return;

    const lease1 = acqRes.value;
    expect(lease1.taskId).toBe(taskId(tId));
    expect(lease1.workerId).toBe(workerId(wId));
    expect(lease1.version).toBe(2);
    expect(new Date(lease1.leaseUntil).getTime()).toBeGreaterThan(Date.now());

    // 2. Worker renews lease
    const renewRes = await repo.renewTaskLease(
      taskId(tId),
      lease1.leaseId,
      workerId(wId),
      30000,
      lease1.version,
    );
    expect(renewRes.ok).toBe(true);
    if (!renewRes.ok) return;

    const lease2 = renewRes.value;
    expect(lease2.version).toBe(3);
    expect(new Date(lease2.leaseUntil).getTime()).toBeGreaterThan(
      new Date(lease1.leaseUntil).getTime(),
    );

    // 3. Worker completes execution
    const completeRes = await repo.updateTaskState(
      taskId(tId),
      { status: "completed", output: "success result" },
      lease2.version,
    );
    expect(completeRes.ok).toBe(true);
    if (!completeRes.ok) return;
    expect(completeRes.value.newVersion).toBe(4);

    // 4. Worker explicitly releases lease
    const releaseRes = await repo.releaseTaskLease(
      taskId(tId),
      lease1.leaseId,
      workerId(wId),
      completeRes.value.newVersion,
    );
    expect(releaseRes.ok).toBe(true);

    // 5. Verify authoritative database state
    const runAfter = await repo.findById(runId(rId));
    const taskAfter = runAfter?.tasks.find((t) => t.id === taskId(tId));
    expect(taskAfter).toBeDefined();
    expect(taskAfter?.status).toBe("completed");
    expect(taskAfter?.leaseId).toBeUndefined();
    expect(taskAfter?.leaseUntil).toBeUndefined();
    expect(taskAfter?.version).toBe(5);
  });

  it("Scenario 2: Worker Crash / Partition -> Lease Expiration -> Status Preservation & Audit Event", async () => {
    const repo = getRepo();
    const rId = `${prefix}-r2`;
    const tId = `${prefix}-t2`;
    const wId = `${prefix}-w2`;

    await repo.save(createRunningTestRun(rId, tId, wId, 1));

    // Worker acquires a short 2-second lease
    const acqRes = await repo.acquireTaskLease(taskId(tId), workerId(wId), 2000, 1);
    expect(acqRes.ok).toBe(true);

    // Worker crashes / partition occurs: no renewals
    // Advance time 5 seconds
    const cutoff = new Date(Date.now() + 5000);

    const monitor = new TaskLeaseMonitor({
      repository: repo,
    });

    const sweepRes = await monitor.sweepOnce(cutoff);
    expect(sweepRes.checkedCandidates).toBe(1);
    expect(sweepRes.expiredMarked).toBe(1);
    expect(sweepRes.conflictsSkipped).toBe(0);

    // CRITICAL INVARIANT: Task remains 'running'! Status is NOT 'failed' (Phase 12D handles recovery)
    const runAfter = await repo.findById(runId(rId));
    const taskAfter = runAfter?.tasks.find((t) => t.id === taskId(tId));
    expect(taskAfter).toBeDefined();
    expect(taskAfter?.status).toBe("running");
    expect(taskAfter?.workerId).toBe(workerId(wId));
    expect(taskAfter?.leaseExpiredAt).toBe(cutoff.toISOString());
    expect(taskAfter?.version).toBe(3);

    // Verify timeline audit event
    const events = await repo.findEvents(runId(rId));
    const expiredEvent = events.find((e) => e.type === "task_lease_expired");
    expect(expiredEvent).toBeDefined();
    expect(expiredEvent?.severity).toBe("warn");
    expect(expiredEvent?.taskId).toBe(taskId(tId));
    expect(expiredEvent?.worker ?? expiredEvent?.metadata?.["worker"]).toBe(workerId(wId));
  });

  it("Scenario 3: Zombie Worker Late Renewal Rejection", async () => {
    const repo = getRepo();
    const rId = `${prefix}-r3`;
    const tId = `${prefix}-t3`;
    const wId = `${prefix}-w3`;

    await repo.save(createRunningTestRun(rId, tId, wId, 1));

    const acqRes = await repo.acquireTaskLease(taskId(tId), workerId(wId), 2000, 1);
    expect(acqRes.ok).toBe(true);
    if (!acqRes.ok) return;

    // Lease expires
    const cutoff = new Date(Date.now() + 5000);
    const marked = await repo.markTaskLeaseExpired(taskId(tId), 2, cutoff);
    expect(marked).toBe(true);

    // Zombie worker awakens and attempts renewal with its old lease
    const renewRes = await repo.renewTaskLease(
      taskId(tId),
      acqRes.value.leaseId,
      workerId(wId),
      30000,
      2,
    );
    expect(renewRes.ok).toBe(false);
    if (!renewRes.ok) {
      expect(renewRes.error.code === "LEASE_EXPIRED" || renewRes.error.code === "CONCURRENCY_CONFLICT").toBe(true);
    }
  });

  it("Scenario 4: Concurrent Monitor Race Lockout (Optimistic OCC)", async () => {
    const repo = getRepo();
    const rId = `${prefix}-r4`;
    const tId = `${prefix}-t4`;
    const wId = `${prefix}-w4`;

    await repo.save(createRunningTestRun(rId, tId, wId, 1));

    await repo.acquireTaskLease(taskId(tId), workerId(wId), 1000, 1);

    const cutoff = new Date(Date.now() + 3000);

    // Two monitor sweeps racing concurrently with same expectedVersion = 2
    const [resultA, resultB] = await Promise.all([
      repo.markTaskLeaseExpired(taskId(tId), 2, cutoff),
      repo.markTaskLeaseExpired(taskId(tId), 2, cutoff),
    ]);

    // Exactly one wins, one loses
    const successes = [resultA, resultB].filter((r) => r).length;
    const failures = [resultA, resultB].filter((r) => !r).length;

    expect(successes).toBe(1);
    expect(failures).toBe(1);

    // Version was incremented exactly once (2 -> 3)
    const runAfter = await repo.findById(runId(rId));
    const taskAfter = runAfter?.tasks.find((t) => t.id === taskId(tId));
    expect(taskAfter?.version).toBe(3);
  });
}

describe("Phase 12B: Worker Heartbeats & Lease Management E2E Integration", () => {
  describe("InMemoryRunRepository Verification", () => {
    let repo: InMemoryRunRepository;

    beforeEach(() => {
      repo = new InMemoryRunRepository(false);
    });

    runLeaseLifecycleScenarios(() => repo, "mem");
  });

  describe.runIf(dbAvailable)("PostgreSQL Authoritative Lease Verification", () => {
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

    runLeaseLifecycleScenarios(() => new PostgresRunRepository(ctx), "pg");

    it("Scenario 5: Process Cold Restart Resilience across Lease Expiration", async () => {
      // 1. Process 1: Create run, acquire lease, crash
      const repo1 = new PostgresRunRepository(ctx);
      const rId = "pg-cold-r5";
      const tId = "pg-cold-t5";
      const wId = "pg-cold-w5";

      await repo1.save(createRunningTestRun(rId, tId, wId, 1));
      const acqRes = await repo1.acquireTaskLease(taskId(tId), workerId(wId), 2000, 1);
      expect(acqRes.ok).toBe(true);

      // 2. Process 2: Simulating new control plane instance after reboot
      const repo2 = new PostgresRunRepository(ctx);
      const cutoff = new Date(Date.now() + 5000);

      const monitor = new TaskLeaseMonitor({
        repository: repo2,
      });

      const sweepRes = await monitor.sweepOnce(cutoff);
      expect(sweepRes.expiredMarked).toBeGreaterThanOrEqual(1);

      // 3. Process 3: Simulating worker or API querying post-expiration
      const repo3 = new PostgresRunRepository(ctx);
      const runAfter = await repo3.findById(runId(rId));
      const taskAfter = runAfter?.tasks.find((t) => t.id === taskId(tId));

      expect(taskAfter).toBeDefined();
      expect(taskAfter?.status).toBe("running"); // STRICT: remains running
      expect(taskAfter?.workerId).toBe(workerId(wId));
      expect(taskAfter?.leaseExpiredAt).toBeDefined();
      expect(taskAfter?.version).toBe(3);
    });
  });
});
