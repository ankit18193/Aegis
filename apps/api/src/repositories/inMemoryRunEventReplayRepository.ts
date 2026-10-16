/**
 * InMemoryRunEventReplayRepository — Phase 13D (Commit 2)
 *
 * In-memory implementation of IRunEventReplayRepository for deterministic testing
 * and local offline execution.
 *
 * Provides identical semantics to PostgresRunEventReplayRepository:
 * - Strict run isolation and cross-run cursor rejection.
 * - Deterministic chronological ordering (timestamp ASC, id ASC).
 * - Explicit gap detection and reconcileRequired flags on missing cursors.
 * - Bounded pagination with hasMore, nextCursor, and isCatchUpComplete.
 */

import type {
  IRunEventReplayRepository,
  RunEvent,
  RunEventReplayErrorContract,
  RunEventReplayRequest,
  RunEventReplayResult,
} from "@aegis/contracts";
import {
  createReplayError,
  createReplayResult,
  decodeReplayCursor,
  REPLAY_DEFAULT_PAGE_SIZE,
  REPLAY_MAX_PAGE_SIZE,
  REPLAY_MIN_PAGE_SIZE,
} from "@aegis/contracts";
import type { Result, RunId } from "@aegis/types";
import { err, ok } from "@aegis/types";

export class InMemoryRunEventReplayRepository implements IRunEventReplayRepository {
  private readonly events = new Map<RunId, RunEvent[]>();
  private readonly registeredRuns = new Set<RunId>();

  // ─────────────────────────────────────────────────────────────────────────
  // Test Harness / Seeding Helpers
  // ─────────────────────────────────────────────────────────────────────────

  registerRun(runId: RunId): void {
    this.registeredRuns.add(runId);
  }

  addEvent(event: RunEvent): void {
    this.registeredRuns.add(event.runId);
    const list = this.events.get(event.runId) ?? [];
    list.push(structuredClone(event));
    this.events.set(event.runId, list);
  }

  addEvents(events: readonly RunEvent[]): void {
    for (const evt of events) {
      this.addEvent(evt);
    }
  }

  setEvents(runId: RunId, events: readonly RunEvent[]): void {
    this.registeredRuns.add(runId);
    this.events.set(runId, structuredClone([...events]));
  }

  clear(): void {
    this.events.clear();
    this.registeredRuns.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IRunEventReplayRepository Implementation
  // ─────────────────────────────────────────────────────────────────────────

  replayEvents(
    request: RunEventReplayRequest,
  ): Promise<Result<RunEventReplayResult, RunEventReplayErrorContract>> {
    const targetRunId = request.runId;

    // 1. Verify Run Existence
    if (!this.registeredRuns.has(targetRunId)) {
      return Promise.resolve(
        err(
          createReplayError(
            "RUN_NOT_FOUND",
            `Execution run '${targetRunId}' does not exist in repository.`,
            { runId: targetRunId, cursor: request.cursor },
          ),
        ),
      );
    }

    // 2. Validate Limit bounds
    const rawLimit = request.limit ?? REPLAY_DEFAULT_PAGE_SIZE;
    const limit = Math.min(Math.max(rawLimit, REPLAY_MIN_PAGE_SIZE), REPLAY_MAX_PAGE_SIZE);

    const runEventList = this.events.get(targetRunId) ?? [];

    // Sort chronologically ascending by timestamp, tie-break by id ASC
    const sorted = [...runEventList].sort((a, b) => {
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });

    const latestEvent = sorted.length > 0 ? (sorted[sorted.length - 1] ?? null) : null;
    const latestEventId = latestEvent ? latestEvent.id : null;

    // 3. Resolve Cursor if provided
    let filtered = sorted;

    if (request.cursor && request.cursor.trim().length > 0) {
      const decoded = decodeReplayCursor(request.cursor);
      if (!decoded.ok) {
        return Promise.resolve(err(decoded.error));
      }

      const cursorEventId = decoded.value.eventId;

      // Check if cursor exists in current run
      const anchorIndex = sorted.findIndex((e) => e.id === cursorEventId);

      if (anchorIndex === -1) {
        // Check if cursor belongs to another run (Lock 2: Cross-run check)
        for (const [otherRunId, otherEvents] of this.events.entries()) {
          if (otherRunId !== targetRunId && otherEvents.some((e) => e.id === cursorEventId)) {
            return Promise.resolve(
              err(
                createReplayError(
                  "CROSS_RUN_CURSOR",
                  `Cursor '${request.cursor}' belongs to run '${otherRunId}', not '${targetRunId}'.`,
                  {
                    runId: targetRunId,
                    cursor: request.cursor,
                    details: { requestedRun: targetRunId, cursorRun: otherRunId },
                  },
                ),
              ),
            );
          }
        }

        // Missing cursor (purged, expired, or bogus) -> gap detected
        return Promise.resolve(
          ok(
            createReplayResult({
              runId: targetRunId,
              events: [],
              nextCursor: null,
              hasMore: false,
              status: "gap_detected",
              reconcileRequired: true,
              latestEventId,
              isCatchUpComplete: false,
            }),
          ),
        );
      }

      // Slice strictly after the anchor index
      filtered = sorted.slice(anchorIndex + 1);
    }

    // 4. Handle boundary cutoff if provided
    let isCatchUpComplete = false;
    let effectiveEvents = filtered;

    if (request.boundaryEventId) {
      const boundaryIndex = filtered.findIndex((e) => e.id === request.boundaryEventId);
      if (boundaryIndex !== -1) {
        effectiveEvents = filtered.slice(0, boundaryIndex + 1);
        isCatchUpComplete = true;
      }
    }

    // 5. Apply pagination limit
    const hasMore = effectiveEvents.length > limit;
    const pageEvents = hasMore ? effectiveEvents.slice(0, limit) : effectiveEvents;

    if (!hasMore) {
      isCatchUpComplete = true;
    }

    const nextCursor = hasMore && pageEvents.length > 0 ? (pageEvents[pageEvents.length - 1]?.id ?? null) : null;

    return Promise.resolve(
      ok(
        createReplayResult({
          runId: targetRunId,
          events: pageEvents,
          nextCursor,
          hasMore,
          status: hasMore ? "has_more" : "complete",
          reconcileRequired: false,
          latestEventId,
          isCatchUpComplete,
        }),
      ),
    );
  }

  getLatestEvent(
    runId: RunId,
  ): Promise<Result<RunEvent | null, RunEventReplayErrorContract>> {
    const list = this.events.get(runId) ?? [];
    if (list.length === 0) {
      return Promise.resolve(ok(null));
    }

    const sorted = [...list].sort((a, b) => {
      const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      return b.id.localeCompare(a.id);
    });

    return Promise.resolve(ok(sorted[0] ?? null));
  }

  getEarliestEvent(
    runId: RunId,
  ): Promise<Result<RunEvent | null, RunEventReplayErrorContract>> {
    const list = this.events.get(runId) ?? [];
    if (list.length === 0) {
      return Promise.resolve(ok(null));
    }

    const sorted = [...list].sort((a, b) => {
      const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });

    return Promise.resolve(ok(sorted[0] ?? null));
  }
}
