import type {
  ConnectionState,
  ExecutionStreamListener,
  StreamSubscription,
} from "./executionStream.types";

/**
 * Transport-agnostic client contract for streaming real-time execution events.
 *
 * This abstraction shields the Console UI and state store from the underlying
 * transport protocol (mock generator in Phase 13A, Server-Sent Events in Phases 13B–13D).
 */
export interface IExecutionStreamClient {
  /**
   * Subscribes to real-time execution events for a specific run.
   *
   * @param runId The ID of the execution run to stream.
   * @param listener Callback handlers for events, connection state changes, and errors.
   * @returns A deterministic StreamSubscription object with an idempotent unsubscribe method.
   */
  subscribe(runId: string, listener: ExecutionStreamListener): StreamSubscription;

  /**
   * Returns the current connection state of the stream client.
   */
  getConnectionState(): ConnectionState;

  /**
   * Disposes the client, closing all active subscriptions and releasing resources.
   */
  dispose(): void;
}
