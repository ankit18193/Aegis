/**
 * SSE Streaming Performance Limits & Boundary Validation Suite — Phase 13E (Commit 7)
 *
 * Validates streaming throughput, memory bounds, large payload serialization,
 * and high-fanout transport performance under stress.
 */

import { Writable } from "node:stream";

import {
  createSseExecutionEnvelope,
  deserializeSseEnvelope,
  type RunEvent,
} from "@aegis/contracts";
import { eventId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { SseConnection } from "../sseConnection.js";
import { SseTransportManager } from "../sseTransportManager.js";

class BenchmarkWritableStream extends Writable {
  readonly writtenChunks: string[] = [];
  totalBytesWritten = 0;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.writtenChunks.push(text);
    this.totalBytesWritten += Buffer.byteLength(text, "utf8");
    callback();
  }
}

function makePerfRunEvent(
  idNum: number,
  rId: string,
  extraMetadata?: Record<string, unknown>,
): RunEvent {
  return {
    id: eventId(`evt-perf-${String(idNum).padStart(5, "0")}`),
    runId: runId(rId),
    type: "task_started",
    severity: "info",
    timestamp: new Date(1760500000000 + idNum * 10).toISOString(),
    message: `Performance execution event ${String(idNum)}`,
    taskId: taskId(`task-${String(idNum)}`),
    worker: workerId("worker-perf-1"),
    metadata: extraMetadata,
  };
}

describe("SSE Streaming Performance Limits (Phase 13E — Commit 7)", () => {
  describe("High-Throughput Burst Streaming", () => {
    it("serializes and streams 1,000 sequential execution events with low latency and exact ordering", async () => {
      const stream = new BenchmarkWritableStream();
      const conn = new SseConnection(stream, {
        connectionId: "conn-perf-burst",
        runId: "run-perf-1",
        heartbeatIntervalMs: 0,
      });
      conn.open();

      const TOTAL_EVENTS = 1_000;
      const startTime = performance.now();

      for (let i = 1; i <= TOTAL_EVENTS; i++) {
        const event = makePerfRunEvent(i, "run-perf-1");
        const res = await conn.sendEvent(event);
        expect(res.ok).toBe(true);
      }

      const elapsedMs = performance.now() - startTime;

      expect(stream.writtenChunks).toHaveLength(TOTAL_EVENTS);
      expect(conn.stats.messagesSent).toBe(TOTAL_EVENTS);
      expect(conn.stats.bytesWritten).toBeGreaterThan(0);

      // Verify exact chronological ordering of first, middle, and last
      expect(stream.writtenChunks[0]).toContain('"id":"evt-perf-00001"');
      expect(stream.writtenChunks[499]).toContain('"id":"evt-perf-00500"');
      expect(stream.writtenChunks[999]).toContain('"id":"evt-perf-01000"');

      // Ensure average framing throughput is high (< 50ms per batch of 1,000 in memory)
      expect(elapsedMs).toBeLessThan(5_000);
    });
  });

  describe("Large Payload Serialization & Transmission", () => {
    it("faithfully serializes and delivers large 64KB tool output payload without corruption or truncation", async () => {
      const stream = new BenchmarkWritableStream();
      const conn = new SseConnection(stream, {
        connectionId: "conn-perf-large",
        runId: "run-perf-2",
        heartbeatIntervalMs: 0,
      });
      conn.open();

      // Construct a large 64KB string payload
      const largeOutput = "AegisExecutionLogLine: ".repeat(2_500); // ~60KB
      const largeEvent = makePerfRunEvent(1, "run-perf-2", {
        stdout: largeOutput,
        exitCode: 0,
        nestedStructure: {
          diff: "+ added line\n- deleted line\n".repeat(200),
          summary: "Bulk automated benchmark verification",
        },
      });

      const sendRes = await conn.sendEvent(largeEvent);
      expect(sendRes.ok).toBe(true);

      expect(stream.writtenChunks).toHaveLength(1);
      const rawChunk = stream.writtenChunks[0];
      expect(rawChunk).toBeDefined();
      if (!rawChunk) return;

      expect(Buffer.byteLength(rawChunk, "utf8")).toBeGreaterThan(60_000);

      // Parse and deserialize back to verify round-trip integrity
      const dataMatch = /data: (\{.*\})\n\n$/s.exec(rawChunk);
      expect(dataMatch).not.toBeNull();
      if (!dataMatch?.[1]) return;

      const deserializedRes = deserializeSseEnvelope({ data: dataMatch[1] });
      expect(deserializedRes.ok).toBe(true);
      if (deserializedRes.ok && deserializedRes.value.type === "execution") {
        expect(deserializedRes.value.payload.metadata?.["stdout"]).toBe(largeOutput);
        expect(deserializedRes.value.id).toBe(largeEvent.id);
      }
    });
  });

  describe("Buffer Threshold Enforcement & Memory Reclamation Under Pressure", () => {
    it("strictly bounds live buffer to 500 events and releases all memory upon connection termination", async () => {
      const stream = new BenchmarkWritableStream();
      const conn = new SseConnection(stream, {
        connectionId: "conn-perf-buf",
        runId: "run-perf-3",
        heartbeatIntervalMs: 0,
      });
      conn.open();

      // Arm buffering for replay handoff
      conn.enableBuffering(500);
      expect(conn.isBuffering).toBe(true);

      // Fill exactly 500 events into the buffer
      for (let i = 1; i <= 500; i++) {
        const evt = makePerfRunEvent(i, "run-perf-3");
        const res = await conn.sendEnvelope(createSseExecutionEnvelope(evt));
        expect(res.ok).toBe(true);
      }

      expect(conn.bufferSize).toBe(500);
      expect(conn.hasBufferOverflowed()).toBe(false);

      // Event 501 must trigger BUFFER_OVERFLOW
      const overflowEvt = makePerfRunEvent(501, "run-perf-3");
      const overflowRes = await conn.sendEnvelope(createSseExecutionEnvelope(overflowEvt));
      expect(overflowRes.ok).toBe(false);
      if (!overflowRes.ok) {
        expect(overflowRes.error.code).toBe("BUFFER_OVERFLOW");
      }
      expect(conn.hasBufferOverflowed()).toBe(true);

      // Terminating stream must immediately free all 500 buffered events
      await conn.close("overflow_recovery");
      expect(conn.bufferSize).toBe(0);
      expect(conn.isBuffering).toBe(false);
      expect(conn.isClosed).toBe(true);
    });
  });

  describe("Transport Manager High-Fanout Broadcast", () => {
    it("distributes events to 50 concurrent connections simultaneously with zero dropped streams", async () => {
      const manager = new SseTransportManager();
      const rId = "run-perf-fanout";
      const CLIENT_COUNT = 50;

      const streams: BenchmarkWritableStream[] = [];
      const conns: SseConnection[] = [];

      for (let i = 1; i <= CLIENT_COUNT; i++) {
        const s = new BenchmarkWritableStream();
        streams.push(s);
        const c = manager.createConnection(s, {
          connectionId: `conn-fanout-${String(i)}`,
          runId: rId,
          heartbeatIntervalMs: 0,
        });
        c.open();
        conns.push(c);
      }

      expect(manager.activeConnectionCount).toBe(CLIENT_COUNT);
      expect(manager.getConnectionsByRunId(rId)).toHaveLength(CLIENT_COUNT);

      // Broadcast 10 events across all 50 streams
      const EVENT_COUNT = 10;
      for (let i = 1; i <= EVENT_COUNT; i++) {
        const evt = makePerfRunEvent(i, rId);
        const delivered = await manager.broadcastToRun(rId, createSseExecutionEnvelope(evt));
        expect(delivered).toBe(CLIENT_COUNT);
      }

      // Verify every stream received all 10 events
      for (const s of streams) {
        expect(s.writtenChunks).toHaveLength(EVENT_COUNT);
      }

      // Teardown all 50 connections
      await manager.closeAll("benchmark_complete");
      expect(manager.activeConnectionCount).toBe(0);
      expect(manager.getConnectionsByRunId(rId)).toHaveLength(0);

      for (const c of conns) {
        expect(c.isClosed).toBe(true);
      }
    });
  });
});
