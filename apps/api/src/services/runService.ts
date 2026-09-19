import {
  createApiError,
  isValidRunTransition,
  type ApiErrorResponse,
  type CancelRunRequest,
  type CancelRunResponse,
  type CreateRunRequest,
  type CreateRunResponse,
  type GetRunEventsQuery,
  type GetRunEventsResponse,
  type GetRunResponse,
  type ListRunsQuery,
  type ListRunsResponse,
  type Run,
  type RunEvent,
  type Task,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import {
  err,
  eventId,
  ok,
  runId as toRunId,
  taskId,
  workflowId,
  type Result,
  type RunId,
} from "@aegis/types";

import type { IRunRepository } from "../repositories/runRepository.js";

let runSequence = 100;
let eventSequence = 500;

export class RunApplicationService {
  constructor(
    private readonly repository: IRunRepository,
    private readonly logger?: Logger,
  ) {}

  async listRuns(query?: ListRunsQuery): Promise<Result<ListRunsResponse, ApiErrorResponse>> {
    const { items, totalCount, hasMore } = await this.repository.findAll({
      status: query?.status,
      limit: query?.limit,
      cursor: query?.cursor,
      query: query?.query,
    });

    const nextCursor =
      hasMore && items.length > 0
        ? items[items.length - 1]?.id
        : undefined;

    return ok({
      items,
      nextCursor,
      totalCount,
    });
  }

  async getRun(id: RunId): Promise<Result<GetRunResponse, ApiErrorResponse>> {
    const run = await this.repository.findById(id);
    if (!run) {
      return err(
        createApiError("NOT_FOUND", `Execution run with ID '${id}' was not found.`),
      );
    }

    return ok({ run });
  }

  async createRun(request: CreateRunRequest): Promise<Result<CreateRunResponse, ApiErrorResponse>> {
    const now = new Date().toISOString();
    runSequence += 1;
    const newId = toRunId(`run-${Date.now().toString().slice(-4)}-${runSequence.toString()}`);
    const wfId = workflowId(`wf-${newId}`);

    const defaultTasks: Task[] = [
      {
        id: taskId(`task-${newId}-1`),
        name: "Initial Goal Analysis & Scope",
        status: "pending",
        description: "Parse execution requirements, inspect target boundaries, and sequence tasks.",
        attemptCount: 0,
      },
      {
        id: taskId(`task-${newId}-2`),
        name: "Execution Plan Formation",
        status: "pending",
        description: "Generate structured task graph and configure execution parameters.",
        attemptCount: 0,
      },
      {
        id: taskId(`task-${newId}-3`),
        name: "Distributed Action Execution",
        status: "pending",
        description: "Execute assigned worker tasks and capture tool outputs.",
        attemptCount: 0,
      },
      {
        id: taskId(`task-${newId}-4`),
        name: "Synthesis & Result Verification",
        status: "pending",
        description: "Synthesize findings, verify assertions, and compile final output report.",
        attemptCount: 0,
      },
    ];

    const run: Run = {
      id: newId,
      goal: request.goal.trim(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      progress: 0,
      workflow: {
        id: request.workflowTemplateId ?? wfId,
        name: "Autonomous Execution Plan",
        tasks: defaultTasks,
      },
      tasks: defaultTasks,
    };

    await this.repository.save(run);

    eventSequence += 1;
    const initialEvent: RunEvent = {
      id: eventId(`ev-${Date.now().toString().slice(-4)}-${eventSequence.toString()}`),
      runId: newId,
      type: "run_created",
      severity: "info",
      timestamp: now,
      message: `Run created with goal: '${run.goal}'`,
    };

    await this.repository.saveEvent(initialEvent);

    this.logger?.info("Execution run created", {
      runId: run.id,
      goal: run.goal,
      taskCount: run.tasks.length,
    });

    return ok({ run });
  }

  async cancelRun(
    id: RunId,
    request?: CancelRunRequest,
  ): Promise<Result<CancelRunResponse, ApiErrorResponse>> {
    const run = await this.repository.findById(id);
    if (!run) {
      return err(
        createApiError("NOT_FOUND", `Execution run with ID '${id}' was not found.`),
      );
    }

    if (!isValidRunTransition(run.status, "cancelled")) {
      return err(
        createApiError(
          "CONFLICT",
          `Cannot cancel run '${id}' with terminal status '${run.status}'.`,
        ),
      );
    }

    const now = new Date().toISOString();

    // Mark pending, queued, or running tasks as cancelled
    const updatedTasks = run.tasks.map((task) => {
      if (task.status === "pending" || task.status === "queued" || task.status === "running") {
        return { ...task, status: "cancelled" as const };
      }
      return task;
    });

    const updatedRun: Run = {
      ...run,
      status: "cancelled",
      updatedAt: now,
      tasks: updatedTasks,
      workflow: {
        ...run.workflow,
        tasks: updatedTasks,
      },
    };

    await this.repository.save(updatedRun);

    eventSequence += 1;
    const cancellationEvent: RunEvent = {
      id: eventId(`ev-${Date.now().toString().slice(-4)}-${eventSequence.toString()}`),
      runId: id,
      type: "run_cancelled",
      severity: "warn",
      timestamp: now,
      message: request?.reason
        ? `Run cancelled by user request: ${request.reason}`
        : "Run cancelled by user request",
    };

    await this.repository.saveEvent(cancellationEvent);

    this.logger?.info("Execution run cancelled", {
      runId: id,
      reason: request?.reason,
    });

    return ok({ run: updatedRun });
  }

  async getRunEvents(
    runId: RunId,
    query?: GetRunEventsQuery,
  ): Promise<Result<GetRunEventsResponse, ApiErrorResponse>> {
    const run = await this.repository.findById(runId);
    if (!run) {
      return err(
        createApiError("NOT_FOUND", `Execution run with ID '${runId}' was not found.`),
      );
    }

    const events = await this.repository.findEvents(runId, {
      severity: query?.severity,
      type: query?.type,
      limit: query?.limit,
      cursor: query?.cursor,
    });

    const nextCursor = events.length > 0 && query?.limit && events.length === query.limit
      ? events[events.length - 1]?.id
      : undefined;

    return ok({
      events,
      nextCursor,
    });
  }
}
