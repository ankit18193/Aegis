import { Writable } from "node:stream";

import {
  createSseExecutionEnvelope,
  type RunEvent,
} from "@aegis/contracts";
import { eventId, runId, taskId, workerId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryRunEventReplayRepository } from "../../repositories/inMemoryRunEventReplayRepository.js";
import { SseConnection } from "../sseConnection.js";
import { SseReplayCoordinator } from "../sseReplayCoordinator.js";

class MockWritableStream extends Writable {
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

function makeRunEvent(idNum: number, timestampIso: string, targetRunId = "run-coord-1"): RunEvent {
  return {
    id: eventId(`evt-${String(idNum).padStart(3, "0")}`),
    runId: runId(targetRunId),
    type: "task_started",
    severity: "info",
    timestamp: timestampIso,
    message: `Task execution event ${String(idNum)}`,
    taskId: taskId(`task-${String(idNum)}`),
    worker: workerId("worker-1"),
  };
}

describe("SseReplayCoordinator (Phase 13D — Commit 3)", () => {
  let repository: InMemoryRunEventReplayRepository;
  let coordinator: SseReplayCoordinator;
  let stream: MockWritableStream;
  let connection: SseConnection;

  beforeEach(() => {
    repository = new InMemoryRunEventReplayRepository();
    coordinator = new SseReplayCoordinator({
      replayRepository: repository,
      defaultPageSize: 5,
    });
    stream = new MockWritableStream();
    connection = new SseConnection(stream, {
      connectionId: "conn-coord-test",
      runId: "run-coord-1",
      heartbeatIntervalMs: 0,
    });
    connection.open();
  });

  describe("Chronological Historical Replay & Cursor Resumption", () => {
    it("replays historical events in strict chronological sequence after anchor cursor", async () => {
      const e1 = makeRunEvent(1, "2026-10-15T10:00:01.000Z");
      const e2 = makeRunEvent(2, "2026-10-15T10:00:02.000Z");
      const e3 = makeRunEvent(3, "2026-10-15T10:00:03.000Z");
      const e4 = makeRunEvent(4, "2026-10-15T10:00:04.000Z");
      repository.setEvents(runId("run-coord-1"), [e1, e2, e3, e4]);

      // Reconnect after evt-002
      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
        cursor: "evt-002",
      });

      expect(result.success).toBe(true);
      expect(result.replayedCount).toBe(2);
      expect(result.drainedCount).toBe(0);
      expect(result.reconcileRequired).toBe(false);
      expect(result.status).toBe("complete");

      // Verify wire frames: only evt-003 and evt-004 were sent
      expect(stream.writtenChunks).toHaveLength(2);
      expect(stream.writtenChunks[0]).toContain('"id":"evt-003"');
      expect(stream.writtenChunks[1]).toContain('"id":"evt-004"');
    });

    it("replays from the beginning when no cursor is provided", async () => {
      const e1 = makeRunEvent(1, "2026-10-15T10:00:01.000Z");
      const e2 = makeRunEvent(2, "2026-10-15T10:00:02.000Z");
      repository.setEvents(runId("run-coord-1"), [e1, e2]);

      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
      });

      expect(result.success).toBe(true);
      expect(result.replayedCount).toBe(2);
      expect(stream.writtenChunks).toHaveLength(2);
      expect(stream.writtenChunks[0]).toContain('"id":"evt-001"');
      expect(stream.writtenChunks[1]).toContain('"id":"evt-002"');
    });
  });

  describe("Multi-Page Catch-Up Pagination (User Correction 2)", () => {
    it("iteratively fetches all pages until hasMore is false without skipping events", async () => {
      // Create 12 events. Page size is 5 -> 3 pages: 5, 5, 2.
      const events: RunEvent[] = [];
      for (let i = 1; i <= 12; i++) {
        const sec = String(i).padStart(2, "0");
        events.push(makeRunEvent(i, `2026-10-15T10:00:${sec}.000Z`));
      }
      repository.setEvents(runId("run-coord-1"), events);

      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
        pageSize: 5,
      });

      expect(result.success).toBe(true);
      expect(result.replayedCount).toBe(12);
      expect(result.status).toBe("complete");
      expect(result.reconcileRequired).toBe(false);
      expect(stream.writtenChunks).toHaveLength(12);

      // Verify all 12 events were delivered in order
      for (let i = 1; i <= 12; i++) {
        const expectedId = `evt-${String(i).padStart(3, "0")}`;
        expect(stream.writtenChunks[i - 1]).toContain(`"id":"${expectedId}"`);
      }
    });
  });

  describe("Live Buffering, Overlap Deduplication & Race-Free Handoff", () => {
    it("buffers live events during historical catch-up and drains them in order", async () => {
      const e1 = makeRunEvent(1, "2026-10-15T10:00:01.000Z");
      const e2 = makeRunEvent(2, "2026-10-15T10:00:02.000Z");
      repository.setEvents(runId("run-coord-1"), [e1, e2]);

      // Enable buffering on the connection before replay starts (as done during connect)
      connection.enableBuffering();

      // Simulate a live event arriving via broadcast while replay is about to start
      const liveEvent3 = makeRunEvent(3, "2026-10-15T10:00:03.000Z");
      const liveEnvelope3 = createSseExecutionEnvelope(liveEvent3);
      await connection.sendEnvelope(liveEnvelope3);

      expect(connection.bufferSize).toBe(1);
      // Stream has not received the live event yet because it is buffered
      expect(stream.writtenChunks).toHaveLength(0);

      // Run replay
      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
      });

      expect(result.success).toBe(true);
      expect(result.replayedCount).toBe(2);
      expect(result.drainedCount).toBe(1);
      expect(connection.isBuffering).toBe(false);
      expect(connection.bufferSize).toBe(0);

      // Total chunks: 2 replayed + 1 drained = 3
      expect(stream.writtenChunks).toHaveLength(3);
      expect(stream.writtenChunks[0]).toContain('"id":"evt-001"');
      expect(stream.writtenChunks[1]).toContain('"id":"evt-002"');
      expect(stream.writtenChunks[2]).toContain('"id":"evt-003"');

      // Subsequent live events write directly because buffering is disabled
      const liveEvent4 = makeRunEvent(4, "2026-10-15T10:00:04.000Z");
      await connection.sendEvent(liveEvent4);
      expect(stream.writtenChunks).toHaveLength(4);
      expect(stream.writtenChunks[3]).toContain('"id":"evt-004"');
    });

    it("deduplicates events that overlap between durable history and live buffer", async () => {
      const e1 = makeRunEvent(1, "2026-10-15T10:00:01.000Z");
      const e2 = makeRunEvent(2, "2026-10-15T10:00:02.000Z");
      repository.setEvents(runId("run-coord-1"), [e1, e2]);

      connection.enableBuffering();

      // Suppose evt-002 arrived in live buffer while DB also had evt-002 committed,
      // and live buffer also has evt-003
      const liveEnvelope2 = createSseExecutionEnvelope(e2);
      const liveEnvelope3 = createSseExecutionEnvelope(
        makeRunEvent(3, "2026-10-15T10:00:03.000Z"),
      );

      await connection.sendEnvelope(liveEnvelope2);
      await connection.sendEnvelope(liveEnvelope3);
      expect(connection.bufferSize).toBe(2);

      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
      });

      expect(result.success).toBe(true);
      expect(result.replayedCount).toBe(2); // e1, e2 replayed from DB
      expect(result.drainedCount).toBe(1); // e2 was deduplicated; only e3 drained!

      expect(stream.writtenChunks).toHaveLength(3);
      expect(stream.writtenChunks[0]).toContain('"id":"evt-001"');
      expect(stream.writtenChunks[1]).toContain('"id":"evt-002"');
      expect(stream.writtenChunks[2]).toContain('"id":"evt-003"');
    });
  });

  describe("Buffer Overflow Protection (User Correction 3)", () => {
    it("halts handoff immediately and triggers reconciliation on buffer overflow", async () => {
      const e1 = makeRunEvent(1, "2026-10-15T10:00:01.000Z");
      repository.setEvents(runId("run-coord-1"), [e1]);

      // Set capacity to 2
      connection.enableBuffering(2);

      // Overflow the buffer by attempting to send 3 live events
      await connection.sendEnvelope(createSseExecutionEnvelope(makeRunEvent(2, "2026-10-15T10:00:02.000Z")));
      await connection.sendEnvelope(createSseExecutionEnvelope(makeRunEvent(3, "2026-10-15T10:00:03.000Z")));
      const overflowRes = await connection.sendEnvelope(
        createSseExecutionEnvelope(makeRunEvent(4, "2026-10-15T10:00:04.000Z")),
      );

      expect(overflowRes.ok).toBe(false);
      expect(connection.isBufferOverflowed).toBe(true);

      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("buffer_overflow");
      expect(result.reconcileRequired).toBe(true);

      // Verifies SSE error envelope was sent with BUFFER_OVERFLOW code
      const errorChunk = stream.writtenChunks.find((c) => c.includes('"code":"BUFFER_OVERFLOW"'));
      expect(errorChunk).toBeDefined();
      expect(errorChunk).toContain('"reconcileRequired":true');

      // Buffer was cleared and disabled
      expect(connection.bufferSize).toBe(0);
      expect(connection.isBuffering).toBe(false);
    });
  });

  describe("Gap Detection & Cursor Ordering Failures (User Correction 1)", () => {
    it("halts handoff immediately and triggers reconciliation when cursor does not exist", async () => {
      const e1 = makeRunEvent(1, "2026-10-15T10:00:01.000Z");
      repository.setEvents(runId("run-coord-1"), [e1]);

      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
        cursor: "evt-nonexistent-999",
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("gap_detected");
      expect(result.reconcileRequired).toBe(true);

      // Verifies SSE error envelope was sent with REPLAY_GAP_DETECTED
      const errorChunk = stream.writtenChunks.find((c) =>
        c.includes('"code":"REPLAY_GAP_DETECTED"'),
      );
      expect(errorChunk).toBeDefined();
      expect(errorChunk).toContain('"reconcileRequired":true');
      expect(connection.isBuffering).toBe(false);
    });

    it("halts handoff immediately when cursor belongs to a different run", async () => {
      const eOther = makeRunEvent(1, "2026-10-15T10:00:01.000Z", "run-other-999");
      repository.setEvents(runId("run-other-999"), [eOther]);
      repository.registerRun(runId("run-coord-1"));

      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
        cursor: eOther.id,
      });

      expect(result.success).toBe(false);
      expect(result.reconcileRequired).toBe(true);
      expect(connection.isBuffering).toBe(false);
    });
  });

  describe("Client Disconnect & Edge Cases", () => {
    it("stops replay gracefully if connection closes during historical pagination", async () => {
      const events: RunEvent[] = [];
      for (let i = 1; i <= 10; i++) {
        events.push(makeRunEvent(i, `2026-10-15T10:00:0${String(i)}.000Z`));
      }
      repository.setEvents(runId("run-coord-1"), events);

      // Close the connection before replay runs
      await connection.close();

      const result = await coordinator.coordinateReplay(connection, {
        runId: "run-coord-1",
      });

      expect(result.success).toBe(false);
      expect(result.replayedCount).toBe(0);
      expect(connection.isBuffering).toBe(false);
    });
  });
});
