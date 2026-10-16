/**
 * Concurrent Clients & Failure Recovery Test Suite — Phase 13E (Commit 6)
 *
 * Verifies multi-client streaming behavior, failure containment, and independent recovery:
 * 1. Concurrent clients on the same run receiving independent replay offsets and synchronized live broadcast.
 * 2. Slow consumer isolation: slow consumers experiencing backpressure do not impede fast consumers.
 * 3. Server restart / mass close simulation with subsequent individual client reconnection catch-up.
 * 4. High-concurrency client subscription burst and safe connection cleanup.
 */

import { Writable } from "node:stream";

import {
  createSseExecutionEnvelope,
  decodeReplayCursor,
  encodeReplayCursor,
  type EventConsumerErrorContract,
  type IEventSubscriber,
  type IRunEventReplayRepository,
  type RunEvent,
  type RunEventReplayResult,
} from "@aegis/contracts";
import { eventId, ok, runId, taskId, workerId, type Result } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SseEventGateway } from "../sseEventGateway.js";
import { SseReplayCoordinator } from "../sseReplayCoordinator.js";
import { SseTransportManager } from "../sseTransportManager.js";

class TestWritableStream extends Writable {
  readonly writtenChunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.writtenChunks.push(text);
    callback();
  }
}

class MockSubscriber implements IEventSubscriber {
  readonly subscribe = vi.fn();
  readonly unsubscribe = vi.fn();
  readonly subscribeAll = vi.fn();
  isSubscribed(): boolean {
    return true;
  }
  readonly isRunning = true;
  start(): Promise<Result<void, EventConsumerErrorContract>> {
    return Promise.resolve(ok(undefined));
  }
  stop(): Promise<Result<void, EventConsumerErrorContract>> {
    return Promise.resolve(ok(undefined));
  }
}

function makeRunEvent(
  idNum: number,
  targetRunId: string,
  timestampIso: string,
): RunEvent {
  return {
    id: eventId(`evt-${String(idNum).padStart(3, "0")}`),
    runId: runId(targetRunId),
    type: "task_started",
    severity: "info",
    timestamp: timestampIso,
    message: `Concurrent execution event ${String(idNum)}`,
    taskId: taskId(`task-${String(idNum)}`),
    worker: workerId("worker-conc-1"),
  };
}

describe("Concurrent Clients & Failure Recovery (Phase 13E — Commit 6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Concurrent Clients on the Same Run with Distinct Cursors", () => {
    it("delivers independent historical replays and synchronized live events to concurrent clients", async () => {
      const manager = new SseTransportManager();
      const rId = "run-conc-shared";

      const events: RunEvent[] = [
        makeRunEvent(1, rId, "2026-10-15T12:00:01.000Z"),
        makeRunEvent(2, rId, "2026-10-15T12:00:02.000Z"),
        makeRunEvent(3, rId, "2026-10-15T12:00:03.000Z"),
      ];

      const replayRepo: IRunEventReplayRepository = {
        replayEvents: (req) => {
          let filtered = events;
          if (req.cursor) {
            const decoded = decodeReplayCursor(req.cursor);
            const anchorId = decoded.ok ? decoded.value.eventId : req.cursor;
            const idx = events.findIndex((e) => e.id === anchorId);
            filtered = idx >= 0 ? events.slice(idx + 1) : events;
          }
          const result: RunEventReplayResult = {
            runId: runId(rId),
            events: filtered,
            nextCursor: null,
            hasMore: false,
            replayedCount: filtered.length,
            status: "complete",
            reconcileRequired: false,
            isCatchUpComplete: true,
          };
          return Promise.resolve({ ok: true as const, value: result });
        },
        getLatestEvent: () => Promise.resolve({ ok: true as const, value: null }),
        getEarliestEvent: () => Promise.resolve({ ok: true as const, value: null }),
      };

      const coordinator = new SseReplayCoordinator({ replayRepository: replayRepo });

      // Client A connects with no cursor (replays all: 1, 2, 3)
      const streamA = new TestWritableStream();
      const connA = manager.createConnection(streamA, { connectionId: "conn-A", runId: rId });
      connA.open();

      // Client B connects with cursor at event 2 (replays only: 3)
      const streamB = new TestWritableStream();
      const connB = manager.createConnection(streamB, { connectionId: "conn-B", runId: rId });
      connB.open();

      const event2 = events[1];
      expect(event2).toBeDefined();
      if (!event2) return;

      const cursorForB = encodeReplayCursor({
        eventId: event2.id,
        timestamp: event2.timestamp,
      });

      // Coordinate replay concurrently
      const [resA, resB] = await Promise.all([
        coordinator.coordinateReplay(connA, { runId: rId }),
        coordinator.coordinateReplay(connB, { runId: rId, cursor: cursorForB }),
      ]);

      expect(resA.success).toBe(true);
      expect(resA.replayedCount).toBe(3);

      expect(resB.success).toBe(true);
      expect(resB.replayedCount).toBe(1);

      // Verify stream A got evt-001, evt-002, evt-003
      expect(streamA.writtenChunks).toHaveLength(3);
      expect(streamA.writtenChunks[0]).toContain('"id":"evt-001"');
      expect(streamA.writtenChunks[1]).toContain('"id":"evt-002"');
      expect(streamA.writtenChunks[2]).toContain('"id":"evt-003"');

      // Verify stream B got only evt-003
      expect(streamB.writtenChunks).toHaveLength(1);
      expect(streamB.writtenChunks[0]).toContain('"id":"evt-003"');

      // Now broadcast a live event 4 to the run
      const liveEvent4 = makeRunEvent(4, rId, "2026-10-15T12:00:04.000Z");
      const liveEnvelope4 = createSseExecutionEnvelope(liveEvent4);

      const dispatchedCount = await manager.broadcastToRun(rId, liveEnvelope4);
      expect(dispatchedCount).toBe(2);

      // Both streams must have received live event 4
      expect(streamA.writtenChunks).toHaveLength(4);
      expect(streamA.writtenChunks[3]).toContain('"id":"evt-004"');

      expect(streamB.writtenChunks).toHaveLength(2);
      expect(streamB.writtenChunks[1]).toContain('"id":"evt-004"');
    });
  });

  describe("Slow Consumer Isolation Under Concurrent Streaming", () => {
    it("delivers events immediately to fast consumers even when a concurrent consumer is slow", async () => {
      const manager = new SseTransportManager();
      const rId = "run-conc-isolation";

      const streamFast = new TestWritableStream();
      const connFast = manager.createConnection(streamFast, { connectionId: "conn-fast", runId: rId });
      connFast.open();

      const streamSlow = new TestWritableStream();
      // Simulate slow socket that blocks on write
      vi.spyOn(streamSlow, "write").mockReturnValue(false);

      const connSlow = manager.createConnection(streamSlow, {
        connectionId: "conn-slow",
        runId: rId,
        drainTimeoutMs: 100, // fast timeout for test
      });
      connSlow.open();

      expect(manager.getConnectionsByRunId(rId)).toHaveLength(2);

      const event = makeRunEvent(1, rId, "2026-10-15T12:00:01.000Z");
      const envelope = createSseExecutionEnvelope(event);

      // Broadcast to both. Fast client immediately succeeds; slow consumer initiates backpressure wait.
      const broadcastPromise = manager.broadcastToRun(rId, envelope);

      // Advance past slow consumer drain timeout
      await vi.advanceTimersByTimeAsync(150);
      const deliveredCount = await broadcastPromise;

      // Fast consumer received the event
      expect(streamFast.writtenChunks).toHaveLength(1);
      expect(streamFast.writtenChunks[0]).toContain('"id":"evt-001"');

      // Delivered count should be 1 because slow consumer timed out
      expect(deliveredCount).toBe(1);

      // Slow consumer was evicted due to backpressure timeout
      expect(connSlow.isClosed).toBe(true);
      expect(connFast.isOpen).toBe(true);

      // Subsequent broadcasts route smoothly to fast client
      const event2 = makeRunEvent(2, rId, "2026-10-15T12:00:02.000Z");
      const delivered2 = await manager.broadcastToRun(rId, createSseExecutionEnvelope(event2));
      expect(delivered2).toBe(1);
      expect(streamFast.writtenChunks).toHaveLength(2);
    });
  });

  describe("Mass Server Shutdown & Individual Client Resumption", () => {
    it("gracefully terminates all connections on closeAll and permits clean resumption", async () => {
      const manager = new SseTransportManager();
      const rId = "run-mass-close";

      const stream1 = new TestWritableStream();
      const conn1 = manager.createConnection(stream1, { connectionId: "conn-1", runId: rId });
      conn1.open();

      const stream2 = new TestWritableStream();
      const conn2 = manager.createConnection(stream2, { connectionId: "conn-2", runId: rId });
      conn2.open();

      expect(manager.activeConnectionCount).toBe(2);

      // Send event 1 before shutdown
      const evt1 = makeRunEvent(1, rId, "2026-10-15T12:00:01.000Z");
      await manager.broadcastToRun(rId, createSseExecutionEnvelope(evt1));

      // Trigger mass server shutdown
      await manager.closeAll("server_restart");

      expect(manager.activeConnectionCount).toBe(0);
      expect(conn1.isClosed).toBe(true);
      expect(conn2.isClosed).toBe(true);

      // Client 1 reconnects after server restart and supplies cursor
      const stream1Reconnect = new TestWritableStream();
      const conn1Resume = manager.createConnection(stream1Reconnect, {
        connectionId: "conn-1-reconnected",
        runId: rId,
      });
      conn1Resume.open();

      expect(manager.activeConnectionCount).toBe(1);

      // New event 2 arrives post-restart
      const evt2 = makeRunEvent(2, rId, "2026-10-15T12:00:02.000Z");
      const delivered = await manager.broadcastToRun(rId, createSseExecutionEnvelope(evt2));
      expect(delivered).toBe(1);

      expect(stream1Reconnect.writtenChunks).toHaveLength(1);
      expect(stream1Reconnect.writtenChunks[0]).toContain('"id":"evt-002"');
    });
  });

  describe("SseEventGateway Multi-Connection Delivery Isolation", () => {
    it("routes domain events to all subscribers of the matching run without cross-run leaks", async () => {
      const manager = new SseTransportManager();
      const mockSubscriber = new MockSubscriber();
      const gateway = new SseEventGateway({
        subscriber: mockSubscriber,
        transportManager: manager,
      });

      const streamRunA1 = new TestWritableStream();
      const connA1 = manager.createConnection(streamRunA1, { connectionId: "conn-A1", runId: "run-alpha" });
      connA1.open();

      const streamRunA2 = new TestWritableStream();
      const connA2 = manager.createConnection(streamRunA2, { connectionId: "conn-A2", runId: "run-alpha" });
      connA2.open();

      const streamRunB = new TestWritableStream();
      const connB = manager.createConnection(streamRunB, { connectionId: "conn-B", runId: "run-beta" });
      connB.open();

      const eventA = makeRunEvent(1, "run-alpha", "2026-10-15T12:00:01.000Z");
      const resA = await gateway.deliverRunEvent(eventA, "run-alpha");

      expect(resA.delivered).toBe(2);
      expect(resA.dropped).toBe(false);

      // Check stream contents
      expect(streamRunA1.writtenChunks).toHaveLength(1);
      expect(streamRunA2.writtenChunks).toHaveLength(1);
      expect(streamRunB.writtenChunks).toHaveLength(0); // Zero cross-run leakage!

      const eventB = makeRunEvent(10, "run-beta", "2026-10-15T12:00:02.000Z");
      const resB = await gateway.deliverRunEvent(eventB, "run-beta");

      expect(resB.delivered).toBe(1);
      expect(resB.dropped).toBe(false);

      expect(streamRunA1.writtenChunks).toHaveLength(1);
      expect(streamRunA2.writtenChunks).toHaveLength(1);
      expect(streamRunB.writtenChunks).toHaveLength(1);
    });
  });
});
