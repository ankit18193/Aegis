import type {
  WorkerHeartbeatEnvelope,
  WorkerHeartbeatError,
} from "@aegis/contracts";
import {
  createWorkerHeartbeatError,
  workerHeartbeatEnvelopeSchema,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

/**
 * Deserializes and validates a raw Kafka message into a canonical WorkerHeartbeatEnvelope.
 */
export function deserializeWorkerHeartbeatEnvelope(
  raw: Buffer | string | null | undefined,
): Result<WorkerHeartbeatEnvelope, WorkerHeartbeatError> {
  if (raw === null || raw === undefined) {
    return err(
      createWorkerHeartbeatError(
        "INVALID_HEARTBEAT_ENVELOPE",
        "Kafka message value is null or empty.",
      ),
    );
  }

  const rawString = typeof raw === "string" ? raw : raw.toString("utf8");
  if (!rawString.trim()) {
    return err(
      createWorkerHeartbeatError(
        "INVALID_HEARTBEAT_ENVELOPE",
        "Kafka message value is empty.",
      ),
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawString);
  } catch (error) {
    return err(
      createWorkerHeartbeatError(
        "INVALID_HEARTBEAT_ENVELOPE",
        `Malformed JSON in worker heartbeat: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    );
  }

  const schemaResult = workerHeartbeatEnvelopeSchema.safeParse(parsedJson);
  if (!schemaResult.success) {
    return err(
      createWorkerHeartbeatError(
        "INVALID_HEARTBEAT_ENVELOPE",
        `WorkerHeartbeatEnvelope failed schema validation: ${schemaResult.error.message}`,
        schemaResult.error,
      ),
    );
  }

  return ok(schemaResult.data);
}
