/**
 * Durable Run Event Replay Contract Test Suite — Phase 13D: Commit 1
 *
 * Verifies the durable replay contracts, schemas, cursor codecs, error contracts,
 * pagination semantics, and invariants defined in replay.ts.
 */

import { randomUUID } from "node:crypto";

import { eventId, runId, taskId, type EventId, type RunId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { RunEvent } from "./events.js";
import {
  createReplayError,
  createReplayRequest,
  createReplayResult,
  decodeReplayCursor,
  encodeReplayCursor,
  isReconcileRequired,
  rawCursorSchema,
  REPLAY_DEFAULT_PAGE_SIZE,
  REPLAY_MAX_BUFFER_CAPACITY,
  REPLAY_MAX_PAGE_SIZE,
  REPLAY_MIN_PAGE_SIZE,
  replayCursorPositionSchema,
  runEventReplayErrorCodeSchema,
  runEventReplayRequestSchema,
  runEventReplayResultSchema,
  runEventReplayStatusSchema,
  type ReplayCursorPosition,
  type RunEventReplayStatus,
} from "./replay.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createSampleRunEvent(params: {
  id?: string;
  runIdStr?: string;
  type?: "task_started" | "task_completed" | "run_created";
  timestamp?: string;
} = {}): RunEvent {
  const rId = params.runIdStr ? runId(params.runIdStr) : runId("run-test-100");
  const eId = params.id ? eventId(params.id) : eventId(`evt-${randomUUID()}`);
  return {
    id: eId,
    runId: rId,
    type: params.type ?? "task_started",
    severity: "info",
    timestamp: params.timestamp ?? new Date().toISOString(),
    message: "Test task started",
    taskId: taskId("task-1"),
    taskName: "analyze_code",
    metadata: { key: "value" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Durable Replay Contracts & Cursor Semantics (Phase 13D - Commit 1)", () => {
  const TEST_RUN_ID: RunId = runId("run-alpha-42");

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Cursor Encoding & Decoding
  // ─────────────────────────────────────────────────────────────────────────

  describe("Cursor Encoding & Decoding", () => {
    it("decodes a raw canonical EventId string directly", () => {
      const raw = "evt-test-12345";
      const result = decodeReplayCursor(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.eventId).toBe(eventId("evt-test-12345"));
        expect(result.value.timestamp).toBeUndefined();
        expect(result.value.sequenceNumber).toBeUndefined();
      }
    });

    it("decodes a raw UUID string without modification", () => {
      const uuidStr = randomUUID();
      const result = decodeReplayCursor(uuidStr);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.eventId).toBe(eventId(uuidStr));
      }
    });

    it("encodes and decodes a compound cursor with timestamp and sequenceNumber roundtrip", () => {
      const original: ReplayCursorPosition = {
        eventId: eventId("evt-comp-99"),
        timestamp: "2026-10-16T12:00:00.000Z",
        sequenceNumber: 42,
      };

      const encoded = encodeReplayCursor(original);
      expect(encoded.startsWith("c1:")).toBe(true);

      const decodedRes = decodeReplayCursor(encoded);
      expect(decodedRes.ok).toBe(true);
      if (decodedRes.ok) {
        expect(decodedRes.value.eventId).toBe(original.eventId);
        expect(decodedRes.value.timestamp).toBe(original.timestamp);
        expect(decodedRes.value.sequenceNumber).toBe(original.sequenceNumber);
      }
    });

    it("encodes plain eventId without compound prefix when only eventId is provided", () => {
      const simple: ReplayCursorPosition = {
        eventId: eventId("evt-simple-1"),
      };
      const encoded = encodeReplayCursor(simple);
      expect(encoded).toBe("evt-simple-1");
    });

    it("rejects empty, blank, or whitespace-only cursors", () => {
      const emptyRes = decodeReplayCursor("");
      expect(emptyRes.ok).toBe(false);
      if (!emptyRes.ok) {
        expect(emptyRes.error.code).toBe("INVALID_CURSOR");
      }

      const blankRes = decodeReplayCursor("   ");
      expect(blankRes.ok).toBe(false);
      if (!blankRes.ok) {
        expect(blankRes.error.code).toBe("INVALID_CURSOR");
      }
    });

    it("rejects cursors containing newlines, spaces, or illegal control characters", () => {
      const invalidChars = [
        "evt-123\n456",
        "evt-123\r456",
        "evt 123",
        "evt\t123",
        "<script>alert(1)</script>",
      ];

      for (const invalid of invalidChars) {
        const res = decodeReplayCursor(invalid);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("INVALID_CURSOR");
        }
      }
    });

    it("rejects corrupted compound cursor payload with invalid JSON or missing eventId", () => {
      const corruptedB64 = "c1:bm90LWpzb24"; // "not-json" base64
      const res = decodeReplayCursor(corruptedB64);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_CURSOR");
      }

      // JSON without event ID
      const missingIdPayload = Buffer.from(JSON.stringify({ t: "2026-01-01" })).toString("base64url");
      const res2 = decodeReplayCursor(`c1:${missingIdPayload}`);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.error.code).toBe("INVALID_CURSOR");
      }
    });

    it("validates rawCursorSchema directly", () => {
      expect(rawCursorSchema.safeParse("evt-abc_123.456:789").success).toBe(true);
      expect(rawCursorSchema.safeParse("").success).toBe(false);
      expect(rawCursorSchema.safeParse("a".repeat(513)).success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Replay Request Schema & Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe("Replay Request Schema", () => {
    it("parses valid minimal replay request with default page size", () => {
      const parsed = runEventReplayRequestSchema.parse({
        runId: TEST_RUN_ID,
      });

      expect(parsed.runId).toBe(TEST_RUN_ID);
      expect(parsed.cursor).toBeUndefined();
      expect(parsed.limit).toBe(REPLAY_DEFAULT_PAGE_SIZE);
      expect(parsed.boundaryEventId).toBeUndefined();
    });

    it("parses complete request with cursor, custom limit, and boundaryEventId", () => {
      const boundaryId: EventId = eventId("evt-bound-1");
      const parsed = runEventReplayRequestSchema.parse({
        runId: TEST_RUN_ID,
        cursor: "evt-anchor-456",
        limit: 100,
        boundaryEventId: boundaryId,
      });

      expect(parsed.runId).toBe(TEST_RUN_ID);
      expect(parsed.cursor).toBe("evt-anchor-456");
      expect(parsed.limit).toBe(100);
      expect(parsed.boundaryEventId).toBe(boundaryId);
    });

    it("coerces string limit into number within allowed bounds", () => {
      const parsed = runEventReplayRequestSchema.parse({
        runId: TEST_RUN_ID,
        limit: "25",
      });
      expect(parsed.limit).toBe(25);
    });

    it("rejects limits smaller than minimum (1) or greater than maximum (200)", () => {
      expect(() =>
        runEventReplayRequestSchema.parse({
          runId: TEST_RUN_ID,
          limit: 0,
        }),
      ).toThrow();

      expect(() =>
        runEventReplayRequestSchema.parse({
          runId: TEST_RUN_ID,
          limit: -5,
        }),
      ).toThrow();

      expect(() =>
        runEventReplayRequestSchema.parse({
          runId: TEST_RUN_ID,
          limit: 201,
        }),
      ).toThrow();
    });

    it("creates replay request via createReplayRequest helper", () => {
      const success = createReplayRequest({
        runId: TEST_RUN_ID,
        cursor: "evt-123",
        limit: 75,
      });
      expect(success.ok).toBe(true);
      if (success.ok) {
        expect(success.value.limit).toBe(75);
      }

      const fail = createReplayRequest({
        runId: "",
        limit: 9999,
      });
      expect(fail.ok).toBe(false);
      if (!fail.ok) {
        expect(fail.error.code).toBe("INVALID_CURSOR");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Replay Result Construction & Status Semantics
  // ─────────────────────────────────────────────────────────────────────────

  describe("Replay Result & Pagination Semantics", () => {
    it("constructs complete replay result when no more pages exist", () => {
      const event1 = createSampleRunEvent({ runIdStr: TEST_RUN_ID, id: "evt-1" });
      const event2 = createSampleRunEvent({ runIdStr: TEST_RUN_ID, id: "evt-2" });

      const result = createReplayResult({
        runId: TEST_RUN_ID,
        events: [event1, event2],
        nextCursor: null,
        hasMore: false,
        latestEventId: "evt-2",
      });

      expect(result.runId).toBe(TEST_RUN_ID);
      expect(result.events).toHaveLength(2);
      expect(result.replayedCount).toBe(2);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      expect(result.status).toBe("complete");
      expect(result.reconcileRequired).toBe(false);
      expect(result.isCatchUpComplete).toBe(true);
      expect(result.latestEventId).toBe(eventId("evt-2"));

      // Schema check
      expect(runEventReplayResultSchema.safeParse(result).success).toBe(true);
    });

    it("constructs multi-page result with has_more status and nextCursor", () => {
      const event1 = createSampleRunEvent({ runIdStr: TEST_RUN_ID, id: "evt-page1-last" });

      const result = createReplayResult({
        runId: TEST_RUN_ID,
        events: [event1],
        nextCursor: "evt-page1-last",
        hasMore: true,
        latestEventId: "evt-page3-latest",
      });

      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBe("evt-page1-last");
      expect(result.status).toBe("has_more");
      expect(result.reconcileRequired).toBe(false);
      expect(result.isCatchUpComplete).toBe(false);
      expect(result.latestEventId).toBe(eventId("evt-page3-latest"));
    });

    it("enforces reconcileRequired: true when status is gap_detected", () => {
      const result = createReplayResult({
        runId: TEST_RUN_ID,
        events: [],
        status: "gap_detected",
      });

      expect(result.status).toBe("gap_detected");
      expect(result.reconcileRequired).toBe(true);
      expect(result.hasMore).toBe(false);
      expect(result.events).toHaveLength(0);
    });

    it("enforces reconcileRequired: true when status is history_exhausted", () => {
      const result = createReplayResult({
        runId: TEST_RUN_ID,
        events: [],
        status: "history_exhausted",
      });

      expect(result.status).toBe("history_exhausted");
      expect(result.reconcileRequired).toBe(true);
    });

    it("enforces reconcileRequired: true on buffer_overflow to stop unsafe handoff", () => {
      const result = createReplayResult({
        runId: TEST_RUN_ID,
        events: [],
        status: "buffer_overflow",
      });

      expect(result.status).toBe("buffer_overflow");
      expect(result.reconcileRequired).toBe(true);
    });

    it("evaluates isReconcileRequired correctly for all status variants", () => {
      const allStatuses: RunEventReplayStatus[] = [
        "complete",
        "has_more",
        "gap_detected",
        "history_exhausted",
        "buffer_overflow",
      ];

      for (const st of allStatuses) {
        expect(runEventReplayStatusSchema.safeParse(st).success).toBe(true);
      }

      expect(isReconcileRequired("complete")).toBe(false);
      expect(isReconcileRequired("has_more")).toBe(false);
      expect(isReconcileRequired("gap_detected")).toBe(true);
      expect(isReconcileRequired("history_exhausted")).toBe(true);
      expect(isReconcileRequired("buffer_overflow")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Error Contracts & Validation
  // ─────────────────────────────────────────────────────────────────────────

  describe("Error Contracts & Codes", () => {
    it("validates all canonical replay error codes against schema", () => {
      const codes = [
        "INVALID_CURSOR",
        "CURSOR_NOT_FOUND",
        "CROSS_RUN_CURSOR",
        "RUN_NOT_FOUND",
        "REPLAY_LIMIT_EXCEEDED",
        "REPLAY_BUFFER_OVERFLOW",
        "HISTORY_EXHAUSTED",
        "INTERNAL_REPLAY_ERROR",
      ];

      for (const code of codes) {
        expect(runEventReplayErrorCodeSchema.safeParse(code).success).toBe(true);
      }
    });

    it("constructs strongly-typed error contracts via createReplayError", () => {
      const errContract = createReplayError(
        "CROSS_RUN_CURSOR",
        "Cursor evt-cross-99 does not belong to run-alpha-42",
        {
          runId: TEST_RUN_ID,
          cursor: "evt-cross-99",
          details: { requestedRun: TEST_RUN_ID, actualRun: "run-beta-99" },
        },
      );

      expect(errContract.code).toBe("CROSS_RUN_CURSOR");
      expect(errContract.runId).toBe(TEST_RUN_ID);
      expect(errContract.cursor).toBe("evt-cross-99");
      expect(errContract.details?.["actualRun"]).toBe("run-beta-99");
    });

    it("supports error cause chaining", () => {
      const rootCause = new Error("Database query timed out");
      const errContract = createReplayError(
        "INTERNAL_REPLAY_ERROR",
        "Failed to query historical events",
        { cause: rootCause },
      );

      expect(errContract.cause).toBe(rootCause);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Constants & System Invariants
  // ─────────────────────────────────────────────────────────────────────────

  describe("Replay Constants & System Bounds", () => {
    it("maintains verified operational bounds", () => {
      expect(REPLAY_MIN_PAGE_SIZE).toBe(1);
      expect(REPLAY_MAX_PAGE_SIZE).toBe(200);
      expect(REPLAY_DEFAULT_PAGE_SIZE).toBe(50);
      expect(REPLAY_MAX_BUFFER_CAPACITY).toBe(500);
      expect(REPLAY_DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(REPLAY_MAX_PAGE_SIZE);
    });

    it("validates replayCursorPositionSchema with timestamp and sequence", () => {
      const valid = replayCursorPositionSchema.safeParse({
        eventId: eventId("evt-123"),
        timestamp: "2026-10-16T12:00:00.000Z",
        sequenceNumber: 10,
      });
      expect(valid.success).toBe(true);

      const invalidTimestamp = replayCursorPositionSchema.safeParse({
        eventId: eventId("evt-123"),
        timestamp: "not-a-timestamp",
      });
      expect(invalidTimestamp.success).toBe(false);
    });
  });
});
