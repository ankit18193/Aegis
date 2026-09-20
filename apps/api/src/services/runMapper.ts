/**
 * Application-layer mappers between pure Domain snapshots and Canonical API Contract DTOs.
 * Decouples domain entities from transport contracts and presentation representations.
 */

import type {
  Run,
  RunEvent,
  RunResult,
  Task,
} from "@aegis/contracts";
import type { EventId } from "@aegis/types";
import { eventId } from "@aegis/types";

import type { DomainEvent } from "../domain/events.js";
import type { TaskStatus as DomainTaskStatus } from "../domain/lifecycle.js";
import type { RunResultSnapshot, RunSnapshot } from "../domain/run.js";
import type { TaskSnapshot } from "../domain/task.js";

/**
 * Maps a pure TaskSnapshot to a canonical Task DTO.
 */
export function mapTaskSnapshotToTaskDto(snapshot: TaskSnapshot): Task {
  return {
    id: snapshot.id,
    name: snapshot.name,
    status: snapshot.status,
    description: snapshot.description ?? "",
    worker: snapshot.worker,
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
    attemptCount: snapshot.attemptCount,
    output: snapshot.output,
    error: snapshot.error,
    dependencies: snapshot.dependencies ? [...snapshot.dependencies] : undefined,
  };
}

/**
 * Maps a canonical Task DTO to a pure TaskSnapshot.
 */
export function mapTaskDtoToTaskSnapshot(dto: Task): TaskSnapshot {
  const status: DomainTaskStatus = dto.status === "retrying" ? "queued" : dto.status;
  return {
    id: dto.id,
    name: dto.name,
    status,
    description: dto.description,
    worker: dto.worker,
    startedAt: dto.startedAt,
    completedAt: dto.completedAt,
    attemptCount: dto.attemptCount,
    output: dto.output,
    error: dto.error,
    dependencies: dto.dependencies ? [...dto.dependencies] : undefined,
  };
}

/**
 * Maps a pure RunSnapshot to a canonical Run DTO.
 */
export function mapSnapshotToRunDto(snapshot: RunSnapshot): Run {
  const tasks = snapshot.tasks.map(mapTaskSnapshotToTaskDto);
  let result: RunResult | undefined;

  if (snapshot.result) {
    result = {
      summary: snapshot.result.summary,
      reportMarkdown: snapshot.result.reportMarkdown,
      metrics: snapshot.result.metrics,
      artifacts: snapshot.result.artifacts ? [...snapshot.result.artifacts] : undefined,
    };
  }

  return {
    id: snapshot.id,
    goal: snapshot.goal,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    progress: snapshot.progress,
    workflow: {
      id: snapshot.workflow.id,
      name: snapshot.workflow.name,
      tasks,
    },
    tasks,
    result,
  };
}

/**
 * Maps a canonical Run DTO to a pure RunSnapshot for aggregate reconstitution.
 */
export function mapDtoToRunSnapshot(dto: Run): RunSnapshot {
  const tasks = dto.tasks.map(mapTaskDtoToTaskSnapshot);
  let result: RunResultSnapshot | undefined;

  if (dto.result) {
    result = {
      summary: dto.result.summary,
      reportMarkdown: dto.result.reportMarkdown,
      metrics: dto.result.metrics,
      artifacts: dto.result.artifacts ? [...dto.result.artifacts] : undefined,
    };
  }

  return {
    id: dto.id,
    goal: dto.goal,
    status: dto.status,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    progress: dto.progress,
    workflow: {
      id: dto.workflow.id,
      name: dto.workflow.name,
      tasks,
    },
    tasks,
    result,
  };
}

/**
 * Maps a domain event to a canonical RunEvent DTO for timeline persistence and audit.
 */
export function mapDomainEventToRunEvent(event: DomainEvent): RunEvent {
  const id: EventId = eventId(event.id);
  switch (event.type) {
    case "run_created":
      return {
        id,
        runId: event.runId,
        type: "run_created",
        severity: "info",
        timestamp: event.timestamp,
        message: `Run created with goal: '${event.goal}'`,
      };
    case "run_started":
      return {
        id,
        runId: event.runId,
        type: "workflow_started",
        severity: "info",
        timestamp: event.timestamp,
        message: "Workflow started",
      };
    case "run_completed":
      return {
        id,
        runId: event.runId,
        type: "run_completed",
        severity: "success",
        timestamp: event.timestamp,
        message: event.summary ?? "Run completed successfully",
      };
    case "run_failed":
      return {
        id,
        runId: event.runId,
        type: "run_failed",
        severity: "error",
        timestamp: event.timestamp,
        message: `Run failed: ${event.error}`,
      };
    case "run_cancelled":
      return {
        id,
        runId: event.runId,
        type: "run_cancelled",
        severity: "warn",
        timestamp: event.timestamp,
        message: event.reason
          ? `Run cancelled by user request: ${event.reason}`
          : "Run cancelled by user request",
      };
    case "task_scheduled":
      return {
        id,
        runId: event.runId,
        type: "task_scheduled",
        severity: "info",
        timestamp: event.timestamp,
        message: `Task '${event.taskName}' scheduled`,
        taskId: event.taskId,
      };
    case "task_started":
      return {
        id,
        runId: event.runId,
        type: "task_started",
        severity: "info",
        timestamp: event.timestamp,
        message: `Task '${event.taskName}' started`,
        taskId: event.taskId,
      };
    case "task_completed":
      return {
        id,
        runId: event.runId,
        type: "task_completed",
        severity: "success",
        timestamp: event.timestamp,
        message: `Task '${event.taskName}' completed`,
        taskId: event.taskId,
      };
    case "task_failed":
      return {
        id,
        runId: event.runId,
        type: "task_failed",
        severity: "error",
        timestamp: event.timestamp,
        message: `Task '${event.taskName}' failed: ${event.error}`,
        taskId: event.taskId,
      };
    case "task_cancelled":
      return {
        id,
        runId: event.runId,
        type: "task_cancelled",
        severity: "warn",
        timestamp: event.timestamp,
        message: event.reason
          ? `Task '${event.taskName}' cancelled: ${event.reason}`
          : `Task '${event.taskName}' cancelled`,
        taskId: event.taskId,
      };
    case "tool_invoked":
      return {
        id,
        runId: event.runId,
        type: "tool_invoked",
        severity: event.error ? "warn" : "info",
        timestamp: event.timestamp,
        message: event.error
          ? `Action '${event.toolName}' failed: ${event.error}`
          : `Action '${event.toolName}' executed successfully`,
        taskId: event.taskId,
        metadata: {
          actionName: event.toolName,
          input: event.input,
          output: event.output,
          error: event.error,
        },
      };
  }
}
