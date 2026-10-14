/**
 * Phase 12D: Orphan Task Recovery & Automatic Reassignment — Failure Verification Test Suite.
 *
 * Verifies the 7 mandatory failure and recovery scenarios across in-memory and PostgreSQL:
 * - Scenario 1: Worker Crash & Reassignment to Worker B via Outbox (Lock 7 exclusion + Lock 8 atomic outbox).
 * - Scenario 2: Full End-to-End Recovery Flow (Attempt 1 fail -> Reassign Worker B -> Succeeded -> Completed).
 * - Scenario 3: Retry Limit Exhaustion (Bounded Retries - Lock 6: terminal permanent failure).
 * - Scenario 4: Concurrent Recovery Coordinator Contention (OCC Version Gating - Lock 3).
 * - Scenario 5: Late Worker A Result Strictly Rejected (Lock 9: Stale result rejection).
 * - Scenario 6: No Eligible Alternative Worker Available (Graceful isolation, zero spinning).
 * - Scenario 7: Post-Commit API Crash Gap Simulation (Outbox durability bridge across control-plane restarts).
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
  WorkerPresenceState,
} from "@aegis/contracts";
import {
  assignmentId,
  err,
  eventId,
  ok,
  runId,
  taskId,
  workerId,
  workflowId,
  type Result,
} from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";
import { OrphanRecoveryCoordinator } from "../dispatch/recoveryCoordinator.js";
import { TaskResultConsumer } from "../dispatch/resultConsumer.js";
import { DeterministicWorkerSelector } from "../dispatch/workerSelector.js";
import { OutboxPublisher } from "../events/outboxPublisher.js";
import { InMemoryWorkerRegistry } from "../presence/workerRegistry.js";
import { InMemoryOutboxRepository } from "../repositories/inMemoryOutboxRepository.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";
import type { IOutboxRepository } from "../repositories/outboxRepository.js";
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

class MockKafkaEventPublisher implements IEventPublisher {
  public publishedBatches: { envelopes: EventEnvelope[]; topic?: string | undefined }[] = [];
  public shouldFail = false;
  public failureMessage = "Simulated Kafka outage";

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

  publishBatch(
    envelopes: readonly EventEnvelope[],
    topic?: string,
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>> {
    if (this.shouldFail) {
      return Promise.resolve(
        err({
          code: "BROKER_UNAVAILABLE",
          message: this.failureMessage,
        }),
      );
    }
    this.publishedBatches.push({ envelopes: [...envelopes], topic });
    const results: EventPublishResult[] = envelopes.map((e, idx) => ({
      success: true,
      topic: topic ?? "aegis.events",
      partition: 0,
      offset: String(idx),
      messageId: e.id,
    }));
    return Promise.resolve(ok(results));
  }
}

function createWorkerDescriptor(
  id: string,
  presenceState: WorkerPresenceState = "HEALTHY",
  activeTaskCount = 0,
  maxConcurrentTasks = 5,
  taskTypes: string[] = ["*"],
): WorkerDescriptor {
  const now = new Date().toISOString();
  return {
    workerId: workerId(id),
    presenceState,
    lifecycleState: "ready",
    capabilities: {
      taskTypes,
      tools: [],
      maxConcurrency: maxConcurrentTasks,
    },
    activeTaskCount,
    maxConcurrentTasks,
    lastHeartbeatAt: now,
    registeredAt: now,
  };
}

function createOrphanedTestRun(
  rId: string,
  tId: string,
  failedWorkerId: string,
  attemptCount = 1,
  version = 2,
): Run {
  const expiredAt = new Date(Date.now() - 5000).toISOString();
  const t: Task = {
    id: taskId(tId),
    runId: runId(rId),
    name: "Execution Unit 1",
    status: "running",
    description: "Orphan recovery integration test task",
    attemptCount,
    worker: workerId(failedWorkerId),
    workerId: workerId(failedWorkerId),
    version,
    leaseId: "lease-expired-original",
    leaseUntil: new Date(Date.now() - 10000).toISOString(),
    leaseExpiredAt: expiredAt,
    startedAt: new Date(Date.now() - 20000).toISOString(),
  };

  return {
    id: runId(rId),
    goal: "Verify orphan recovery and automatic reassignment pipeline",
    status: "running",
    progress: 25,
    createdAt: new Date(Date.now() - 30000).toISOString(),
    updatedAt: expiredAt,
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Recovery Test Workflow",
      tasks: [t],
    },
    tasks: [t],
  };
}

function executeOrphanRecoverySuite(
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

  it("Scenario 1: Worker Crash & Reassignment to Worker B via Outbox (Lock 7 & 8)", async () => {
    const runRepo = getRunRepo();
    const outboxRepo = getOutboxRepo();
    const rId = `${prefix}-sc1-r1`;
    const tId = `${prefix}-sc1-t1`;
    const wIdOld = `${prefix}-sc1-worker-A`;
    const wIdNew = `${prefix}-sc1-worker-B`;

    // 1. Worker A crashed: task is running but lease is expired
    await runRepo.save(createOrphanedTestRun(rId, tId, wIdOld, 1, 2));

    // 2. Both workers in registry: Worker A (dead/lost lease) and Worker B (healthy candidate)
    workerRegistry.register(createWorkerDescriptor(wIdOld, "HEALTHY", 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, "HEALTHY", 0, 5));

    // 3. Coordinator recovers orphan: strictly excludes Worker A (Lock 7) and reassigns to Worker B
    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    const recoveryRes = await coordinator.recoverOrphan(taskId(tId));
    expect(recoveryRes.ok).toBe(true);
    if (!recoveryRes.ok) return;

    expect(recoveryRes.value.action).toBe("reassigned");
    expect(recoveryRes.value.assignedWorkerId).toBe(workerId(wIdNew));
    expect(recoveryRes.value.attemptCount).toBe(2);

    // 4. Verify durable persistence state in repository (Lock 1, 4, 5)
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task).toBeDefined();
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe(workerId(wIdNew));
    expect(task?.version).toBe(3); // 2 -> 3
    expect(task?.attemptCount).toBe(2);
    expect(task?.leaseExpiredAt).toBeUndefined();

    // 5. Verify multi-topic transactional outbox insertion (Lock 8)
    // There must be 2 pending outbox records:
    // a. Domain event: task_reassigned on aegis.events
    // b. Worker assignment: task_assigned on aegis.tasks.assign.{workerId}
    const pendingRecords = await outboxRepo.claimPending({
      batchSize: 10,
      lockDurationMs: 30000,
      workerId: "test-verifier",
    });

    expect(pendingRecords.length).toBeGreaterThanOrEqual(2);
    const domainRecord = pendingRecords.find((r) => r.eventType === "task_reassigned");
    const assignRecord = pendingRecords.find((r) => r.eventType === "task_assigned");

    expect(domainRecord).toBeDefined();
    expect(domainRecord?.topic).toBe("aegis.events");

    expect(assignRecord).toBeDefined();
    expect(assignRecord?.topic).toBe(`aegis.tasks.assign.${wIdNew}`);
  });

  it("Scenario 2: Full End-to-End Recovery Flow (Attempt 1 fail -> Reassigned -> Completed)", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-sc2-r1`;
    const tId = `${prefix}-sc2-t1`;
    const wIdOld = `${prefix}-sc2-worker-A`;
    const wIdNew = `${prefix}-sc2-worker-B`;

    // 1. Initial orphan from Worker A
    await runRepo.save(createOrphanedTestRun(rId, tId, wIdOld, 1, 2));
    workerRegistry.register(createWorkerDescriptor(wIdOld, "HEALTHY", 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, "HEALTHY", 0, 5));

    // 2. Recovery coordinator reassigns to Worker B
    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    const recoveryRes = await coordinator.recoverOrphan(taskId(tId));
    expect(recoveryRes.ok).toBe(true);

    // 3. Worker B executes task and dispatches successful TaskResultEnvelope
    const consumer = new TaskResultConsumer({ runRepository: runRepo });
    const resultEnvelope: TaskResultEnvelope = {
      id: eventId(`evt-res-${tId}`),
      type: "task_result",
      source: `aegis/worker/${wIdNew}`,
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: taskId(tId),
      aggregateType: "TaskResult",
      correlationId: `corr-${rId}`,
      data: {
        taskId: taskId(tId),
        runId: runId(rId),
        assignmentId: assignmentId(`asgn-${tId}`),
        workerId: workerId(wIdNew),
        status: "SUCCEEDED",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: { result: "Processed successfully on Worker B" },
      },
    };

    const handled = await consumer.handleMessage(resultEnvelope);
    expect(handled).toBe(true);

    // 4. Verify task is cleanly completed in durable storage
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("completed");
    expect(task?.workerId).toBe(workerId(wIdNew));
    expect(task?.version).toBe(4); // 2 -> 3 (reassigned) -> 4 (completed)
    expect(task?.output).toContain("Processed successfully on Worker B");
  });

  it("Scenario 3: Retry Limit Exhaustion (Bounded Retries - Lock 6: Permanent Failure)", async () => {
    const runRepo = getRunRepo();
    const outboxRepo = getOutboxRepo();
    const rId = `${prefix}-sc3-r1`;
    const tId = `${prefix}-sc3-t1`;
    const wIdOld = `${prefix}-sc3-worker-A`;
    const wIdNew = `${prefix}-sc3-worker-B`;

    // Task has already reached attemptCount = 3 (maxAttempts = 3)
    await runRepo.save(createOrphanedTestRun(rId, tId, wIdOld, 3, 4));
    workerRegistry.register(createWorkerDescriptor(wIdOld, "HEALTHY", 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, "HEALTHY", 0, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    const recoveryRes = await coordinator.recoverOrphan(taskId(tId));
    expect(recoveryRes.ok).toBe(true);
    if (!recoveryRes.ok) return;

    expect(recoveryRes.value.action).toBe("failed");
    expect(recoveryRes.value.reason).toContain("Execution retry limit exceeded");

    // Task is permanently failed in store
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("failed");
    expect(task?.version).toBe(5);
    expect(task?.error).toContain("Execution retry limit exceeded");

    // Outbox contains task_failed domain event, but zero task_assigned records
    const pendingRecords = await outboxRepo.claimPending({
      batchSize: 10,
      lockDurationMs: 30000,
      workerId: "test-verifier-fail",
    });

    const failedEvent = pendingRecords.find((r) => r.eventType === "task_failed");
    const assignedEvent = pendingRecords.find((r) => r.eventType === "task_assigned");
    expect(failedEvent).toBeDefined();
    expect(assignedEvent).toBeUndefined();

    // Subsequent recovery attempts strictly reject the task (terminal state immutability)
    const subsequentRes = await coordinator.recoverOrphan(taskId(tId));
    expect(subsequentRes.ok).toBe(false);
  });

  it("Scenario 4: Concurrent Recovery Coordinator Contention (OCC Version Gating - Lock 3)", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-sc4-r1`;
    const tId = `${prefix}-sc4-t1`;
    const wIdOld = `${prefix}-sc4-worker-A`;
    const wIdNew = `${prefix}-sc4-worker-B`;

    await runRepo.save(createOrphanedTestRun(rId, tId, wIdOld, 1, 2));
    workerRegistry.register(createWorkerDescriptor(wIdOld, "HEALTHY", 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, "HEALTHY", 0, 5));

    const coordinator1 = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    const coordinator2 = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    // Both coordinators concurrently attempt to recover the identical orphan
    const [res1, res2] = await Promise.all([
      coordinator1.recoverOrphan(taskId(tId)),
      coordinator2.recoverOrphan(taskId(tId)),
    ]);

    // Exactly one must succeed with reassignment; the other must fail or skip cleanly
    const reassignments = [res1, res2].filter((r) => r.ok && r.value.action === "reassigned");
    const nonReassignments = [res1, res2].filter(
      (r) => !r.ok || r.value.action !== "reassigned",
    );

    expect(reassignments.length).toBe(1);
    expect(nonReassignments.length).toBe(1);

    // Exactly 1 version bump occurred (2 -> 3)
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.version).toBe(3);
    expect(task?.workerId).toBe(workerId(wIdNew));
  });

  it("Scenario 5: Late Worker A Result Strictly Rejected (Lock 9)", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-sc5-r1`;
    const tId = `${prefix}-sc5-t1`;
    const wIdOld = `${prefix}-sc5-worker-A`;
    const wIdNew = `${prefix}-sc5-worker-B`;

    // 1. Task reassigned to Worker B
    await runRepo.save(createOrphanedTestRun(rId, tId, wIdOld, 1, 2));
    workerRegistry.register(createWorkerDescriptor(wIdOld, "HEALTHY", 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, "HEALTHY", 0, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    await coordinator.recoverOrphan(taskId(tId));

    // 2. Worker A (superseded) arrives late with result
    const consumer = new TaskResultConsumer({ runRepository: runRepo });
    const staleEnvelope: TaskResultEnvelope = {
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
        assignmentId: assignmentId(`asgn-old-${tId}`),
        workerId: workerId(wIdOld), // Dead/superseded worker
        status: "SUCCEEDED",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: { result: "Zombie output from dead Worker A" },
      },
    };

    const handled = await consumer.handleMessage(staleEnvelope);
    expect(handled).toBe(false);

    // 3. Task state remains completely uncorrupted (still assigned to Worker B, running, version 3)
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe(workerId(wIdNew));
    expect(task?.version).toBe(3);
    expect(task?.output).toBeUndefined();
  });

  it("Scenario 6: No Eligible Alternative Worker Available (Graceful Isolation, Zero Spinning)", async () => {
    const runRepo = getRunRepo();
    const rId = `${prefix}-sc6-r1`;
    const tId = `${prefix}-sc6-t1`;
    const wIdOld = `${prefix}-sc6-worker-A`;
    const wIdOffline = `${prefix}-sc6-worker-Offline`;

    // Only Worker A and an OFFLINE worker exist in registry
    await runRepo.save(createOrphanedTestRun(rId, tId, wIdOld, 1, 2));
    workerRegistry.register(createWorkerDescriptor(wIdOld, "HEALTHY", 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdOffline, "OFFLINE", 0, 5));

    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    // Single orphan recovery evaluation skips
    const recoveryRes = await coordinator.recoverOrphan(taskId(tId));
    expect(recoveryRes.ok).toBe(true);
    if (!recoveryRes.ok) return;

    expect(recoveryRes.value.action).toBe("skipped");
    expect(recoveryRes.value.reason).toContain("NO_HEALTHY_WORKERS");

    // Sweep scan also skips without throwing
    const sweepRes = await coordinator.sweepOrphans();
    expect(sweepRes.ok).toBe(true);
    if (!sweepRes.ok) return;

    expect(sweepRes.value.skippedCount).toBe(1);
    expect(sweepRes.value.reassignedCount).toBe(0);

    // Task remains durably orphaned in DB with attemptCount preserved
    const run = await runRepo.findById(runId(rId));
    const task = run?.tasks.find((t) => t.id === tId);
    expect(task?.status).toBe("running");
    expect(task?.workerId).toBe(workerId(wIdOld));
    expect(task?.attemptCount).toBe(1);
    expect(task?.version).toBe(2);
    expect(task?.leaseExpiredAt).toBeDefined();
  });

  it("Scenario 7: Post-Commit API Crash Gap Simulation (Outbox Durability Bridge)", async () => {
    const runRepo = getRunRepo();
    const outboxRepo = getOutboxRepo();
    const rId = `${prefix}-sc7-r1`;
    const tId = `${prefix}-sc7-t1`;
    const wIdOld = `${prefix}-sc7-worker-A`;
    const wIdNew = `${prefix}-sc7-worker-B`;

    await runRepo.save(createOrphanedTestRun(rId, tId, wIdOld, 1, 2));
    workerRegistry.register(createWorkerDescriptor(wIdOld, "HEALTHY", 1, 5));
    workerRegistry.register(createWorkerDescriptor(wIdNew, "HEALTHY", 0, 5));

    // 1. Coordinator successfully commits reassignment transaction to DB
    const coordinator = new OrphanRecoveryCoordinator({
      repository: runRepo,
      workerRegistry,
      workerSelector,
      policy: { maxAttempts: 3 },
    });

    const recoveryRes = await coordinator.recoverOrphan(taskId(tId));
    expect(recoveryRes.ok).toBe(true);

    // 2. CRASH SIMULATION: Control plane process terminates before Kafka publication.
    // Assert pending outbox records exist durably in the outbox table
    const pendingCount = await outboxRepo.getPendingCount();
    expect(pendingCount).toBeGreaterThanOrEqual(2);

    // 3. RESTART: New OutboxPublisher service starts up and sweeps pending records
    const eventPublisher = new MockKafkaEventPublisher();
    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher,
      defaultTopic: "aegis.events",
    });

    const sweepResult = await outboxPublisher.sweepOnce();
    expect(sweepResult.publishedCount).toBeGreaterThanOrEqual(2);
    expect(sweepResult.failedCount).toBe(0);

    // 4. Verify Kafka dispatcher routed batches to their respective topics
    const publishedTopics = eventPublisher.publishedBatches.map((b) => b.topic);
    expect(publishedTopics).toContain(`aegis.tasks.assign.${wIdNew}`);
    expect(publishedTopics).toContain("aegis.events");

    // All outbox records are now marked published
    const remainingPending = await outboxRepo.getPendingCount();
    expect(remainingPending).toBe(0);
  });
}

describe("Phase 12D: Orphan Recovery & Automatic Reassignment Test Suite", () => {
  describe("In-Memory Persistence Layer", () => {
    let runRepo: InMemoryRunRepository;
    let outboxRepo: InMemoryOutboxRepository;

    beforeEach(() => {
      outboxRepo = new InMemoryOutboxRepository();
      runRepo = new InMemoryRunRepository(false, outboxRepo);
    });

    executeOrphanRecoverySuite(
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

    executeOrphanRecoverySuite(
      () => runRepo,
      () => outboxRepo,
      "pg",
    );
  });
});
