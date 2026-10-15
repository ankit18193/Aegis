import type { IExecutionStreamClient } from "./IExecutionStreamClient";
import { MockExecutionStreamClient } from "./MockExecutionStreamClient";
import { SseExecutionStreamClient } from "./SseExecutionStreamClient";

let mockOverride: boolean | null = null;

/**
 * Explicitly forces or disables mock execution stream client mode.
 * Passing `null` restores automatic environment-based detection.
 */
export function setUseMockStream(useMock: boolean | null): void {
  mockOverride = useMock;
  resetExecutionStreamClient();
}

/**
 * Returns true if mock stream client should be used based on override or environment.
 */
export function isMockStreamEnabled(): boolean {
  if (mockOverride !== null) {
    return mockOverride;
  }
  if (import.meta.env.MODE === "test") {
    return true;
  }
  if (import.meta.env.VITE_USE_MOCK !== undefined) {
    return import.meta.env.VITE_USE_MOCK === "true";
  }
  if (typeof EventSource === "undefined") {
    return true;
  }
  return false;
}

/**
 * Creates the default stream client according to runtime environment.
 */
export function createDefaultStreamClient(): IExecutionStreamClient {
  if (isMockStreamEnabled()) {
    return new MockExecutionStreamClient();
  }
  return new SseExecutionStreamClient();
}

let activeStreamClient: IExecutionStreamClient = createDefaultStreamClient();

/**
 * Returns the currently active execution stream client singleton.
 * Automatically selects SseExecutionStreamClient in live browser environments
 * while falling back to MockExecutionStreamClient in test environments or when
 * VITE_USE_MOCK=true.
 */
export function getExecutionStreamClient(): IExecutionStreamClient {
  return activeStreamClient;
}

/**
 * Replaces the active execution stream client instance.
 * Useful for tests, mock simulation engines, and custom SSE client injections.
 */
export function setExecutionStreamClient(client: IExecutionStreamClient): void {
  activeStreamClient = client;
}

/**
 * Resets the stream client back to a clean default client.
 */
export function resetExecutionStreamClient(): void {
  activeStreamClient.dispose();
  activeStreamClient = createDefaultStreamClient();
}
