/**
 * SseEventGateway Unit Tests — Phase 13C (Commit 2)
 *
 * Coverage:
 * - register() / unregister() lifecycle and idempotency
 * - handleEvent: happy-path fan-out delivery
 * - handleEvent: skip when no active connections
 * - handleEvent: adapter error — drop and return ok (never fails Kafka pipeline)
 * - handleEvent: broadcastToRun error — absorb and return ok
 * - handleEvent: all connections close between check and broadcast (deliveredCount = 0)
 * - deliverRunEvent: direct RunEvent delivery path
 * - metrics: consumed, delivered, dropped, skipped counters
 * - metrics: resetMetrics()
 */

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import type {
  ConsumerRecordMetadata,
  EventEnvelope,
  IEventSubscriber,
  RunEvent,
} from "@aegis/contracts";
import { eventId, runId, taskId } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SseConnection } from "../sseConnection.js";
import { SseEventGateway } from "../sseEventGateway.js";
import { SseTransportManager } from "../sseTransportManager.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — minimal mock stream and subscriber
// ─────────────────────────────────────────────────────────────────────────────

class MockWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    callback: (err?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }
}

/** Minimal in-process event subscriber that records subscriptions and dispatches. */
class MockSubscriber {
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();

  subscribe(type: string, handler: (...args: unknown[]) => unknown): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  unsubscribe(type: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.get(type)?.delete(handler);
  }

  /** Returns all unique handler functions currently subscribed. */
  allHandlers(): Set<(...args: unknown[]) => unknown> {
    const all = new Set<(...args: unknown[]) => unknown>();
    for (const set of this.handlers.values()) {
      for (const h of set) all.add(h);
    }
    return all;
  }

  subscribedTypes(): string[] {
    return [...this.handlers.keys()];
  }

  handlerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }

  async dispatch(
    type: string,
    envelope: EventEnvelope,
    metadata: ConsumerRecordMetadata,
  ): Promise<void> {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of set) {
      await (handler as (e: EventEnvelope, m: ConsumerRecordMetadata) => Promise<unknown>)(
        envelope,
        metadata,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture factories
// ─────────────────────────────────────────────────────────────────────────────

const TEST_RUN_ID = runId(randomUUID());
const TEST_TASK_ID = taskId(randomUUID());

function makeEventEnvelope(
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    id: eventId(randomUUID()),
    type: "task_completed",
    source: "aegis://api",
    specVersion: "1.0",
    time: new Date().toISOString(),
    aggregateId: TEST_RUN_ID,
    aggregateType: "ExecutionRun",
    correlationId: eventId(randomUUID()),
    data: {
      id: eventId(randomUUID()),
      runId: TEST_RUN_ID,
      type: "task_completed",
      severity: "success",
      timestamp: new Date().toISOString(),
      message: "Task completed",
      taskId: TEST_TASK_ID,
      taskName: "test-task",
    },
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<ConsumerRecordMetadata> = {}): ConsumerRecordMetadata {
  return {
    topic: "aegis-execution-events",
    partition: 0,
    offset: "42",
    timestamp: String(Date.now()),
    key: undefined,
    ...overrides,
  };
}

function makeWritableConnection(
  manager: SseTransportManager,
  runIdValue: string = TEST_RUN_ID,
): { stream: MockWritable; connection: SseConnection } {
  const stream = new MockWritable();
  const connection = manager.createConnection(stream, { runId: runIdValue });
  connection.open();
  return { stream, connection };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("SseEventGateway", () => {
  let subscriber: MockSubscriber;
  let transportManager: SseTransportManager;
  let gateway: SseEventGateway;

  beforeEach(() => {
    subscriber = new MockSubscriber();
    transportManager = new SseTransportManager();
    gateway = new SseEventGateway({
      subscriber: subscriber as unknown as IEventSubscriber,
      transportManager,
    });
  });

  afterEach(() => {
    gateway.unregister();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Registration lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  describe("register() / unregister()", () => {
    it("registers handlers for all supported execution event types", () => {
      gateway.register();
      expect(gateway.isRegistered).toBe(true);
      // 13 supported types — each should have exactly 1 handler
      const types = subscriber.subscribedTypes();
      expect(types).toHaveLength(13);
      for (const type of types) {
        expect(subscriber.handlerCount(type)).toBe(1);
      }
    });

    it("register() is idempotent — second call is a no-op", () => {
      gateway.register();
      gateway.register();
      expect(gateway.isRegistered).toBe(true);
      // Should still be exactly 1 handler per type
      for (const type of subscriber.subscribedTypes()) {
        expect(subscriber.handlerCount(type)).toBe(1);
      }
    });

    it("unregister() removes all handlers", () => {
      gateway.register();
      gateway.unregister();
      expect(gateway.isRegistered).toBe(false);
      for (const type of subscriber.subscribedTypes()) {
        expect(subscriber.handlerCount(type)).toBe(0);
      }
    });

    it("unregister() is idempotent when not registered", () => {
      expect(() => gateway.unregister()).not.toThrow();
      expect(gateway.isRegistered).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // handleEvent: happy path fan-out
  // ─────────────────────────────────────────────────────────────────────────

  describe("handleEvent()", () => {
    it("delivers adapted event to an active SSE connection", async () => {
      gateway.register();
      const { stream } = makeWritableConnection(transportManager, TEST_RUN_ID);

      const envelope = makeEventEnvelope();
      const metadata = makeMetadata();

      const result = await gateway.handleEvent(envelope, metadata);

      expect(result.ok).toBe(true);
      // Stream should have received at least one SSE frame
      const written = stream.chunks.join("");
      expect(written).toContain("data:");
      expect(written).toContain("task_completed");
    });

    it("delivers to multiple connections for the same runId", async () => {
      gateway.register();
      const { stream: stream1 } = makeWritableConnection(transportManager, TEST_RUN_ID);
      const { stream: stream2 } = makeWritableConnection(transportManager, TEST_RUN_ID);

      const result = await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      expect(result.ok).toBe(true);
      expect(stream1.chunks.join("")).toContain("data:");
      expect(stream2.chunks.join("")).toContain("data:");
    });

    it("does NOT deliver to connections bound to a different runId", async () => {
      gateway.register();
  const otherRunId = runId(randomUUID());
      makeWritableConnection(transportManager, otherRunId);

      // This connection exists but is for a different run
      const result = await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      expect(result.ok).toBe(true);
      // eventsSkipped because no connections for TEST_RUN_ID
      const metrics = gateway.getMetrics();
      expect(metrics.eventsSkipped).toBe(1);
      expect(metrics.eventsDelivered).toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Skip path
    // ─────────────────────────────────────────────────────────────────────

    it("returns ok and increments eventsSkipped when no connections exist for runId", async () => {
      gateway.register();
      // No connections registered

      const result = await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      expect(result.ok).toBe(true);
      const metrics = gateway.getMetrics();
      expect(metrics.eventsConsumed).toBe(1);
      expect(metrics.eventsSkipped).toBe(1);
      expect(metrics.eventsDelivered).toBe(0);
      expect(metrics.eventsDropped).toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Adapter error path
    // ─────────────────────────────────────────────────────────────────────

    it("returns ok and increments eventsDropped on adapter error (unsupported type)", async () => {
      gateway.register();
      makeWritableConnection(transportManager, TEST_RUN_ID);

      // Use an unsupported event type that won't be adapted
      const envelope = makeEventEnvelope({ type: "run_created" });
      // Force an unsupported payload shape to trigger adapter rejection
      const badEnvelope = {
        ...envelope,
        // aggregateType mismatch — not "ExecutionRun" so adapter will reject
        aggregateType: "UnknownEntity",
        data: "not-a-valid-run-event",
      } as unknown as EventEnvelope;

      const result = await gateway.handleEvent(badEnvelope, makeMetadata());

      expect(result.ok).toBe(true);
      const metrics = gateway.getMetrics();
      expect(metrics.eventsDropped).toBe(1);
      expect(metrics.eventsDelivered).toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // broadcastToRun error path
    // ─────────────────────────────────────────────────────────────────────

    it("returns ok and increments eventsDropped when broadcastToRun throws", async () => {
      gateway.register();
      makeWritableConnection(transportManager, TEST_RUN_ID);

      vi.spyOn(transportManager, "broadcastToRun").mockRejectedValueOnce(
        new Error("Network error"),
      );

      const result = await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      expect(result.ok).toBe(true);
      const metrics = gateway.getMetrics();
      expect(metrics.eventsDropped).toBe(1);
      expect(metrics.eventsDelivered).toBe(0);
    });

    it("returns ok and increments eventsSkipped when broadcast delivers to 0 connections", async () => {
      gateway.register();
      makeWritableConnection(transportManager, TEST_RUN_ID);

      // Stub broadcastToRun to return 0 — all connections closed mid-flight
      vi.spyOn(transportManager, "broadcastToRun").mockResolvedValueOnce(0);

      const result = await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      expect(result.ok).toBe(true);
      const metrics = gateway.getMetrics();
      expect(metrics.eventsSkipped).toBe(1);
      expect(metrics.eventsDelivered).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics
  // ─────────────────────────────────────────────────────────────────────────

  describe("metrics", () => {
    it("starts at zero", () => {
      const m = gateway.getMetrics();
      expect(m.eventsConsumed).toBe(0);
      expect(m.eventsDelivered).toBe(0);
      expect(m.eventsDropped).toBe(0);
      expect(m.eventsSkipped).toBe(0);
    });

    it("increments eventsConsumed and eventsDelivered on successful delivery", async () => {
      gateway.register();
      makeWritableConnection(transportManager, TEST_RUN_ID);

      await gateway.handleEvent(makeEventEnvelope(), makeMetadata());
      await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      const m = gateway.getMetrics();
      expect(m.eventsConsumed).toBe(2);
      expect(m.eventsDelivered).toBe(2);
    });

    it("resetMetrics() resets all counters to zero", async () => {
      gateway.register();
      makeWritableConnection(transportManager, TEST_RUN_ID);
      await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      gateway.resetMetrics();

      const m = gateway.getMetrics();
      expect(m.eventsConsumed).toBe(0);
      expect(m.eventsDelivered).toBe(0);
      expect(m.eventsDropped).toBe(0);
      expect(m.eventsSkipped).toBe(0);
    });

    it("getMetrics() returns a snapshot — mutation does not affect internal state", async () => {
      gateway.register();
      makeWritableConnection(transportManager, TEST_RUN_ID);
      await gateway.handleEvent(makeEventEnvelope(), makeMetadata());

      const snapshot = gateway.getMetrics() as { eventsConsumed: number };
      snapshot.eventsConsumed = 9999;

      expect(gateway.getMetrics().eventsConsumed).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // deliverRunEvent — direct injection path
  // ─────────────────────────────────────────────────────────────────────────

  describe("deliverRunEvent()", () => {
    it("delivers a RunEvent directly to active connections", async () => {
      const { stream } = makeWritableConnection(transportManager, TEST_RUN_ID);

      const runEvent = {
        id: eventId(randomUUID()),
        runId: TEST_RUN_ID,
        type: "run_completed" as const,
        severity: "success" as const,
        timestamp: new Date().toISOString(),
        message: "Run completed successfully",
      };

      const result = await gateway.deliverRunEvent(runEvent, TEST_RUN_ID);

      expect(result.delivered).toBe(1);
      expect(result.dropped).toBe(false);
      expect(stream.chunks.join("")).toContain("run_completed");
    });

    it("returns delivered=0 and dropped=false when no connections", async () => {
      const runEvent = {
        id: eventId(randomUUID()),
        runId: TEST_RUN_ID,
        type: "run_failed" as const,
        severity: "error" as const,
        timestamp: new Date().toISOString(),
        message: "Run failed",
      };

      const result = await gateway.deliverRunEvent(runEvent, TEST_RUN_ID);

      expect(result.delivered).toBe(0);
      expect(result.dropped).toBe(false);
    });

    it("returns dropped=true on adapter error", async () => {
      makeWritableConnection(transportManager, TEST_RUN_ID);

      // Invalid RunEvent — missing required fields
      const badEvent = {
        id: eventId(randomUUID()),
        runId: TEST_RUN_ID,
        type: "unknown_type",
        severity: "info",
        timestamp: new Date().toISOString(),
        message: "Bad event",
      };

      const result = await gateway.deliverRunEvent(
        badEvent as unknown as RunEvent,
        TEST_RUN_ID,
      );

      expect(result.dropped).toBe(true);
      expect(result.delivered).toBe(0);
    });
  });
});
