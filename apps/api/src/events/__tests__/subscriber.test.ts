import type { EventEnvelope, EventHandler, RunEvent } from "@aegis/contracts";
import { eventId, ok, runId, taskId } from "@aegis/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryDeduplicator } from "../deduplicator.js";
import { toEventEnvelope } from "../envelope.js";
import { HandlerExecutionError } from "../errors.js";
import { InMemoryEventSubscriber } from "../inMemorySubscriber.js";

describe("Consumer Contracts, InMemorySubscriber & Deduplicator (Phase 10B)", () => {
  let sampleEvent: RunEvent;
  let sampleEnvelope: EventEnvelope;

  beforeEach(() => {
    sampleEvent = {
      id: eventId("evt-sub-101"),
      runId: runId("run-sub-202"),
      type: "task_started",
      severity: "info",
      timestamp: "2026-09-24T12:00:00.000Z",
      message: "Task started",
      taskId: taskId("task-303"),
      taskName: "Build",
    };
    sampleEnvelope = toEventEnvelope(sampleEvent);
  });

  describe("InMemoryDeduplicator", () => {
    it("identifies new and duplicate event IDs correctly", () => {
      const dedup = new InMemoryDeduplicator(10);
      expect(dedup.size).toBe(0);

      expect(dedup.isDuplicate("evt-1")).toBe(false);
      expect(dedup.size).toBe(1);

      expect(dedup.isDuplicate("evt-1")).toBe(true);
      expect(dedup.size).toBe(1);

      expect(dedup.isDuplicate("evt-2")).toBe(false);
      expect(dedup.size).toBe(2);
    });

    it("enforces sliding window eviction when capacity is exceeded", () => {
      const dedup = new InMemoryDeduplicator(3);

      expect(dedup.isDuplicate("evt-1")).toBe(false);
      expect(dedup.isDuplicate("evt-2")).toBe(false);
      expect(dedup.isDuplicate("evt-3")).toBe(false);
      expect(dedup.size).toBe(3);

      // Inserting 4th element should evict evt-1
      expect(dedup.isDuplicate("evt-4")).toBe(false);
      expect(dedup.size).toBe(3);

      // evt-1 should now be forgotten (returns false if re-encountered)
      expect(dedup.isDuplicate("evt-1")).toBe(false);

      // evt-2 was now evicted because evt-1 was pushed
      expect(dedup.isDuplicate("evt-3")).toBe(true);
      expect(dedup.isDuplicate("evt-4")).toBe(true);
    });

    it("resets state on clear()", () => {
      const dedup = new InMemoryDeduplicator(10);
      dedup.isDuplicate("evt-1");
      dedup.isDuplicate("evt-2");
      expect(dedup.size).toBe(2);

      dedup.clear();
      expect(dedup.size).toBe(0);
      expect(dedup.isDuplicate("evt-1")).toBe(false);
    });

    it("rejects non-positive maxEntries", () => {
      expect(() => new InMemoryDeduplicator(0)).toThrow(/must be greater than 0/);
      expect(() => new InMemoryDeduplicator(-5)).toThrow(/must be greater than 0/);
    });
  });

  describe("InMemoryEventSubscriber", () => {
    it("allows registering subscriptions before startup (independent registration)", async () => {
      const subscriber = new InMemoryEventSubscriber();
      const mockHandler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));

      // Independent registration: register BEFORE start
      subscriber.subscribe("task_started", mockHandler);
      expect(subscriber.getHandlerCount("task_started")).toBe(1);
      expect(subscriber.isRunning).toBe(false);

      // Startup
      const startRes = await subscriber.start();
      expect(startRes.ok).toBe(true);
      expect(subscriber.isRunning).toBe(true);

      // Dispatch
      const dispatchRes = await subscriber.dispatch(sampleEnvelope);
      expect(dispatchRes.ok).toBe(true);
      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockHandler).toHaveBeenCalledWith(
        sampleEnvelope,
        expect.objectContaining({
          topic: "in-memory.events",
          partition: 0,
          offset: "0",
          key: sampleEnvelope.aggregateId,
        }),
      );

      // Shutdown
      const stopRes = await subscriber.stop();
      expect(stopRes.ok).toBe(true);
      expect(subscriber.isRunning).toBe(false);
    });

    it("routes events to wildcard '*' handlers and specific handlers", async () => {
      const subscriber = new InMemoryEventSubscriber();
      const specificHandler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));
      const wildcardHandler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));

      subscriber.subscribe("task_started", specificHandler);
      subscriber.subscribe("*", wildcardHandler);

      await subscriber.start();

      await subscriber.dispatch(sampleEnvelope);
      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(1);

      // An event with a different type should only reach wildcard
      const otherEnvelope = toEventEnvelope({
        ...sampleEvent,
        id: eventId("evt-sub-999"),
        type: "run_created",
      });
      await subscriber.dispatch(otherEnvelope);
      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(wildcardHandler).toHaveBeenCalledTimes(2);
    });

    it("suppresses duplicate events when deduplicator is attached", async () => {
      const dedup = new InMemoryDeduplicator(100);
      const subscriber = new InMemoryEventSubscriber(dedup);
      const handler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));

      subscriber.subscribe("task_started", handler);
      await subscriber.start();

      // First dispatch
      const res1 = await subscriber.dispatch(sampleEnvelope);
      expect(res1.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);

      // Second dispatch with same event ID -> suppressed
      const res2 = await subscriber.dispatch(sampleEnvelope);
      expect(res2.ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1); // handler NOT called again
    });

    it("handles unsubscribe correctly", async () => {
      const subscriber = new InMemoryEventSubscriber();
      const handler: EventHandler = vi.fn().mockResolvedValue(ok(undefined));

      subscriber.subscribe("task_started", handler);
      expect(subscriber.getHandlerCount("task_started")).toBe(1);

      subscriber.unsubscribe("task_started", handler);
      expect(subscriber.getHandlerCount("task_started")).toBe(0);

      await subscriber.start();
      await subscriber.dispatch(sampleEnvelope);
      expect(handler).not.toHaveBeenCalled();
    });

    it("fails cleanly when dispatch is called before start", async () => {
      const subscriber = new InMemoryEventSubscriber();
      const res = await subscriber.dispatch(sampleEnvelope);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("CONSUMER_NOT_CONNECTED");
      }
    });

    it("catches thrown exceptions in handlers and returns HandlerExecutionError", async () => {
      const subscriber = new InMemoryEventSubscriber();
      const faultyHandler: EventHandler = vi.fn().mockImplementation(() => {
        throw new Error("Unexpected crash inside handler");
      });

      subscriber.subscribe("task_started", faultyHandler);
      await subscriber.start();

      const res = await subscriber.dispatch(sampleEnvelope);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("HANDLER_FAILED");
        expect(res.error).toBeInstanceOf(HandlerExecutionError);
        expect(res.error.message).toContain("Unexpected crash inside handler");
      }
    });
  });
});
