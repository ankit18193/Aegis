/**
 * Unit Test Suite for InMemoryRunEventReplayRepository — Phase 13D (Commit 2)
 *
 * Verifies replay semantics:
 * 1. Run isolation & cross-run cursor rejection.
 * 2. Deterministic chronological ordering (timestamp ASC, tie-breaker id ASC).
 * 3. Multi-page pagination loops and catch-up convergence.
 * 4. Missing cursor detection and reconcileRequired gap signaling.
 * 5. Boundary cutoff enforcement.
 * 6. Edge cases: empty history, single event, identical timestamps.
 */

import type { RunEvent } from "@aegis/contracts";
import { eventId, runId, taskId, type RunId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryRunEventReplayRepository } from "../inMemoryRunEventReplayRepository.js";

function createEvent(params: {
  id: string;
  runId: RunId;
  timestamp: string;
  type?: "task_started" | "task_completed" | "run_created";
}): RunEvent {
  return {
    id: eventId(params.id),
    runId: params.runId,
    type: params.type ?? "task_started",
    severity: "info",
    timestamp: params.timestamp,
    message: `Event ${params.id}`,
    taskId: taskId("task-1"),
    taskName: "step_one",
  };
}

describe("InMemoryRunEventReplayRepository", () => {
  let repository: InMemoryRunEventReplayRepository;
  const RUN_A: RunId = runId("run-alpha");
  const RUN_B: RunId = runId("run-beta");

  beforeEach(() => {
    repository = new InMemoryRunEventReplayRepository();
    repository.registerRun(RUN_A);
    repository.registerRun(RUN_B);
  });

  describe("Run Existence & Validation", () => {
    it("returns RUN_NOT_FOUND when requesting events for an unregistered run", async () => {
      const nonExistentRun = runId("run-ghost");
      const result = await repository.replayEvents({ runId: nonExistentRun });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("RUN_NOT_FOUND");
        expect(result.error.runId).toBe(nonExistentRun);
      }
    });

    it("returns complete result with empty events when run has no events", async () => {
      const result = await repository.replayEvents({ runId: RUN_A });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events).toHaveLength(0);
        expect(result.value.hasMore).toBe(false);
        expect(result.value.nextCursor).toBeNull();
        expect(result.value.status).toBe("complete");
        expect(result.value.reconcileRequired).toBe(false);
        expect(result.value.isCatchUpComplete).toBe(true);
      }
    });
  });

  describe("Chronological Ordering & Determinism", () => {
    it("orders events chronologically ascending by timestamp", async () => {
      const e1 = createEvent({ id: "evt-01", runId: RUN_A, timestamp: "2026-10-16T10:00:00.000Z" });
      const e2 = createEvent({ id: "evt-02", runId: RUN_A, timestamp: "2026-10-16T10:01:00.000Z" });
      const e3 = createEvent({ id: "evt-03", runId: RUN_A, timestamp: "2026-10-16T10:02:00.000Z" });

      // Add out of order
      repository.addEvents([e3, e1, e2]);

      const result = await repository.replayEvents({ runId: RUN_A });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events.map((e) => e.id)).toEqual(["evt-01", "evt-02", "evt-03"]);
        expect(result.value.status).toBe("complete");
      }
    });

    it("breaks timestamp collisions deterministically using id ASC", async () => {
      const sameTime = "2026-10-16T10:00:00.000Z";
      const eB = createEvent({ id: "evt-b", runId: RUN_A, timestamp: sameTime });
      const eA = createEvent({ id: "evt-a", runId: RUN_A, timestamp: sameTime });
      const eC = createEvent({ id: "evt-c", runId: RUN_A, timestamp: sameTime });

      repository.addEvents([eC, eB, eA]);

      const result = await repository.replayEvents({ runId: RUN_A });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events.map((e) => e.id)).toEqual(["evt-a", "evt-b", "evt-c"]);
      }
    });
  });

  describe("Cursor Resumption & Multi-Page Pagination", () => {
    beforeEach(() => {
      const events = [
        createEvent({ id: "e1", runId: RUN_A, timestamp: "2026-10-16T10:00:01.000Z" }),
        createEvent({ id: "e2", runId: RUN_A, timestamp: "2026-10-16T10:00:02.000Z" }),
        createEvent({ id: "e3", runId: RUN_A, timestamp: "2026-10-16T10:00:03.000Z" }),
        createEvent({ id: "e4", runId: RUN_A, timestamp: "2026-10-16T10:00:04.000Z" }),
        createEvent({ id: "e5", runId: RUN_A, timestamp: "2026-10-16T10:00:05.000Z" }),
      ];
      repository.addEvents(events);
    });

    it("resumes strictly after a specified anchor cursor", async () => {
      const result = await repository.replayEvents({
        runId: RUN_A,
        cursor: "e2",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events.map((e) => e.id)).toEqual(["e3", "e4", "e5"]);
        expect(result.value.hasMore).toBe(false);
        expect(result.value.isCatchUpComplete).toBe(true);
      }
    });

    it("iteratively fetches all pages until caught up (multi-page catch-up loop)", async () => {
      const collected: string[] = [];
      let cursor: string | undefined = undefined;
      let iterations = 0;
      const MAX_ITERATIONS = 10;

      while (iterations < MAX_ITERATIONS) {
        iterations++;
        const pageRes = await repository.replayEvents({
          runId: RUN_A,
          cursor,
          limit: 2,
        });

        expect(pageRes.ok).toBe(true);
        if (!pageRes.ok) break;

        const page = pageRes.value;
        for (const evt of page.events) {
          collected.push(evt.id);
        }

        if (!page.hasMore) {
          expect(page.isCatchUpComplete).toBe(true);
          expect(page.nextCursor).toBeNull();
          break;
        }

        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor ?? undefined;
      }

      expect(collected).toEqual(["e1", "e2", "e3", "e4", "e5"]);
      expect(iterations).toBe(3); // Page 1: e1,e2; Page 2: e3,e4; Page 3: e5
    });

    it("stops pagination cleanly at boundaryEventId", async () => {
      const result = await repository.replayEvents({
        runId: RUN_A,
        limit: 10,
        boundaryEventId: eventId("e3"),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
        expect(result.value.isCatchUpComplete).toBe(true);
        expect(result.value.hasMore).toBe(false);
      }
    });
  });

  describe("Run Isolation & Cross-Run Cursors", () => {
    it("rejects cursor belonging to a different run with CROSS_RUN_CURSOR", async () => {
      const eventA = createEvent({ id: "evt-runA-1", runId: RUN_A, timestamp: "2026-10-16T10:00:00.000Z" });
      const eventB = createEvent({ id: "evt-runB-1", runId: RUN_B, timestamp: "2026-10-16T10:00:00.000Z" });

      repository.addEvent(eventA);
      repository.addEvent(eventB);

      // Query RUN_A with cursor from RUN_B
      const result = await repository.replayEvents({
        runId: RUN_A,
        cursor: "evt-runB-1",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CROSS_RUN_CURSOR");
        expect(result.error.runId).toBe(RUN_A);
        expect(result.error.cursor).toBe("evt-runB-1");
      }
    });

    it("returns gap_detected with reconcileRequired: true for non-existent cursor", async () => {
      const eventA = createEvent({ id: "evt-1", runId: RUN_A, timestamp: "2026-10-16T10:00:00.000Z" });
      repository.addEvent(eventA);

      const result = await repository.replayEvents({
        runId: RUN_A,
        cursor: "evt-ghost-unknown",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("gap_detected");
        expect(result.value.reconcileRequired).toBe(true);
        expect(result.value.events).toHaveLength(0);
        expect(result.value.hasMore).toBe(false);
      }
    });
  });

  describe("Earliest and Latest Event Probes", () => {
    it("returns correct earliest and latest events for a run", async () => {
      const e1 = createEvent({ id: "e-first", runId: RUN_A, timestamp: "2026-10-16T08:00:00.000Z" });
      const e2 = createEvent({ id: "e-mid", runId: RUN_A, timestamp: "2026-10-16T09:00:00.000Z" });
      const e3 = createEvent({ id: "e-last", runId: RUN_A, timestamp: "2026-10-16T10:00:00.000Z" });

      repository.addEvents([e2, e3, e1]);

      const earliest = await repository.getEarliestEvent(RUN_A);
      expect(earliest.ok).toBe(true);
      if (earliest.ok) {
        expect(earliest.value?.id).toBe("e-first");
      }

      const latest = await repository.getLatestEvent(RUN_A);
      expect(latest.ok).toBe(true);
      if (latest.ok) {
        expect(latest.value?.id).toBe("e-last");
      }
    });

    it("returns null when run has no events", async () => {
      const earliest = await repository.getEarliestEvent(RUN_A);
      expect(earliest.ok).toBe(true);
      if (earliest.ok) {
        expect(earliest.value).toBeNull();
      }

      const latest = await repository.getLatestEvent(RUN_A);
      expect(latest.ok).toBe(true);
      if (latest.ok) {
        expect(latest.value).toBeNull();
      }
    });
  });
});
