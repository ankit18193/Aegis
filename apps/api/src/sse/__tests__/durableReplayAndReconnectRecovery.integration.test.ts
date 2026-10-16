/**
 * Durable Replay & Reconnect Recovery Integration Test Suite — Phase 13D (Commit 5)
 *
 * Verifies end-to-end durable replay, reconnection, pagination, buffer draining,
 * gap detection, and buffer overflow recovery across the SSE gateway and transport layers.
 *
 * User Constraints & Invariants Verified:
 * 1. Cursor ordering & gap detection: (timestamp, id) compound cursors ensure deterministic
 *    replay. Unknown cursors or gaps abort unsafe handoff and emit REPLAY_GAP_DETECTED
 *    with reconcileRequired: true.
 * 2. Multi-page pagination: Replay coordinator iteratively loops through hasMore and nextCursor
 *    until hasMore === false so no missed events are skipped across page boundaries.
 * 3. Buffer overflow protection: When live events arrive faster than catch-up can complete,
 *    exceeding the 500-event buffer threshold aborts unsafe delivery and emits BUFFER_OVERFLOW
 *    with reconcileRequired: true.
 * 4. Live event deduplication: Real-time broker events buffered during replay catch-up are
 *    deduplicated against historical events and flushed in strict order.
 */

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import {
  createSseExecutionEnvelope,
  deserializeSseEnvelope,
  parseSseFrame,
  type ConsumerRecordMetadata,
  type EventConsumerErrorContract,
  type EventEnvelope,
  type EventHandler,
  type EventType,
  type IEventSubscriber,
  type RunEvent,
  type SseErrorEnvelope,
  type SseExecutionEnvelope,
} from "@aegis/contracts";
import { eventId, ok, runId, taskId, workerId, type Result } from "@aegis/types";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { InMemoryRunEventReplayRepository } from "../../repositories/inMemoryRunEventReplayRepository.js";
import { SseEventGateway } from "../sseEventGateway.js";
import { SseReplayCoordinator } from "../sseReplayCoordinator.js";
import { SseTransportManager } from "../sseTransportManager.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers & Mock Transport Stream
// ─────────────────────────────────────────────────────────────────────────────

class TestStreamSink extends Writable {
  readonly chunks: string[] = [];
  isFinalized = false;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.chunks.push(text);
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.isFinalized = true;
    callback();
  }

  get rawOutput(): string {
    return this.chunks.join("");
  }

  getReceivedExecutionEnvelopes(): SseExecutionEnvelope[] {
    const rawFrames = this.rawOutput.split(/\r?\n\r?\n/).filter((f) => f.trim().length > 0);
    const envelopes: SseExecutionEnvelope[] = [];

    for (const rawFrame of rawFrames) {
      const parsed = parseSseFrame(rawFrame);
      if (parsed.ok && parsed.value.data) {
        const deserialized = deserializeSseEnvelope(parsed.value);
        if (deserialized.ok && deserialized.value.type === "execution") {
          envelopes.push(deserialized.value);
        }
      }
    }

    return envelopes;
  }

  getReceivedErrorEnvelopes(): SseErrorEnvelope[] {
    const rawFrames = this.rawOutput.split(/\r?\n\r?\n/).filter((f) => f.trim().length > 0);
    const envelopes: SseErrorEnvelope[] = [];

    for (const rawFrame of rawFrames) {
      const parsed = parseSseFrame(rawFrame);
      if (parsed.ok && parsed.value.data) {
        const deserialized = deserializeSseEnvelope(parsed.value);
        if (deserialized.ok && deserialized.value.type === "error") {
          envelopes.push(deserialized.value);
        }
      }
    }

    return envelopes;
  }
}

class TestEventSubscriber implements IEventSubscriber {
  private readonly handlers = new Map<EventType | "*", Set<EventHandler>>();
  private _running = false;

  get isRunning(): boolean {
    return this._running;
  }

  start(): Promise<Result<void, EventConsumerErrorContract>> {
    this._running = true;
    return Promise.resolve(ok(undefined));
  }

  stop(): Promise<Result<void, EventConsumerErrorContract>> {
    this._running = false;
    return Promise.resolve(ok(undefined));
  }

  subscribe(type: EventType | "*", handler: EventHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  unsubscribe(type: EventType | "*", handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    const set = this.handlers.get(envelope.type);
    if (!set) return;

    const metadata: ConsumerRecordMetadata = {
      topic: "aegis-execution-events",
      partition: 0,
      offset: "100",
      timestamp: String(Date.now()),
      key: envelope.aggregateId,
    };

    for (const handler of set) {
      await handler(envelope, metadata);
    }
  }
}

function createSampleEvent(
  rId: string,
  idStr: string,
  isoTime: string,
  message = "Execution event",
): RunEvent {
  return {
    id: eventId(idStr),
    runId: runId(rId),
    taskId: taskId(`task-${idStr}`),
    type: "task_started",
    severity: "info",
    timestamp: isoTime,
    message,
    worker: workerId("worker-1"),
  };
}

function makeEventEnvelope(rId: string, event: RunEvent): EventEnvelope {
  return {
    id: event.id,
    type: event.type,
    source: "aegis://execution-engine",
    specVersion: "1.0",
    time: event.timestamp,
    aggregateId: event.runId,
    aggregateType: "ExecutionRun",
    correlationId: eventId(randomUUID()),
    data: {
      ...event,
    },
  };
}

describe("Durable Replay & Reconnect Recovery Integration Suite (Phase 13D)", () => {
  let app: FastifyInstance;
  let transportManager: SseTransportManager;
  let replayRepo: InMemoryRunEventReplayRepository;
  let replayCoordinator: SseReplayCoordinator;
  let subscriber: TestEventSubscriber;
  let gateway: SseEventGateway;

  beforeEach(async () => {
    transportManager = new SseTransportManager({ defaultHeartbeatIntervalMs: 60_000 });
    replayRepo = new InMemoryRunEventReplayRepository();
    replayCoordinator = new SseReplayCoordinator({
      replayRepository: replayRepo,
    });
    subscriber = new TestEventSubscriber();
    gateway = new SseEventGateway({
      subscriber,
      transportManager,
    });
    gateway.register();

    app = await buildApp({
      sseTransportManager: transportManager,
      replayRepository: replayRepo,
      replayCoordinator,
    });
    await app.ready();
  });

  afterEach(async () => {
    gateway.unregister();
    await transportManager.closeAll("test_teardown");
    await app.close();
  });

  describe("Lifecycle: Disconnect, Store Missed Events, Reconnect with Last-Event-ID", () => {
    it("replays all missed events across multiple pages and transitions cleanly to live delivery", async () => {
      const testRunId = `run-replay-${randomUUID()}`;

      // 1. Initial connection receives initial event
      const sink1 = new TestStreamSink();
      const conn1 = transportManager.createConnection(sink1, { runId: testRunId });
      conn1.open();

      const initialEvent = createSampleEvent(testRunId, "evt-init-0", "2026-10-15T10:00:00.000Z", "Initial event");
      replayRepo.addEvent(initialEvent);
      await subscriber.publish(makeEventEnvelope(testRunId, initialEvent));

      expect(sink1.getReceivedExecutionEnvelopes()).toHaveLength(1);
      expect(sink1.getReceivedExecutionEnvelopes()[0]?.id).toBe("evt-init-0");

      // 2. Client disconnects / goes offline
      await conn1.close();
      expect(conn1.isClosed).toBe(true);

      // 3. Worker/engine emits 5 subsequent events while client is offline into repository
      const offlineEvents: RunEvent[] = [
        createSampleEvent(testRunId, "evt-missed-1", "2026-10-15T10:00:01.000Z", "Missed event 1"),
        createSampleEvent(testRunId, "evt-missed-2", "2026-10-15T10:00:02.000Z", "Missed event 2"),
        createSampleEvent(testRunId, "evt-missed-3", "2026-10-15T10:00:03.000Z", "Missed event 3"),
        createSampleEvent(testRunId, "evt-missed-4", "2026-10-15T10:00:04.000Z", "Missed event 4"),
        createSampleEvent(testRunId, "evt-missed-5", "2026-10-15T10:00:05.000Z", "Missed event 5"),
      ];

      for (const ev of offlineEvents) {
        replayRepo.addEvent(ev);
      }

      // 4. Client reconnects via HTTP transport supplying Last-Event-ID: evt-init-0
      const sink2 = new TestStreamSink();
      const conn2 = transportManager.createConnection(sink2, { runId: testRunId });
      conn2.open();

      // Initiate replay through coordinator using small pageSize (2) to enforce multi-page loop pagination
      const result = await replayCoordinator.coordinateReplay(conn2, {
        runId: testRunId,
        cursor: "evt-init-0",
        pageSize: 2,
      });

      expect(result.success).toBe(true);
      expect(result.replayedCount).toBe(5);

      const replayedEnvelopes = sink2.getReceivedExecutionEnvelopes();
      expect(replayedEnvelopes).toHaveLength(5);
      expect(replayedEnvelopes.map((e) => e.id)).toEqual([
        "evt-missed-1",
        "evt-missed-2",
        "evt-missed-3",
        "evt-missed-4",
        "evt-missed-5",
      ]);

      // 5. Subsequent live event arrives after catch-up completed
      const postReplayLiveEvent = createSampleEvent(
        testRunId,
        "evt-live-post",
        "2026-10-15T10:00:06.000Z",
        "Post-replay live event",
      );
      replayRepo.addEvent(postReplayLiveEvent);
      await subscriber.publish(makeEventEnvelope(testRunId, postReplayLiveEvent));

      const finalEnvelopes = sink2.getReceivedExecutionEnvelopes();
      expect(finalEnvelopes).toHaveLength(6);
      expect(finalEnvelopes[5]?.id).toBe("evt-live-post");

      await conn2.close();
    });

    it("supports HTTP Fastify transport injection with Last-Event-ID header and lastEventId query param", async () => {
      const testRunId = `run-http-${randomUUID()}`;
      const brId = runId(testRunId);

      const events: RunEvent[] = [
        createSampleEvent(testRunId, "evt-http-1", "2026-10-15T10:00:01.000Z", "Event 1"),
        createSampleEvent(testRunId, "evt-http-2", "2026-10-15T10:00:02.000Z", "Event 2"),
        createSampleEvent(testRunId, "evt-http-3", "2026-10-15T10:00:03.000Z", "Event 3"),
      ];
      replayRepo.setEvents(brId, events);

      // Reconnect with Last-Event-ID header
      const resHeader = await app.inject({
        method: "GET",
        url: `/api/v1/stream/transport?runId=${testRunId}&closeImmediately=true`,
        headers: {
          "Last-Event-ID": "evt-http-1",
        },
      });

      expect(resHeader.statusCode).toBe(200);
      expect(resHeader.body).not.toContain('"id":"evt-http-1"');
      expect(resHeader.body).toContain('"id":"evt-http-2"');
      expect(resHeader.body).toContain('"id":"evt-http-3"');

      // Reconnect with lastEventId query param
      const resQuery = await app.inject({
        method: "GET",
        url: `/api/v1/stream/transport?runId=${testRunId}&lastEventId=evt-http-2&closeImmediately=true`,
      });

      expect(resQuery.statusCode).toBe(200);
      expect(resQuery.body).not.toContain('"id":"evt-http-1"');
      expect(resQuery.body).not.toContain('"id":"evt-http-2"');
      expect(resQuery.body).toContain('"id":"evt-http-3"');
    });
  });

  describe("Interleaving Live Events During Catch-up & Buffer Deduplication", () => {
    it("buffers live events arriving during catch-up, deduplicates against replay, and flushes in order", async () => {
      const testRunId = `run-interleave-${randomUUID()}`;
      const brId = runId(testRunId);

      const initialEvents: RunEvent[] = [
        createSampleEvent(testRunId, "evt-past-1", "2026-10-15T11:00:01.000Z", "Past 1"),
        createSampleEvent(testRunId, "evt-past-2", "2026-10-15T11:00:02.000Z", "Past 2"),
        createSampleEvent(testRunId, "evt-past-3", "2026-10-15T11:00:03.000Z", "Past 3"),
      ];
      replayRepo.setEvents(brId, initialEvents);

      const sink = new TestStreamSink();
      const conn = transportManager.createConnection(sink, { runId: testRunId });
      conn.open();

      // Enter buffering mode on connection
      conn.enableBuffering();
      expect(conn.isBuffering).toBe(true);

      // Simulate live events arriving concurrently while DB replay is fetching
      const liveEvt1 = createSampleEvent(testRunId, "evt-past-3", "2026-10-15T11:00:03.000Z", "Past 3 re-published");
      const liveEvt2 = createSampleEvent(testRunId, "evt-live-4", "2026-10-15T11:00:04.000Z", "Live event 4");
      const liveEvt3 = createSampleEvent(testRunId, "evt-live-5", "2026-10-15T11:00:05.000Z", "Live event 5");

      // Gateway publishes these into connection's live buffer
      await subscriber.publish(makeEventEnvelope(testRunId, liveEvt1));
      await subscriber.publish(makeEventEnvelope(testRunId, liveEvt2));
      await subscriber.publish(makeEventEnvelope(testRunId, liveEvt3));

      expect(conn.bufferSize).toBe(3);
      // Nothing flushed to sink yet because replay is active
      expect(sink.getReceivedExecutionEnvelopes()).toHaveLength(0);

      // Coordinate replay from evt-past-1
      const result = await replayCoordinator.coordinateReplay(conn, {
        runId: testRunId,
        cursor: "evt-past-1",
      });

      expect(result.success).toBe(true);
      expect(conn.isBuffering).toBe(false);
      expect(conn.bufferSize).toBe(0);

      const delivered = sink.getReceivedExecutionEnvelopes();
      expect(delivered.map((e) => e.id)).toEqual([
        "evt-past-2",
        "evt-past-3", // From historical replay
        "evt-live-4", // Drained from live buffer (past-3 was deduplicated!)
        "evt-live-5", // Drained from live buffer
      ]);

      await conn.close();
    });
  });

  describe("User Correction #1: Cursor Validation & Gap Detection", () => {
    it("aborts handoff and emits REPLAY_GAP_DETECTED with reconcileRequired: true when cursor is unknown", async () => {
      const testRunId = `run-gap-${randomUUID()}`;
      const brId = runId(testRunId);

      replayRepo.setEvents(brId, [
        createSampleEvent(testRunId, "evt-valid-1", "2026-10-15T12:00:01.000Z", "Valid 1"),
      ]);

      const sink = new TestStreamSink();
      const conn = transportManager.createConnection(sink, { runId: testRunId });
      conn.open();

      const result = await replayCoordinator.coordinateReplay(conn, {
        runId: testRunId,
        cursor: "evt-non-existent-cursor-999",
      });

      expect(result.success).toBe(false);
      expect(result.reconcileRequired).toBe(true);

      const errors = sink.getReceivedErrorEnvelopes();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload.code).toBe("REPLAY_GAP_DETECTED");
      expect(errors[0]?.payload.retryable).toBe(true);
      expect(errors[0]?.payload.details?.["reconcileRequired"]).toBe(true);

      await conn.close();
    });
  });

  describe("User Correction #3: Buffer Overflow Protection", () => {
    it("halts handoff and emits BUFFER_OVERFLOW when live buffer exceeds 500 events", async () => {
      const testRunId = `run-overflow-${randomUUID()}`;
      const brId = runId(testRunId);

      replayRepo.setEvents(brId, [
        createSampleEvent(testRunId, "evt-seed-1", "2026-10-15T13:00:01.000Z", "Seed 1"),
      ]);

      const sink = new TestStreamSink();
      const conn = transportManager.createConnection(sink, { runId: testRunId });
      conn.open();

      // Put connection into buffering mode with capacity 500
      conn.enableBuffering(500);

      // Flood the live buffer with 501 events
      for (let i = 1; i <= 501; i++) {
        const idxStr = String(i);
        const floodEvt = createSampleEvent(
          testRunId,
          `evt-flood-${idxStr}`,
          `2026-10-15T13:00:${idxStr.padStart(2, "0")}.000Z`,
          `Flood ${idxStr}`,
        );
        await conn.sendEnvelope(createSseExecutionEnvelope(floodEvt));
      }

      expect(conn.hasBufferOverflowed()).toBe(true);

      // Attempting to coordinate with an overflowed connection must halt immediately
      const result = await replayCoordinator.coordinateReplay(conn, {
        runId: testRunId,
        cursor: "evt-seed-1",
      });

      expect(result.success).toBe(false);
      expect(result.reconcileRequired).toBe(true);

      const errors = sink.getReceivedErrorEnvelopes();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload.code).toBe("BUFFER_OVERFLOW");
      expect(errors[0]?.payload.retryable).toBe(true);
      expect(errors[0]?.payload.details?.["reconcileRequired"]).toBe(true);

      await conn.close();
    });
  });
});
