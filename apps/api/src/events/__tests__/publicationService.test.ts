import type { EventEnvelope, RunEvent } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { RunId, TaskId } from "@aegis/types";
import { eventId, runId, taskId } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import type { DomainEvent } from "../../domain/events.js";
import { KafkaNotConnectedError } from "../errors.js";
import { InMemoryEventPublisher } from "../inMemoryPublisher.js";
import { EventPublicationService } from "../publicationService.js";

describe("EventPublicationService (Phase 10C — Commit 1)", () => {
  const sampleRunId: RunId = runId("run-test-10c");
  const sampleTaskId: TaskId = taskId("task-test-10c-1");

  const sampleRunEvent: RunEvent = {
    id: eventId("evt-10c-run-1"),
    runId: sampleRunId,
    type: "run_created",
    severity: "info",
    timestamp: "2026-10-01T20:00:00.000Z",
    message: "Run created with goal: 'Test 10C publication'",
  };

  const sampleDomainEvent: DomainEvent = {
    id: "evt-10c-dom-1",
    runId: sampleRunId,
    type: "task_started",
    taskId: sampleTaskId,
    taskName: "Execute Step 1",
    timestamp: "2026-10-01T20:00:05.000Z",
  };

  it("returns empty array when publishing empty run events list", async () => {
    const publisher = new InMemoryEventPublisher();
    const service = new EventPublicationService(publisher);

    const result = await service.publishRunEvents([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
    expect(publisher.getPublishedEnvelopes()).toHaveLength(0);
  });

  it("publishes canonical RunEvent wrapped in EventEnvelope with CloudEvents metadata", async () => {
    const publisher = new InMemoryEventPublisher();
    const service = new EventPublicationService(publisher, {
      source: "aegis.execution.test",
    });

    const result = await service.publishRunEvents([sampleRunEvent]);
    expect(result.ok).toBe(true);

    const published = publisher.getPublishedEnvelopes();
    expect(published).toHaveLength(1);

    const envelope = published[0];
    expect(envelope).toBeDefined();
    if (envelope) {
      expect(envelope.id).toBe("evt-10c-run-1");
      expect(envelope.type).toBe("run_created");
      expect(envelope.source).toBe("aegis.execution.test");
      expect(envelope.specVersion).toBe("1.0");
      expect(envelope.time).toBe("2026-10-01T20:00:00.000Z");
      expect(envelope.aggregateId).toBe(sampleRunId);
      expect(envelope.aggregateType).toBe("ExecutionRun");
      expect(envelope.correlationId).toBe(sampleRunId);
      expect(envelope.data).toEqual(sampleRunEvent);
    }
  });

  it("preserves custom correlationId, causationId, and source overrides", async () => {
    const publisher = new InMemoryEventPublisher();
    const service = new EventPublicationService(publisher);

    const result = await service.publishRunEvents([sampleRunEvent], {
      source: "custom.source",
      correlationId: "corr-12345",
      causationId: "caus-67890",
    });
    expect(result.ok).toBe(true);

    const published = publisher.getPublishedEnvelopes();
    const envelope = published[0];
    expect(envelope).toBeDefined();
    if (envelope) {
      expect(envelope.source).toBe("custom.source");
      expect(envelope.correlationId).toBe("corr-12345");
      expect(envelope.causationId).toBe("caus-67890");
    }
  });

  it("strictly maps DomainEvent to RunEvent and publishes through publishRunEvents", async () => {
    const publisher = new InMemoryEventPublisher();
    const service = new EventPublicationService(publisher);

    const spyPublishRunEvents = vi.spyOn(service, "publishRunEvents");

    const result = await service.publishDomainEvents([sampleDomainEvent]);
    expect(result.ok).toBe(true);

    expect(spyPublishRunEvents).toHaveBeenCalledTimes(1);
    const firstCallArgs = spyPublishRunEvents.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
    if (firstCallArgs) {
      const calledRunEvents: readonly RunEvent[] = firstCallArgs[0];
      expect(calledRunEvents).toHaveLength(1);
      const firstEvent = calledRunEvents[0];
      expect(firstEvent).toBeDefined();
      if (firstEvent) {
        expect(firstEvent.type).toBe("task_started");
        expect(firstEvent.taskId).toBe(sampleTaskId);
        expect(firstEvent.runId).toBe(sampleRunId);
      }
    }

    const published = publisher.getPublishedEnvelopes();
    expect(published).toHaveLength(1);
    const envelope: EventEnvelope | undefined = published[0];
    expect(envelope).toBeDefined();
    if (envelope) {
      expect(envelope.id).toBe(sampleDomainEvent.id);
      expect(envelope.type).toBe("task_started");
      expect(envelope.aggregateId).toBe(sampleRunId);
      expect(envelope.data.taskId).toBe(sampleTaskId);
    }
  });

  it("returns empty array when publishing empty domain events list", async () => {
    const publisher = new InMemoryEventPublisher();
    const service = new EventPublicationService(publisher);

    const result = await service.publishDomainEvents([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
    expect(publisher.getPublishedEnvelopes()).toHaveLength(0);
  });

  it("handles publisher failure gracefully, logs warning, and returns err without throwing", async () => {
    const publisher = new InMemoryEventPublisher();
    publisher.simulateFailure(
      new KafkaNotConnectedError("Simulated Kafka disconnected error"),
    );

    const warnSpy = vi.fn();
    const mockLogger: Logger = {
      warn: warnSpy,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;

    const service = new EventPublicationService(publisher, {
      logger: mockLogger,
    });

    const result = await service.publishRunEvents([sampleRunEvent]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KAFKA_NOT_CONNECTED");
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to publish event envelopes"),
      expect.objectContaining({
        errorCode: "KAFKA_NOT_CONNECTED",
        envelopeCount: 1,
      }),
    );
  });
});
