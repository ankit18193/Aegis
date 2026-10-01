import type { WorkerConfig } from "@aegis/config";
import type { Logger } from "@aegis/logger";

import { createWorkerIdentity } from "./identity.js";
import { WorkerRuntime } from "./runtime.js";

export interface CreateWorkerOptions {
  readonly config: WorkerConfig;
  readonly logger?: Logger | undefined;
  readonly onStart?: (() => Promise<void> | void) | undefined;
  readonly onStop?: (() => Promise<void> | void) | undefined;
}

/**
 * Bootstraps a WorkerRuntime instance configured from standard WorkerConfig.
 */
export function createWorkerFromConfig(options: CreateWorkerOptions): WorkerRuntime {
  const identity = createWorkerIdentity({
    id: options.config.workerId,
    name: options.config.workerName,
    capabilities: {
      maxConcurrency: options.config.maxConcurrency,
      taskTypes: options.config.taskTypes,
      tools: options.config.tools,
    },
  });

  return new WorkerRuntime({
    identity,
    logger: options.logger,
    onStart: options.onStart,
    onStop: options.onStop,
  });
}
