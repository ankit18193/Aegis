import { eventId, outboxEventId, runId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "./events.js";
import type { IOutboxRepository } from "./outbox.js";
import {
  DEFAULT_OUTBOX_CONFIG,
  OutboxClaimConflictError,
  OutboxError,
  OutboxRecordNotFoundError,
  OutboxSerializationError,
  createOutboxRecordSchema,
  outboxClaimRequestSchema,
  outboxConfigSchema,
  outboxEventIdSchema,
  outboxRecordSchema,
  outboxStatusSchema,
} from "./outbox.js";

describe("Outbox Contracts & Schemas", () => {
  const sampleEventId = eventId("evt-run-created-1");
  const sampleRunId = runId("run-alpha");
  const sampleOutboxId = outboxEventId("outbox-12345");
  const sampleTime = "2026-10-05T12:00:00.000Z";

  const sampleEnvelope: EventEnvelope = {
    id: sampleEventId,
    type: "run_created",
    source: "aegis.execution",
    specVersion: "1.0",
    time: sampleTime,
    aggregateId: sampleRunId,
    aggregateType: "ExecutionRun",
    correlationId: sampleRunId,
    data: {
      id: sampleEventId,
      runId: sampleRunId,
      type: "run_created",
      severity: "info",
      timestamp: sampleTime,
      message: "Execution run created",
    },
  };

  describe("outboxEventIdSchema", () => {
    it("parses valid non-empty string and brands it as OutboxEventId", () => {
      const parsed = outboxEventIdSchema.parse("outbox-test-1");
      expect(parsed).toBe("outbox-test-1");
    });

    it("rejects empty string", () => {
      expect(() => outboxEventIdSchema.parse("")).toThrow();
    });
  });

  describe("outboxStatusSchema", () => {
    it("accepts canonical outbox lifecycle statuses", () => {
      expect(outboxStatusSchema.parse("pending")).toBe("pending");
      expect(outboxStatusSchema.parse("publishing")).toBe("publishing");
      expect(outboxStatusSchema.parse("published")).toBe("published");
      expect(outboxStatusSchema.parse("failed")).toBe("failed");
    });

    it("rejects non-canonical status values", () => {
      expect(() => outboxStatusSchema.parse("in_progress")).toThrow();
      expect(() => outboxStatusSchema.parse("done")).toThrow();
      expect(() => outboxStatusSchema.parse("")).toThrow();
    });
  });

  describe("outboxRecordSchema", () => {
    it("validates a full pending OutboxRecord with pre-built EventEnvelope", () => {
      const record = outboxRecordSchema.parse({
        id: sampleOutboxId,
        aggregateId: sampleRunId,
        aggregateType: "run",
        eventType: "run_created",
        payload: sampleEnvelope,
        status: "pending",
        attemptCount: 0,
        createdAt: sampleTime,
      });

      expect(record.id).toBe(sampleOutboxId);
      expect(record.aggregateId).toBe(sampleRunId);
      expect(record.status).toBe("pending");
      expect(record.payload.id).toBe(sampleEventId);
      expect(record.payload.type).toBe("run_created");
      expect(record.attemptCount).toBe(0);
      expect(record.lockedUntil).toBeUndefined();
      expect(record.publishedAt).toBeUndefined();
    });

    it("validates a record with claiming metadata (status='publishing')", () => {
      const lockedUntil = "2026-10-05T12:00:30.000Z";
      const record = outboxRecordSchema.parse({
        id: sampleOutboxId,
        aggregateId: sampleRunId,
        aggregateType: "run",
        eventType: "run_created",
        payload: sampleEnvelope,
        status: "publishing",
        attemptCount: 1,
        lockedUntil,
        lockedBy: "worker-publisher-1",
        createdAt: sampleTime,
      });

      expect(record.status).toBe("publishing");
      expect(record.attemptCount).toBe(1);
      expect(record.lockedUntil).toBe(lockedUntil);
      expect(record.lockedBy).toBe("worker-publisher-1");
    });

    it("validates a successfully published record (status='published')", () => {
      const publishedAt = "2026-10-05T12:00:05.000Z";
      const record = outboxRecordSchema.parse({
        id: sampleOutboxId,
        aggregateId: sampleRunId,
        aggregateType: "run",
        eventType: "run_created",
        payload: sampleEnvelope,
        status: "published",
        attemptCount: 1,
        publishedAt,
        createdAt: sampleTime,
      });

      expect(record.status).toBe("published");
      expect(record.publishedAt).toBe(publishedAt);
    });

    it("validates a failed record with lastError and incremented attempts", () => {
      const record = outboxRecordSchema.parse({
        id: sampleOutboxId,
        aggregateId: sampleRunId,
        aggregateType: "run",
        eventType: "run_created",
        payload: sampleEnvelope,
        status: "failed",
        attemptCount: 5,
        lastError: "Kafka broker connection timeout (5000ms)",
        createdAt: sampleTime,
      });

      expect(record.status).toBe("failed");
      expect(record.attemptCount).toBe(5);
      expect(record.lastError).toBe("Kafka broker connection timeout (5000ms)");
    });

    it("rejects record with negative attemptCount", () => {
      expect(() =>
        outboxRecordSchema.parse({
          id: sampleOutboxId,
          aggregateId: sampleRunId,
          aggregateType: "run",
          eventType: "run_created",
          payload: sampleEnvelope,
          status: "pending",
          attemptCount: -1,
          createdAt: sampleTime,
        }),
      ).toThrow();
    });

    it("rejects record with invalid envelope payload", () => {
      expect(() =>
        outboxRecordSchema.parse({
          id: sampleOutboxId,
          aggregateId: sampleRunId,
          aggregateType: "run",
          eventType: "run_created",
          payload: { invalid: "payload missing required fields" },
          status: "pending",
          attemptCount: 0,
          createdAt: sampleTime,
        }),
      ).toThrow();
    });
  });

  describe("createOutboxRecordSchema", () => {
    it("supplies default status 'pending' and attemptCount 0", () => {
      const created = createOutboxRecordSchema.parse({
        aggregateId: sampleRunId,
        aggregateType: "run",
        eventType: "run_created",
        payload: sampleEnvelope,
      });

      expect(created.status).toBe("pending");
      expect(created.attemptCount).toBe(0);
      expect(created.aggregateId).toBe(sampleRunId);
    });
  });

  describe("outboxClaimRequestSchema", () => {
    it("parses valid claim request with defaults", () => {
      const request = outboxClaimRequestSchema.parse({
        workerId: "pod-1",
      });

      expect(request.batchSize).toBe(100);
      expect(request.lockDurationMs).toBe(30000);
      expect(request.workerId).toBe("pod-1");
    });

    it("rejects non-positive batchSize or lockDurationMs", () => {
      expect(() =>
        outboxClaimRequestSchema.parse({
          workerId: "pod-1",
          batchSize: 0,
        }),
      ).toThrow();

      expect(() =>
        outboxClaimRequestSchema.parse({
          workerId: "pod-1",
          lockDurationMs: -100,
        }),
      ).toThrow();
    });
  });

  describe("outboxConfigSchema & DEFAULT_OUTBOX_CONFIG", () => {
    it("validates default configuration constants", () => {
      const parsed = outboxConfigSchema.parse(DEFAULT_OUTBOX_CONFIG);
      expect(parsed.pollIntervalMs).toBe(500);
      expect(parsed.batchSize).toBe(100);
      expect(parsed.lockDurationMs).toBe(30000);
      expect(parsed.maxAttempts).toBe(5);
      expect(parsed.backoffBaseMs).toBe(1000);
      expect(parsed.backoffMaxMs).toBe(60000);
    });

    it("is frozen and immutable", () => {
      expect(Object.isFrozen(DEFAULT_OUTBOX_CONFIG)).toBe(true);
    });
  });

  describe("Typed Outbox Errors", () => {
    it("instantiates base OutboxError correctly", () => {
      const error = new OutboxError("OUTBOX_INSERT_FAILED", "Failed to insert outbox batch");
      expect(error.code).toBe("OUTBOX_INSERT_FAILED");
      expect(error.message).toBe("Failed to insert outbox batch");
      expect(error.name).toBe("OutboxError");
    });

    it("instantiates OutboxClaimConflictError with cause", () => {
      const cause = new Error("DB lock timeout");
      const error = new OutboxClaimConflictError("Claim failed due to contention", cause);
      expect(error.code).toBe("OUTBOX_CLAIM_FAILED");
      expect(error.cause).toBe(cause);
      expect(error.name).toBe("OutboxClaimConflictError");
    });

    it("instantiates OutboxSerializationError correctly", () => {
      const error = new OutboxSerializationError("Payload json circular ref");
      expect(error.code).toBe("OUTBOX_SERIALIZATION_FAILED");
      expect(error.name).toBe("OutboxSerializationError");
    });

    it("instantiates OutboxRecordNotFoundError with branded ID", () => {
      const error = new OutboxRecordNotFoundError(sampleOutboxId);
      expect(error.code).toBe("OUTBOX_RECORD_NOT_FOUND");
      expect(error.outboxId).toBe(sampleOutboxId);
      expect(error.message).toContain(sampleOutboxId);
      expect(error.name).toBe("OutboxRecordNotFoundError");
    });
  });

  describe("IOutboxRepository Contract Shape", () => {
    it("allows an object to satisfy IOutboxRepository interface", async () => {
      const repo: IOutboxRepository = {
        insert: () => Promise.resolve(),
        claimPending: () => Promise.resolve([]),
        markPublished: () => Promise.resolve(),
        markFailed: () => Promise.resolve(),
        getPendingCount: () => Promise.resolve(0),
        getFailedCount: () => Promise.resolve(0),
      };

      expect(repo).toBeDefined();
      expect(typeof repo.insert).toBe("function");
      expect(typeof repo.claimPending).toBe("function");
      expect(typeof repo.markPublished).toBe("function");
      expect(typeof repo.markFailed).toBe("function");
      expect(await repo.getPendingCount()).toBe(0);
      expect(await repo.getFailedCount()).toBe(0);
    });
  });
});
