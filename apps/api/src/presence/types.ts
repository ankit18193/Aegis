import type { Logger } from "@aegis/logger";

/**
 * Options for InMemoryWorkerRegistry.
 */
export interface InMemoryWorkerRegistryOptions {
  /**
   * Duration in milliseconds without a heartbeat before a HEALTHY worker is marked STALE.
   * Default: 30,000ms (30 seconds).
   */
  readonly heartbeatTimeoutMs?: number | undefined;

  /**
   * Optional logger instance.
   */
  readonly logger?: Logger | undefined;
}

/**
 * Options for WorkerLivenessMonitor.
 */
export interface WorkerLivenessMonitorOptions {
  /**
   * Evaluation interval in milliseconds.
   * Default: 5,000ms (5 seconds).
   */
  readonly intervalMs?: number | undefined;

  /**
   * Optional logger instance.
   */
  readonly logger?: Logger | undefined;
}
