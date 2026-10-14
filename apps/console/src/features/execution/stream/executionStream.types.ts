import type { RunEvent } from "@aegis/contracts";

/**
 * Represents the lifecycle connection state of an execution event stream.
 * - 'connecting': Initial handshake or reconnect attempt in progress.
 * - 'connected': Stream is active and ready to deliver events.
 * - 'disconnected': Stream has been cleanly closed or paused.
 * - 'error': Connection failed or encountered an unrecoverable stream error.
 */
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

/**
 * Standardized error payload emitted by execution streams.
 */
export interface ExecutionStreamError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * Canonical real-time event received from an execution stream.
 * Reuses the platform's core RunEvent contract to maintain domain consistency.
 */
export type ExecutionStreamEvent = RunEvent;

/**
 * Callback handlers registered when subscribing to a run execution stream.
 */
export interface ExecutionStreamListener {
  /**
   * Invoked when a new execution event arrives for the subscribed run.
   */
  readonly onEvent: (event: ExecutionStreamEvent) => void;

  /**
   * Invoked when the transport connection state changes.
   */
  readonly onStateChange?: (state: ConnectionState) => void;

  /**
   * Invoked when a stream error occurs.
   */
  readonly onError?: (error: ExecutionStreamError) => void;
}

/**
 * Handle returned by `IExecutionStreamClient.subscribe()` representing an active subscription.
 */
export interface StreamSubscription {
  /**
   * The run ID to which this subscription is bound.
   */
  readonly runId: string;

  /**
   * Unsubscribes from the stream. Deterministic and idempotent.
   * After calling, no further callbacks will be triggered.
   */
  readonly unsubscribe: () => void;

  /**
   * Returns true if this subscription has been closed/unsubscribed.
   */
  readonly isClosed: () => boolean;
}
