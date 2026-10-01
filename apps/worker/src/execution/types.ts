import type {
  ITaskExecutor,
  TaskExecutionContext,
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultStatus,
} from "@aegis/contracts";
import type { AssignmentId, RunId, TaskId, WorkerId } from "@aegis/types";

/**
 * Normalized execution request adapted from transport-level TaskAssignment.
 * Feeds cleanly into the AgentRuntime without leaking Kafka or broker types.
 */
export interface TaskExecutionRequest {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  readonly workerId: WorkerId;
  readonly goal: string;
  readonly context: Record<string, unknown>;
  readonly startedAt: string;
}

export type {
  ITaskExecutor,
  TaskExecutionContext,
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultStatus,
};
