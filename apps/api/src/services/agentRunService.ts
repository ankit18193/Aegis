/**
 * AgentRunService — Application service for the Aegis Agent Runtime.
 * Coordinates between Fastify HTTP controller, InProcessExecutionDispatcher,
 * AgentRuntime, the pure ExecutionRun aggregate, and IRunRepository.
 */

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

import type { IActionExecutor } from "../agent/action.js";
import { DeterministicPlanner, type IPlanner } from "../agent/planner.js";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "../agent/policy.js";
import type { AgentState } from "../agent/state.js";
import { ExecutionRun } from "../domain/run.js";
import { TaskEntity } from "../domain/task.js";
import type { IRunRepository } from "../repositories/runRepository.js";
import { ToolActionExecutor } from "../tools/adapter.js";
import { registerBuiltinTools } from "../tools/builtins/index.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { WorkflowTaskExecutor } from "../workflow/task-executor.js";
import type {
  ITaskExecutor,
  IWorkflowEngine,
  WorkflowDefinition,
  WorkflowExecutionContext,
} from "../workflow/types.js";

import { InProcessExecutionDispatcher, type IExecutionDispatcher } from "./executionDispatcher.js";
import {
  mapDomainEventToRunEvent,
  mapDtoToRunSnapshot,
  mapSnapshotToRunDto,
} from "./runMapper.js";

let runSequence = 100;

export interface AgentRunServiceOptions {
  planner?: IPlanner | undefined;
  executor?: IActionExecutor | undefined;
  policy?: ExecutionPolicy | undefined;
  dispatcher?: IExecutionDispatcher | undefined;
  autoExecute?: boolean | undefined;
  stepDelayMs?: number | undefined;
  workflowEngine?: IWorkflowEngine | undefined;
  taskExecutor?: ITaskExecutor | undefined;
}

export class AgentRunService {
  private readonly planner: IPlanner;
  private readonly executor: IActionExecutor;
  private readonly policy: ExecutionPolicy;
  private readonly dispatcher: IExecutionDispatcher;
  private readonly autoExecute: boolean;
  private readonly stepDelayMs: number;
  private readonly workflowEngine?: IWorkflowEngine | undefined;
  private readonly taskExecutor?: ITaskExecutor | undefined;

  constructor(
    private readonly repository: IRunRepository,
    private readonly logger?: Logger | undefined,
    options: AgentRunServiceOptions = {},
  ) {
    this.planner =
      options.planner ??
      new DeterministicPlanner((state: AgentState) => {
        if (state.iteration === 0) {
          return ok({
            type: "execute",
            action: {
              name: "echo",
              payload: {
                text: `Analyzing goal: '${state.goal}'`,
              },
            },
          });
        }
        return ok({
          type: "complete",
          summary: `Successfully completed execution for goal: '${state.goal}'`,
        });
      });

    if (options.executor) {
      this.executor = options.executor;
    } else {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      const toolExecutor = new ToolExecutor(registry);
      this.executor = new ToolActionExecutor(toolExecutor);
    }

    this.policy = options.policy ?? DEFAULT_EXECUTION_POLICY;
    this.dispatcher = options.dispatcher ?? new InProcessExecutionDispatcher();
    this.autoExecute = options.autoExecute ?? true;
    this.stepDelayMs = options.stepDelayMs ?? 40;
  }

  async listRuns(query?: ListRunsQuery): Promise<Result<ListRunsResponse, ApiErrorResponse>> {
    const { items, totalCount, hasMore } = await this.repository.findAll({
      status: query?.status,
      limit: query?.limit,
      cursor: query?.cursor,
      query: query?.query,
    });

    const nextCursor =
      hasMore && items.length > 0 ? items[items.length - 1]?.id : undefined;

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

    let runTasks: TaskEntity[];
    if (request.tasks && request.tasks.length > 0) {
      runTasks = request.tasks.map((t) =>
        TaskEntity.create({
          id: t.id,
          name: t.name,
          description: t.description,
          dependencies: t.dependencies ? [...t.dependencies] : [],
          input: t.input,
        }),
      );
    } else {
      runTasks = [
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
    }

    const runResult = ExecutionRun.create({
      id: newId,
      goal: request.goal.trim(),
      workflow: {
        id: request.workflowTemplateId ?? wfId,
        name: "Autonomous Execution Plan",
      },
      tasks: runTasks,
      createdAt: now,
    });

    if (!runResult.ok) {
      return err(createApiError("VALIDATION_ERROR", runResult.error.message));
    }

    const runAggregate = runResult.value;
    const runDto = mapSnapshotToRunDto(runAggregate.toSnapshot());
    const initialEvents = runAggregate.pullEvents().map(mapDomainEventToRunEvent);

    // Atomic persistence of run and initial creation event
    await this.repository.save(runDto, initialEvents);

    this.logger?.info("Execution run created", {
      runId: runDto.id,
      goal: runDto.goal,
      taskCount: runDto.tasks.length,
    });

    // Dispatch background execution if autoExecute is enabled
    if (this.autoExecute) {
      this.dispatcher.dispatch(newId, async (signal) => {
        await this.executeRun(newId, signal);
      });
    }

    return ok({ run: runDto });
  }

  /**
   * Orchestrates workflow execution across tasks, advancing task lifecycles,
   * resolving dependencies, invoking tools, and atomically persisting state.
   */
  async executeRun(runId: RunId, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) {
      return;
    }

    const existing = await this.repository.findById(runId);
    if (!existing) {
      return;
    }

    // Cancel-before-start invariant: if already terminal (e.g. cancelled), do not execute
    if (
      existing.status === "cancelled" ||
      existing.status === "completed" ||
      existing.status === "failed"
    ) {
      return;
    }

    const run = ExecutionRun.reconstitute(mapDtoToRunSnapshot(existing));

    // Helper to persist intermediate state atomically
    const persistSnapshot = async (): Promise<void> => {
      const intermediateDto = mapSnapshotToRunDto(run.toSnapshot());
      const stepEvents = run.pullEvents().map(mapDomainEventToRunEvent);
      await this.repository.save(intermediateDto, stepEvents);
    };

    // Construct WorkflowDefinition from reconstituted run
    const workflowDef: WorkflowDefinition = {
      id: run.workflow.id,
      name: run.workflow.name,
      tasks: run.tasks.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        dependencies: [...t.dependencies],
        input: t.input,
      })),
    };

    // Configure task executor bridging actionExecutor and AgentRuntime
    const taskExecutor =
      this.taskExecutor ??
      new WorkflowTaskExecutor({
        actionExecutor: this.executor,
        planner: this.planner,
        policy: this.policy,
        onToolInvoked: async (toolName, input, output, error, taskId) => {
          if (abortSignal?.aborted) {
            return;
          }
          const current = await this.repository.findById(runId);
          if (
            current &&
            (current.status === "cancelled" ||
              current.status === "completed" ||
              current.status === "failed")
          ) {
            return;
          }
          run.recordToolInvocation(toolName, input, output, error, taskId);
          await persistSnapshot();
        },
      });

    const engine =
      this.workflowEngine ??
      new WorkflowEngine({
        taskExecutor,
      });

    const context: WorkflowExecutionContext = {
      abortSignal,
      onTaskScheduled: async (_task) => {
        await persistSnapshot();
      },
      onTaskStarted: async (_task) => {
        await persistSnapshot();
      },
      onTaskCompleted: async (_task, _output) => {
        await persistSnapshot();
      },
      onTaskFailed: async (_task, _error) => {
        await persistSnapshot();
      },
    };

    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (ms <= 0 || abortSignal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, ms);
        abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    if (abortSignal?.aborted) {
      return;
    }
    if (this.stepDelayMs > 0) {
      await sleep(this.stepDelayMs);
    }
    if (abortSignal?.aborted) {
      return;
    }

    // Execute via WorkflowEngine
    await engine.execute(workflowDef, run, context);

    // Terminal state protection: if already terminal in repository, terminal state wins
    const latest = await this.repository.findById(runId);
    if (
      latest &&
      (latest.status === "cancelled" ||
        latest.status === "completed" ||
        latest.status === "failed")
    ) {
      return;
    }

    // Atomically persist final terminal state and all remaining domain events
    await persistSnapshot();

    this.logger?.info("Execution run terminated", {
      runId,
      status: run.status,
    });
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

    // Check terminal conflict per Phase 4 invariants
    if (existing.status === "completed" || existing.status === "failed") {
      return err(
        createApiError(
          "CONFLICT",
          `Cannot cancel run '${id}' with terminal status '${existing.status}'.`,
        ),
      );
    }

    // Signal in-process execution dispatcher
    this.dispatcher.cancel(id, request?.reason);

    // Reconstitute aggregate and execute cancellation
    const run = ExecutionRun.reconstitute(mapDtoToRunSnapshot(existing));
    const cancelResult = run.cancel(request?.reason);
    if (!cancelResult.ok) {
      return err(
        createApiError("CONFLICT", `Cannot cancel run '${id}' with terminal status '${existing.status}'.`),
      );
    }

    const updatedDto = mapSnapshotToRunDto(run.toSnapshot());
    const events = run.pullEvents().map(mapDomainEventToRunEvent);

    // Atomic persistence of cancelled run and cancellation events
    await this.repository.save(updatedDto, events);

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

    const nextCursor =
      events.length > 0 && query?.limit && events.length === query.limit
        ? events[events.length - 1]?.id
        : undefined;

    return ok({
      events,
      nextCursor,
    });
  }

  /**
   * Helper for tests to synchronize with in-process background execution.
   */
  async awaitRunCompletion(runId: RunId, timeoutMs?: number): Promise<void> {
    await this.dispatcher.awaitCompletion(runId, timeoutMs);
  }
}
