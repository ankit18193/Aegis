import type {
  ExecutionPolicy,
  IActionExecutor,
  IPlanner,
} from "@aegis/agent-runtime";
import {
  AgentRuntime,
  DEFAULT_EXECUTION_POLICY,
  DefaultActionExecutor,
  DeterministicPlanner,
} from "@aegis/agent-runtime";
import type {
  ITaskExecutor,
  TaskAssignment,
  TaskExecutionContext,
  TaskExecutionResult,
} from "@aegis/contracts";

import {
  mapAgentOutcomeToResult,
  mapAssignmentToExecutionRequest,
  mapRequestToAgentState,
} from "./mapper.js";

export interface TaskExecutorOptions {
  readonly planner?: IPlanner | undefined;
  readonly executor?: IActionExecutor | undefined;
  readonly policy?: ExecutionPolicy | undefined;
  readonly runtimeFactory?:
    | ((planner: IPlanner, executor: IActionExecutor, policy: ExecutionPolicy) => AgentRuntime)
    | undefined;
}

/**
 * Worker-side task execution coordinator.
 * Implements ITaskExecutor by delegating to canonical AgentRuntime primitives.
 * Completely transport-agnostic: has zero knowledge of Kafka, partitions, or offsets.
 */
export class TaskExecutor implements ITaskExecutor {
  private readonly planner: IPlanner;
  private readonly executor: IActionExecutor;
  private readonly policy: ExecutionPolicy;
  private readonly runtime: AgentRuntime;

  constructor(options: TaskExecutorOptions = {}) {
    this.planner =
      options.planner ??
      new DeterministicPlanner([
        { type: "complete", summary: "Default deterministic completion" },
      ]);
    this.executor = options.executor ?? new DefaultActionExecutor();
    this.policy = options.policy ?? DEFAULT_EXECUTION_POLICY;

    if (options.runtimeFactory) {
      this.runtime = options.runtimeFactory(this.planner, this.executor, this.policy);
    } else {
      this.runtime = new AgentRuntime(this.planner, this.executor, this.policy);
    }
  }

  async execute(
    assignment: TaskAssignment,
    context: TaskExecutionContext,
    abortSignal?: AbortSignal,
  ): Promise<TaskExecutionResult> {
    const request = mapAssignmentToExecutionRequest(assignment, context);
    const state = mapRequestToAgentState(request);

    try {
      const runResult = await this.runtime.run(state, abortSignal);

      if (!runResult.ok) {
        return mapAgentOutcomeToResult(state, context, new Error(runResult.error.message));
      }

      return mapAgentOutcomeToResult(state, context);
    } catch (err) {
      return mapAgentOutcomeToResult(state, context, err);
    }
  }
}
