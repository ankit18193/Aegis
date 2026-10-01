import { AgentState } from "@aegis/agent-runtime";
import type {
  TaskAssignment,
  TaskExecutionContext,
  TaskExecutionResult,
} from "@aegis/contracts";
import {
  createTaskExecutionError,
  TaskResultStatusValue,
} from "@aegis/contracts";

import type { TaskExecutionRequest } from "./types.js";

/**
 * Extracts a coherent agent goal string from task metadata and input.
 */
function extractGoal(assignment: TaskAssignment): string {
  const task = assignment.task;

  if (typeof task.input === "string" && task.input.trim().length > 0) {
    return task.input.trim();
  }

  if (task.input && typeof task.input === "object") {
    const goal = task.input["goal"];
    if (typeof goal === "string" && goal.trim().length > 0) {
      return goal.trim();
    }
    const prompt = task.input["prompt"];
    if (typeof prompt === "string" && prompt.trim().length > 0) {
      return prompt.trim();
    }
  }

  if (task.description && task.description.trim().length > 0) {
    return `${task.name}: ${task.description.trim()}`;
  }

  return task.name;
}

/**
 * Adapts transport-level TaskAssignment into a clean TaskExecutionRequest.
 */
export function mapAssignmentToExecutionRequest(
  assignment: TaskAssignment,
  context: TaskExecutionContext,
): TaskExecutionRequest {
  const inputContext: Record<string, unknown> =
    assignment.task.input && typeof assignment.task.input === "object"
      ? assignment.task.input
      : typeof assignment.task.input === "string"
        ? { rawInput: assignment.task.input }
        : {};

  const executionContext: Record<string, unknown> = {
    ...inputContext,
    taskId: context.taskId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    workerId: context.workerId,
    taskName: assignment.task.name,
    assignedAt: assignment.assignedAt,
  };

  return {
    taskId: context.taskId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    workerId: context.workerId,
    goal: extractGoal(assignment),
    context: executionContext,
    startedAt: context.startedAt,
  };
}

/**
 * Initializes an AgentState from a normalized TaskExecutionRequest.
 */
export function mapRequestToAgentState(request: TaskExecutionRequest): AgentState {
  return AgentState.init(request.runId, request.goal, request.context);
}

/**
 * Maps terminal AgentState or unhandled error into a canonical TaskExecutionResult.
 * Always produces a valid result with strictly preserved identity attributes.
 */
export function mapAgentOutcomeToResult(
  state: AgentState,
  context: TaskExecutionContext,
  unexpectedError?: unknown,
): TaskExecutionResult {
  const now = new Date().toISOString();

  if (unexpectedError !== undefined) {
    const errorMsg =
      unexpectedError instanceof Error
        ? unexpectedError.message
        : typeof unexpectedError === "string"
          ? unexpectedError
          : JSON.stringify(unexpectedError);
    const stack = unexpectedError instanceof Error ? unexpectedError.stack : undefined;

    return {
      taskId: context.taskId,
      runId: context.runId,
      assignmentId: context.assignmentId,
      workerId: context.workerId,
      status: TaskResultStatusValue.FAILED,
      startedAt: context.startedAt,
      completedAt: now,
      error: createTaskExecutionError("TASK_RUNTIME_ERROR", errorMsg, undefined, stack),
    };
  }

  if (state.status === "completed") {
    return {
      taskId: context.taskId,
      runId: context.runId,
      assignmentId: context.assignmentId,
      workerId: context.workerId,
      status: TaskResultStatusValue.SUCCEEDED,
      startedAt: context.startedAt,
      completedAt: state.termination?.completedAt ?? now,
      output: state.termination?.output ?? state.termination?.reason ?? "Task execution completed",
    };
  }

  // Handle failed or cancelled runtime states
  const reason =
    state.termination?.error ?? state.termination?.reason ?? "Task execution failed";

  return {
    taskId: context.taskId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    workerId: context.workerId,
    status: TaskResultStatusValue.FAILED,
    startedAt: context.startedAt,
    completedAt: state.termination?.completedAt ?? now,
    error: createTaskExecutionError("TASK_EXECUTION_FAILED", reason, {
      iterations: state.iteration,
      status: state.status,
    }),
  };
}
