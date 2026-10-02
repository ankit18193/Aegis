import type { IWorkerRegistry } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { WorkerId } from "@aegis/types";

export interface InMemoryWorkerRegistryOptions {
  /**
   * Timeout after which a worker with no heartbeat is considered STALE.
   * Default: 30000ms (30s)
   */
  readonly heartbeatTimeoutMs?: number | undefined;
  readonly logger?: Logger | undefined;
}

export interface WorkerLivenessMonitorOptions {
  readonly registry: IWorkerRegistry;
  /**
   * Interval at which liveness evaluation runs.
   * Default: 5000ms (5s)
   */
  readonly evaluationIntervalMs?: number | undefined;
  /**
   * Timeout passed to markStale.
   * Default: 30000ms (30s)
   */
  readonly heartbeatTimeoutMs?: number | undefined;
  readonly onWorkerStale?: ((workerId: WorkerId) => void) | undefined;
  readonly logger?: Logger | undefined;
}

export interface WorkerLivenessStatus {
  readonly isRunning: boolean;
  readonly evaluationIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly evaluationCount: number;
  readonly lastEvaluatedAt?: string | undefined;
}
