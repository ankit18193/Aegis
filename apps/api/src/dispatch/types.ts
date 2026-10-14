import type { IWorkerRegistry, IWorkerSelector, RecoveryPolicy } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";

import type { IRunRepository } from "../repositories/runRepository.js";

/**
 * Configuration options for the deterministic worker selector.
 */
export interface WorkerSelectorOptions {
  readonly logger?: Logger | undefined;
}

/**
 * Configuration options for the orphan task recovery coordinator.
 */
export interface OrphanRecoveryCoordinatorOptions {
  readonly repository: IRunRepository;
  readonly workerRegistry: IWorkerRegistry;
  readonly workerSelector: IWorkerSelector;
  readonly policy?: Partial<RecoveryPolicy> | undefined;
  readonly baseAssignmentTopic?: string | undefined;
  readonly eventsTopic?: string | undefined;
  readonly logger?: Logger | undefined;
}

