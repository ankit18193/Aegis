/**
 * PostgresRunEventReplayRepository — Phase 13D (Commit 2)
 *
 * PostgreSQL implementation of IRunEventReplayRepository using Drizzle ORM.
 * Implements durable, run-scoped event retrieval after a validated cursor,
 * backed by the authoritative `run_events` table.
 *
 * Boundary Discipline & Invariant Locks:
 * - Lock 1: Authoritative Store: Reuses the existing PostgreSQL `run_events` table.
 *   Zero duplicate event tables, zero in-memory fallback for durable history.
 * - Lock 2: Run Isolation: Cursor resolution and event fetching are strictly scoped
 *   to `run_id`. Cross-run cursors are rejected with `CROSS_RUN_CURSOR`.
 * - Lock 3: Deterministic Ordering: Events are ordered chronologically by `timestamp ASC`,
 *   with tie-breaking on `id ASC`.
 * - Lock 4: Explicit Gap Signaling: If a cursor does not exist in the run's history,
 *   returns status `"gap_detected"` with `reconcileRequired: true`.
 * - Lock 5: Bounded Replay Pagination: Queries fetch `limit + 1` rows to determine
 *   `hasMore` and `nextCursor` without exceeding memory limits.
 */

import type {
  EventSeverity,
  EventType,
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
import type { Logger } from "@aegis/logger";
import {
  err,
  eventId,
  ok,
  runId as toRunId,
  taskId as toTaskId,
  type Result,
  type RunId,
} from "@aegis/types";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { DatabaseContext } from "../db/client.js";
import { runEventsTable, runsTable } from "../db/schema.js";

function toIsoStringRequired(dateOrStr: string | Date): string {
  if (dateOrStr instanceof Date) return dateOrStr.toISOString();
  return new Date(dateOrStr).toISOString();
}

function mapEventRowToEvent(row: typeof runEventsTable.$inferSelect): RunEvent {
  return {
    id: eventId(row.id),
    runId: toRunId(row.runId),
    type: row.type as EventType,
    severity: row.severity as EventSeverity,
    timestamp: toIsoStringRequired(row.timestamp),
    message: row.message,
    taskId: row.taskId ? toTaskId(row.taskId) : undefined,
    taskName: row.taskName ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

export class PostgresRunEventReplayRepository implements IRunEventReplayRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly db: PostgresJsDatabase<any>;
  private readonly logger?: Logger | undefined;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dbOrContext: PostgresJsDatabase<any> | DatabaseContext,
    logger?: Logger,
  ) {
    this.db = "db" in dbOrContext ? dbOrContext.db : dbOrContext;
    this.logger = logger;
  }

  /**
   * Replays a bounded batch of events for a run strictly following the specified cursor.
   */
  async replayEvents(
    request: RunEventReplayRequest,
  ): Promise<Result<RunEventReplayResult, RunEventReplayErrorContract>> {
    const targetRunId = request.runId;

    // 1. Verify Run Existence
    const [runRow] = await this.db
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(eq(runsTable.id, targetRunId))
      .limit(1);

    if (!runRow) {
      return err(
        createReplayError(
          "RUN_NOT_FOUND",
          `Execution run '${targetRunId}' does not exist in authoritative persistence.`,
          { runId: targetRunId, cursor: request.cursor },
        ),
      );
    }

    // 2. Validate Limit bounds
    const rawLimit = request.limit ?? REPLAY_DEFAULT_PAGE_SIZE;
    const limit = Math.min(Math.max(rawLimit, REPLAY_MIN_PAGE_SIZE), REPLAY_MAX_PAGE_SIZE);

    // 3. Resolve Anchor Cursor if provided
    let anchorTimestamp: string | null = null;
    let anchorId: string | null = null;

    if (request.cursor && request.cursor.trim().length > 0) {
      const decodedCursor = decodeReplayCursor(request.cursor);
      if (!decodedCursor.ok) {
        return err(decodedCursor.error);
      }

      const cursorEventId = decodedCursor.value.eventId;

      // Look up cursor in run_events to verify existence and run isolation
      const [cursorRow] = await this.db
        .select({
          id: runEventsTable.id,
          runId: runEventsTable.runId,
          timestamp: runEventsTable.timestamp,
        })
        .from(runEventsTable)
        .where(eq(runEventsTable.id, cursorEventId))
        .limit(1);

      if (!cursorRow) {
        // Cursor not found in durable history (purged, expired, or invalid)
        this.logger?.warn("PostgresRunEventReplayRepository: anchor cursor not found", {
          runId: targetRunId,
          cursor: request.cursor,
          cursorEventId,
        });

        // Determine latest event for this run
        const latest = await this.getLatestEvent(targetRunId);

        return ok(
          createReplayResult({
            runId: targetRunId,
            events: [],
            nextCursor: null,
            hasMore: false,
            status: "gap_detected",
            reconcileRequired: true,
            latestEventId: latest.ok && latest.value ? latest.value.id : null,
            isCatchUpComplete: false,
          }),
        );
      }

      // Strict Run Isolation Check (Lock 2)
      if (cursorRow.runId !== targetRunId) {
        this.logger?.warn("PostgresRunEventReplayRepository: cross-run cursor detected", {
          requestedRun: targetRunId,
          cursorRun: cursorRow.runId,
          cursor: request.cursor,
        });
        return err(
          createReplayError(
            "CROSS_RUN_CURSOR",
            `Cursor '${request.cursor}' belongs to run '${cursorRow.runId}', not '${targetRunId}'.`,
            {
              runId: targetRunId,
              cursor: request.cursor,
              details: { requestedRun: targetRunId, cursorRun: cursorRow.runId },
            },
          ),
        );
      }

      anchorTimestamp = toIsoStringRequired(cursorRow.timestamp);
      anchorId = cursorRow.id;
    }

    // 4. Construct Bounded Replay Query (Ordered by timestamp ASC, id ASC)
    const conditions = [eq(runEventsTable.runId, targetRunId)];

    if (anchorTimestamp && anchorId) {
      const orCond = or(
        gt(runEventsTable.timestamp, anchorTimestamp),
        and(eq(runEventsTable.timestamp, anchorTimestamp), gt(runEventsTable.id, anchorId)),
      );
      if (orCond) {
        conditions.push(orCond);
      }
    }

    // Query limit + 1 to determine hasMore
    const rows = await this.db
      .select()
      .from(runEventsTable)
      .where(and(...conditions))
      .orderBy(asc(runEventsTable.timestamp), asc(runEventsTable.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const events = pageRows.map(mapEventRowToEvent);

    // 5. Query latest event for this run to assist boundary tracking
    const latestEventRes = await this.getLatestEvent(targetRunId);
    const latestEventId = latestEventRes.ok && latestEventRes.value ? latestEventRes.value.id : null;

    // 6. Handle boundary cutoff if requested
    let isCatchUpComplete = !hasMore;
    if (request.boundaryEventId) {
      const boundaryIndex = events.findIndex((e) => e.id === request.boundaryEventId);
      if (boundaryIndex !== -1) {
        isCatchUpComplete = true;
      }
    } else if (latestEventId && events.length > 0) {
      if (events[events.length - 1]?.id === latestEventId) {
        isCatchUpComplete = true;
      }
    } else if (events.length === 0 && !hasMore) {
      isCatchUpComplete = true;
    }

    // Next cursor is the ID of the last event in this page
    const nextCursor = hasMore && events.length > 0 ? (events[events.length - 1]?.id ?? null) : null;

    return ok(
      createReplayResult({
        runId: targetRunId,
        events,
        nextCursor,
        hasMore,
        status: hasMore ? "has_more" : "complete",
        reconcileRequired: false,
        latestEventId,
        isCatchUpComplete,
      }),
    );
  }

  /**
   * Retrieves the single most recent persisted event for a run, or null if none exist.
   */
  async getLatestEvent(
    runId: RunId,
  ): Promise<Result<RunEvent | null, RunEventReplayErrorContract>> {
    try {
      const [row] = await this.db
        .select()
        .from(runEventsTable)
        .where(eq(runEventsTable.runId, runId))
        .orderBy(desc(runEventsTable.timestamp), desc(runEventsTable.id))
        .limit(1);

      if (!row) {
        return ok(null);
      }

      return ok(mapEventRowToEvent(row));
    } catch (dbErr) {
      return err(
        createReplayError(
          "INTERNAL_REPLAY_ERROR",
          `Failed to retrieve latest event for run '${runId}': ${String(dbErr)}`,
          { runId, cause: dbErr },
        ),
      );
    }
  }

  /**
   * Retrieves the earliest persisted event for a run, or null if none exist.
   */
  async getEarliestEvent(
    runId: RunId,
  ): Promise<Result<RunEvent | null, RunEventReplayErrorContract>> {
    try {
      const [row] = await this.db
        .select()
        .from(runEventsTable)
        .where(eq(runEventsTable.runId, runId))
        .orderBy(asc(runEventsTable.timestamp), asc(runEventsTable.id))
        .limit(1);

      if (!row) {
        return ok(null);
      }

      return ok(mapEventRowToEvent(row));
    } catch (dbErr) {
      return err(
        createReplayError(
          "INTERNAL_REPLAY_ERROR",
          `Failed to retrieve earliest event for run '${runId}': ${String(dbErr)}`,
          { runId, cause: dbErr },
        ),
      );
    }
  }
}
