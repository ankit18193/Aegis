import type {
  AssignmentErrorContract,
  TaskAssignmentEnvelope,
} from "@aegis/contracts";
import {
  createAssignmentError,
  taskAssignmentEnvelopeSchema,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

/**
 * Deserializes and validates a raw Kafka message into a canonical TaskAssignmentEnvelope.
 *
 * Enforces:
 * - Non-empty string or Buffer payload
 * - Valid JSON structure
 * - Compliance with taskAssignmentEnvelopeSchema (CloudEvents attributes + TaskAssignment payload)
 */
export function deserializeAssignmentEnvelope(
  raw: Buffer | string | null | undefined,
): Result<TaskAssignmentEnvelope, AssignmentErrorContract> {
  if (raw === null || raw === undefined) {
    return err(
      createAssignmentError(
        "INVALID_ASSIGNMENT_ENVELOPE",
        "Kafka message value is null or empty.",
      ),
    );
  }

  const rawString = typeof raw === "string" ? raw : raw.toString("utf8");
  if (!rawString.trim()) {
    return err(
      createAssignmentError(
        "INVALID_ASSIGNMENT_ENVELOPE",
        "Kafka message value is empty.",
      ),
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawString);
  } catch (parseError) {
    return err(
      createAssignmentError(
        "INVALID_ASSIGNMENT_ENVELOPE",
        `Kafka message contains invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        parseError,
      ),
    );
  }

  const validationResult = taskAssignmentEnvelopeSchema.safeParse(parsedJson);
  if (!validationResult.success) {
    return err(
      createAssignmentError(
        "INVALID_ASSIGNMENT_ENVELOPE",
        `Kafka message failed TaskAssignmentEnvelope schema validation: ${validationResult.error.message}`,
        validationResult.error,
      ),
    );
  }

  return ok(validationResult.data);
}
