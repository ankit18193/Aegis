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
 * Serializes a WorkerHeartbeatEnvelope into a JSON string.
 */
export function serializeWorkerHeartbeatEnvelope(
  envelope: WorkerHeartbeatEnvelope,
): Result<string, WorkerHeartbeatError> {
  try {
    const json = JSON.stringify(envelope);
    return ok(json);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err(
      createWorkerHeartbeatError(
        "HEARTBEAT_SERIALIZATION_FAILED",
        `Failed to serialize WorkerHeartbeatEnvelope to JSON: ${msg}`,
        error,
      ),
    );
  }
}

/**
 * Deserializes and validates a raw Kafka message into a canonical WorkerHeartbeatEnvelope.
 *
 * Enforces:
 * - Non-empty string or Buffer payload
 * - Valid JSON structure
 * - Compliance with workerHeartbeatEnvelopeSchema (CloudEvents attributes + WorkerHeartbeat payload)
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
  } catch (parseError) {
    return err(
      createWorkerHeartbeatError(
        "INVALID_HEARTBEAT_ENVELOPE",
        `Kafka message contains invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        parseError,
      ),
    );
  }

  const validationResult = workerHeartbeatEnvelopeSchema.safeParse(parsedJson);
  if (!validationResult.success) {
    return err(
      createWorkerHeartbeatError(
        "INVALID_HEARTBEAT_ENVELOPE",
        `Kafka message failed WorkerHeartbeatEnvelope schema validation: ${validationResult.error.message}`,
        validationResult.error,
      ),
    );
  }

  return ok(validationResult.data);
}
