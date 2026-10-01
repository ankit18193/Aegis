import type {
  ITaskResultPublisher,
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultEnvelope,
  TaskResultStatus,
} from "@aegis/contracts";

export interface TaskResultPublishOptions {
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
}

export type {
  ITaskResultPublisher,
  TaskExecutionError,
  TaskExecutionResult,
  TaskResultEnvelope,
  TaskResultStatus,
};
