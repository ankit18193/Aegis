import { Writable } from "node:stream";

import {
  createSseExecutionEnvelope,
  deserializeSseEnvelope,
  parseSseFrame,
  type RunEvent,
} from "@aegis/contracts";
import { eventId, runId, taskId, workerId } from "@aegis/types";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../app.js";
import { SseTransportManager } from "../index.js";

class BufferedWritableStream extends Writable {
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

  simulateDisconnect(): void {
    this.destroy();
    this.emit("close");
  }
}

function createSampleEvent(rId: string, tId: string, status: "task_started" | "task_completed"): RunEvent {
  return {
    id: eventId(`evt-${rId}-${tId}-${status}`),
    runId: runId(rId),
    type: status,
    severity: "info",
    timestamp: "2026-10-15T00:00:00.000Z",
    message: `Task ${tId} transitioned to ${status}`,
    taskId: taskId(tId),
    worker: workerId("worker-node-1"),
    metadata: { testMeta: true },
  };
}

describe("SSE Transport Foundation — End-to-End Integration Tests (Phase 13B)", () => {
  let app: FastifyInstance;
  let transportManager: SseTransportManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    transportManager = new SseTransportManager({ defaultHeartbeatIntervalMs: 3000 });
    app = await buildApp({
      sseTransportManager: transportManager,
    });
    await app.ready();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  describe("End-to-End Wire Framing & Protocol Deserialization", () => {
    it("delivers sequential execution events across the transport that deserialize faithfully", async () => {
      const stream = new BufferedWritableStream();
      const conn = transportManager.createConnection(stream, {
        connectionId: "conn-e2e-1",
        runId: "run-e2e-1",
      });
      conn.open();

      expect(conn.isOpen).toBe(true);
      expect(transportManager.activeConnectionCount).toBe(1);

      // 1. Send task_started event
      const event1 = createSampleEvent("run-e2e-1", "task-1", "task_started");
      const res1 = await conn.sendEvent(event1);
      expect(res1.ok).toBe(true);

      // 2. Send task_completed event
      const event2 = createSampleEvent("run-e2e-1", "task-1", "task_completed");
      const res2 = await conn.sendEvent(event2);
      expect(res2.ok).toBe(true);

      expect(stream.chunks).toHaveLength(2);

      // Parse and deserialize first chunk
      const parsedFrame1 = parseSseFrame(stream.chunks[0] ?? "");
      expect(parsedFrame1.ok).toBe(true);
      if (parsedFrame1.ok) {
        expect(parsedFrame1.value.event).toBe("execution");
        expect(parsedFrame1.value.id).toBe(event1.id);
      }

      const deserialized1 = deserializeSseEnvelope(stream.chunks[0] ?? "");
      expect(deserialized1.ok).toBe(true);
      if (deserialized1.ok) {
        expect(deserialized1.value.type).toBe("execution");
        if (deserialized1.value.type === "execution") {
          expect(deserialized1.value.payload.id).toBe(event1.id);
          expect(deserialized1.value.payload.type).toBe("task_started");
          expect(deserialized1.value.payload.worker).toBe("worker-node-1");
        }
      }

      // Parse and deserialize second chunk
      const deserialized2 = deserializeSseEnvelope(stream.chunks[1] ?? "");
      expect(deserialized2.ok).toBe(true);
      if (deserialized2.ok) {
        expect(deserialized2.value.type).toBe("execution");
        if (deserialized2.value.type === "execution") {
          expect(deserialized2.value.payload.id).toBe(event2.id);
          expect(deserialized2.value.payload.type).toBe("task_completed");
        }
      }

      await conn.close("e2e_complete", true);
      expect(conn.isClosed).toBe(true);
      expect(transportManager.activeConnectionCount).toBe(0);
    });
  });

  describe("Concurrent Multi-Client Streaming & Run-Scoped Isolation", () => {
    it("delivers broadcast events exclusively to targeted run subscribers without cross-talk", async () => {
      const streamAlpha1 = new BufferedWritableStream();
      const streamAlpha2 = new BufferedWritableStream();
      const streamBeta1 = new BufferedWritableStream();

      // Client 1 & 2 subscribe to Run Alpha
      const connAlpha1 = transportManager.createConnection(streamAlpha1, {
        connectionId: "alpha-client-1",
        runId: "run-alpha",
      });
      const connAlpha2 = transportManager.createConnection(streamAlpha2, {
        connectionId: "alpha-client-2",
        runId: "run-alpha",
      });

      // Client 3 subscribes to Run Beta
      const connBeta1 = transportManager.createConnection(streamBeta1, {
        connectionId: "beta-client-1",
        runId: "run-beta",
      });

      connAlpha1.open();
      connAlpha2.open();
      connBeta1.open();

      expect(transportManager.activeConnectionCount).toBe(3);
      expect(transportManager.getConnectionsByRunId("run-alpha")).toHaveLength(2);
      expect(transportManager.getConnectionsByRunId("run-beta")).toHaveLength(1);

      // Broadcast event to Run Alpha
      const alphaEvent = createSampleEvent("run-alpha", "task-alpha-1", "task_started");
      const alphaEnvelope = createSseExecutionEnvelope(alphaEvent);

      const deliveredCount = await transportManager.broadcastToRun("run-alpha", alphaEnvelope);
      expect(deliveredCount).toBe(2);

      // Both Alpha clients received the event
      expect(streamAlpha1.chunks).toHaveLength(1);
      expect(streamAlpha2.chunks).toHaveLength(1);
      expect(streamAlpha1.chunks[0]).toContain(alphaEvent.id);
      expect(streamAlpha2.chunks[0]).toContain(alphaEvent.id);

      // Beta client received NOTHING (strict isolation)
      expect(streamBeta1.chunks).toHaveLength(0);

      // Broadcast event to Run Beta
      const betaEvent = createSampleEvent("run-beta", "task-beta-1", "task_started");
      const betaEnvelope = createSseExecutionEnvelope(betaEvent);

      const deliveredBeta = await transportManager.broadcastToRun("run-beta", betaEnvelope);
      expect(deliveredBeta).toBe(1);

      // Beta client received its event
      expect(streamBeta1.chunks).toHaveLength(1);
      expect(streamBeta1.chunks[0]).toContain(betaEvent.id);

      // Alpha clients remained at 1 chunk
      expect(streamAlpha1.chunks).toHaveLength(1);
      expect(streamAlpha2.chunks).toHaveLength(1);

      // Clean up
      await connAlpha1.close();
      await connAlpha2.close();
      await connBeta1.close();
      expect(transportManager.activeConnectionCount).toBe(0);
    });
  });

  describe("Heartbeat & Comment Framing", () => {
    it("periodically emits keep-alive comments without corrupting data streams", async () => {
      const stream = new BufferedWritableStream();
      const conn = transportManager.createConnection(stream, {
        connectionId: "conn-heartbeat-test",
        heartbeatIntervalMs: 2000,
        heartbeatMode: "comment",
      });
      conn.open();

      // Send initial data event
      await conn.sendEvent(createSampleEvent("run-1", "task-1", "task_started"));
      expect(stream.chunks).toHaveLength(1);

      // Advance by 2 seconds -> heartbeat emitted
      await vi.advanceTimersByTimeAsync(2000);
      expect(stream.chunks).toHaveLength(2);
      expect(stream.chunks[1]).toBe(": keep-alive\n\n");

      // Send another data event
      await conn.sendEvent(createSampleEvent("run-1", "task-1", "task_completed"));
      expect(stream.chunks).toHaveLength(3);

      // Advance another 2 seconds -> second heartbeat
      await vi.advanceTimersByTimeAsync(2000);
      expect(stream.chunks).toHaveLength(4);
      expect(stream.chunks[3]).toBe(": keep-alive\n\n");

      await conn.close();
    });
  });

  describe("Abrupt Client Disconnect and Resource Recovery", () => {
    it("recovers resources and unregisters connection when client socket abruptly disconnects", async () => {
      const stream1 = new BufferedWritableStream();
      const stream2 = new BufferedWritableStream();

      const conn1 = transportManager.createConnection(stream1, {
        connectionId: "conn-abort-1",
        runId: "run-resilience",
      });
      const conn2 = transportManager.createConnection(stream2, {
        connectionId: "conn-survive-2",
        runId: "run-resilience",
      });

      conn1.open();
      conn2.open();
      expect(transportManager.activeConnectionCount).toBe(2);

      // Client 1 disconnects abruptly
      stream1.simulateDisconnect();

      expect(conn1.isClosed).toBe(true);
      expect(transportManager.activeConnectionCount).toBe(1);
      expect(transportManager.getConnectionsByRunId("run-resilience")).toHaveLength(1);

      // Surviving connection continues to receive broadcasts
      const event = createSampleEvent("run-resilience", "task-1", "task_completed");
      const envelope = createSseExecutionEnvelope(event);

      const delivered = await transportManager.broadcastToRun("run-resilience", envelope);
      expect(delivered).toBe(1);
      expect(stream2.chunks).toHaveLength(1);

      // Writing to aborted conn1 safely returns error without crash
      const deadSend = await conn1.sendEvent(event);
      expect(deadSend.ok).toBe(false);
      if (!deadSend.ok) {
        expect(deadSend.error.code).toBe("CONNECTION_CLOSED");
      }

      await conn2.close();
      expect(transportManager.activeConnectionCount).toBe(0);
    });
  });

  describe("Server Shutdown and Mass Teardown", () => {
    it("gracefully terminates all open SSE connections when Fastify server shuts down", async () => {
      const streamA = new BufferedWritableStream();
      const streamB = new BufferedWritableStream();

      const connA = transportManager.createConnection(streamA, { connectionId: "shutdown-A" });
      const connB = transportManager.createConnection(streamB, { connectionId: "shutdown-B" });

      connA.open();
      connB.open();
      expect(transportManager.activeConnectionCount).toBe(2);

      // Fastify app closes
      await app.close();

      expect(transportManager.activeConnectionCount).toBe(0);
      expect(connA.isClosed).toBe(true);
      expect(connB.isClosed).toBe(true);
      expect(streamA.isEnded).toBe(true);
      expect(streamB.isEnded).toBe(true);
    });
  });
});
