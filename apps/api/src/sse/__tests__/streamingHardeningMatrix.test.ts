/**
 * SSE Streaming End-to-End Failure Hardening Matrix — Phase 13E (Commit 1)
 *
 * Deterministic failure matrix verifying the complete real-time execution journey:
 * persistence -> Kafka delivery -> replay coordination -> SSE framing -> client recovery.
 *
 * Covered Scenarios:
 * 1. Mid-stream client disconnect during multi-page historical replay and subsequent resume.
 * 2. Concurrent live broker event arrival during replay catch-up with boundary deduplication.
 * 3. Cross-run cursor rejection and stream isolation (prevention of tenant/run event leakage).
 * 4. Retention gap detection when client supplies purged or non-existent cursor.
 * 5. Buffer overflow protection when live burst exceeds 500-event threshold.
 * 6. Persistence fault injection during historical replay pagination loop.
 * 7. Fastify HTTP transport injection verifying header extraction and parameter handling.
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
  type IRunEventReplayRepository,
  type RunEvent,
  type RunEventReplayErrorContract,
  type RunEventReplayRequest,
  type RunEventReplayResult,
  type SseErrorEnvelope,
  type SseExecutionEnvelope,
} from "@aegis/contracts";
import {
  createReplayError,
  encodeReplayCursor,
} from "@aegis/contracts";
import {
  err,
  eventId,
  ok,
  runId,
  taskId,
  workerId,
  type Result,
} from "@aegis/types";
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

describe("SSE Streaming End-to-End Hardening Matrix (Phase 13E — Commit 1)", () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // Matrix Dimension 1: Mid-Stream Disconnect & Resume Across Pages
  // ─────────────────────────────────────────────────────────────────────────
  describe("Matrix 01: Mid-Stream Disconnect & Resumption During Multi-Page Replay", () => {
    it("safely terminates replay on disconnect without resource leaks and resumes from acknowledged cursor on reconnect", async () => {
      const testRunId = `run-matrix-dc-${randomUUID()}`;
      const brId = runId(testRunId);

      // Seed 6 events in durable history: 3 pages of 2 events each
      const seedEvents: RunEvent[] = [
        createSampleEvent(testRunId, "evt-dc-1", "2026-10-15T10:00:01.000Z", "Event 1"),
        createSampleEvent(testRunId, "evt-dc-2", "2026-10-15T10:00:02.000Z", "Event 2"),
        createSampleEvent(testRunId, "evt-dc-3", "2026-10-15T10:00:03.000Z", "Event 3"),
        createSampleEvent(testRunId, "evt-dc-4", "2026-10-15T10:00:04.000Z", "Event 4"),
        createSampleEvent(testRunId, "evt-dc-5", "2026-10-15T10:00:05.000Z", "Event 5"),
        createSampleEvent(testRunId, "evt-dc-6", "2026-10-15T10:00:06.000Z", "Event 6"),
      ];
      replayRepo.setEvents(brId, seedEvents);

      // 1. Initial connection: client starts catch-up
      const sink1 = new TestStreamSink();
      const conn1 = transportManager.createConnection(sink1, { runId: testRunId });
      conn1.open();

      // Start replay coordination with pageSize = 2
      const coordPromise = replayCoordinator.coordinateReplay(conn1, {
        runId: testRunId,
        pageSize: 2,
      });

      // Abruptly close connection after initial page processing
      await conn1.close("client_aborted");
      expect(conn1.isClosed).toBe(true);

      const result1 = await coordPromise;
      // Replay coordination must exit gracefully without throwing unhandled rejection
      expect(result1.success).toBe(false);
      expect(conn1.isBuffering).toBe(false);
      expect(conn1.bufferSize).toBe(0);

      // 2. Client reconnects, providing Last-Event-ID for the last acknowledged event (evt-dc-2)
      const sink2 = new TestStreamSink();
      const conn2 = transportManager.createConnection(sink2, { runId: testRunId });
      conn2.open();

      const result2 = await replayCoordinator.coordinateReplay(conn2, {
        runId: testRunId,
        cursor: "evt-dc-2",
        pageSize: 2,
      });

      expect(result2.success).toBe(true);
      expect(result2.replayedCount).toBe(4); // evt-dc-3, 4, 5, 6

      const delivered = sink2.getReceivedExecutionEnvelopes();
      expect(delivered).toHaveLength(4);
      expect(delivered.map((e) => e.id)).toEqual([
        "evt-dc-3",
        "evt-dc-4",
        "evt-dc-5",
        "evt-dc-6",
      ]);

      await conn2.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Matrix Dimension 2: Interleaved Broker Delivery with Duplicate Boundary Filtering
  // ─────────────────────────────────────────────────────────────────────────
  describe("Matrix 02: Interleaved Broker Delivery & Boundary Deduplication", () => {
    it("preserves FIFO arrival for live events while dropping duplicates delivered during historical catch-up", async () => {
      const testRunId = `run-matrix-dedup-${randomUUID()}`;
      const brId = runId(testRunId);

      // Seed 3 events in durable store
      const dbEvents: RunEvent[] = [
        createSampleEvent(testRunId, "evt-hist-1", "2026-10-15T11:00:01.000Z", "Historical 1"),
        createSampleEvent(testRunId, "evt-hist-2", "2026-10-15T11:00:02.000Z", "Historical 2"),
        createSampleEvent(testRunId, "evt-hist-3", "2026-10-15T11:00:03.000Z", "Historical 3"),
      ];
      replayRepo.setEvents(brId, dbEvents);

      const sink = new TestStreamSink();
      const conn = transportManager.createConnection(sink, { runId: testRunId });
      conn.open();
      conn.enableBuffering();

      // While replay is queued/buffering, broker delivers:
      // - duplicate of evt-hist-3 (already in DB)
      // - new live events: evt-live-4 and evt-live-5
      const brokerDup = createSampleEvent(testRunId, "evt-hist-3", "2026-10-15T11:00:03.000Z", "Historical 3 re-broadcast");
      const brokerLive4 = createSampleEvent(testRunId, "evt-live-4", "2026-10-15T11:00:04.000Z", "Live 4");
      const brokerLive5 = createSampleEvent(testRunId, "evt-live-5", "2026-10-15T11:00:05.000Z", "Live 5");

      await subscriber.publish(makeEventEnvelope(testRunId, brokerDup));
      await subscriber.publish(makeEventEnvelope(testRunId, brokerLive4));
      await subscriber.publish(makeEventEnvelope(testRunId, brokerLive5));

      expect(conn.bufferSize).toBe(3);

      // Execute replay from beginning (no cursor -> replay all 3)
      const replayResult = await replayCoordinator.coordinateReplay(conn, {
        runId: testRunId,
        pageSize: 2,
      });

      expect(replayResult.success).toBe(true);
      expect(replayResult.replayedCount).toBe(3);
      expect(replayResult.drainedCount).toBe(2); // evt-hist-3 dropped, live-4 and live-5 drained
      expect(conn.isBuffering).toBe(false);

      const envelopes = sink.getReceivedExecutionEnvelopes();
      expect(envelopes).toHaveLength(5);
      expect(envelopes.map((e) => e.id)).toEqual([
        "evt-hist-1",
        "evt-hist-2",
        "evt-hist-3",
        "evt-live-4",
        "evt-live-5",
      ]);

      await conn.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Matrix Dimension 3: Cross-Run Cursor Rejection & Stream Isolation
  // ─────────────────────────────────────────────────────────────────────────
  describe("Matrix 03: Cross-Run Cursor Rejection & Stream Isolation", () => {
    it("rejects cross-run cursor and aborts handoff with reconcileRequired: true without leaking foreign events", async () => {
      const runAlpha = `run-alpha-${randomUUID()}`;
      const runBeta = `run-beta-${randomUUID()}`;

      // Register two runs with distinct events
      replayRepo.setEvents(runId(runAlpha), [
        createSampleEvent(runAlpha, "evt-alpha-1", "2026-10-15T12:00:01.000Z", "Alpha 1"),
        createSampleEvent(runAlpha, "evt-alpha-2", "2026-10-15T12:00:02.000Z", "Alpha 2"),
      ]);
      replayRepo.setEvents(runId(runBeta), [
        createSampleEvent(runBeta, "evt-beta-1", "2026-10-15T12:00:01.000Z", "Beta 1"),
        createSampleEvent(runBeta, "evt-beta-2", "2026-10-15T12:00:02.000Z", "Beta 2"),
      ]);

      const sinkAlpha = new TestStreamSink();
      const connAlpha = transportManager.createConnection(sinkAlpha, { runId: runAlpha });
      connAlpha.open();

      // Client connects to run-alpha, but maliciously or erroneously supplies cursor from run-beta
      const result = await replayCoordinator.coordinateReplay(connAlpha, {
        runId: runAlpha,
        cursor: "evt-beta-1",
      });

      expect(result.success).toBe(false);
      expect(result.reconcileRequired).toBe(true);

      // Verify connection received error envelope
      const errorEnvelopes = sinkAlpha.getReceivedErrorEnvelopes();
      expect(errorEnvelopes).toHaveLength(1);
      expect(errorEnvelopes[0]?.payload.retryable).toBe(true);
      expect(errorEnvelopes[0]?.payload.details?.["reconcileRequired"]).toBe(true);

      // Zero execution events from run-beta leaked into run-alpha
      const execEnvelopes = sinkAlpha.getReceivedExecutionEnvelopes();
      expect(execEnvelopes).toHaveLength(0);

      await connAlpha.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Matrix Dimension 4: Purged Retention Window Gap Detection
  // ─────────────────────────────────────────────────────────────────────────
  describe("Matrix 04: Retention Window Gap Detection for Purged Cursors", () => {
    it("signals REPLAY_GAP_DETECTED with reconcileRequired: true when cursor was purged or does not exist", async () => {
      const testRunId = `run-purged-${randomUUID()}`;
      replayRepo.setEvents(runId(testRunId), [
        createSampleEvent(testRunId, "evt-curr-10", "2026-10-15T14:00:10.000Z", "Retained event"),
      ]);

      const sink = new TestStreamSink();
      const conn = transportManager.createConnection(sink, { runId: testRunId });
      conn.open();

      const encodedPurgedCursor = encodeReplayCursor({
        eventId: eventId("evt-purged-old-1"),
        timestamp: "2026-10-14T00:00:00.000Z",
      });

      const result = await replayCoordinator.coordinateReplay(conn, {
        runId: testRunId,
        cursor: encodedPurgedCursor,
      });

      expect(result.success).toBe(false);
      expect(result.reconcileRequired).toBe(true);
      expect(result.status).toBe("gap_detected");

      const errorEnvelopes = sink.getReceivedErrorEnvelopes();
      expect(errorEnvelopes).toHaveLength(1);
      expect(errorEnvelopes[0]?.payload.code).toBe("REPLAY_GAP_DETECTED");
      expect(errorEnvelopes[0]?.payload.details?.["reconcileRequired"]).toBe(true);

      await conn.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Matrix Dimension 5: Buffer Overflow Protection Threshold
  // ─────────────────────────────────────────────────────────────────────────
  describe("Matrix 05: Live Buffer Overflow Protection Threshold", () => {
    it("halts coordination and emits BUFFER_OVERFLOW when live buffer exceeds safety threshold", async () => {
      const testRunId = `run-oflow-${randomUUID()}`;
      replayRepo.setEvents(runId(testRunId), [
        createSampleEvent(testRunId, "evt-init", "2026-10-15T15:00:00.000Z", "Initial event"),
      ]);

      const sink = new TestStreamSink();
      const conn = transportManager.createConnection(sink, { runId: testRunId });
      conn.open();
      conn.enableBuffering(500);

      // Flood buffer with 501 events
      for (let i = 1; i <= 501; i++) {
        const floodEvt = createSampleEvent(
          testRunId,
          `evt-flood-${String(i)}`,
          `2026-10-15T15:00:01.000Z`,
          `Flood event ${String(i)}`,
        );
        await conn.sendEnvelope(createSseExecutionEnvelope(floodEvt));
      }

      expect(conn.hasBufferOverflowed()).toBe(true);

      const result = await replayCoordinator.coordinateReplay(conn, {
        runId: testRunId,
        cursor: "evt-init",
      });

      expect(result.success).toBe(false);
      expect(result.reconcileRequired).toBe(true);

      const errorEnvelopes = sink.getReceivedErrorEnvelopes();
      expect(errorEnvelopes).toHaveLength(1);
      expect(errorEnvelopes[0]?.payload.code).toBe("BUFFER_OVERFLOW");
      expect(errorEnvelopes[0]?.payload.details?.["reconcileRequired"]).toBe(true);

      await conn.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Matrix Dimension 6: Persistence Fault Injection During Replay
  // ─────────────────────────────────────────────────────────────────────────
  describe("Matrix 06: Persistence Fault Injection Handling", () => {
    it("gracefully catches repository failures, sends INTERNAL_TRANSPORT_ERROR, and cleans up buffering", async () => {
      const faultyRepo: IRunEventReplayRepository = {
        replayEvents: (_req: RunEventReplayRequest): Promise<Result<RunEventReplayResult, RunEventReplayErrorContract>> => {
          return Promise.resolve(
            err(
              createReplayError(
                "INTERNAL_REPLAY_ERROR",
                "Simulated PostgreSQL connection timeout during replay query",
                { runId: runId("run-faulty") },
              ),
            ),
          );
        },
        getLatestEvent: () => Promise.resolve(ok(null)),
        getEarliestEvent: () => Promise.resolve(ok(null)),
      };

      const faultyCoordinator = new SseReplayCoordinator({
        replayRepository: faultyRepo,
      });

      const sink = new TestStreamSink();
      const conn = transportManager.createConnection(sink, { runId: "run-faulty" });
      conn.open();

      const result = await faultyCoordinator.coordinateReplay(conn, {
        runId: "run-faulty",
        cursor: "evt-any",
      });

      expect(result.success).toBe(false);
      expect(result.reconcileRequired).toBe(true);
      expect(conn.isBuffering).toBe(false);

      const errors = sink.getReceivedErrorEnvelopes();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.payload.code).toBe("INTERNAL_TRANSPORT_ERROR");
      expect(errors[0]?.payload.message).toContain("Simulated PostgreSQL connection timeout");
      expect(errors[0]?.payload.details?.["reconcileRequired"]).toBe(true);

      await conn.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Matrix Dimension 7: Fastify Transport Route Verification
  // ─────────────────────────────────────────────────────────────────────────
  describe("Matrix 07: Fastify Transport Route Integration", () => {
    it("serves stats and streams initial connection frame over HTTP injection", async () => {
      const statsRes = await app.inject({
        method: "GET",
        url: "/api/v1/stream/transport/stats",
      });
      expect(statsRes.statusCode).toBe(200);
      const parsedStats = JSON.parse(statsRes.body) as { activeConnections: unknown };
      expect(typeof parsedStats.activeConnections).toBe("number");

      const streamRes = await app.inject({
        method: "GET",
        url: "/api/v1/stream/transport?runId=run-probe&closeImmediately=true",
      });
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers["content-type"]).toContain("text/event-stream");
      expect(streamRes.body).toContain("event: connected");
    });
  });
});
