import { Writable } from "node:stream";

import { createSseExecutionEnvelope, type RunEvent } from "@aegis/contracts";
import { eventId, runId, taskId, workerId } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SseConnection } from "./sseConnection.js";

/**
 * In-memory Mock Writable Stream for testing SSE writes, backpressure, and disconnects.
 */
class MockWritableStream extends Writable {
  readonly writtenChunks: string[] = [];
  shouldSimulateBackpressure = false;
  destroyOnWrite = false;

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.destroyOnWrite) {
      const err = new Error("EPIPE: Broken pipe");
      callback(err);
      this.destroy(err);
      return;
    }

    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.writtenChunks.push(text);

    if (this.shouldSimulateBackpressure) {
      // Simulate backpressure by delaying drain
      callback();
      return;
    }

    callback();
  }

  emitDrain(): void {
    this.emit("drain");
  }

  simulateClientDisconnect(): void {
    this.destroy();
    this.emit("close");
  }
}

function createSampleRunEvent(): RunEvent {
  return {
    id: eventId("evt-conn-test-1"),
    runId: runId("run-conn-test-1"),
    type: "task_started",
    severity: "info",
    timestamp: "2026-10-15T00:00:00.000Z",
    message: "Task started",
    taskId: taskId("task-1"),
    worker: workerId("worker-1"),
  };
}

describe("SseConnection Lifecycle Management (Phase 13B — Commit 3)", () => {
  let stream: MockWritableStream;

  beforeEach(() => {
    vi.useFakeTimers();
    stream = new MockWritableStream();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Connection State & Lifecycle Initialization", () => {
    it("initializes with 'initializing' status and opens cleanly", () => {
      const conn = new SseConnection(stream, {
        connectionId: "conn-init-1",
        runId: "run-init-1",
        heartbeatIntervalMs: 5000,
      });

      expect(conn.status).toBe("initializing");
      expect(conn.isOpen).toBe(false);
      expect(conn.isClosed).toBe(false);

      const openRes = conn.open();
      expect(openRes.ok).toBe(true);
      expect(conn.status).toBe("open");
      expect(conn.isOpen).toBe(true);
      expect(conn.isClosed).toBe(false);
      expect(conn.connectionId).toBe("conn-init-1");
      expect(conn.runId).toBe("run-init-1");
    });

    it("rejects repeated open() calls with ALREADY_INITIALIZED", () => {
      const conn = new SseConnection(stream);
      expect(conn.open().ok).toBe(true);

      const secondOpen = conn.open();
      expect(secondOpen.ok).toBe(false);
      if (!secondOpen.ok) {
        expect(secondOpen.error.code).toBe("ALREADY_INITIALIZED");
      }
    });

    it("closes cleanly and notifies onClose listeners", async () => {
      const conn = new SseConnection(stream, { connectionId: "conn-close-1" });
      conn.open();

      let closedReason = "";
      conn.onClose((reason) => {
        closedReason = reason;
      });

      const closeRes = await conn.close("task_completed", true);
      expect(closeRes.ok).toBe(true);
      expect(conn.status).toBe("closed");
      expect(conn.isOpen).toBe(false);
      expect(conn.isClosed).toBe(true);
      expect(closedReason).toBe("task_completed");
      expect(conn.stats.closedAt).toBeDefined();

      // Verified closed frame was written before stream ended
      const lastChunk = stream.writtenChunks[stream.writtenChunks.length - 1];
      expect(lastChunk).toContain("event: closed\n");
      expect(lastChunk).toContain('"terminal":true');
    });

    it("close() is idempotent on already closed connection", async () => {
      const conn = new SseConnection(stream);
      conn.open();

      await conn.close("first_close");
      expect(conn.isClosed).toBe(true);

      // Second call does not error
      const secondClose = await conn.close("second_close");
      expect(secondClose.ok).toBe(true);
    });
  });

  describe("Message Transmission & Canonical Events", () => {
    it("sends canonical RunEvent wrapped in an execution envelope", async () => {
      const conn = new SseConnection(stream);
      conn.open();

      const runEvent = createSampleRunEvent();
      const sendRes = await conn.sendEvent(runEvent);

      expect(sendRes.ok).toBe(true);
      expect(stream.writtenChunks).toHaveLength(1);

      const chunk = stream.writtenChunks[0];
      expect(chunk).toContain(`id: ${runEvent.id}\n`);
      expect(chunk).toContain("event: execution\n");
      expect(chunk).toContain('"type":"task_started"');
      expect(chunk?.endsWith("\n\n")).toBe(true);

      expect(conn.stats.messagesSent).toBe(1);
      expect(conn.stats.bytesWritten).toBeGreaterThan(0);
    });

    it("sends comment frames and error frames", async () => {
      const conn = new SseConnection(stream);
      conn.open();

      const commentRes = await conn.sendComment("custom-ping");
      expect(commentRes.ok).toBe(true);
      expect(stream.writtenChunks[0]).toBe(": custom-ping\n\n");

      const errRes = await conn.sendError(
        "UNAUTHORIZED",
        "Invalid run credentials",
        false,
      );
      expect(errRes.ok).toBe(true);
      expect(stream.writtenChunks[1]).toContain("event: error\n");
      expect(stream.writtenChunks[1]).toContain('"code":"UNAUTHORIZED"');
    });

    it("refuses to send messages if connection is not open", async () => {
      const conn = new SseConnection(stream);
      // Not opened yet!
      const sendRes = await conn.sendEvent(createSampleRunEvent());
      expect(sendRes.ok).toBe(false);
      if (!sendRes.ok) {
        expect(sendRes.error.code).toBe("CONNECTION_CLOSED");
      }
    });
  });

  describe("Heartbeat Management", () => {
    it("emits periodic comment heartbeats when heartbeatMode is 'comment'", async () => {
      const conn = new SseConnection(stream, {
        heartbeatIntervalMs: 2000,
        heartbeatMode: "comment",
      });
      conn.open();

      expect(stream.writtenChunks).toHaveLength(0);

      // Advance by 2 seconds
      await vi.advanceTimersByTimeAsync(2000);
      expect(stream.writtenChunks).toHaveLength(1);
      expect(stream.writtenChunks[0]).toBe(": keep-alive\n\n");
      expect(conn.stats.heartbeatsSent).toBe(1);

      // Advance another 2 seconds
      await vi.advanceTimersByTimeAsync(2000);
      expect(stream.writtenChunks).toHaveLength(2);
      expect(stream.writtenChunks[1]).toBe(": keep-alive\n\n");
      expect(conn.stats.heartbeatsSent).toBe(2);

      await conn.close();
    });

    it("emits periodic event heartbeats when heartbeatMode is 'event'", async () => {
      const conn = new SseConnection(stream, {
        heartbeatIntervalMs: 1000,
        heartbeatMode: "event",
      });
      conn.open();

      await vi.advanceTimersByTimeAsync(1000);
      expect(stream.writtenChunks).toHaveLength(1);
      expect(stream.writtenChunks[0]).toContain("event: heartbeat\n");
      expect(stream.writtenChunks[0]).toContain('"sequenceNumber":1');

      await conn.close();
    });

    it("stops heartbeat timer immediately upon connection closure", async () => {
      const conn = new SseConnection(stream, { heartbeatIntervalMs: 1000 });
      conn.open();

      await conn.close();
      const chunksBefore = stream.writtenChunks.length;

      // Advancing timer does NOT emit any more heartbeats
      await vi.advanceTimersByTimeAsync(5000);
      expect(stream.writtenChunks.length).toBe(chunksBefore);
    });
  });

  describe("Client Disconnect & Stream Failure Safety", () => {
    it("handles abrupt client disconnect cleanly without unhandled exceptions", async () => {
      const conn = new SseConnection(stream);
      conn.open();

      let closeNotified = false;
      let closeReason = "";
      conn.onClose((reason) => {
        closeNotified = true;
        closeReason = reason;
      });

      // Simulate client closing the TCP connection
      stream.simulateClientDisconnect();

      expect(conn.isClosed).toBe(true);
      expect(closeNotified).toBe(true);
      expect(closeReason).toBe("client_disconnected");

      // Attempting to send on closed connection returns graceful error
      const sendRes = await conn.sendEvent(createSampleRunEvent());
      expect(sendRes.ok).toBe(false);
      if (!sendRes.ok) {
        expect(sendRes.error.code).toBe("CONNECTION_CLOSED");
      }
    });

    it("handles stream write errors (e.g. EPIPE) safely", async () => {
      const conn = new SseConnection(stream);
      conn.open();

      // Configure mock stream to fail on write
      stream.destroyOnWrite = true;

      const sendRes = await conn.sendEvent(createSampleRunEvent());
      expect(sendRes.ok).toBe(false);
      expect(conn.stats.errorsEncountered).toBeGreaterThan(0);
      expect(conn.isClosed).toBe(true);
    });
  });

  describe("Backpressure and Drain Handling", () => {
    it("waits for stream 'drain' event when write returns backpressure", async () => {
      const conn = new SseConnection(stream, { drainTimeoutMs: 1000 });
      conn.open();

      // Mock write returning false (backpressure)
      vi.spyOn(stream, "write").mockReturnValue(false);

      const sendPromise = conn.sendComment("heavy-load");

      // Connection is waiting for drain
      // Fire drain event
      stream.emitDrain();

      const sendRes = await sendPromise;
      expect(sendRes.ok).toBe(true);
    });

    it("times out with BACKPRESSURE_TIMEOUT when drain is not emitted within limit", async () => {
      const conn = new SseConnection(stream, { drainTimeoutMs: 500 });
      conn.open();

      vi.spyOn(stream, "write").mockReturnValue(false);

      const sendPromise = conn.sendComment("blocked-data");

      // Advance timer past drainTimeoutMs
      await vi.advanceTimersByTimeAsync(600);

      const sendRes = await sendPromise;
      expect(sendRes.ok).toBe(false);
      if (!sendRes.ok) {
        expect(sendRes.error.code).toBe("BACKPRESSURE_TIMEOUT");
      }
    });

    it("cancels drain timeout immediately and returns CONNECTION_CLOSED if client disconnects while waiting for drain", async () => {
      const conn = new SseConnection(stream, { drainTimeoutMs: 5000 });
      conn.open();

      vi.spyOn(stream, "write").mockReturnValue(false);

      const sendPromise = conn.sendComment("blocked-data");

      // Client abruptly closes socket before drain or timeout
      stream.simulateClientDisconnect();

      const sendRes = await sendPromise;
      expect(sendRes.ok).toBe(false);
      if (!sendRes.ok) {
        expect(sendRes.error.code).toBe("CONNECTION_CLOSED");
      }
      expect(conn.isClosed).toBe(true);
    });

    it("evicts slow consumer, triggers backpressure_timeout, and destroys stream upon timeout", async () => {
      const conn = new SseConnection(stream, { drainTimeoutMs: 1000 });
      conn.open();

      let terminationReason = "";
      conn.onClose((reason) => {
        terminationReason = reason;
      });

      vi.spyOn(stream, "write").mockReturnValue(false);

      const sendPromise = conn.sendComment("slow-consumer-data");

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(1100);

      const sendRes = await sendPromise;
      expect(sendRes.ok).toBe(false);
      expect(conn.isClosed).toBe(true);
      expect(terminationReason).toBe("backpressure_timeout");
    });

    it("clears live replay buffer and disables buffering immediately upon stream termination", async () => {
      const conn = new SseConnection(stream);
      conn.open();
      conn.enableBuffering(100);

      await conn.sendEnvelope(createSseExecutionEnvelope(createSampleRunEvent()));

      expect(conn.bufferSize).toBe(1);
      expect(conn.isBuffering).toBe(true);

      // Stream terminates
      stream.simulateClientDisconnect();

      expect(conn.bufferSize).toBe(0);
      expect(conn.isBuffering).toBe(false);
    });
  });

  describe("Listener Management", () => {
    it("supports unsubscribing from onClose", () => {
      const conn = new SseConnection(stream);
      conn.open();

      let called = false;
      const unsubscribe = conn.onClose(() => {
        called = true;
      });

      // Unsubscribe before close
      unsubscribe();
      stream.simulateClientDisconnect();

      expect(called).toBe(false);
    });
  });
});
