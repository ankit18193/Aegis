import { randomUUID } from "node:crypto";

import type {
  WorkerCapabilities,
  WorkerIdentity,
} from "@aegis/contracts";
import { workerIdentitySchema } from "@aegis/contracts";
import type { WorkerId } from "@aegis/types";
import { workerId } from "@aegis/types";

export interface CreateWorkerIdentityOptions {
  readonly id?: WorkerId | undefined;
  readonly name?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly capabilities?: Partial<WorkerCapabilities> | undefined;
}

/**
 * Creates and validates a canonical WorkerIdentity representing a logical worker instance.
 */
export function createWorkerIdentity(
  options: CreateWorkerIdentityOptions = {},
): WorkerIdentity {
  const id = options.id ?? workerId(`worker-${randomUUID()}`);
  const name = options.name ?? `worker-${id.slice(-8)}`;
  const startedAt = options.startedAt ?? new Date().toISOString();

  const capabilities: WorkerCapabilities = {
    taskTypes: options.capabilities?.taskTypes && options.capabilities.taskTypes.length > 0
      ? options.capabilities.taskTypes
      : ["*"],
    tools: options.capabilities?.tools ?? [],
    maxConcurrency:
      options.capabilities?.maxConcurrency && options.capabilities.maxConcurrency > 0
        ? options.capabilities.maxConcurrency
        : 1,
  };

  return workerIdentitySchema.parse({
    id,
    name,
    startedAt,
    capabilities,
  });
}
