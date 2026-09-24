/**
 * Event envelope factory and explicit JSON serialization boundary.
 * Formulates the transport-agnostic Aegis canonical event envelope with CloudEvents-inspired metadata.
 */

import type { EventEnvelope, RunEvent } from "@aegis/contracts";
import { eventEnvelopeSchema } from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import type {
  EventPublishError,
} from "./errors.js";
import {
  DeserializationError,
  InvalidEnvelopeError,
  SerializationError,
} from "./errors.js";

export interface CreateEnvelopeOptions {
  readonly source?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
}

/**
 * Maps a canonical RunEvent into an Aegis EventEnvelope with CloudEvents-inspired metadata.
 */
export function toEventEnvelope(
  runEvent: RunEvent,
  options: CreateEnvelopeOptions = {},
): EventEnvelope {
  return {
    id: runEvent.id,
    type: runEvent.type,
    source: options.source ?? "aegis.api",
    specVersion: "1.0",
    time: runEvent.timestamp,
    aggregateId: runEvent.runId,
    aggregateType: "ExecutionRun",
    correlationId: options.correlationId ?? runEvent.runId,
    causationId: options.causationId,
    data: runEvent,
  };
}

/**
 * Explicit JSON serialization boundary.
 * Serializes an EventEnvelope to a UTF-8 JSON string.
 */
export function serializeEnvelope(
  envelope: EventEnvelope,
): Result<string, EventPublishError> {
  try {
    const json = JSON.stringify(envelope);
    return ok(json);
  } catch (error) {
    return err(
      new SerializationError(
        `Failed to serialize event envelope ${envelope.id}: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    );
  }
}

/**
 * Explicit JSON deserialization boundary.
 * Parses a UTF-8 JSON string and validates the envelope schema.
 */
export function deserializeEnvelope(
  json: string,
): Result<EventEnvelope, EventPublishError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return err(
      new DeserializationError(
        `Failed to parse event envelope JSON: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    );
  }

  const result = eventEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return err(
      new InvalidEnvelopeError(
        `Event envelope schema validation failed: ${result.error.message}`,
        result.error,
      ),
    );
  }

  return ok(result.data as EventEnvelope);
}
