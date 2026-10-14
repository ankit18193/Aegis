/**
 * Phase 12E — Milestone 1: Durable Execution Failure Boundaries Test Suite.
 *
 * Establishes deterministic fault-injection tests covering the core failure boundaries:
 * 1. Process crash gap: Database commits outbox record, process dies before Kafka publication.
 * 2. Publisher crash gap: Kafka publication succeeds, publisher dies before marking published (at-least-once replay).
 * 3. Expired lease result rejection: Worker submits result after lease expiration but before reassignment (Lock 6).
 * 4. Duplicate/delayed result delivery: Repeated deliveries of same result do not corrupt state or re-bump versions.
 * 5. Concurrent coordinator contention: Multiple recovery sweeps do not double-increment attemptCount or mutate versions.
 * 6. Graceful shutdown drain: OutboxPublisher and OrphanRecoveryCoordinator drain in-flight sweeps cleanly on stop().
 */

import * as net from "node:net";

import type {
  EventEnvelope,
  EventPublishErrorContract,
  EventPublishResult,
  IEventPublisher,
  Run,
  Task,
  TaskResultEnvelope,
  WorkerDescriptor,
} from "@aegis/contracts";
import {
  assignmentId,
  err,
  eventId,
  ok,
  outboxEventId,
  runId,
  taskId,
  workerId,
  workflowId,
  type Result,
} from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";
import { OrphanRecoveryCoordinator } from "../dispatch/recoveryCoordinator.js";
import { TaskResultConsumer } from "../dispatch/resultConsumer.js";
import { DeterministicWorkerSelector } from "../dispatch/workerSelector.js";
import { OutboxPublisher } from "../events/outboxPublisher.js";
import { InMemoryWorkerRegistry } from "../presence/workerRegistry.js";
import { InMemoryOutboxRepository } from "../repositories/inMemoryOutboxRepository.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";
import type { CreateOutboxRecord, IOutboxRepository } from "../repositories/outboxRepository.js";
import { PostgresOutboxRepository } from "../repositories/postgresOutboxRepository.js";
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

class FaultInjectablePublisher implements IEventPublisher {
  public publishedBatches: { envelopes: EventEnvelope[]; topic?: string | undefined }[] = [];
  public failNextPublish = false;
  public delayMs = 0;

  publish(
    envelope: EventEnvelope,
    topic?: string,
  ): Promise<Result<EventPublishResult, EventPublishErrorContract>> {
    return this.publishBatch([envelope], topic).then((res) => {
      if (!res.ok) return err(res.error);
      const first = res.value[0];
      return first ? ok(first) : err({ code: "BROKER_UNAVAILABLE", message: "No result" });
    });
  }

  async publishBatch(
    envelopes: readonly EventEnvelope[],
    topic?: string,
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    if (this.failNextPublish) {
      this.failNextPublish = false;
      return err({
        code: "BROKER_UNAVAILABLE",
        message: "Simulated transient broker disconnect",
      });
    }

    this.publishedBatches.push({ envelopes: [...envelopes], topic });
    const results: EventPublishResult[] = envelopes.map((e, idx) => ({
      success: true,
      topic: topic ?? "aegis.events",
      partition: 0,
      offset: String(idx),
      messageId: e.id,
    }));
    return ok(results);
  }
}

function createWorkerDescriptor(
  id: string,
  activeTaskCount = 0,
  maxConcurrentTasks = 5,
): WorkerDescriptor {
  const now = new Date().toISOString();
  return {
    workerId: workerId(id),
    presenceState: "HEALTHY",
    lifecycleState: "ready",
    capabilities: {
      taskTypes: ["*"],
      tools: [],
      maxConcurrency: maxConcurrentTasks,
    },
    activeTaskCount,
    maxConcurrentTasks,
    lastHeartbeatAt: now,
    registeredAt: now,
  };
}

function createRunningRun(
  rId: string,
  tId: string,
  wId: string,
  opts?: {
    leaseExpiredAt?: string | undefined;
    leaseUntil?: string | undefined;
    version?: number | undefined;
    attemptCount?: number | undefined;
  },
): Run {
  const nowIso = new Date().toISOString();
  const t: Task = {
    id: taskId(tId),
    runId: runId(rId),
    name: "Boundary Unit",
    status: "running",
    description: "Failure boundary task",
    attemptCount: opts?.attemptCount ?? 1,
    worker: workerId(wId),
    workerId: workerId(wId),
    version: opts?.version ?? 2,
    leaseId: "lease-boundary-1",
    leaseUntil: opts?.leaseUntil ?? new Date(Date.now() + 30000).toISOString(),
    leaseExpiredAt: opts?.leaseExpiredAt,
    startedAt: nowIso,
  };

  return {
    id: runId(rId),
    goal: "Verify durable execution failure boundaries",
    status: "running",
    progress: 30,
    createdAt: nowIso,
    updatedAt: nowIso,
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Boundary Workflow",
      tasks: [t],
    },
    tasks: [t],
  };
}

function runFailureBoundaryTests(
  getRunRepo: () => IRunRepository,
  getOutboxRepo: () => IOutboxRepository,
  prefix: string,
): void {
  let workerRegistry: InMemoryWorkerRegistry;
  let workerSelector: DeterministicWorkerSelector;

  beforeEach(() => {
    workerRegistry = new InMemoryWorkerRegistry();
    workerSelector = new DeterministicWorkerSelector();
  });

  it("Boundary 1: Process crash after DB commit before Kafka send retains pending outbox records", async () => {
    const outboxRepo = getOutboxRepo();
    const eventPublisher = new FaultInjectablePublisher();

    // 1. Simulate DB commit with outbox record
    const record: CreateOutboxRecord = {
      id: outboxEventId(`${prefix}-outbox-crash-1`),
      aggregateId: "run-crash-1",
      aggregateType: "ExecutionRun",
      eventType: "task_assigned",
      topic: "aegis.tasks.assign.worker-test",
      payload: {
        id: eventId("evt-crash-1"),
        type: "task_assigned",
        source: "aegis.dispatch",
        specVersion: "1.0",
        time: new Date().toISOString(),
        aggregateId: "task-crash-1",
        aggregateType: "TaskAssignment",
        correlationId: "run-crash-1",
        data: { message: "Task assigned before crash" },
      },
    };

    await outboxRepo.insert([record]);
    expect(await outboxRepo.getPendingCount()).toBe(1);

    // 2. Control plane crashes and restarts with fresh OutboxPublisher
    const restartedPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher,
      defaultTopic: "aegis.events",
    });

    const sweepResult = await restartedPublisher.sweepOnce();
    expect(sweepResult.publishedCount).toBe(1);
    expect(eventPublisher.publishedBatches).toHaveLength(1);
    expect(eventPublisher.publishedBatches[0]?.topic).toBe("aegis.tasks.assign.worker-test");
    expect(await outboxRepo.getPendingCount()).toBe(0);
  });

  it("Boundary 2: Outbox lock expiry allows recovery after publisher crash mid-flight", async () => {
    const outboxRepo = getOutboxRepo();
    const eventPublisher = new FaultInjectablePublisher();

    const record: CreateOutboxRecord = {
      id: outboxEventId(`${prefix}-outbox-midflight-1`),
      aggregateId: "run-midflight-1",
      aggregateType: "ExecutionRun",
      eventType: "task_completed",
      payload: {
        id: eventId("evt-midflight-1"),
        type: "task_completed",
        source: "aegis.api",
        specVersion: "1.0",
        time: new Date().toISOString(),
        aggregateId: "run-midflight-1",
        aggregateType: "ExecutionRun",
        correlationId: "run-midflight-1",
        data: { status: "completed" },
      },
    };

    await outboxRepo.insert([record]);

    // Publisher claims with 100ms lock duration, then simulated crash occurs
    const claimed = await outboxRepo.claimPending({
      batchSize: 10,
      lockDurationMs: 100,
      workerId: "crashed-worker-instance",
    });
    expect(claimed).toHaveLength(1);

    // Immediately, other workers cannot claim it
    const concurrentClaim = await outboxRepo.claimPending({
      batchSize: 10,
      lockDurationMs: 1000,
      workerId: "surviving-worker-instance",
    });
    expect(concurrentClaim).toHaveLength(0);

    // Wait 150ms for lock to expire
    await new Promise((r) => setTimeout(r, 150));

    // After lock expiration, surviving publisher claims and delivers it
    const restartedPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher,
    });

    const sweepResult = await restartedPublisher.sweepOnce();
    expect(sweepResult.publishedCount).toBe(1);
    expect(await outboxRepo.getPendingCount()).toBe(0);
  });

  it("Boundary 3: Stale result rejected from superseded worker after lease expiration and reassignment (Lock 6 & 9)", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-stale-lease-r1`;
    const tId = `${prefix}-stale-lease-t1`;
    const wIdOld = `${prefix}-worker-A`;
    const wIdNew = `${prefix}-worker-B`;

    // Task was running on worker-A, but lease expired
    const expiredIso = new Date(Date.now() - 5000).toISOString();
    await runRepo.save(createRunningRun(rId, tId, wIdOld, { leaseExpiredAt: expiredIso }));

    workerRegistry.register(createWorkerDescriptor(wIdOld, 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, 0, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });
    const recoveryRes = await coordinator.recoverOrphan(taskId(tId));
    expect(recoveryRes.ok).toBe(true);

    const consumer = new TaskResultConsumer({ runRepository: runRepo });
    const resultEnvelope: TaskResultEnvelope = {
      id: eventId(`evt-res-stale-${tId}`),
      type: "task_result",
      source: `aegis/worker/${wIdOld}`,
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: taskId(tId),
      aggregateType: "TaskResult",
      correlationId: `corr-${rId}`,
      data: {
        taskId: taskId(tId),
        runId: runId(rId),
        assignmentId: assignmentId(`asgn-${tId}`),
        workerId: workerId(wIdOld),
        status: "SUCCEEDED",
        startedAt: new Date(Date.now() - 20000).toISOString(),
        completedAt: new Date().toISOString(),
        output: { result: "Late output from expired worker" },
      },
    };

    // Stale result from dead/superseded worker MUST be rejected
    const handled = await consumer.handleMessage(resultEnvelope);
    expect(handled).toBe(false);

    // Verify task is still running under worker-B and uncorrupted
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe(workerId(wIdNew));
    expect(task?.output).toBeUndefined();
  });

  it("Boundary 4: Duplicate task result delivery is safely ignored without re-bumping versions", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-dup-res-r1`;
    const tId = `${prefix}-dup-res-t1`;
    const wId = `${prefix}-worker-A`;

    await runRepo.save(createRunningRun(rId, tId, wId, { version: 2 }));

    const consumer = new TaskResultConsumer({ runRepository: runRepo });
    const resultEnvelope: TaskResultEnvelope = {
      id: eventId(`evt-res-dup-${tId}`),
      type: "task_result",
      source: `aegis/worker/${wId}`,
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: taskId(tId),
      aggregateType: "TaskResult",
      correlationId: `corr-${rId}`,
      data: {
        taskId: taskId(tId),
        runId: runId(rId),
        assignmentId: assignmentId(`asgn-${tId}`),
        workerId: workerId(wId),
        status: "SUCCEEDED",
        startedAt: new Date(Date.now() - 10000).toISOString(),
        completedAt: new Date().toISOString(),
        output: { result: "Success result" },
      },
    };

    // First delivery succeeds
    const firstHandled = await consumer.handleMessage(resultEnvelope);
    expect(firstHandled).toBe(true);

    const runAfterFirst = await runRepo.findById(runId(rId));
    const taskAfterFirst = runAfterFirst?.tasks.find((t) => t.id === tId);
    expect(taskAfterFirst?.status).toBe("completed");
    expect(taskAfterFirst?.version).toBe(3);

    // Duplicate redelivery: gracefully rejected, version unchanged
    const secondHandled = await consumer.handleMessage(resultEnvelope);
    expect(secondHandled).toBe(false);

    const runAfterSecond = await runRepo.findById(runId(rId));
    const taskAfterSecond = runAfterSecond?.tasks.find((t) => t.id === tId);
    expect(taskAfterSecond?.status).toBe("completed");
    expect(taskAfterSecond?.version).toBe(3);
  });

  it("Boundary 5: Repeated recovery sweeps do not duplicate assignments or inflate attempt count", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-repeat-sweep-r1`;
    const tId = `${prefix}-repeat-sweep-t1`;
    const wIdOld = `${prefix}-worker-old`;
    const wIdNew = `${prefix}-worker-new`;

    const expiredIso = new Date(Date.now() - 5000).toISOString();
    await runRepo.save(createRunningRun(rId, tId, wIdOld, { leaseExpiredAt: expiredIso, version: 2 }));

    workerRegistry.register(createWorkerDescriptor(wIdOld, 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, 0, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    // Sweep 1: Finds orphan, reassigns to worker-new, bumps attemptCount 1 -> 2, version 2 -> 3
    const sweep1 = await coordinator.sweepOrphans();
    expect(sweep1.ok).toBe(true);
    if (!sweep1.ok) return;
    expect(sweep1.value.reassignedCount).toBe(1);

    // Sweep 2: Runs immediately. Task is no longer orphaned (leaseExpiredAt was cleared).
    const sweep2 = await coordinator.sweepOrphans();
    expect(sweep2.ok).toBe(true);
    if (!sweep2.ok) return;
    expect(sweep2.value.scannedCount).toBe(0);
    expect(sweep2.value.reassignedCount).toBe(0);

    // Verify task state remains stable at attempt 2 and version 3
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.attemptCount).toBe(2);
    expect(task?.version).toBe(3);
    expect(task?.workerId).toBe(workerId(wIdNew));
  });

  it("Boundary 6: OutboxPublisher stop() drains in-flight sweep batch without loss", async () => {
    const outboxRepo = getOutboxRepo();
    const eventPublisher = new FaultInjectablePublisher();
    eventPublisher.delayMs = 50; // Slow Kafka transmission

    const record: CreateOutboxRecord = {
      id: outboxEventId(`${prefix}-outbox-drain-1`),
      aggregateId: "run-drain-1",
      aggregateType: "ExecutionRun",
      eventType: "task_completed",
      payload: {
        id: eventId("evt-drain-1"),
        type: "task_completed",
        source: "aegis.api",
        specVersion: "1.0",
        time: new Date().toISOString(),
        aggregateId: "run-drain-1",
        aggregateType: "ExecutionRun",
        correlationId: "run-drain-1",
        data: { status: "completed" },
      },
    };

    await outboxRepo.insert([record]);

    const publisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher,
      pollIntervalMs: 500,
    });

    // Launch sweep and immediately stop
    const sweepPromise = publisher.sweepOnce();
    const stopPromise = publisher.stop();

    await Promise.all([sweepPromise, stopPromise]);

    expect(publisher.publishedCount).toBe(1);
    expect(await outboxRepo.getPendingCount()).toBe(0);
  });

  it("Boundary 7: Worker lease expires while task is processing; late result is strictly rejected (Lock 6)", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-lease-exp-r1`;
    const tId = `${prefix}-lease-exp-t1`;
    const wId = `${prefix}-worker-slow`;

    // Task is running under worker-slow, but lease was marked expired
    const expiredIso = new Date(Date.now() - 5000).toISOString();
    await runRepo.save(
      createRunningRun(rId, tId, wId, {
        leaseExpiredAt: expiredIso,
        leaseUntil: expiredIso,
        version: 2,
      }),
    );

    const consumer = new TaskResultConsumer({ runRepository: runRepo });
    const lateEnvelope: TaskResultEnvelope = {
      id: eventId("evt-late-exp-1"),
      type: "task_result",
      source: `aegis/worker/${wId}`,
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: taskId(tId),
      aggregateType: "TaskResult",
      correlationId: `corr-${tId}`,
      data: {
        taskId: taskId(tId),
        runId: runId(rId),
        assignmentId: assignmentId("asgn-late-1"),
        workerId: workerId(wId),
        status: "SUCCEEDED",
        startedAt: new Date(Date.now() - 60000).toISOString(),
        completedAt: new Date().toISOString(),
        output: { result: "late calculation after lease expired" },
      },
    };

    const handled = await consumer.handleMessage(lateEnvelope);
    expect(handled).toBe(false);

    // Verify task state remains running with version unchanged
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("running");
    expect(task?.version).toBe(2);
  });

  it("Boundary 8: Recovery encounters no alternative eligible worker; task remains safely isolated without spinning", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-no-worker-r1`;
    const tId = `${prefix}-no-worker-t1`;
    const wIdOld = `${prefix}-worker-dead`;

    const expiredIso = new Date(Date.now() - 5000).toISOString();
    await runRepo.save(
      createRunningRun(rId, tId, wIdOld, {
        leaseExpiredAt: expiredIso,
        version: 2,
        attemptCount: 1,
      }),
    );

    // Only register the dead worker itself — no alternatives exist
    workerRegistry.register(createWorkerDescriptor(wIdOld, 1, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    const sweepResult = await coordinator.sweepOrphans();
    expect(sweepResult.ok).toBe(true);
    if (!sweepResult.ok) return;

    expect(sweepResult.value.scannedCount).toBe(1);
    expect(sweepResult.value.reassignedCount).toBe(0);
    expect(sweepResult.value.skippedCount).toBe(1);

    const first = sweepResult.value.results[0];
    expect(first?.action).toBe("skipped");
    expect(first?.error).toBe("NO_ELIGIBLE_WORKER");

    // Task is NOT mutated, attemptCount NOT incremented
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("running");
    expect(task?.attemptCount).toBe(1);
    expect(task?.version).toBe(2);
  });

  it("Boundary 9: Execution retry limit reached; task transitions to terminal failed and emits outbox failure event", async () => {
    const runRepo = getRunRepo();
    const outboxRepo = getOutboxRepo();
    const rId = `${prefix}-exhaust-r1`;
    const tId = `${prefix}-exhaust-t1`;
    const wIdOld = `${prefix}-worker-exhaust-old`;
    const wIdNew = `${prefix}-worker-exhaust-new`;

    // Task has already reached maxAttempts (3)
    const expiredIso = new Date(Date.now() - 5000).toISOString();
    await runRepo.save(
      createRunningRun(rId, tId, wIdOld, {
        leaseExpiredAt: expiredIso,
        version: 4,
        attemptCount: 3,
      }),
    );

    workerRegistry.register(createWorkerDescriptor(wIdOld, 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, 0, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    const sweepResult = await coordinator.sweepOrphans();
    expect(sweepResult.ok).toBe(true);
    if (!sweepResult.ok) return;

    expect(sweepResult.value.scannedCount).toBe(1);
    expect(sweepResult.value.reassignedCount).toBe(0);
    expect(sweepResult.value.failedCount).toBe(1);

    const first = sweepResult.value.results[0];
    expect(first?.action).toBe("failed");
    expect(first?.reason).toContain("Execution retry limit exceeded");

    // Verify task is terminal failed
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("failed");
    expect(task?.version).toBe(5);

    // Verify outbox has task_failed event and NO task_assigned event
    const pending = await outboxRepo.claimPending({
      batchSize: 10,
      lockDurationMs: 30000,
      workerId: "test-exhaust-verifier",
    });
    const failedOutbox = pending.find((p) => p.eventType === "task_failed");
    const assignOutbox = pending.find((p) => p.eventType === "task_assigned");
    expect(failedOutbox).toBeDefined();
    expect(assignOutbox).toBeUndefined();
  });

  it("Boundary 10: OrphanRecoveryCoordinator stop() drains in-flight recovery cycle cleanly during process shutdown", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-coord-drain-r1`;
    const tId = `${prefix}-coord-drain-t1`;
    const wIdOld = `${prefix}-coord-drain-old`;
    const wIdNew = `${prefix}-coord-drain-new`;

    const expiredIso = new Date(Date.now() - 5000).toISOString();
    await runRepo.save(
      createRunningRun(rId, tId, wIdOld, {
        leaseExpiredAt: expiredIso,
        version: 2,
        attemptCount: 1,
      }),
    );

    workerRegistry.register(createWorkerDescriptor(wIdOld, 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, 0, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
    });

    let signalStarted!: () => void;
    const startedPromise = new Promise<void>((res) => {
      signalStarted = res;
    });

    let releaseDelay!: () => void;
    const delayedPromise = new Promise<void>((res) => {
      releaseDelay = res;
    });

    const originalReassign = runRepo.reassignTask.bind(runRepo);
    const reassignSpy = vi.spyOn(runRepo, "reassignTask").mockImplementation(async (params, outbox) => {
      signalStarted();
      await delayedPromise;
      return originalReassign(params, outbox);
    });

    // Start background loop
    await coordinator.start();
    expect(coordinator.isRunning).toBe(true);

    // Launch sweep
    const sweepPromise = coordinator.sweepOrphans();
    await startedPromise;

    // Call stop() while recovery is in-flight
    const stopPromise = coordinator.stop();
    expect(coordinator.isRunning).toBe(false);

    // Release delay so in-flight recovery completes
    releaseDelay();

    const [sweepRes] = await Promise.all([sweepPromise, stopPromise]);

    reassignSpy.mockRestore();

    expect(coordinator.isRunning).toBe(false);
    expect(sweepRes.ok).toBe(true);
    if (sweepRes.ok) {
      expect(sweepRes.value.reassignedCount).toBe(1);
    }

    // Verify task was reassigned cleanly
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe(workerId(wIdNew));
  });
}

describe("Phase 12E — Milestone 1: Failure Recovery Boundaries", () => {
  describe("In-Memory Persistence Layer", () => {
    let runRepo: InMemoryRunRepository;
    let outboxRepo: InMemoryOutboxRepository;

    beforeEach(() => {
      outboxRepo = new InMemoryOutboxRepository();
      runRepo = new InMemoryRunRepository(false, outboxRepo);
    });

    runFailureBoundaryTests(
      () => runRepo,
      () => outboxRepo,
      "mem",
    );
  });

  describe("PostgreSQL Persistence Layer (Live Integration)", () => {
    let ctx: DatabaseContext | undefined;
    let runRepo: PostgresRunRepository;
    let outboxRepo: PostgresOutboxRepository;
    let dbAvailable = false;

    beforeAll(async () => {
      dbAvailable = await isDatabaseReachable();
      if (!dbAvailable) return;

      ctx = createDatabaseContext({
        url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5433/aegis",
        poolMin: 1,
        poolMax: 3,
      });
      await runMigrations(ctx.db);
      outboxRepo = new PostgresOutboxRepository(ctx.db);
      runRepo = new PostgresRunRepository(ctx);
    }, 30000);

    beforeEach(async () => {
      if (!dbAvailable) return;
      await runRepo.resetToDefaults();
    });

    afterAll(async () => {
      await ctx?.close();
    });

    runFailureBoundaryTests(
      () => runRepo,
      () => outboxRepo,
      "pg",
    );
  });
});
