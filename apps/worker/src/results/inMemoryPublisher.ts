import type {
  ITaskResultPublisher,
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultEnvelope,
} from "@aegis/contracts";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { createTaskResultEnvelope } from "./resultMapper.js";
import type { TaskResultPublishOptions } from "./types.js";

/**
 * In-memory test double for ITaskResultPublisher.
 * Allows deterministic assertion of published task results in hermetic test environments.
 */
export class InMemoryTaskResultPublisher implements ITaskResultPublisher {
  private readonly _published: TaskResultEnvelope[] = [];
  private _simulatedError: TaskExecutionError | null = null;

  constructor(readonly topic = "aegis.tasks.results") {}

  /**
   * Injects a failure for testing publication failure handling.
   */
  simulateFailure(error: TaskExecutionError | null): void {
    this._simulatedError = error;
  }

  publish(
    result: TaskExecutionResult,
    metadata?: TaskResultPublishOptions,
  ): Promise<Result<TaskResultEnvelope, TaskExecutionError>> {
    if (this._simulatedError) {
      return Promise.resolve(err(this._simulatedError));
    }

    try {
      const envelope = createTaskResultEnvelope(result, metadata);
      this._published.push(envelope);
      return Promise.resolve(ok(envelope));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return Promise.resolve(
        err({
          code: "TASK_RESULT_SERIALIZATION_FAILED",
          message: `In-memory result envelope creation failed: ${msg}`,
        }),
      );
    }
  }

  getPublishedEnvelopes(): readonly TaskResultEnvelope[] {
    return [...this._published];
  }

  getEnvelopesByTaskId(taskId: string): readonly TaskResultEnvelope[] {
    return this._published.filter((e) => e.data.taskId === taskId);
  }

  clear(): void {
    this._published.length = 0;
    this._simulatedError = null;
  }
}
