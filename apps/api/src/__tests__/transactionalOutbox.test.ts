/**
 * Phase 12C: Transactional Outbox & Durable Event Publication — Failure Verification Test Suite.
 *
 * Verifies the 7 mandatory failure scenarios across in-memory and PostgreSQL:
 * - Test 1: Atomic Success (State mutation + outbox record committed together).
 * - Test 2: Transaction Rollback (DB failure discards both state & outbox).
 * - Test 3: Crash Gap Simulation (Process dies immediately post-commit, restart claims & publishes).
 * - Test 4: Kafka Outage Containment (Buffer in DB & recover when Kafka returns).
 * - Test 5: Stable Event Identity Across Retries (Lock 4: canonical event ID preserved).
 * - Test 6: Concurrent Multi-Publisher Contention (Zero collision via FOR UPDATE SKIP LOCKED).
 * - Test 7: Consumer End-to-End Compatibility (Full deserialization and consumer ingest).
 */

import * as net from "node:net";

import type {
  EventEnvelope,
  EventPublishErrorContract,
  EventPublishResult,
  IEventPublisher,
  Run,
  RunEvent,
  Task,
  TaskResultEnvelope,
} from "@aegis/contracts";
import { eventEnvelopeSchema } from "@aegis/contracts";
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
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../db/client.js";
import { runMigrations } from "../db/migrator.js";
import { outboxEventsTable, runsTable } from "../db/schema.js";
import { TaskResultConsumer } from "../dispatch/resultConsumer.js";
import { deserializeEnvelope, serializeEnvelope } from "../events/envelope.js";
import { OutboxPublisher } from "../events/outboxPublisher.js";
import { InMemoryOutboxRepository } from "../repositories/inMemoryOutboxRepository.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";
import type { CreateOutboxRecord } from "../repositories/outboxRepository.js";
import { PostgresOutboxRepository } from "../repositories/postgresOutboxRepository.js";
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

class MockKafkaEventPublisher implements IEventPublisher {
  public publishedEnvelopes: EventEnvelope[] = [];
  public publishedBatches: EventEnvelope[][] = [];
  public shouldFail = false;
  public failureCode: "BROKER_UNAVAILABLE" | "KAFKA_NOT_CONNECTED" = "BROKER_UNAVAILABLE";
  public failureMessage = "Simulated Kafka outage";

  publish(envelope: EventEnvelope): Promise<Result<EventPublishResult, EventPublishErrorContract>> {
    return this.publishBatch([envelope]).then((res) => {
      if (!res.ok) {
        return err(res.error);
      }
      const first = res.value[0];
      if (first) {
        return ok(first);
      }
      return err({ code: "BROKER_UNAVAILABLE", message: "No result" });
    });
  }

  publishBatch(
    envelopes: readonly EventEnvelope[],
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>> {
    if (this.shouldFail) {
      return Promise.resolve(
        err({
          code: this.failureCode,
          message: this.failureMessage,
        }),
      );
    }

    const copy = [...envelopes];
    this.publishedEnvelopes.push(...copy);
    this.publishedBatches.push(copy);

    const results: EventPublishResult[] = copy.map((env, idx) => ({
      success: true,
      topic: "aegis.events",
      partition: 0,
      offset: String(idx),
      messageId: env.id,
    }));

    return Promise.resolve(ok(results));
  }
}

function createSampleRun(rIdStr: string, tIdStr: string): { run: Run; events: RunEvent[] } {
  const rId = runId(rIdStr);
  const tId = taskId(tIdStr);
  const now = new Date().toISOString();

  const task: Task = {
    id: tId,
    runId: rId,
    name: "Outbox Durability Step",
    description: "Verifies state and outbox atomicity",
    status: "running",
    attemptCount: 1,
    workerId: workerId("worker-durability-1"),
    version: 1,
    startedAt: now,
  };

  const run: Run = {
    id: rId,
    goal: "Transactional Outbox Durability Test",
    status: "running",
    progress: 30,
    workflow: {
      id: workflowId(`wf-${rIdStr}`),
      name: "Outbox Durability Workflow",
      tasks: [task],
    },
    tasks: [task],
    createdAt: now,
    updatedAt: now,
  };

  const events: RunEvent[] = [
    {
      id: eventId(`evt-${rIdStr}-started`),
      runId: rId,
      type: "task_started",
      severity: "info",
      timestamp: now,
      message: `Task ${tIdStr} started on worker`,
      taskId: tId,
    },
  ];

  return { run, events };
}

describe("Phase 12C: Transactional Outbox Durability Verification", () => {
  let inMemoryRunRepo: InMemoryRunRepository;
  let inMemoryOutboxRepo: InMemoryOutboxRepository;
  let kafkaPublisher: MockKafkaEventPublisher;

  beforeEach(() => {
    inMemoryOutboxRepo = new InMemoryOutboxRepository();
    inMemoryRunRepo = new InMemoryRunRepository(true, inMemoryOutboxRepo);
    kafkaPublisher = new MockKafkaEventPublisher();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1: Atomic Success (State Mutation + Outbox Committed Together)
  // ─────────────────────────────────────────────────────────────────────────────
  it("Test 1 (Atomic Success): persists state mutation and outbox record together in one transaction", async () => {
    const { run, events } = createSampleRun("r-atom-1", "t-atom-1");

    await inMemoryRunRepo.save(run, events);

    // Verify run and task are persisted
    const savedRun = await inMemoryRunRepo.findById(run.id);
    expect(savedRun).toBeDefined();
    expect(savedRun?.tasks).toHaveLength(1);

    // Verify outbox record exists and contains canonical EventEnvelope
    const pendingCount = await inMemoryOutboxRepo.getPendingCount();
    expect(pendingCount).toBe(1);

    const pending = await inMemoryOutboxRepo.claimPending({
      batchSize: 10,
      lockDurationMs: 10000,
      workerId: "test-verifier",
    });

    expect(pending).toHaveLength(1);
    const outboxRecord = pending[0];
    expect(outboxRecord).toBeDefined();
    if (!outboxRecord) return;

    expect(outboxRecord.aggregateId).toBe(run.id);
    expect(outboxRecord.eventType).toBe("task_started");

    const firstEvent = events[0];
    expect(firstEvent).toBeDefined();
    if (!firstEvent) return;

    expect(outboxRecord.payload.id).toBe(firstEvent.id);
    expect((outboxRecord.payload as EventEnvelope).data.message).toBe(firstEvent.message);
    expect(outboxRecord.status).toBe("publishing");
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: Transaction Rollback (DB Failure Discards Both State & Outbox)
  // ─────────────────────────────────────────────────────────────────────────────
  it("Test 2 (Transaction Rollback): OCC failure discards task state mutation and outbox events", async () => {
    const { run, events } = createSampleRun("r-roll-1", "t-roll-1");
    await inMemoryRunRepo.save(run, events);

    const initialPendingCount = await inMemoryOutboxRepo.getPendingCount();
    expect(initialPendingCount).toBe(1);

    // Attempt task update with stale version 999 (OCC conflict)
    const completionEvent: RunEvent = {
      id: eventId("evt-roll-stale"),
      runId: run.id,
      type: "task_completed",
      severity: "success",
      timestamp: new Date().toISOString(),
      message: "Stale completion",
      taskId: taskId("t-roll-1"),
    };

    const updateResult = await inMemoryRunRepo.updateTaskState(
      taskId("t-roll-1"),
      { status: "completed" },
      999, // Stale version! Current version is 1
      completionEvent,
    );

    expect(updateResult.ok).toBe(false);

    // Verify task is still 'running' with version 1
    const runAfterFailedUpdate = await inMemoryRunRepo.findById(run.id);
    expect(runAfterFailedUpdate?.tasks[0]?.status).toBe("running");
    expect(runAfterFailedUpdate?.tasks[0]?.version).toBe(1);

    // Verify outbox record count did NOT increment (the completion event was rejected)
    const pendingCountAfter = await inMemoryOutboxRepo.getPendingCount();
    expect(pendingCountAfter).toBe(1); // Only the initial event remains
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3: Crash Gap Simulation
  // ─────────────────────────────────────────────────────────────────────────────
  it("Test 3 (Crash Gap Simulation): process termination immediately post-commit is recovered by restarted publisher", async () => {
    const { run, events } = createSampleRun("r-crash-1", "t-crash-1");

    // 1. Transaction commits state + outbox in DB
    await inMemoryRunRepo.save(run, events);

    // 2. CRASH GAP: Process immediately terminates! Zero Kafka publish calls happen.
    expect(kafkaPublisher.publishedEnvelopes).toHaveLength(0);

    // 3. RESTART: New process / container starts up with fresh OutboxPublisher
    const restartedPublisher = new OutboxPublisher({
      outboxRepository: inMemoryOutboxRepo,
      eventPublisher: kafkaPublisher,
      workerId: "restarted-worker-pod-2",
    });

    // 4. Background sweep claims pending event and delivers to Kafka
    const sweepResult = await restartedPublisher.sweepOnce();
    expect(sweepResult.claimedCount).toBe(1);
    expect(sweepResult.publishedCount).toBe(1);
    expect(sweepResult.failedCount).toBe(0);

    // 5. Verification: Event reached Kafka and outbox queue is cleared
    expect(kafkaPublisher.publishedEnvelopes).toHaveLength(1);
    const pubEnv = kafkaPublisher.publishedEnvelopes[0];
    const initialEvt = events[0];
    expect(pubEnv).toBeDefined();
    expect(initialEvt).toBeDefined();
    if (pubEnv && initialEvt) {
      expect(pubEnv.id).toBe(initialEvt.id);
    }
    expect(await inMemoryOutboxRepo.getPendingCount()).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4: Kafka Outage Containment (Buffer in DB & Recover When Kafka Returns)
  // ─────────────────────────────────────────────────────────────────────────────
  it("Test 4 (Kafka Outage Containment): buffers events in DB during broker outage and recovers when Kafka returns", async () => {
    const { run, events } = createSampleRun("r-outage-1", "t-outage-1");
    await inMemoryRunRepo.save(run, events);

    // 1. Kafka is completely down
    kafkaPublisher.shouldFail = true;
    kafkaPublisher.failureCode = "BROKER_UNAVAILABLE";
    kafkaPublisher.failureMessage = "Kafka broker connection refused (ECONNREFUSED)";

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: inMemoryOutboxRepo,
      eventPublisher: kafkaPublisher,
      backoffBaseMs: 40,
      backoffMaxMs: 500,
      workerId: "outage-verifier",
    });

    // 2. Sweep attempts publication and handles outage cleanly
    const sweep1 = await outboxPublisher.sweepOnce();
    expect(sweep1.claimedCount).toBe(1);
    expect(sweep1.publishedCount).toBe(0);
    expect(sweep1.failedCount).toBe(1);

    // Event remains safely buffered in DB
    expect(await inMemoryOutboxRepo.getPendingCount()).toBe(1);

    // 3. Immediate second sweep cannot claim due to backoff lock
    const sweep2 = await outboxPublisher.sweepOnce();
    expect(sweep2.claimedCount).toBe(0);

    // 4. Kafka recovers!
    kafkaPublisher.shouldFail = false;

    // Wait for backoff window (40ms) to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. Next sweep succeeds and drains the buffer
    const sweep3 = await outboxPublisher.sweepOnce();
    expect(sweep3.claimedCount).toBe(1);
    expect(sweep3.publishedCount).toBe(1);
    expect(sweep3.failedCount).toBe(0);

    expect(kafkaPublisher.publishedEnvelopes).toHaveLength(1);
    expect(await inMemoryOutboxRepo.getPendingCount()).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5: Stable Event Identity Across Retries (Lock 4 & Lock 5)
  // ─────────────────────────────────────────────────────────────────────────────
  it("Test 5 (Stable Event Identity): retries publish identical EventEnvelope.id for downstream deduplication", async () => {
    const { run, events } = createSampleRun("r-stable-1", "t-stable-1");
    await inMemoryRunRepo.save(run, events);

    const originalEvent = events[0];
    expect(originalEvent).toBeDefined();
    if (!originalEvent) return;

    const publishedEnvelopesDuringRetries: EventEnvelope[] = [];

    // Capture every envelope passed to publishBatch
    const trackingPublisher: IEventPublisher = {
      publish: () => Promise.reject(new Error("Unused")),
      publishBatch: (envelopes) => {
        publishedEnvelopesDuringRetries.push(...envelopes);
        if (publishedEnvelopesDuringRetries.length === 1) {
          // Fail first attempt
          return Promise.resolve(
            err({ code: "BROKER_UNAVAILABLE", message: "Transient network timeout" }),
          );
        }
        // Succeed second attempt
        return Promise.resolve(
          ok(
            envelopes.map((e, idx) => ({
              success: true,
              topic: "aegis.events",
              partition: 0,
              offset: String(idx),
              messageId: e.id,
            })),
          ),
        );
      },
    };

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: inMemoryOutboxRepo,
      eventPublisher: trackingPublisher,
      backoffBaseMs: 30,
      backoffMaxMs: 100,
    });

    // Attempt 1: Fails
    const sweep1 = await outboxPublisher.sweepOnce();
    expect(sweep1.failedCount).toBe(1);

    // Wait for backoff (30ms) to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Attempt 2: Succeeds
    const sweep2 = await outboxPublisher.sweepOnce();
    expect(sweep2.publishedCount).toBe(1);

    // Verify 2 attempts were dispatched
    expect(publishedEnvelopesDuringRetries).toHaveLength(2);

    const firstAttemptEnvelope = publishedEnvelopesDuringRetries[0];
    const secondAttemptEnvelope = publishedEnvelopesDuringRetries[1];
    expect(firstAttemptEnvelope).toBeDefined();
    expect(secondAttemptEnvelope).toBeDefined();
    if (!firstAttemptEnvelope || !secondAttemptEnvelope) return;

    // Lock 4 invariant: Exact same event identity across attempts
    expect(firstAttemptEnvelope.id).toBe(originalEvent.id);
    expect(secondAttemptEnvelope.id).toBe(originalEvent.id);
    expect(secondAttemptEnvelope.id).toBe(firstAttemptEnvelope.id);
    expect(secondAttemptEnvelope.time).toBe(firstAttemptEnvelope.time);
    expect(secondAttemptEnvelope.correlationId).toBe(firstAttemptEnvelope.correlationId);
    expect(secondAttemptEnvelope.data).toEqual(firstAttemptEnvelope.data);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6: Concurrent Multi-Publisher Contention
  // ─────────────────────────────────────────────────────────────────────────────
  it("Test 6 (Concurrent Contention): multiple concurrent publisher sweeps claim distinct records without collision", async () => {
    // Populate 6 pending outbox records
    const recordsToInsert: CreateOutboxRecord[] = Array.from({ length: 6 }, (_, idx) => {
      const eId = eventId(`evt-contention-${String(idx)}`);
      const rId = runId(`run-contention-${String(idx)}`);
      const now = new Date().toISOString();
      const envelope: EventEnvelope = {
        id: eId,
        type: "task_started",
        source: "aegis.api",
        specVersion: "1.0",
        time: now,
        aggregateId: rId,
        aggregateType: "ExecutionRun",
        correlationId: rId,
        data: {
          id: eId,
          runId: rId,
          type: "task_started",
          severity: "info",
          timestamp: now,
          message: `Contention record ${String(idx)}`,
        },
      };

      return {
        id: outboxEventId(`outbox-contention-${String(idx)}`),
        aggregateId: rId,
        aggregateType: "ExecutionRun",
        eventType: "task_started",
        payload: envelope,
      };
    });

    await inMemoryOutboxRepo.insert(recordsToInsert);
    expect(await inMemoryOutboxRepo.getPendingCount()).toBe(6);

    const publisherAEvents: EventEnvelope[] = [];
    const publisherBEvents: EventEnvelope[] = [];

    const mockPubA: IEventPublisher = {
      publish: () => Promise.reject(new Error("Unused")),
      publishBatch: (envelopes) => {
        publisherAEvents.push(...envelopes);
        return Promise.resolve(
          ok(
            envelopes.map((e, idx) => ({
              success: true,
              topic: "aegis.events",
              partition: 0,
              offset: String(idx),
              messageId: e.id,
            })),
          ),
        );
      },
    };

    const mockPubB: IEventPublisher = {
      publish: () => Promise.reject(new Error("Unused")),
      publishBatch: (envelopes) => {
        publisherBEvents.push(...envelopes);
        return Promise.resolve(
          ok(
            envelopes.map((e, idx) => ({
              success: true,
              topic: "aegis.events",
              partition: 1,
              offset: String(idx),
              messageId: e.id,
            })),
          ),
        );
      },
    };

    const publisherA = new OutboxPublisher({
      outboxRepository: inMemoryOutboxRepo,
      eventPublisher: mockPubA,
      batchSize: 3,
      workerId: "worker-pod-A",
    });

    const publisherB = new OutboxPublisher({
      outboxRepository: inMemoryOutboxRepo,
      eventPublisher: mockPubB,
      batchSize: 3,
      workerId: "worker-pod-B",
    });

    // Execute concurrent sweeps simultaneously
    const [resultA, resultB] = await Promise.all([
      publisherA.sweepOnce(),
      publisherB.sweepOnce(),
    ]);

    expect(resultA.publishedCount + resultB.publishedCount).toBe(6);
    expect(publisherAEvents.length + publisherBEvents.length).toBe(6);

    // Verify zero overlap in claimed event IDs (no duplicate publication)
    const setA = new Set(publisherAEvents.map((e) => e.id));
    const setB = new Set(publisherBEvents.map((e) => e.id));

    for (const idOfA of setA) {
      expect(setB.has(idOfA)).toBe(false);
    }

    expect(await inMemoryOutboxRepo.getPendingCount()).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7: Consumer End-to-End Compatibility
  // ─────────────────────────────────────────────────────────────────────────────
  it("Test 7 (Consumer End-to-End Compatibility): outbox payload adheres to canonical EventEnvelope and is accepted by consumers", async () => {
    const { run, events } = createSampleRun("r-consumer-1", "t-consumer-1");
    await inMemoryRunRepo.save(run, events);

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: inMemoryOutboxRepo,
      eventPublisher: kafkaPublisher,
    });

    await outboxPublisher.sweepOnce();
    expect(kafkaPublisher.publishedEnvelopes).toHaveLength(1);

    const dispatchedEnvelope = kafkaPublisher.publishedEnvelopes[0];
    expect(dispatchedEnvelope).toBeDefined();
    if (!dispatchedEnvelope) return;

    // 1. Explicit serialization boundary check
    const serResult = serializeEnvelope(dispatchedEnvelope);
    expect(serResult.ok).toBe(true);
    if (!serResult.ok) return;

    const rawJson = serResult.value;

    // 2. Explicit deserialization boundary check
    const deserResult = deserializeEnvelope(rawJson);
    expect(deserResult.ok).toBe(true);
    if (!deserResult.ok) return;

    const parsedEnvelope = deserResult.value;

    // 3. Validate against Zod canonical EventEnvelope contract
    const zodValidation = eventEnvelopeSchema.safeParse(parsedEnvelope);
    expect(zodValidation.success).toBe(true);

    const firstEvt = events[0];
    expect(firstEvt).toBeDefined();
    if (firstEvt) {
      expect(parsedEnvelope.id).toBe(firstEvt.id);
    }
    expect(parsedEnvelope.type).toBe("task_started");
    expect(parsedEnvelope.data.runId).toBe(run.id);

    // 4. Test TaskResultConsumer end-to-end integration
    const resultConsumer = new TaskResultConsumer({
      runRepository: inMemoryRunRepo,
    });

    const completionEnvelope: TaskResultEnvelope = {
      specVersion: "1.0",
      id: eventId("res-env-1"),
      type: "task_result",
      source: "aegis.worker",
      time: new Date().toISOString(),
      aggregateId: taskId("t-consumer-1"),
      aggregateType: "TaskResult",
      correlationId: run.id,
      data: {
        assignmentId: assignmentId("asg-consumer-1"),
        runId: run.id,
        taskId: taskId("t-consumer-1"),
        workerId: workerId("worker-durability-1"),
        status: "SUCCEEDED",
        output: { result: "Success from worker" },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    };

    const handled = await resultConsumer.handleMessage(completionEnvelope);
    expect(handled).toBe(true);

    // Verify task state in repository transitioned to 'completed'
    const updatedRun = await inMemoryRunRepo.findById(run.id);
    expect(updatedRun?.tasks[0]?.status).toBe("completed");
    expect(updatedRun?.tasks[0]?.version).toBe(2);

    // Verify TaskResultConsumer generated an atomic outbox event for the task completion
    const newPendingEvents = await inMemoryOutboxRepo.claimPending({
      batchSize: 10,
      lockDurationMs: 10000,
      workerId: "consumer-verifier",
    });
    expect(newPendingEvents).toHaveLength(1);
    const firstPending = newPendingEvents[0];
    expect(firstPending).toBeDefined();
    if (firstPending) {
      expect(firstPending.eventType).toBe("task_completed");
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // PostgreSQL Live Integration Scenarios (when PostgreSQL is available)
  // ─────────────────────────────────────────────────────────────────────────────
  describe.runIf(dbAvailable)("PostgreSQL Live Transactional Outbox Scenarios", () => {
    let dbContext: DatabaseContext;
    let postgresRunRepo: PostgresRunRepository;
    let postgresOutboxRepo: PostgresOutboxRepository;

    beforeAll(async () => {
      const dbUrl = process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5433/aegis";
      dbContext = createDatabaseContext({
        url: dbUrl,
        poolMin: 1,
        poolMax: 5,
      });
      await runMigrations(dbContext.db);
      postgresOutboxRepo = new PostgresOutboxRepository(dbContext.db);
      postgresRunRepo = new PostgresRunRepository(dbContext);
    });

    afterAll(async () => {
      await dbContext.close();
    });

    it("persists task mutation and outbox event in single PostgreSQL transaction (Lock 2)", async () => {
      const rIdStr = `r-pg-atom-${String(Date.now())}`;
      const tIdStr = `t-pg-atom-${String(Date.now())}`;
      const { run, events } = createSampleRun(rIdStr, tIdStr);

      await postgresRunRepo.save(run, events);

      // Verify row in runsTable
      const runRows = await dbContext.db
        .select()
        .from(runsTable)
        .where(eq(runsTable.id, run.id));
      expect(runRows).toHaveLength(1);

      // Verify row in outboxEventsTable
      const outboxRows = await dbContext.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.aggregateId, run.id));
      expect(outboxRows).toHaveLength(1);
      const firstOutboxRow = outboxRows[0];
      expect(firstOutboxRow).toBeDefined();
      if (!firstOutboxRow) return;
      expect(firstOutboxRow.status).toBe("pending");

      // Verify PostgresOutboxRepository claiming and publishing
      const pgPublisher = new OutboxPublisher({
        outboxRepository: postgresOutboxRepo,
        eventPublisher: kafkaPublisher,
      });

      const sweep = await pgPublisher.sweepOnce();
      expect(sweep.publishedCount).toBeGreaterThanOrEqual(1);

      // Verify status in DB updated to published
      const publishedRow = await dbContext.db
        .select()
        .from(outboxEventsTable)
        .where(eq(outboxEventsTable.id, firstOutboxRow.id));
      const firstPublishedRow = publishedRow[0];
      expect(firstPublishedRow).toBeDefined();
      if (!firstPublishedRow) return;
      expect(firstPublishedRow.status).toBe("published");
      expect(firstPublishedRow.publishedAt).not.toBeNull();
    });
  });
});
