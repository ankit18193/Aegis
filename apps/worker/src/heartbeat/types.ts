import type {
  IWorkerHeartbeatPublisher,
  WorkerCapabilities,
  WorkerObservableState,
  WorkerState,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { WorkerId } from "@aegis/types";

export interface WorkerHeartbeatManagerOptions {
  readonly workerId: WorkerId;
  readonly publisher: IWorkerHeartbeatPublisher;
  readonly capabilities: WorkerCapabilities;
  readonly intervalMs?: number | undefined;
  readonly getState: () => WorkerState;
  readonly getActiveTaskCount: () => number;
  readonly getMaxConcurrentTasks: () => number;
  readonly logger?: Logger | undefined;
}

export interface WorkerHeartbeatStatus {
  readonly isRunning: boolean;
  readonly intervalMs: number;
  readonly lastEmittedAt?: string | undefined;
  readonly emissionCount: number;
  readonly lastObservableState?: WorkerObservableState | undefined;
}
