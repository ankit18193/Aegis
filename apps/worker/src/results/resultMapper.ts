import crypto from "node:crypto";

import type {
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultEnvelope,
} from "@aegis/contracts";
import {
  createTaskExecutionError,
  taskExecutionResultSchema,
  taskResultEnvelopeSchema,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, eventId, ok } from "@aegis/types";

import type { TaskResultPublishOptions } from "./types.js";

/**
 * Creates and validates a canonical TaskResultEnvelope from a TaskExecutionResult.
 * Assigns CloudEvents metadata while preserving all identity boundaries.
 */
export function createTaskResultEnvelope(
  result: TaskExecutionResult,
  options?: TaskResultPublishOptions,
): TaskResultEnvelope {
  // Validate underlying result schema first
  const validatedResult = taskExecutionResultSchema.parse(result);

  const envelope: TaskResultEnvelope = {
    id: eventId(`evt-res-${crypto.randomUUID()}`),
    type: "task_result",
    source: `aegis.worker.${validatedResult.workerId}`,
    specVersion: "1.0",
    time: new Date().toISOString(),
    aggregateId: validatedResult.taskId,
    aggregateType: "TaskResult",
    correlationId: options?.correlationId ?? `corr-${validatedResult.runId}`,
    causationId: options?.causationId ?? validatedResult.assignmentId,
    data: validatedResult,
  };

  return taskResultEnvelopeSchema.parse(envelope);
}

/**
 * Serializes a TaskResultEnvelope to JSON string.
 */
export function serializeTaskResultEnvelope(
  envelope: TaskResultEnvelope,
): Result<string, TaskExecutionError> {
  try {
    const json = JSON.stringify(envelope);
    return ok(json);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err(
      createTaskExecutionError(
        "TASK_RESULT_SERIALIZATION_FAILED",
        `Failed to serialize task result envelope: ${msg}`,
      ),
    );
  }
}

/**
 * Deserializes and validates a TaskResultEnvelope from raw JSON string.
 */
export function deserializeTaskResultEnvelope(
  raw: string,
): Result<TaskResultEnvelope, TaskExecutionError> {
  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = taskResultEnvelopeSchema.parse(parsed);
    return ok(envelope);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return err(
      createTaskExecutionError(
        "TASK_RESULT_SERIALIZATION_FAILED",
        `Failed to deserialize or validate task result envelope: ${msg}`,
      ),
    );
  }
}
