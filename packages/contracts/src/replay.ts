/**
 * Durable Run Event Replay Contracts & Schemas — Phase 13D: Commit 1
 *
 * Defines contracts, schemas, cursor semantics, typed errors, and repository
 * interfaces for durable execution run event replay and reconnection recovery.
 *
 * Boundary Discipline & Invariant Locks:
 * - Lock 1: Authoritative Persisted Source: The PostgreSQL `run_events` table is the
 *   single authoritative source of historical execution events. In-memory event buffers
 *   must never be treated as durable history.
 * - Lock 2: Run Isolation: Every replay operation is strictly run-scoped. Cursors are
 *   never resolved across different run boundaries. Cross-run cursor queries fail fast.
 * - Lock 3: Explicit Cursor Semantics & Ordering:
 *   - Events are ordered chronologically by `timestamp ASC`, with deterministic tie-breaking on `id ASC`.
 *   - The cursor represents the anchor event from which subsequent events are fetched.
 *   - Both raw canonical `EventId` (from W3C SSE `Last-Event-ID`) and compound cursor tokens
 *     (`v1:<timestamp>:<id>`) are supported.
 * - Lock 4: Documented Ordering Limitation & Data-Model Reality:
 *   - In the current `run_events` schema, ordering relies on `(timestamp, id)`.
 *   - If multiple events are inserted within the same millisecond/transaction with identical timestamps,
 *     the secondary `id ASC` tie-breaker provides deterministic pagination, but does not guarantee
 *     database commit sequence order when IDs are random UUIDs.
 *   - If an ordering discontinuity, missing cursor, or gap is detected, the contract enforces
 *     `reconcileRequired: true` so the consumer performs authoritative state recovery (`GET /runs/:id`).
 * - Lock 5: Bounded Replay Pagination & Multi-Page Catch-Up:
 *   - Queries are bounded to prevent memory exhaustion (default limit 50, maximum 200).
 *   - Replay results provide explicit pagination fields (`hasMore`, `nextCursor`, `isCatchUpComplete`)
 *     so the transport layer can iteratively fetch all missed pages until caught up.
 * - Lock 6: Non-Silent Failure Handling:
 *   - Unknown, expired, malformed, or cross-run cursors produce explicit typed results
 *     (`gap_detected`, `history_exhausted`) with `reconcileRequired: true`, rather than silently
 *     streaming from the beginning or returning partial history without warning.
 * - Lock 7: Buffer Overflow Protection:
 *   - On live buffer overflow during replay handoff, replay status must be `"buffer_overflow"`
 *     with `reconcileRequired: true`. Hand-off MUST halt rather than silently dropping updates.
 * - Lock 8: Decoupled Protocol Architecture:
 *   - Pure domain contracts with zero dependencies on Fastify, Kafka consumer internals, or React.
 */

import type { EventId, Result, RunId } from "@aegis/types";
import { err, eventId, ok } from "@aegis/types";
import { z } from "zod";

import { runEventSchema, type RunEvent } from "./events.js";
import { eventIdSchema, runIdSchema } from "./runs.js";

// ─────────────────────────────────────────────────────────────────────────────
// Replay Configuration Constants
// ─────────────────────────────────────────────────────────────────────────────

export const REPLAY_DEFAULT_PAGE_SIZE = 50;
export const REPLAY_MAX_PAGE_SIZE = 200;
export const REPLAY_MIN_PAGE_SIZE = 1;
export const REPLAY_MAX_BUFFER_CAPACITY = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Cursor Types and Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validated compound cursor position used internally by replay repositories.
 */
export const replayCursorPositionSchema = z.object({
  /** Canonical event ID of the anchor event. */
  eventId: eventIdSchema,
  /** ISO-8601 timestamp of the anchor event if known. */
  timestamp: z.string().datetime({ offset: true }).optional(),
  /** Optional sequence number if present in future schema revisions. */
  sequenceNumber: z.number().int().nonnegative().optional(),
});
export type ReplayCursorPosition = z.infer<typeof replayCursorPositionSchema>;

/**
 * Raw string cursor accepted from clients (W3C `Last-Event-ID` header or query param).
 * Must be a non-empty string without control characters.
 */
export const rawCursorSchema = z
  .string()
  .trim()
  .min(1, "Cursor cannot be empty")
  .max(512, "Cursor length exceeds maximum allowed length of 512 characters")
  .regex(/^[A-Za-z0-9_\-.:+=]+$/, "Cursor contains invalid characters");

// ─────────────────────────────────────────────────────────────────────────────
// Replay Request Schema
// ─────────────────────────────────────────────────────────────────────────────

export const runEventReplayRequestSchema = z.object({
  /** Target execution run ID. Required. */
  runId: runIdSchema,
  /**
   * Anchor cursor after which events should be retrieved.
   * If omitted, replay starts from the beginning of available history.
   */
  cursor: rawCursorSchema.optional(),
  /**
   * Maximum number of events to return in a single page.
   * Defaults to 50, bounded between 1 and 200.
   */
  limit: z.coerce
    .number()
    .int()
    .min(REPLAY_MIN_PAGE_SIZE, `Limit must be at least ${String(REPLAY_MIN_PAGE_SIZE)}`)
    .max(REPLAY_MAX_PAGE_SIZE, `Limit cannot exceed ${String(REPLAY_MAX_PAGE_SIZE)}`)
    .default(REPLAY_DEFAULT_PAGE_SIZE),
  /**
   * Optional live boundary cutoff event ID.
   * When provided, replay terminates upon reaching or passing this event ID.
   */
  boundaryEventId: eventIdSchema.optional(),
});

export interface RunEventReplayRequest {
  readonly runId: RunId;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly boundaryEventId?: EventId | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay Status & Error Codes
// ─────────────────────────────────────────────────────────────────────────────

export const runEventReplayStatusSchema = z.enum([
  /** Replay successfully completed up to the end of currently persisted history. */
  "complete",
  /** Additional historical pages exist; client/coordinator must continue fetching. */
  "has_more",
  /** Anchor cursor was not found, cross-run, or a gap was detected. State reconciliation required. */
  "gap_detected",
  /** Cursor refers to an event older than the earliest available retained event. */
  "history_exhausted",
  /** Live event buffer capacity was exceeded during replay coordination. Safe handoff halted. */
  "buffer_overflow",
]);
export type RunEventReplayStatus = z.infer<typeof runEventReplayStatusSchema>;

export const runEventReplayErrorCodeSchema = z.enum([
  "INVALID_CURSOR",
  "CURSOR_NOT_FOUND",
  "CROSS_RUN_CURSOR",
  "RUN_NOT_FOUND",
  "REPLAY_LIMIT_EXCEEDED",
  "REPLAY_BUFFER_OVERFLOW",
  "HISTORY_EXHAUSTED",
  "INTERNAL_REPLAY_ERROR",
]);
export type RunEventReplayErrorCode = z.infer<typeof runEventReplayErrorCodeSchema>;

export interface RunEventReplayErrorContract {
  readonly code: RunEventReplayErrorCode;
  readonly message: string;
  readonly runId?: RunId | undefined;
  readonly cursor?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay Result Schema
// ─────────────────────────────────────────────────────────────────────────────

export const runEventReplayResultSchema = z.object({
  /** Run ID to which these replayed events belong. */
  runId: runIdSchema,
  /** Ordered list of canonical run events following the cursor. */
  events: z.array(runEventSchema).readonly(),
  /**
   * Next cursor to use for requesting the subsequent page.
   * Null if no further events exist in durable history.
   */
  nextCursor: z.string().nullable(),
  /** True if additional events exist after this page. */
  hasMore: z.boolean(),
  /** Number of events included in this replay page. */
  replayedCount: z.number().int().nonnegative(),
  /** Overall replay outcome status. */
  status: runEventReplayStatusSchema,
  /**
   * True if the client MUST reconcile full state (`GET /api/v1/runs/:id`)
   * due to a gap, buffer overflow, or expired cursor.
   */
  reconcileRequired: z.boolean(),
  /**
   * Event ID of the most recent event persisted in durable storage for this run.
   * Enables the coordinator to confirm boundary convergence.
   */
  latestEventId: eventIdSchema.nullable().optional(),
  /**
   * True if all historical events up to the latest known event or boundary have been retrieved.
   */
  isCatchUpComplete: z.boolean(),
});
export type RunEventReplayResult = z.infer<typeof runEventReplayResultSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Replay Repository Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authoritative contract for retrieving historical execution events after a cursor.
 * Implemented by database-backed (PostgreSQL) and in-memory test repositories.
 */
export interface IRunEventReplayRepository {
  /**
   * Replays a bounded batch of events for a given run strictly after the specified cursor.
   *
   * Guarantees:
   * 1. Run Isolation: Cursors must belong to the specified `runId`. Cross-run queries fail with CROSS_RUN_CURSOR.
   * 2. Deterministic Ordering: Events are returned in chronological order (`timestamp ASC, id ASC`).
   * 3. Explicit Gap Signaling: If cursor does not exist, returns status `"gap_detected"` with `reconcileRequired: true`.
   * 4. Bounded Limit: Never returns more than `request.limit` events.
   */
  replayEvents(
    request: RunEventReplayRequest,
  ): Promise<Result<RunEventReplayResult, RunEventReplayErrorContract>>;

  /**
   * Retrieves the single most recent persisted event for a run, or null if none exist.
   */
  getLatestEvent(runId: RunId): Promise<Result<RunEvent | null, RunEventReplayErrorContract>>;

  /**
   * Retrieves the earliest persisted event for a run, or null if none exist.
   * Used to detect if a client's cursor is older than retained history (history exhausted).
   */
  getEarliestEvent(runId: RunId): Promise<Result<RunEvent | null, RunEventReplayErrorContract>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor Encoding and Decoding Helpers
// ─────────────────────────────────────────────────────────────────────────────

const COMPOUND_CURSOR_PREFIX = "c1:";

/**
 * Encodes a ReplayCursorPosition into a durable opaque cursor token.
 */
export function encodeReplayCursor(position: ReplayCursorPosition): string {
  if (!position.timestamp && position.sequenceNumber === undefined) {
    // If only eventId is provided, the canonical eventId string is the cursor
    return position.eventId;
  }
  const payload = JSON.stringify({
    e: position.eventId,
    t: position.timestamp,
    s: position.sequenceNumber,
  });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  return `${COMPOUND_CURSOR_PREFIX}${b64}`;
}

/**
 * Decodes a raw cursor string into a ReplayCursorPosition.
 * Supports both raw canonical EventId strings (e.g. `evt-123`, UUIDs)
 * and compound encoded tokens (`c1:...`).
 */
export function decodeReplayCursor(
  rawCursor: string,
): Result<ReplayCursorPosition, RunEventReplayErrorContract> {
  const parseValidation = rawCursorSchema.safeParse(rawCursor);
  if (!parseValidation.success) {
    return err({
      code: "INVALID_CURSOR",
      message: `Invalid cursor format: ${parseValidation.error.issues.map((i) => i.message).join("; ")}`,
      cursor: rawCursor,
    });
  }

  const trimmed = rawCursor.trim();

  // 1. Compound encoded token
  if (trimmed.startsWith(COMPOUND_CURSOR_PREFIX)) {
    const encoded = trimmed.slice(COMPOUND_CURSOR_PREFIX.length);
    try {
      const json = Buffer.from(encoded, "base64url").toString("utf8");
      const parsed = JSON.parse(json) as { e?: unknown; t?: unknown; s?: unknown };
      if (typeof parsed.e !== "string" || parsed.e.length === 0) {
        return err({
          code: "INVALID_CURSOR",
          message: "Compound cursor missing valid event ID.",
          cursor: rawCursor,
        });
      }
      return ok({
        eventId: eventId(parsed.e),
        timestamp: typeof parsed.t === "string" ? parsed.t : undefined,
        sequenceNumber: typeof parsed.s === "number" ? parsed.s : undefined,
      });
    } catch (decodeErr) {
      return err({
        code: "INVALID_CURSOR",
        message: "Failed to decode compound cursor token.",
        cursor: rawCursor,
        cause: decodeErr,
      });
    }
  }

  // 2. Raw canonical EventId (e.g. from SSE `Last-Event-ID`)
  return ok({
    eventId: eventId(trimmed),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates and constructs a RunEventReplayRequest.
 */
export function createReplayRequest(
  input: unknown,
): Result<RunEventReplayRequest, RunEventReplayErrorContract> {
  const result = runEventReplayRequestSchema.safeParse(input);
  if (!result.success) {
    const issueMsg = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return err({
      code: "INVALID_CURSOR",
      message: `Replay request validation failed: ${issueMsg}`,
      details: { issues: result.error.issues },
    });
  }
  return ok(result.data);
}

/**
 * Constructs a strongly-typed RunEventReplayResult.
 */
export function createReplayResult(params: {
  runId: RunId;
  events: readonly RunEvent[];
  nextCursor?: string | null;
  hasMore?: boolean;
  status?: RunEventReplayStatus;
  reconcileRequired?: boolean;
  latestEventId?: string | null;
  isCatchUpComplete?: boolean;
}): RunEventReplayResult {
  const status = params.status ?? (params.hasMore ? "has_more" : "complete");
  const isOverflow = status === "buffer_overflow";
  const isGap = status === "gap_detected" || status === "history_exhausted";
  const reconcileRequired = params.reconcileRequired ?? (isGap || isOverflow);
  const hasMore = params.hasMore ?? false;
  const isCatchUpComplete = params.isCatchUpComplete ?? (!hasMore && status === "complete");

  return {
    runId: params.runId,
    events: params.events,
    nextCursor: params.nextCursor ?? null,
    hasMore,
    replayedCount: params.events.length,
    status,
    reconcileRequired,
    latestEventId: params.latestEventId ? eventId(params.latestEventId) : null,
    isCatchUpComplete,
  };
}

/**
 * Constructs a strongly-typed RunEventReplayErrorContract.
 */
export function createReplayError(
  code: RunEventReplayErrorCode,
  message: string,
  options: {
    runId?: RunId | undefined;
    cursor?: string | undefined;
    details?: Record<string, unknown> | undefined;
    cause?: unknown;
  } = {},
): RunEventReplayErrorContract {
  return {
    code,
    message,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.details ? { details: options.details } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
  };
}

/**
 * Determines whether a given replay status necessitates state reconciliation.
 */
export function isReconcileRequired(status: RunEventReplayStatus): boolean {
  switch (status) {
    case "gap_detected":
    case "history_exhausted":
    case "buffer_overflow":
      return true;
    case "complete":
    case "has_more":
      return false;
  }
}
