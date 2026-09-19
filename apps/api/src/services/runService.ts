import type {
  ApiErrorResponse,
  CancelRunRequest,
  CancelRunResponse,
  CreateRunRequest,
  CreateRunResponse,
  GetRunEventsQuery,
  GetRunEventsResponse,
  GetRunResponse,
  ListRunsQuery,
  ListRunsResponse,
} from "@aegis/contracts";
import { createApiError } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result, RunId } from "@aegis/types";
import {
  err,
  ok,
  runId as toRunId,
  taskId,
  workflowId,
} from "@aegis/types";

import { ExecutionRun } from "../domain/run.js";
import { TaskEntity } from "../domain/task.js";
import type { IRunRepository } from "../repositories/runRepository.js";

import {
  mapDomainEventToRunEvent,
  mapDtoToRunSnapshot,
  mapSnapshotToRunDto,
} from "./runMapper.js";


let runSequence = 100;

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

    const defaultTasks: TaskEntity[] = [
      TaskEntity.create({
        id: taskId(`task-${newId}-1`),
        name: "Initial Goal Analysis & Scope",
        description: "Parse execution requirements, inspect target boundaries, and sequence tasks.",
      }),
      TaskEntity.create({
        id: taskId(`task-${newId}-2`),
        name: "Execution Plan Formation",
        description: "Generate structured task graph and configure execution parameters.",
        dependencies: [taskId(`task-${newId}-1`)],
      }),
      TaskEntity.create({
        id: taskId(`task-${newId}-3`),
        name: "Distributed Action Execution",
        description: "Execute assigned worker tasks and capture tool outputs.",
        dependencies: [taskId(`task-${newId}-2`)],
      }),
      TaskEntity.create({
        id: taskId(`task-${newId}-4`),
        name: "Synthesis & Result Verification",
        description: "Synthesize findings, verify assertions, and compile final output report.",
        dependencies: [taskId(`task-${newId}-3`)],
      }),
    ];

    const runResult = ExecutionRun.create({
      id: newId,
      goal: request.goal.trim(),
      workflow: {
        id: request.workflowTemplateId ?? wfId,
        name: "Autonomous Execution Plan",
      },
      tasks: defaultTasks,
      createdAt: now,
    });

    if (!runResult.ok) {
      return err(createApiError("VALIDATION_ERROR", runResult.error.message));
    }

    const runAggregate = runResult.value;
    const runDto = mapSnapshotToRunDto(runAggregate.toSnapshot());

    await this.repository.save(runDto);

    for (const domainEvent of runAggregate.pullEvents()) {
      await this.repository.saveEvent(mapDomainEventToRunEvent(domainEvent));
    }

    this.logger?.info("Execution run created", {
      runId: runDto.id,
      goal: runDto.goal,
      taskCount: runDto.tasks.length,
    });

    return ok({ run: runDto });
  }

  async cancelRun(
    id: RunId,
    request?: CancelRunRequest,
  ): Promise<Result<CancelRunResponse, ApiErrorResponse>> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      return err(
        createApiError("NOT_FOUND", `Execution run with ID '${id}' was not found.`),
      );
    }

    // Reconstitute domain aggregate from snapshot
    const run = ExecutionRun.reconstitute(mapDtoToRunSnapshot(existing));

    // Execute domain cancel operation (with explicit cascading cancellation)
    const cancelResult = run.cancel(request?.reason);
    if (!cancelResult.ok) {
      return err(
        createApiError(
          "CONFLICT",
          `Cannot cancel run '${id}' with terminal status '${existing.status}'.`,
        ),
      );
    }

    const updatedDto = mapSnapshotToRunDto(run.toSnapshot());
    await this.repository.save(updatedDto);

    for (const domainEvent of run.pullEvents()) {
      await this.repository.saveEvent(mapDomainEventToRunEvent(domainEvent));
    }

    this.logger?.info("Execution run cancelled", {
      runId: id,
      reason: request?.reason,
    });

    return ok({ run: updatedDto });
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
