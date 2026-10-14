import type { IExecutionStreamClient } from "./IExecutionStreamClient";
import { MockExecutionStreamClient } from "./MockExecutionStreamClient";

let activeStreamClient: IExecutionStreamClient = new MockExecutionStreamClient();

/**
 * Returns the currently active execution stream client singleton.
 * In Phase 13A, this returns MockExecutionStreamClient by default.
 * Later phases (13B–13D) can swap in SseExecutionStreamClient without altering UI consumers.
 */
export function getExecutionStreamClient(): IExecutionStreamClient {
  return activeStreamClient;
}

/**
 * Replaces the active execution stream client instance.
 * Useful for tests, mock simulation engines, and future SSE client injections.
 */
export function setExecutionStreamClient(client: IExecutionStreamClient): void {
  activeStreamClient = client;
}

/**
 * Resets the stream client back to a clean default MockExecutionStreamClient.
 */
export function resetExecutionStreamClient(): void {
  activeStreamClient.dispose();
  activeStreamClient = new MockExecutionStreamClient();
}
