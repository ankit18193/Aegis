import { randomUUID } from "node:crypto";

import type {
  WorkerCapabilities,
  WorkerIdentity,
} from "@aegis/contracts";
import { workerIdentitySchema } from "@aegis/contracts";
import type { WorkerId } from "@aegis/types";
import { workerId } from "@aegis/types";

export interface CreateWorkerCapabilitiesOptions {
  readonly taskTypes?: readonly string[] | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly maxConcurrency?: number | undefined;
}

export interface CreateWorkerIdentityOptions {
  readonly id?: WorkerId | undefined;
  readonly name?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly capabilities?: CreateWorkerCapabilitiesOptions | undefined;
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

  const taskTypes =
    options.capabilities?.taskTypes && options.capabilities.taskTypes.length > 0
      ? [...options.capabilities.taskTypes]
      : ["*"];
  const tools =
    options.capabilities?.tools && options.capabilities.tools.length > 0
      ? [...options.capabilities.tools]
      : [];

  const capabilities: WorkerCapabilities = {
    taskTypes,
    tools,
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
