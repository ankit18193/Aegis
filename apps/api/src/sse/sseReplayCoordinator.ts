/**
 * SSE Replay Coordinator — Phase 13D: Commit 3
 *
 * Coordinates durable run event replay with live broadcast delivery over Server-Sent Events.
 *
 * Responsibilities:
 * 1. Coordinates multi-page historical event streaming using IRunEventReplayRepository.
 * 2. Manages live event buffering during historical catch-up to prevent out-of-order delivery.
 * 3. Enforces multi-page loop pagination until `hasMore === false` so no missed events are skipped.
 * 4. Halts and signals authoritative state reconciliation on gap detection or missing cursor.
 * 5. Halts immediately on live buffer overflow (>500 events) and triggers state reconciliation.
 * 6. Deduplicates events at the boundary between durable history and live buffer during drain.
 * 7. Transitions connection smoothly to pure live delivery upon successful catch-up.
 */

import {
  isReconcileRequired,
  REPLAY_DEFAULT_PAGE_SIZE,
  REPLAY_MAX_BUFFER_CAPACITY,
  type IRunEventReplayRepository,
  type RunEventReplayErrorContract,
  type RunEventReplayResult,
  type RunEventReplayStatus,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { runId as toRunId } from "@aegis/types";

import type { ISseConnection, SseConnectionError } from "./types.js";

export interface SseReplayCoordinatorOptions {
  readonly replayRepository: IRunEventReplayRepository;
  readonly defaultPageSize?: number | undefined;
  readonly defaultMaxBufferCapacity?: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface CoordinateReplayOptions {
  readonly runId: string;
  readonly cursor?: string | undefined;
  readonly pageSize?: number | undefined;
  readonly maxBufferCapacity?: number | undefined;
}

export interface ReplayCoordinationResult {
  readonly success: boolean;
  readonly runId: string;
  readonly replayedCount: number;
  readonly drainedCount: number;
  readonly status: RunEventReplayStatus;
  readonly reconcileRequired: boolean;
  readonly cursorUsed?: string | undefined;
  readonly error?: RunEventReplayErrorContract | Error | SseConnectionError | undefined;
}

export class SseReplayCoordinator {
  private readonly replayRepository: IRunEventReplayRepository;
  private readonly defaultPageSize: number;
  private readonly defaultMaxBufferCapacity: number;
  private readonly logger?: Logger | undefined;
  private readonly inFlightCoordinations = new Map<string, Promise<ReplayCoordinationResult>>();

  constructor(options: SseReplayCoordinatorOptions) {
    this.replayRepository = options.replayRepository;
    this.defaultPageSize = options.defaultPageSize ?? REPLAY_DEFAULT_PAGE_SIZE;
    this.defaultMaxBufferCapacity =
      options.defaultMaxBufferCapacity ?? REPLAY_MAX_BUFFER_CAPACITY;
    this.logger = options.logger;
  }

  /**
   * Coordinates the replay of historical run events followed by draining buffered live events.
   *
   * Step 1: Arms connection buffering so any concurrent live broadcast events are preserved.
   * Step 2: Iteratively paginates through durable history via replayRepository until hasMore is false.
   * Step 3: At each step, checks for buffer overflow or gap detection; halts immediately if unsafe.
   * Step 4: Drains buffered live events, filtering out any event IDs already delivered during replay.
   * Step 5: Disables buffering, completing the transition to live streaming.
   */
  async coordinateReplay(
    connection: ISseConnection,
    options: CoordinateReplayOptions,
  ): Promise<ReplayCoordinationResult> {
    const existing = this.inFlightCoordinations.get(connection.connectionId);
    if (existing) {
      this.logger?.debug("Reusing active in-flight replay coordination for connection", {
        connectionId: connection.connectionId,
        runId: options.runId,
      });
      return existing;
    }

    const executionPromise = this.doCoordinateReplay(connection, options);
    this.inFlightCoordinations.set(connection.connectionId, executionPromise);

    try {
      return await executionPromise;
    } finally {
      this.inFlightCoordinations.delete(connection.connectionId);
    }
  }

  private async doCoordinateReplay(
    connection: ISseConnection,
    options: CoordinateReplayOptions,
  ): Promise<ReplayCoordinationResult> {
    const { runId, cursor } = options;
    const pageSize = options.pageSize ?? this.defaultPageSize;
    const maxCapacity = options.maxBufferCapacity ?? this.defaultMaxBufferCapacity;

    // Step 0: Enforce connection run isolation
    if (connection.runId && runId !== connection.runId) {
      this.logger?.warn("Cross-run replay coordination rejected", {
        connectionId: connection.connectionId,
        connectionRunId: connection.runId,
        requestedRunId: runId,
      });
      return {
        success: false,
        runId,
        replayedCount: 0,
        drainedCount: 0,
        status: "complete",
        reconcileRequired: true,
        cursorUsed: cursor,
        error: new Error(
          `Cannot coordinate replay for run '${runId}' on connection bound to run '${connection.runId}'.`,
        ),
      };
    }

    this.logger?.debug("Starting SSE replay coordination", {
      connectionId: connection.connectionId,
      runId,
      cursor,
      pageSize,
      maxCapacity,
    });

    // Step 1: Ensure buffering is enabled on the connection
    if (!connection.isBuffering) {
      connection.enableBuffering(maxCapacity);
    }

    const replayedEventIds = new Set<string>();
    let totalReplayed = 0;
    let currentCursor = cursor;

    let hasMorePages = true;

    // Step 2: Iterative pagination loop through durable history
    while (hasMorePages) {
      // Check client liveness
      if (!connection.isOpen) {
        this.logger?.debug("SSE connection closed during historical replay; aborting", {
          connectionId: connection.connectionId,
          runId,
        });
        connection.clearBuffer();
        connection.disableBuffering();
        return {
          success: false,
          runId,
          replayedCount: totalReplayed,
          drainedCount: 0,
          status: "complete",
          reconcileRequired: false,
          cursorUsed: cursor,
        };
      }

      // Check buffer overflow prior to fetching next page
      if (connection.hasBufferOverflowed()) {
        return this.handleBufferOverflow(connection, runId, totalReplayed, cursor);
      }

      const replayResult = await this.replayRepository.replayEvents({
        runId: toRunId(runId),
        cursor: currentCursor,
        limit: pageSize,
      });

      if (!replayResult.ok) {
        this.logger?.warn("Replay repository error during replay coordination", {
          connectionId: connection.connectionId,
          runId,
          cursor: currentCursor,
          error: replayResult.error,
        });
        await connection.sendError(
          "INTERNAL_TRANSPORT_ERROR",
          replayResult.error.message,
          true,
          { reconcileRequired: true, runId },
        );
        connection.clearBuffer();
        connection.disableBuffering();
        return {
          success: false,
          runId,
          replayedCount: totalReplayed,
          drainedCount: 0,
          status: "gap_detected",
          reconcileRequired: true,
          cursorUsed: cursor,
          error: replayResult.error,
        };
      }

      const page: RunEventReplayResult = replayResult.value;

      // Check for gap detected or state reconciliation requirement
      if (page.reconcileRequired || isReconcileRequired(page.status)) {
        this.logger?.warn("Replay gap detected; halting SSE handoff and requiring reconciliation", {
          connectionId: connection.connectionId,
          runId,
          status: page.status,
          cursor: currentCursor,
        });
        await connection.sendError(
          "REPLAY_GAP_DETECTED",
          "Replay gap or invalid cursor detected; full state reconciliation required.",
          true,
          { reconcileRequired: true, runId, status: page.status },
        );
        connection.clearBuffer();
        connection.disableBuffering();
        return {
          success: false,
          runId,
          replayedCount: totalReplayed,
          drainedCount: 0,
          status: page.status,
          reconcileRequired: true,
          cursorUsed: cursor,
        };
      }

      // Deliver events from current page directly to stream
      for (const event of page.events) {
        // Enforce stream isolation on durable events
        if (event.runId && event.runId !== runId) {
          continue;
        }

        // Concurrency hardening: prevent duplicate delivery from overlapping page boundaries
        if (replayedEventIds.has(event.id)) {
          continue;
        }

        const sendRes = await connection.sendHistoricalEvent(event);
        if (!sendRes.ok) {
          this.logger?.warn("Failed to write historical event to SSE stream", {
            connectionId: connection.connectionId,
            runId,
            eventId: event.id,
            error: sendRes.error,
          });
          connection.clearBuffer();
          connection.disableBuffering();
          return {
            success: false,
            runId,
            replayedCount: totalReplayed,
            drainedCount: 0,
            status: "complete",
            reconcileRequired: false,
            cursorUsed: cursor,
          };
        }

        replayedEventIds.add(event.id);
        totalReplayed += 1;
      }

      // Check if multi-page pagination has more items
      if (page.hasMore && page.nextCursor) {
        currentCursor = page.nextCursor;
      } else {
        // All durable historical events up to the current database snapshot have been replayed!
        hasMorePages = false;
      }
    }

    // Step 3: Verify buffer overflow status before handoff
    if (connection.hasBufferOverflowed()) {
      return this.handleBufferOverflow(connection, runId, totalReplayed, cursor);
    }

    // Step 4: Drain buffered live events with duplicate filter
    let drainedCount = 0;
    const drainResult = await connection.drainBuffer((envelope) => {
      if (envelope.type === "execution") {
        const id = envelope.payload.id;
        // If event was already delivered during historical replay, drop duplicate
        return !replayedEventIds.has(id);
      }
      return true;
    });

    if (!drainResult.ok) {
      this.logger?.warn("Error draining live replay buffer", {
        connectionId: connection.connectionId,
        runId,
        error: drainResult.error,
      });

      if (drainResult.error.code === "BUFFER_OVERFLOW" || connection.hasBufferOverflowed()) {
        return this.handleBufferOverflow(connection, runId, totalReplayed, cursor);
      }

      if (drainResult.error.code === "CONNECTION_CLOSED" || !connection.isOpen) {
        connection.clearBuffer();
        connection.disableBuffering();
        return {
          success: false,
          runId,
          replayedCount: totalReplayed,
          drainedCount: 0,
          status: "complete",
          reconcileRequired: false,
          cursorUsed: cursor,
        };
      }

      await connection.sendError(
        "INTERNAL_TRANSPORT_ERROR",
        drainResult.error.message,
        true,
        { reconcileRequired: true, runId },
      );
      connection.clearBuffer();
      connection.disableBuffering();
      return {
        success: false,
        runId,
        replayedCount: totalReplayed,
        drainedCount: 0,
        status: "gap_detected",
        reconcileRequired: true,
        cursorUsed: cursor,
        error: drainResult.error,
      };
    }

    drainedCount = drainResult.value;

    // Step 4b: Re-verify buffer overflow and connection state immediately post-drain
    if (connection.hasBufferOverflowed()) {
      return this.handleBufferOverflow(connection, runId, totalReplayed, cursor);
    }

    if (!connection.isOpen) {
      connection.clearBuffer();
      connection.disableBuffering();
      return {
        success: false,
        runId,
        replayedCount: totalReplayed,
        drainedCount,
        status: "complete",
        reconcileRequired: false,
        cursorUsed: cursor,
      };
    }

    // Step 5: Transition to pure live mode
    connection.disableBuffering();

    this.logger?.info("SSE replay coordination completed successfully", {
      connectionId: connection.connectionId,
      runId,
      replayedCount: totalReplayed,
      drainedCount,
    });

    return {
      success: true,
      runId,
      replayedCount: totalReplayed,
      drainedCount,
      status: "complete",
      reconcileRequired: false,
      cursorUsed: cursor,
    };
  }

  private async handleBufferOverflow(
    connection: ISseConnection,
    runId: string,
    totalReplayed: number,
    cursor?: string,
  ): Promise<ReplayCoordinationResult> {
    this.logger?.warn(
      "Replay buffer capacity exceeded during coordination; halting handoff and requiring reconciliation",
      {
        connectionId: connection.connectionId,
        runId,
        replayedCount: totalReplayed,
      },
    );

    await connection.sendError(
      "BUFFER_OVERFLOW",
      "Live event replay buffer capacity exceeded; full state reconciliation required.",
      true,
      { reconcileRequired: true, runId },
    );

    connection.clearBuffer();
    connection.disableBuffering();

    return {
      success: false,
      runId,
      replayedCount: totalReplayed,
      drainedCount: 0,
      status: "buffer_overflow",
      reconcileRequired: true,
      cursorUsed: cursor,
    };
  }
}
