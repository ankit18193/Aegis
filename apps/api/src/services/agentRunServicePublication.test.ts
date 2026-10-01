import type { EventEnvelope } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { describe, expect, it, vi } from "vitest";

import { DeterministicPlanner } from "../agent/planner.js";
import { KafkaNotConnectedError } from "../events/errors.js";
import { InMemoryEventPublisher } from "../events/inMemoryPublisher.js";
import { EventPublicationService } from "../events/publicationService.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";

import { AgentRunService } from "./agentRunService.js";
import { InProcessExecutionDispatcher } from "./executionDispatcher.js";

describe("AgentRunService — Post-Commit Event Publication (Phase 10C — Commit 2)", () => {
  it("publishes run_created event strictly post-commit during createRun", async () => {
    const repository = new InMemoryRunRepository(false);
    const publisher = new InMemoryEventPublisher();
    const publicationService = new EventPublicationService(publisher);

    const callOrder: string[] = [];
    const originalSave = repository.save.bind(repository);
    repository.save = vi.fn().mockImplementation(async (...args: Parameters<typeof originalSave>) => {
      callOrder.push("repository.save");
      return originalSave(...args);
    });

    const originalPublish = publicationService.publishRunEvents.bind(publicationService);
    const spyPublish = vi.spyOn(publicationService, "publishRunEvents").mockImplementation(async (events, options) => {
      callOrder.push("publicationService.publishRunEvents");
      return originalPublish(events, options);
    });

    const service = new AgentRunService(repository, undefined, {
      autoExecute: false,
      eventPublicationService: publicationService,
    });

    const result = await service.createRun({
      goal: "Audit container memory footprints",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify ordering: DB commit precedes publication
    expect(callOrder).toEqual(["repository.save", "publicationService.publishRunEvents"]);

    // Verify published envelope
    const published = publisher.getPublishedEnvelopes();
    expect(published).toHaveLength(1);
    const envelope = published[0];
    expect(envelope).toBeDefined();
    if (envelope) {
      expect(envelope.type).toBe("run_created");
      expect(envelope.aggregateId).toBe(result.value.run.id);
      expect(envelope.correlationId).toBe(result.value.run.id);
      expect(envelope.data.type).toBe("run_created");
    }

    spyPublish.mockRestore();
  });

  it("publishes task lifecycle and completion events strictly post-commit during executeRun", async () => {
    const repository = new InMemoryRunRepository(false);
    const publisher = new InMemoryEventPublisher();
    const publicationService = new EventPublicationService(publisher);
    const dispatcher = new InProcessExecutionDispatcher();

    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "echo", payload: { text: "Step 1" } } },
      { type: "complete", summary: "Workflow finished" },
    ]);

    const service = new AgentRunService(repository, undefined, {
      planner,
      dispatcher,
      autoExecute: true,
      stepDelayMs: 0,
      eventPublicationService: publicationService,
    });

    const result = await service.createRun({
      goal: "Execute multi-task workflow with event publication",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runId = result.value.run.id;
    await service.awaitRunCompletion(runId);

    const published = publisher.getPublishedEnvelopes();
    // Must contain run_created, workflow/task events, and terminal run_completed
    expect(published.length).toBeGreaterThanOrEqual(4);

    const types = published.map((e: EventEnvelope) => e.type);
    expect(types).toContain("run_created");
    expect(types).toContain("task_started");
    expect(types).toContain("task_completed");
    expect(types).toContain("run_completed");

    // All envelopes must preserve runId as aggregateId
    for (const env of published) {
      expect(env.aggregateId).toBe(runId);
      expect(env.specVersion).toBe("1.0");
    }
  });

  it("publishes run_cancelled and task_cancelled events strictly post-commit during cancelRun", async () => {
    const repository = new InMemoryRunRepository(false);
    const publisher = new InMemoryEventPublisher();
    const publicationService = new EventPublicationService(publisher);

    const service = new AgentRunService(repository, undefined, {
      autoExecute: false,
      eventPublicationService: publicationService,
    });

    const createResult = await service.createRun({
      goal: "Run to be cancelled",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const runId = createResult.value.run.id;
    // Clear envelopes from createRun to isolate cancelRun
    publisher.clear();

    const cancelResult = await service.cancelRun(runId, {
      reason: "Execution budget exceeded",
    });

    expect(cancelResult.ok).toBe(true);
    if (!cancelResult.ok) return;

    const published = publisher.getPublishedEnvelopes();
    // 4 tasks cancelled + 1 run_cancelled = 5 events
    expect(published).toHaveLength(5);
    const types = published.map((e: EventEnvelope) => e.type);
    expect(types).toContain("task_cancelled");
    expect(types).toContain("run_cancelled");

    const runCancelledEnv = published.find((e) => e.type === "run_cancelled");
    expect(runCancelledEnv).toBeDefined();
    if (runCancelledEnv) {
      expect(runCancelledEnv.aggregateId).toBe(runId);
      expect(runCancelledEnv.data.message).toContain("Execution budget exceeded");
    }

  });

  it("failure containment: createRun and cancelRun succeed even if Kafka publish fails", async () => {
    const repository = new InMemoryRunRepository(false);
    const publisher = new InMemoryEventPublisher();
    // Simulate broker disconnect
    publisher.simulateFailure(
      new KafkaNotConnectedError("Simulated Kafka cluster outage"),
    );

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

    // 1. createRun should succeed despite Kafka failure
    const createResult = await service.createRun({
      goal: "Resilience check during Kafka outage",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const runId = createResult.value.run.id;
    // Verify run was persisted in DB
    const persisted = await repository.findById(runId);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("pending");

    // Verify structured warning logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Post-commit event publication failed"),
      expect.objectContaining({
        errorCode: "KAFKA_NOT_CONNECTED",
      }),
    );

    // 2. cancelRun should also succeed despite Kafka failure
    warnSpy.mockClear();
    const cancelResult = await service.cancelRun(runId, {
      reason: "Emergency kill switch",
    });

    expect(cancelResult.ok).toBe(true);
    const cancelledPersisted = await repository.findById(runId);
    expect(cancelledPersisted?.status).toBe("cancelled");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Post-commit event publication failed"),
      expect.objectContaining({
        errorCode: "KAFKA_NOT_CONNECTED",
      }),
    );
  });
});
