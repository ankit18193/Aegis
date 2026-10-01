import net from "node:net";

import { loadKafkaConfig } from "@aegis/config";
import type { EventEnvelope, RunEvent } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { eventId, runId, taskId } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import { DeterministicPlanner } from "../../../agent/planner.js";
import { InMemoryDeduplicator } from "../../../events/deduplicator.js";
import { KafkaNotConnectedError } from "../../../events/errors.js";
import { InMemoryEventPublisher } from "../../../events/inMemoryPublisher.js";
import { InMemoryEventSubscriber } from "../../../events/inMemorySubscriber.js";
import { EventPublicationService } from "../../../events/publicationService.js";
import { AuditSubscriber } from "../../../events/subscribers/auditSubscriber.js";
import { InMemoryRunRepository } from "../../../repositories/inMemoryRunRepository.js";
import { AgentRunService } from "../../../services/agentRunService.js";
import { InProcessExecutionDispatcher } from "../../../services/executionDispatcher.js";
import { KafkaClientManager } from "../client.js";
import { KafkaEventPublisher } from "../publisher.js";

async function isKafkaBrokerAvailable(host = "127.0.0.1", port = 9092, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
}

describe("End-to-End Event Backbone Integration (Phase 10C — Commit 5)", () => {
  it("executes complete lifecycle: Service -> DB -> EventEnvelope -> Publisher -> Subscriber -> AuditSubscriber", async () => {
    const repository = new InMemoryRunRepository(false);
    const publisher = new InMemoryEventPublisher();
    const subscriber = new InMemoryEventSubscriber();
    const deduplicator = new InMemoryDeduplicator(1000);

    const publicationService = new EventPublicationService(publisher, {
      source: "aegis.execution",
    });

    const auditSubscriber = new AuditSubscriber(subscriber);
    auditSubscriber.register();
    await subscriber.start();

    // Wire up publisher -> subscriber transmission double
    const originalPublishBatch = publisher.publishBatch.bind(publisher);
    publisher.publishBatch = vi.fn().mockImplementation(async (envelopes: readonly EventEnvelope[]) => {
      const pubResult = await originalPublishBatch(envelopes);
      if (pubResult.ok) {
        for (const env of envelopes) {
          await subscriber.dispatch(env, {
            topic: "aegis.events",
            partition: 0,
            offset: "100",
          });
        }
      }
      return pubResult;
    });

    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "echo", payload: { text: "E2E Step 1" } } },
      { type: "complete", summary: "E2E Run completed successfully" },
    ]);
    const dispatcher = new InProcessExecutionDispatcher();

    const service = new AgentRunService(repository, undefined, {
      planner,
      dispatcher,
      autoExecute: true,
      stepDelayMs: 0,
      eventPublicationService: publicationService,
    });

    const customTasks = [
      {
        id: taskId("task-e2e-1"),
        name: "E2E Data Extraction",
        description: "Extract telemetry records from cluster",
      },
      {
        id: taskId("task-e2e-2"),
        name: "E2E Analysis & Synthesis",
        description: "Analyze extracted records and synthesize report",
        dependencies: [taskId("task-e2e-1")],
      },
    ];

    // 1. Create Run
    const createResult = await service.createRun({
      goal: "End-to-end event transport validation",
      tasks: customTasks,
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const runIdVal = createResult.value.run.id;

    // 2. Await full background workflow completion
    await service.awaitRunCompletion(runIdVal);

    // 3. Verify PostgreSQL repository state (Source of Truth)
    const runInDb = await repository.findById(runIdVal);
    expect(runInDb).not.toBeNull();
    expect(runInDb?.status).toBe("completed");
    expect(runInDb?.progress).toBe(100);

    const dbEvents = await repository.findEvents(runIdVal);
    expect(dbEvents.length).toBeGreaterThanOrEqual(4);

    // 4. Verify Published Envelopes
    const publishedEnvelopes = publisher.getPublishedEnvelopes();
    expect(publishedEnvelopes.length).toBe(dbEvents.length);

    // 5. Verify Invariant Preservations (Event ID, Run ID, Correlation ID, CloudEvents)
    for (let i = 0; i < publishedEnvelopes.length; i += 1) {
      const env = publishedEnvelopes[i];
      const dbEvt = dbEvents[i];
      expect(env).toBeDefined();
      expect(dbEvt).toBeDefined();
      if (env && dbEvt) {
        expect(env.id).toBe(dbEvt.id);
        expect(env.aggregateId).toBe(runIdVal);
        expect(env.correlationId).toBe(runIdVal);
        expect(env.specVersion).toBe("1.0");
        expect(env.source).toBe("aegis.execution");
        expect(env.type).toBe(dbEvt.type);
      }
    }

    // 6. Verify AuditSubscriber Observation (Lock 5: Pure Read-Only Observer)
    const auditRecords = auditSubscriber.getRecordsByRunId(runIdVal);
    expect(auditRecords.length).toBe(publishedEnvelopes.length);

    const auditTypes = auditRecords.map((r) => r.type);
    expect(auditTypes).toContain("run_created");
    expect(auditTypes).toContain("task_started");
    expect(auditTypes).toContain("task_completed");
    expect(auditTypes).toContain("run_completed");

    // Clean up
    await subscriber.stop();
    deduplicator.clear();
  });

  it("verifies dual-write failure containment: PostgreSQL remains intact when Kafka publisher fails", async () => {
    const repository = new InMemoryRunRepository(false);
    const publisher = new InMemoryEventPublisher();
    publisher.simulateFailure(new KafkaNotConnectedError("Connection refused by Kafka broker"));

    const warnSpy = vi.fn();
    const mockLogger: Logger = {
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    const publicationService = new EventPublicationService(publisher, {
      logger: mockLogger,
    });

    const service = new AgentRunService(repository, mockLogger, {
      autoExecute: false,
      eventPublicationService: publicationService,
    });

    const result = await service.createRun({
      goal: "Dual-write containment test",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Database state must be persisted
    const saved = await repository.findById(result.value.run.id);
    expect(saved).not.toBeNull();
    expect(saved?.status).toBe("pending");

    // Warning logged identifying publisher failure without failing operation
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Post-commit event publication failed"),
      expect.objectContaining({
        errorCode: "KAFKA_NOT_CONNECTED",
      }),
    );
  });

  it("verifies FIFO partition key affinity: envelope.aggregateId is always the partition key", async () => {
    const publisher = new InMemoryEventPublisher();
    const service = new EventPublicationService(publisher);

    const testRunId = runId("run-partition-key-test");
    const testEvent: RunEvent = {
      id: eventId("evt-fifo-1"),
      runId: testRunId,
      type: "task_started",
      severity: "info",
      timestamp: "2026-10-01T21:30:00.000Z",
      message: "FIFO key verification",
    };

    const pubResult = await service.publishRunEvents([testEvent]);
    expect(pubResult.ok).toBe(true);

    const published = publisher.getPublishedEnvelopes();
    expect(published).toHaveLength(1);
    const env = published[0];
    expect(env).toBeDefined();
    if (env) {
      expect(env.aggregateId).toBe(testRunId);
      expect(env.id).toBe("evt-fifo-1");
    }
  });

  it("optional live broker test: publishes to live Kafka if broker port 9092 is available", async () => {
    const isLive = await isKafkaBrokerAvailable("127.0.0.1", 9092);
    if (!isLive) {
      // Skips cleanly when broker is not running locally (hermetic parity)
      expect(true).toBe(true);
      return;
    }

    const clientManager = new KafkaClientManager({
      config: loadKafkaConfig({
        KAFKA_BROKERS: "127.0.0.1:9092",
        KAFKA_CLIENT_ID: "aegis-e2e-test",
      }),
    });

    const livePublisher = new KafkaEventPublisher({
      producer: clientManager.getProducer(),
      topic: "aegis.events",
    });

    const connectRes = await livePublisher.connect();
    expect(connectRes.ok).toBe(true);

    const envelope: EventEnvelope = {
      id: eventId("evt-e2e-live-1"),
      type: "run_created",
      source: "aegis.test.live",
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: runId("run-e2e-live-101"),
      aggregateType: "ExecutionRun",
      correlationId: "run-e2e-live-101",
      data: {
        id: eventId("evt-e2e-live-1"),
        runId: runId("run-e2e-live-101"),
        type: "run_created",
        severity: "info",
        timestamp: new Date().toISOString(),
        message: "Live Kafka E2E event",
      },
    };

    const pubRes = await livePublisher.publish(envelope);
    expect(pubRes.ok).toBe(true);
    if (pubRes.ok) {
      expect(pubRes.value.topic).toBe("aegis.events");
      expect(pubRes.value.partition).toBeGreaterThanOrEqual(0);
    }

    await livePublisher.disconnect();
  });
});
