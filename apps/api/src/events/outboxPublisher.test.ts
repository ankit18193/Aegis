import type { EventEnvelope, EventPublishErrorContract, EventPublishResult, IEventPublisher } from "@aegis/contracts";
import { err, eventId, ok, outboxEventId, runId, type Result } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryOutboxRepository } from "../repositories/inMemoryOutboxRepository.js";
import type { CreateOutboxRecord } from "../repositories/outboxRepository.js";

import { OutboxPublisher } from "./outboxPublisher.js";

function createSampleEnvelope(idStr: string, rIdStr: string): EventEnvelope {
  const eId = eventId(idStr);
  const rId = runId(rIdStr);
  const now = new Date().toISOString();
  return {
    id: eId,
    type: "task_completed",
    source: "aegis.api",
    specVersion: "1.0",
    time: now,
    aggregateId: rId,
    aggregateType: "ExecutionRun",
    correlationId: rId,
    data: {
      id: eId,
      runId: rId,
      type: "task_completed",
      severity: "info",
      timestamp: now,
      message: "Task completed",
    },
  };
}

class MockEventPublisher implements IEventPublisher {
  public publishedBatches: EventEnvelope[][] = [];
  public publishedTopics: (string | undefined)[] = [];
  public shouldFail = false;
  public failureError = "Simulated Kafka broker outage";

  publish(envelope: EventEnvelope, topic?: string): Promise<Result<EventPublishResult, EventPublishErrorContract>> {
    return this.publishBatch([envelope], topic).then((res) => {
      if (!res.ok) {
        return err(res.error);
      }
      const first = res.value[0];
      if (first) {
        return ok(first);
      }
      return err({ code: "BROKER_UNAVAILABLE", message: "No publish result" });
    });
  }

  publishBatch(
    envelopes: readonly EventEnvelope[],
    topic?: string,
  ): Promise<Result<readonly EventPublishResult[], EventPublishErrorContract>> {
    if (this.shouldFail) {
      return Promise.resolve(
        err({
          code: "BROKER_UNAVAILABLE" as const,
          message: this.failureError,
        }),
      );
    }

    this.publishedBatches.push([...envelopes]);
    this.publishedTopics.push(topic);
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

describe("OutboxPublisher (Phase 12C — Commit 4)", () => {
  let outboxRepo: InMemoryOutboxRepository;
  let publisher: MockEventPublisher;

  beforeEach(() => {
    outboxRepo = new InMemoryOutboxRepository();
    publisher = new MockEventPublisher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims and publishes pending outbox records, marking them published", async () => {
    const env1 = createSampleEnvelope("evt-1", "run-1");
    const env2 = createSampleEnvelope("evt-2", "run-1");

    const records: CreateOutboxRecord[] = [
      {
        id: outboxEventId("outbox-1"),
        aggregateId: "run-1",
        aggregateType: "ExecutionRun",
        eventType: "task_completed",
        payload: env1,
      },
      {
        id: outboxEventId("outbox-2"),
        aggregateId: "run-1",
        aggregateType: "ExecutionRun",
        eventType: "task_completed",
        payload: env2,
      },
    ];

    await outboxRepo.insert(records);
    expect(await outboxRepo.getPendingCount()).toBe(2);

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: publisher,
      batchSize: 10,
    });

    const result = await outboxPublisher.sweepOnce();
    expect(result.claimedCount).toBe(2);
    expect(result.publishedCount).toBe(2);
    expect(result.failedCount).toBe(0);

    // Verify publisher received both envelopes
    expect(publisher.publishedBatches).toHaveLength(1);
    expect(publisher.publishedBatches[0]).toHaveLength(2);

    // Verify records are no longer pending
    expect(await outboxRepo.getPendingCount()).toBe(0);
    expect(outboxPublisher.publishedCount).toBe(2);
    expect(outboxPublisher.sweepsCount).toBe(1);
  });

  it("returns zero counts when outbox queue is empty", async () => {
    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: publisher,
    });

    const result = await outboxPublisher.sweepOnce();
    expect(result.claimedCount).toBe(0);
    expect(result.publishedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(publisher.publishedBatches).toHaveLength(0);
  });

  it("applies exponential backoff on publication failure and skips locked records on next sweep", async () => {
    const env = createSampleEnvelope("evt-fail-1", "run-fail");
    await outboxRepo.insert([
      {
        id: outboxEventId("outbox-fail-1"),
        aggregateId: "run-fail",
        aggregateType: "ExecutionRun",
        eventType: "task_completed",
        payload: env,
      },
    ]);

    publisher.shouldFail = true;

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: publisher,
      backoffBaseMs: 5000,
      backoffMaxMs: 60000,
    });

    const result = await outboxPublisher.sweepOnce();
    expect(result.claimedCount).toBe(1);
    expect(result.publishedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(outboxPublisher.failedCount).toBe(1);

    // Record remains pending, but locked by backoff
    expect(await outboxRepo.getPendingCount()).toBe(1);

    // Immediate second sweep cannot claim it because lockedUntil is in the future
    const secondResult = await outboxPublisher.sweepOnce();
    expect(secondResult.claimedCount).toBe(0);
    expect(secondResult.publishedCount).toBe(0);
  });

  it("manages background timer lifecycle cleanly with start() and stop()", async () => {
    vi.useFakeTimers();

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: publisher,
      pollIntervalMs: 500,
    });

    expect(outboxPublisher.isRunning).toBe(false);
    outboxPublisher.start();
    expect(outboxPublisher.isRunning).toBe(true);

    // Advance 550ms -> 1 sweep triggered
    await vi.advanceTimersByTimeAsync(550);
    expect(outboxPublisher.sweepsCount).toBeGreaterThanOrEqual(1);

    // Advance another 550ms -> 2 sweeps
    await vi.advanceTimersByTimeAsync(550);
    expect(outboxPublisher.sweepsCount).toBeGreaterThanOrEqual(2);

    await outboxPublisher.stop();
    expect(outboxPublisher.isRunning).toBe(false);

    const sweepsAtStop = outboxPublisher.sweepsCount;
    await vi.advanceTimersByTimeAsync(2000);
    expect(outboxPublisher.sweepsCount).toBe(sweepsAtStop);
  });

  it("drains in-flight sweep batch gracefully when stop() is called", async () => {
    const env = createSampleEnvelope("evt-drain-1", "run-drain");
    await outboxRepo.insert([
      {
        id: outboxEventId("outbox-drain-1"),
        aggregateId: "run-drain",
        aggregateType: "ExecutionRun",
        eventType: "task_completed",
        payload: env,
      },
    ]);

    let signalStarted!: () => void;
    const startedPromise = new Promise<void>((res) => {
      signalStarted = res;
    });

    let releasePublish!: () => void;
    const releasePromise = new Promise<void>((res) => {
      releasePublish = res;
    });

    const delayedPublisher: IEventPublisher = {
      publish: () => Promise.reject(new Error("Unused")),
      publishBatch: async () => {
        signalStarted();
        await releasePromise;
        return ok([{
          success: true,
          topic: "aegis.events",
          partition: 0,
          offset: "1",
          messageId: env.id,
        }]);
      },
    };

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: delayedPublisher,
    });

    // Start sweep asynchronously
    const sweepPromise = outboxPublisher.sweepOnce();

    // Wait until publishBatch is actually executing
    await startedPromise;

    // Call stop() while sweep is in-flight
    const stopPromise = outboxPublisher.stop();

    // Release the in-flight publishBatch
    releasePublish();

    await sweepPromise;
    await stopPromise;

    expect(outboxPublisher.publishedCount).toBe(1);
    expect(await outboxRepo.getPendingCount()).toBe(0);
  });

  it("groups claimed records by target topic and publishes batches to designated topics", async () => {
    const env1 = createSampleEnvelope("evt-topic-1", "run-topic");
    const env2 = createSampleEnvelope("evt-topic-2", "run-topic");
    const env3 = createSampleEnvelope("evt-topic-3", "run-topic");

    const records: CreateOutboxRecord[] = [
      {
        id: outboxEventId("outbox-t1"),
        aggregateId: "run-topic",
        aggregateType: "ExecutionRun",
        eventType: "task_assigned",
        topic: "aegis.tasks.assign.worker-1",
        payload: env1,
      },
      {
        id: outboxEventId("outbox-t2"),
        aggregateId: "run-topic",
        aggregateType: "ExecutionRun",
        eventType: "task_assigned",
        topic: "aegis.tasks.assign.worker-1",
        payload: env2,
      },
      {
        id: outboxEventId("outbox-t3"),
        aggregateId: "run-topic",
        aggregateType: "ExecutionRun",
        eventType: "task_completed",
        // no topic specified -> fallback to defaultTopic
        payload: env3,
      },
    ];

    await outboxRepo.insert(records);

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: publisher,
      defaultTopic: "aegis.events",
    });

    const result = await outboxPublisher.sweepOnce();
    expect(result.claimedCount).toBe(3);
    expect(result.publishedCount).toBe(3);
    expect(result.failedCount).toBe(0);

    // Two distinct batches dispatched to distinct topics
    expect(publisher.publishedBatches).toHaveLength(2);
    expect(publisher.publishedTopics).toContain("aegis.tasks.assign.worker-1");
    expect(publisher.publishedTopics).toContain("aegis.events");
    expect(await outboxRepo.getPendingCount()).toBe(0);
  });

  it("terminates and marks failed records exceeding maxAttempts due to prior process crashes", async () => {
    const env = createSampleEnvelope("evt-exhausted-1", "run-exhausted");

    // Insert record with attemptCount = 3 (when maxAttempts = 3, claimPending will bump to 4)
    await outboxRepo.insert([
      {
        id: outboxEventId("outbox-exhausted-1"),
        aggregateId: "run-exhausted",
        aggregateType: "ExecutionRun",
        eventType: "task_completed",
        payload: env,
        attemptCount: 3,
      },
    ]);

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: publisher,
      maxAttempts: 3,
    });

    const result = await outboxPublisher.sweepOnce();
    expect(result.claimedCount).toBe(1);
    expect(result.publishedCount).toBe(0);
    expect(result.failedCount).toBe(1);

    // Verify publisher was NEVER called for the exhausted record
    expect(publisher.publishedBatches).toHaveLength(0);

    // Verify record transitioned to failed status
    expect(await outboxRepo.getPendingCount()).toBe(0);
    expect(await outboxRepo.getFailedCount()).toBe(1);
  });

  it("handles markPublished error gracefully without crashing publisher loop", async () => {
    const env = createSampleEnvelope("evt-err-1", "run-err");
    await outboxRepo.insert([
      {
        id: outboxEventId("outbox-err-1"),
        aggregateId: "run-err",
        aggregateType: "ExecutionRun",
        eventType: "task_completed",
        payload: env,
      },
    ]);

    // Force outboxRepo.markPublished to reject
    const originalMarkPublished = outboxRepo.markPublished.bind(outboxRepo);
    outboxRepo.markPublished = () => Promise.reject(new Error("Database connection dropped"));

    const outboxPublisher = new OutboxPublisher({
      outboxRepository: outboxRepo,
      eventPublisher: publisher,
    });

    const result = await outboxPublisher.sweepOnce();
    expect(result.claimedCount).toBe(1);
    expect(result.publishedCount).toBe(0);
    expect(result.failedCount).toBe(1);

    // Publisher did send to Kafka (at-least-once bridge intact)
    expect(publisher.publishedBatches).toHaveLength(1);

    // Restore original method
    outboxRepo.markPublished = originalMarkPublished;
  });
});
