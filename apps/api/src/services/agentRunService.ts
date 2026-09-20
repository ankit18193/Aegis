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
  workerId,
  workflowId,
} from "@aegis/types";

import { DefaultActionExecutor, type IActionExecutor } from "../agent/action.js";
import { DeterministicPlanner, type IPlanner } from "../agent/planner.js";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "../agent/policy.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentState } from "../agent/state.js";
import { ExecutionRun } from "../domain/run.js";
import { TaskEntity } from "../domain/task.js";
import type { IRunRepository } from "../repositories/runRepository.js";

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
}

export class AgentRunService {
  private readonly planner: IPlanner;
  private readonly executor: IActionExecutor;
  private readonly policy: ExecutionPolicy;
  private readonly dispatcher: IExecutionDispatcher;
  private readonly autoExecute: boolean;
  private readonly stepDelayMs: number;

  constructor(
    private readonly repository: IRunRepository,
    private readonly logger?: Logger | undefined,
    options: AgentRunServiceOptions = {},
  ) {
    this.planner =
      options.planner ??
      new DeterministicPlanner([
        { type: "execute", action: { name: "echo", payload: { step: "init", message: "Starting agent execution" } } },
        { type: "complete", summary: "Agent execution completed successfully" },
      ]);
    this.executor = options.executor ?? new DefaultActionExecutor();
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
   * Orchestrates the agent loop for a run, advancing task lifecycles,
   * capturing action observations, and atomically persisting state.
   */
  async executeRun(runId: RunId, abortSignal?: AbortSignal): Promise<void> {
    const existing = await this.repository.findById(runId);
    if (!existing) {
      return;
    }

    // Cancel-before-start invariant: if already terminal (e.g. cancelled), do not execute
    if (existing.status === "cancelled" || existing.status === "completed" || existing.status === "failed") {
      return;
    }

    const run = ExecutionRun.reconstitute(mapDtoToRunSnapshot(existing));

    // 1. Advance run to running
    const startResult = run.start();
    if (!startResult.ok) {
      return;
    }

    const task1Id = taskId(`task-${runId}-1`);
    const task2Id = taskId(`task-${runId}-2`);
    const task3Id = taskId(`task-${runId}-3`);
    const task4Id = taskId(`task-${runId}-4`);

    // Advance Phase 1 task (Goal Analysis)
    run.scheduleTask(task1Id);
    run.startTask(task1Id);
    run.completeTask(task1Id, "Goal scope and execution boundaries analyzed.");

    // Advance Phase 2 task (Plan Formation)
    run.scheduleTask(task2Id);
    run.startTask(task2Id);
    run.completeTask(task2Id, "Execution plan formulated.");

    // Start Phase 3 task (Action Execution)
    run.scheduleTask(task3Id);
    run.startTask(task3Id, workerId("agent-worker-01"));

    // Persist intermediate starting state atomically
    await this.repository.save(
      mapSnapshotToRunDto(run.toSnapshot()),
      run.pullEvents().map(mapDomainEventToRunEvent),
    );

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
    await sleep(this.stepDelayMs);
    if (abortSignal?.aborted) {
      return;
    }

    // 2. Initialize AgentState
    const agentState = AgentState.init(run.id, run.goal, {
      workflowId: run.workflow.id,
    });

    // 3. Create AgentRuntime with onStep hook to capture action events
    const runtime = new AgentRuntime(this.planner, this.executor, this.policy, {
      onStep: async (_state, action, observation) => {
        run.recordToolInvocation(
          action.name,
          action.payload,
          observation.data,
          observation.error,
          task3Id,
          observation.timestamp,
        );

        const intermediateDto = mapSnapshotToRunDto(run.toSnapshot());
        const stepEvents = run.pullEvents().map(mapDomainEventToRunEvent);
        await this.repository.save(intermediateDto, stepEvents);
      },
    });

    // 4. Run agent loop
    await runtime.run(agentState, abortSignal);

    // 5. Final lifecycle resolution ("Terminal Run State Wins")
    // Re-check repository status: if already terminal in repository, terminal state wins
    const latest = await this.repository.findById(runId);
    if (latest && (latest.status === "cancelled" || latest.status === "completed" || latest.status === "failed")) {
      return;
    }

    if (abortSignal?.aborted || agentState.status === "cancelled") {
      if (!run.isTerminal()) {
        run.cancel(agentState.termination?.reason ?? "Execution cancelled by operator");
      }
    } else if (agentState.status === "failed") {
      const errorMsg = agentState.termination?.error ?? agentState.termination?.reason ?? "Execution failed";
      run.failTask(task3Id, errorMsg);
      run.fail(errorMsg);
    } else if (agentState.status === "completed") {
      const summaryMsg = agentState.termination?.output ?? agentState.termination?.reason ?? "Execution completed";
      run.completeTask(task3Id, summaryMsg);

      // Advance synthesis task
      run.scheduleTask(task4Id);
      run.startTask(task4Id);
      run.completeTask(task4Id, summaryMsg);

      run.complete(summaryMsg);
    }

    // Atomically persist final terminal state and all remaining domain events
    const finalDto = mapSnapshotToRunDto(run.toSnapshot());
    const finalEvents = run.pullEvents().map(mapDomainEventToRunEvent);
    await this.repository.save(finalDto, finalEvents);

    this.logger?.info("Execution run terminated", {
      runId,
      status: finalDto.status,
      iterations: agentState.iteration,
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
