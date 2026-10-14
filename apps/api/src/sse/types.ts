/**
 * SSE Connection Types & Contracts — Phase 13B (Commit 3)
 * Server-side connection lifecycle abstraction for SSE streaming.
 */

import type {
  RunEvent,
  SseErrorCode,
  SseSerializeOptions,
  SseTransportEnvelope,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";

export type SseConnectionStatus = "initializing" | "open" | "closing" | "closed";

export type SseConnectionErrorCode =
  | "CONNECTION_CLOSED"
  | "CONNECTION_NOT_OPEN"
  | "WRITE_FAILED"
  | "BACKPRESSURE_TIMEOUT"
  | "SERIALIZATION_ERROR"
  | "ALREADY_INITIALIZED";

export interface SseConnectionError {
  readonly code: SseConnectionErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export interface SseConnectionStats {
  readonly messagesSent: number;
  readonly bytesWritten: number;
  readonly heartbeatsSent: number;
  readonly errorsEncountered: number;
  readonly connectedAt: string;
  readonly closedAt?: string | undefined;
}

export interface SseConnectionOptions {
  /**
   * Unique connection identifier (defaults to generated random UUID).
   */
  readonly connectionId?: string | undefined;

  /**
   * Optional runId to which this SSE stream is bound.
   */
  readonly runId?: string | undefined;

  /**
   * Heartbeat interval in milliseconds. If <= 0, heartbeats are disabled.
   * Default: 15,000ms (15 seconds).
   */
  readonly heartbeatIntervalMs?: number | undefined;

  /**
   * Heartbeat framing mode:
   * - 'comment': sends `: keep-alive\n\n` (default, does not fire onmessage in browser)
   * - 'event': sends typed SseHeartbeatEnvelope
   */
  readonly heartbeatMode?: "comment" | "event" | undefined;

  /**
   * Maximum time in ms to wait for a stream 'drain' event before timing out under backpressure.
   * Default: 5,000ms.
   */
  readonly drainTimeoutMs?: number | undefined;

  /**
   * Optional logger instance.
   */
  readonly logger?: Logger | undefined;
}

/**
 * Server-side connection abstraction representing a single client SSE stream.
 */
export interface ISseConnection {
  readonly connectionId: string;
  readonly runId?: string | undefined;
  readonly status: SseConnectionStatus;
  readonly isOpen: boolean;
  readonly isClosed: boolean;
  readonly stats: SseConnectionStats;

  /**
   * Initializes the connection and starts the heartbeat timer.
   */
  open(): Result<void, SseConnectionError>;

  /**
   * Serializes and writes a canonical SseTransportEnvelope to the stream.
   */
  sendEnvelope(
    envelope: SseTransportEnvelope,
    options?: SseSerializeOptions,
  ): Promise<Result<void, SseConnectionError>>;

  /**
   * Wraps a canonical RunEvent into an execution envelope and writes it.
   */
  sendEvent(runEvent: RunEvent): Promise<Result<void, SseConnectionError>>;

  /**
   * Writes a raw SSE comment frame (e.g. for custom keep-alives).
   */
  sendComment(comment: string): Promise<Result<void, SseConnectionError>>;

  /**
   * Sends a structured transport-level error frame.
   */
  sendError(
    code: SseErrorCode,
    message: string,
    retryable?: boolean,
  ): Promise<Result<void, SseConnectionError>>;

  /**
   * Closes the SSE connection cleanly and releases resources. Deterministic and idempotent.
   */
  close(reason?: string, terminal?: boolean): Promise<Result<void, SseConnectionError>>;

  /**
   * Registers a listener invoked when the connection closes or the client disconnects.
   * Returns an unsubscribe function.
   */
  onClose(callback: (reason: string) => void): () => void;
}
