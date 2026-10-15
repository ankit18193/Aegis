/**
 * Live Execution Event Streaming Integration Test Suite — Phase 13C (Commit 4)
 *
 * Verifies the end-to-end event flow:
 * Execution event consumed from event broker -> SseEventGateway adapter ->
 * SseTransportManager fan-out -> SseConnection framing -> Wire serialization ->
 * Deserialization and validation by downstream client.
 *
 * Test Scenarios:
 * 1. End-to-end delivery of diverse canonical execution event types.
 * 2. Strict run isolation between disparate active streams.
 * 3. Fan-out multiplexing across multiple concurrent connections for the same run.
 * 4. Preservation of event identity, timestamp, and domain metadata end-to-end.
 * 5. Best-effort delivery resilience: client aborts / dropped sockets do not crash the gateway.
 * 6. Gateway metrics consistency across consumed, delivered, skipped, and dropped events.
 */

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import {
  deserializeSseEnvelope,
  parseSseFrame,
  type ConsumerRecordMetadata,
  type EventConsumerErrorContract,
  type EventEnvelope,
  type EventHandler,
  type EventType,
  type IEventSubscriber,
  type RunEvent,
  type SseExecutionEnvelope,
} from "@aegis/contracts";
import { eventId, ok, runId, taskId, workerId, type Result } from "@aegis/types";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { SseEventGateway } from "../sseEventGateway.js";
import { SseTransportManager } from "../sseTransportManager.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers & Mock Transport Stream
// ─────────────────────────────────────────────────────────────────────────────

class TestStreamBuffer extends Writable {
  readonly chunks: string[] = [];
  isEnded = false;

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
    this.isEnded = true;
    callback();
  }

  get rawOutput(): string {
    return this.chunks.join("");
  }

  /**
   * Splits and parses all serialized SSE frames received in this stream.
   */
  getReceivedEnvelopes(): SseExecutionEnvelope[] {
    const output = this.rawOutput;
    // Split by double newline which terminates standard SSE frames
    const rawFrames = output.split(/\r?\n\r?\n/).filter((f) => f.trim().length > 0);
    const envelopes: SseExecutionEnvelope[] = [];

    for (const rawFrame of rawFrames) {
      const parsedFrameRes = parseSseFrame(rawFrame);
      if (parsedFrameRes.ok && parsedFrameRes.value.data) {
        const deserializedRes = deserializeSseEnvelope(parsedFrameRes.value);
        if (deserializedRes.ok && deserializedRes.value.type === "execution") {
          envelopes.push(deserializedRes.value);
        }
      }
    }

    return envelopes;
  }
}

class InMemoryEventSubscriber implements IEventSubscriber {
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

function makeEventEnvelope(
  rId: string,
  type: EventType,
  data: Record<string, unknown>,
): EventEnvelope {
  const evtId = eventId(randomUUID());
  const rIdBranded = runId(rId);
  return {
    id: evtId,
    type,
    source: "aegis://execution-engine",
    specVersion: "1.0",
    time: new Date().toISOString(),
    aggregateId: rIdBranded,
    aggregateType: "ExecutionRun",
    correlationId: eventId(randomUUID()),
    data: {
      id: evtId,
      runId: rIdBranded,
      type,
      severity: "info",
      message: "Event message",
      timestamp: new Date().toISOString(),
      ...data,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 13C — Live Execution Event Streaming Integration", () => {
  let app: FastifyInstance;
  let transportManager: SseTransportManager;
  let subscriber: InMemoryEventSubscriber;
  let gateway: SseEventGateway;

  beforeEach(async () => {
    transportManager = new SseTransportManager({ defaultHeartbeatIntervalMs: 60_000 });
    subscriber = new InMemoryEventSubscriber();

    gateway = new SseEventGateway({
      subscriber,
      transportManager,
    });
    gateway.register();

    app = await buildApp({
      sseTransportManager: transportManager,
    });
    await app.ready();
  });

  afterEach(async () => {
    gateway.unregister();
    await transportManager.closeAll("test_teardown");
    await app.close();
  });

  describe("End-to-End Pipeline & Event Type Coverage", () => {
    it("adapts and streams diverse execution event types faithfully to an active run stream", async () => {
      const stream = new TestStreamBuffer();
      const testRunId = `run-${randomUUID()}`;
      const conn = transportManager.createConnection(stream, { runId: testRunId });
      conn.open();

      // 1. run_created
      await subscriber.publish(
        makeEventEnvelope(testRunId, "run_created", {
          severity: "info",
          message: "Execution run initialized",
          workflowId: "wf-1",
        }),
      );

      // 2. task_started
      const testTaskId = `task-${randomUUID()}`;
      await subscriber.publish(
        makeEventEnvelope(testRunId, "task_started", {
          taskId: testTaskId,
          taskName: "Ingestion Step",
          workerId: "worker-01",
          severity: "info",
          message: "Task ingestion started",
        }),
      );

      // 3. task_completed
      await subscriber.publish(
        makeEventEnvelope(testRunId, "task_completed", {
          taskId: testTaskId,
          taskName: "Ingestion Step",
          workerId: "worker-01",
          severity: "success",
          message: "Task completed successfully",
        }),
      );

      // 4. run_completed
      await subscriber.publish(
        makeEventEnvelope(testRunId, "run_completed", {
          severity: "success",
          message: "Execution run finished successfully",
        }),
      );

      const received = stream.getReceivedEnvelopes();
      expect(received).toHaveLength(4);

      // Verify event 1
      expect(received[0]?.type).toBe("execution");
      expect(received[0]?.runId).toBe(testRunId);
      expect(received[0]?.payload.type).toBe("run_created");
      expect(received[0]?.payload.message).toBe("Execution run initialized");

      // Verify event 2
      expect(received[1]?.payload.type).toBe("task_started");
      expect(received[1]?.payload.taskId).toBe(testTaskId);

      // Verify event 3
      expect(received[2]?.payload.type).toBe("task_completed");
      expect(received[2]?.payload.severity).toBe("success");

      // Verify event 4
      expect(received[3]?.payload.type).toBe("run_completed");
      expect(received[3]?.payload.severity).toBe("success");

      // Verify wire formatting
      expect(stream.rawOutput).toContain("event: execution\n");
      expect(stream.rawOutput).toContain("data: {");
    });

    it("delivers task failure and cancellation execution events with error metadata", async () => {
      const stream = new TestStreamBuffer();
      const testRunId = `run-${randomUUID()}`;
      const conn = transportManager.createConnection(stream, { runId: testRunId });
      conn.open();

      const testTaskId = `task-${randomUUID()}`;
      await subscriber.publish(
        makeEventEnvelope(testRunId, "task_failed", {
          taskId: testTaskId,
          severity: "error",
          message: "Database connection timed out",
          metadata: {
            errorCode: "DB_TIMEOUT",
            attempt: 2,
          },
        }),
      );

      const received = stream.getReceivedEnvelopes();
      expect(received).toHaveLength(1);
      expect(received[0]?.payload.type).toBe("task_failed");
      expect(received[0]?.payload.severity).toBe("error");
      expect(received[0]?.payload.message).toBe("Database connection timed out");
      expect(received[0]?.payload.metadata).toEqual({
        errorCode: "DB_TIMEOUT",
        attempt: 2,
      });
    });
  });

  describe("Run Isolation & Multiplexing", () => {
    it("strictly isolates events between different execution runs", async () => {
      const streamA = new TestStreamBuffer();
      const streamB = new TestStreamBuffer();

      const runA = `run-alpha-${randomUUID()}`;
      const runB = `run-beta-${randomUUID()}`;

      const connA = transportManager.createConnection(streamA, { runId: runA });
      const connB = transportManager.createConnection(streamB, { runId: runB });
      connA.open();
      connB.open();

      // Publish event exclusively for run A
      await subscriber.publish(
        makeEventEnvelope(runA, "task_started", {
          message: "Run A task started",
        }),
      );

      // Publish event exclusively for run B
      await subscriber.publish(
        makeEventEnvelope(runB, "task_started", {
          message: "Run B task started",
        }),
      );

      const receivedA = streamA.getReceivedEnvelopes();
      const receivedB = streamB.getReceivedEnvelopes();

      expect(receivedA).toHaveLength(1);
      expect(receivedA[0]?.runId).toBe(runA);
      expect(receivedA[0]?.payload.message).toBe("Run A task started");

      expect(receivedB).toHaveLength(1);
      expect(receivedB[0]?.runId).toBe(runB);
      expect(receivedB[0]?.payload.message).toBe("Run B task started");
    });

    it("multiplexes identical events to all active connections watching the same runId", async () => {
      const stream1 = new TestStreamBuffer();
      const stream2 = new TestStreamBuffer();
      const stream3 = new TestStreamBuffer();

      const sharedRunId = `run-shared-${randomUUID()}`;

      const conn1 = transportManager.createConnection(stream1, { runId: sharedRunId });
      const conn2 = transportManager.createConnection(stream2, { runId: sharedRunId });
      const conn3 = transportManager.createConnection(stream3, { runId: sharedRunId });

      conn1.open();
      conn2.open();
      conn3.open();

      await subscriber.publish(
        makeEventEnvelope(sharedRunId, "task_completed", {
          message: "Shared task finished",
        }),
      );

      const r1 = stream1.getReceivedEnvelopes();
      const r2 = stream2.getReceivedEnvelopes();
      const r3 = stream3.getReceivedEnvelopes();

      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r3).toHaveLength(1);

      // All 3 connections received the exact same event ID and payload
      expect(r1[0]?.id).toBe(r2[0]?.id);
      expect(r2[0]?.id).toBe(r3[0]?.id);
      expect(r1[0]?.payload.message).toBe("Shared task finished");
    });
  });

  describe("Resilience & Delivery Fault Tolerance", () => {
    it("handles connection abortion cleanly without affecting subsequent event delivery", async () => {
      const streamA = new TestStreamBuffer();
      const streamB = new TestStreamBuffer();

      const testRunId = `run-fault-${randomUUID()}`;

      const connA = transportManager.createConnection(streamA, { runId: testRunId });
      const connB = transportManager.createConnection(streamB, { runId: testRunId });

      connA.open();
      connB.open();

      // First event delivered to both
      await subscriber.publish(
        makeEventEnvelope(testRunId, "task_started", { message: "First step" }),
      );

      expect(streamA.getReceivedEnvelopes()).toHaveLength(1);
      expect(streamB.getReceivedEnvelopes()).toHaveLength(1);

      // Client A aborts / connection is destroyed
      streamA.destroy();
      await connA.close("client_abort");

      // Second event published to run
      await subscriber.publish(
        makeEventEnvelope(testRunId, "task_completed", { message: "Second step" }),
      );

      // Stream B continues to receive events cleanly
      const bEnvelopes = streamB.getReceivedEnvelopes();
      expect(bEnvelopes).toHaveLength(2);
      expect(bEnvelopes[1]?.payload.message).toBe("Second step");

      // Gateway metrics record consumed and delivered events
      const metrics = gateway.getMetrics();
      expect(metrics.eventsConsumed).toBe(2);
      expect(metrics.eventsDelivered).toBe(2);
    });

    it("skips event delivery cleanly when no active connections exist for the run", async () => {
      const unobservedRunId = `run-unobserved-${randomUUID()}`;

      await subscriber.publish(
        makeEventEnvelope(unobservedRunId, "task_started", { message: "Quiet step" }),
      );

      const metrics = gateway.getMetrics();
      expect(metrics.eventsConsumed).toBe(1);
      expect(metrics.eventsSkipped).toBe(1);
      expect(metrics.eventsDelivered).toBe(0);
      expect(metrics.eventsDropped).toBe(0);
    });

    it("supports direct deliverRunEvent() API for programmatic dispatch", async () => {
      const stream = new TestStreamBuffer();
      const testRunId = `run-direct-${randomUUID()}`;
      const conn = transportManager.createConnection(stream, { runId: testRunId });
      conn.open();

      const runEvt: RunEvent = {
        id: eventId(`evt-direct-${randomUUID()}`),
        runId: runId(testRunId),
        taskId: taskId(`task-direct-${randomUUID()}`),
        type: "task_completed",
        severity: "success",
        timestamp: new Date().toISOString(),
        message: "Directly delivered execution event",
        worker: workerId("worker-direct-1"),
      };

      const result = await gateway.deliverRunEvent(runEvt, testRunId);

      expect(result.delivered).toBe(1);
      expect(result.dropped).toBe(false);

      const received = stream.getReceivedEnvelopes();
      expect(received).toHaveLength(1);
      expect(received[0]?.payload.message).toBe("Directly delivered execution event");
    });
  });
});
