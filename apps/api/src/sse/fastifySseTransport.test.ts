import { Writable } from "node:stream";

import { createSseExecutionEnvelope } from "@aegis/contracts";
import { eventId, runId, taskId, workerId } from "@aegis/types";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  registerSseTransportRoutes,
  SseTransportManager,
} from "./index.js";

class TestWritableStream extends Writable {
  readonly writtenChunks: string[] = [];
  isFinalized = false;

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writtenChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.isFinalized = true;
    callback();
  }
}

describe("Fastify SSE Transport Foundation (Phase 13B — Commit 4)", () => {
  let app: FastifyInstance;
  let manager: SseTransportManager;

  beforeEach(async () => {
    app = fastify({ logger: false });
    manager = new SseTransportManager({ defaultHeartbeatIntervalMs: 5000 });
    registerSseTransportRoutes(app, manager);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("HTTP Response Headers & Handshake", () => {
    it("sets standards-compliant SSE headers upon connecting", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/stream/transport?closeImmediately=true",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(
        "text/event-stream; charset=utf-8",
      );
      expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
      expect(response.headers.connection).toBe("keep-alive");
      expect(response.headers["x-accel-buffering"]).toBe("no");

      // Validates initial connected envelope was flushed
      expect(response.body).toContain("event: connected\n");
      expect(response.body).toContain('"specVersion":"1.0"');
      expect(response.body).toContain('"type":"connected"');
    });

    it("reports active connections count accurately via stats endpoint", async () => {
      const statsBefore = await app.inject({
        method: "GET",
        url: "/api/v1/stream/transport/stats",
      });

      expect(statsBefore.statusCode).toBe(200);
      expect(statsBefore.json()).toEqual({ activeConnections: 0 });

      // Create a managed connection
      const dummyStream = new TestWritableStream();
      const conn = manager.createConnection(dummyStream, {
        connectionId: "conn-stat-1",
      });
      conn.open();

      const statsAfter = await app.inject({
        method: "GET",
        url: "/api/v1/stream/transport/stats",
      });

      expect(statsAfter.json()).toEqual({ activeConnections: 1 });

      await conn.close();

      const statsFinal = await app.inject({
        method: "GET",
        url: "/api/v1/stream/transport/stats",
      });
      expect(statsFinal.json()).toEqual({ activeConnections: 0 });
    });
  });

  describe("Run Scoping and Broadcast Management", () => {
    it("associates connections with runId query parameter and supports broadcast", async () => {
      const dummyStreamA = new TestWritableStream();

      const connA = manager.createConnection(dummyStreamA, {
        connectionId: "conn-run-A",
        runId: "run-target-123",
      });
      connA.open();

      const connections = manager.getConnectionsByRunId("run-target-123");
      expect(connections).toHaveLength(1);
      expect(connections[0]?.connectionId).toBe("conn-run-A");

      // Broadcast to run-target-123
      const execEnvelope = createSseExecutionEnvelope({
        id: eventId("evt-broadcast-1"),
        runId: runId("run-target-123"),
        type: "task_started",
        severity: "info",
        timestamp: "2026-10-15T00:00:00.000Z",
        message: "Broadcast task started",
        taskId: taskId("task-b-1"),
        worker: workerId("worker-b-1"),
      });

      const count = await manager.broadcastToRun("run-target-123", execEnvelope);
      expect(count).toBe(1);
      expect(dummyStreamA.writtenChunks).toHaveLength(1);
      expect(dummyStreamA.writtenChunks[0]).toContain("event: execution\n");
      expect(dummyStreamA.writtenChunks[0]).toContain('"type":"task_started"');

      // Broadcast to different run does not deliver to connA
      const countOther = await manager.broadcastToRun("run-other-999", execEnvelope);
      expect(countOther).toBe(0);
      expect(dummyStreamA.writtenChunks).toHaveLength(1); // Still 1

      await connA.close();
      expect(manager.getConnectionsByRunId("run-target-123")).toHaveLength(0);
    });
  });

  describe("Server Shutdown and Cleanup", () => {
    it("closes all active connections when server shuts down", async () => {
      const dummyStream = new TestWritableStream();

      const conn = manager.createConnection(dummyStream, {
        connectionId: "conn-shutdown-test",
      });
      conn.open();
      expect(manager.activeConnectionCount).toBe(1);

      // Trigger server close
      await app.close();

      expect(manager.activeConnectionCount).toBe(0);
      expect(conn.isClosed).toBe(true);
      expect(dummyStream.isFinalized).toBe(true);
    });
  });
});
