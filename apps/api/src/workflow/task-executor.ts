/**
 * Task execution boundary for the Aegis Workflow Engine.
 * Integrates directly with existing AgentRuntime and ToolActionExecutor boundaries,
 * preserving existing Tool System and MCP execution pipelines with zero duplication.
 */

import { runId as toRunId } from "@aegis/types";

import type { IActionExecutor } from "../agent/action.js";
import { DeterministicPlanner } from "../agent/planner.js";
import { DEFAULT_EXECUTION_POLICY, type ExecutionPolicy } from "../agent/policy.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentState } from "../agent/state.js";

import type {
  ITaskExecutor,
  TaskExecutionInput,
  TaskExecutionOutput,
} from "./types.js";

export interface WorkflowTaskExecutorOptions {
  /**
   * Pluggable action executor (defaults to existing ToolActionExecutor if provided).
   */
  readonly actionExecutor?: IActionExecutor | undefined;

  /**
   * Pre-configured AgentRuntime instance.
   */
  readonly agentRuntime?: AgentRuntime | undefined;

  /**
   * Execution policy applied when creating a default AgentRuntime.
   */
  readonly policy?: ExecutionPolicy | undefined;
}

/**
 * Authoritative task executor implementation for workflow orchestration.
 * Bridges TaskExecutionInput to either direct tool action execution
 * or the iterative AgentRuntime reasoning loop.
 */
export class WorkflowTaskExecutor implements ITaskExecutor {
  private readonly actionExecutor?: IActionExecutor | undefined;
  private readonly agentRuntime?: AgentRuntime | undefined;
  private readonly policy: ExecutionPolicy;

  constructor(options: WorkflowTaskExecutorOptions = {}) {
    this.actionExecutor = options.actionExecutor;
    this.agentRuntime = options.agentRuntime;
    this.policy = options.policy ?? DEFAULT_EXECUTION_POLICY;
  }

  async execute(
    input: TaskExecutionInput,
    abortSignal?: AbortSignal,
  ): Promise<TaskExecutionOutput> {
    const startTime = Date.now();

    // 1. Check cancellation before starting
    if (abortSignal?.aborted) {
      const reason =
        typeof abortSignal.reason === "string"
          ? abortSignal.reason
          : "Task execution cancelled by signal";
      return {
        taskId: input.taskId,
        success: false,
        error: reason,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // 2. Direct tool action shortcut if specified in staticInput
      if (this.actionExecutor && this.isToolActionInput(input.staticInput)) {
        const actionName = (input.staticInput as { tool: string }).tool;
        const rawPayload = (input.staticInput as { payload?: unknown }).payload ?? {};
        const payload =
          typeof rawPayload === "object" && rawPayload !== null
            ? (rawPayload as Record<string, unknown>)
            : { value: rawPayload };

        // Inject dependency outputs into payload if not already present
        const mergedPayload: Record<string, unknown> = {
          ...payload,
          _dependencyOutputs: input.dependencyOutputs,
        };

        const execResult = await this.actionExecutor.execute({
          name: actionName,
          payload: mergedPayload,
        });

        const durationMs = Date.now() - startTime;

        if (abortSignal?.aborted) {
          return {
            taskId: input.taskId,
            success: false,
            error: "Task execution cancelled by signal",
            durationMs,
          };
        }

        if (execResult.ok && execResult.value.success) {
          const outputStr =
            typeof execResult.value.data === "string"
              ? execResult.value.data
              : JSON.stringify(execResult.value.data ?? "Tool execution succeeded");

          return {
            taskId: input.taskId,
            success: true,
            output: outputStr,
            durationMs,
          };
        }

        const errorMsg =
          (!execResult.ok ? execResult.error.message : execResult.value.error) ??
          "Tool execution failed";

        return {
          taskId: input.taskId,
          success: false,
          error: errorMsg,
          durationMs,
        };
      }

      // 3. Agent Runtime loop execution
      const runtime = this.agentRuntime ?? this.createDefaultAgentRuntime(input);

      const syntheticRunId = toRunId(`task-run-${input.taskId}`);
      const goal = input.description && input.description.trim() !== ""
        ? input.description
        : input.name;

      const agentState = AgentState.init(syntheticRunId, goal, {
        taskId: input.taskId,
        taskName: input.name,
        staticInput: input.staticInput,
        dependencyOutputs: input.dependencyOutputs,
      });

      const runtimeResult = await runtime.run(agentState, abortSignal);
      const durationMs = Date.now() - startTime;

      if (!runtimeResult.ok) {
        return {
          taskId: input.taskId,
          success: false,
          error: runtimeResult.error.message,
          durationMs,
        };
      }

      const outcome = runtimeResult.value;

      if (outcome.status === "cancelled" || abortSignal?.aborted) {
        return {
          taskId: input.taskId,
          success: false,
          error: outcome.error ?? "Task execution cancelled",
          durationMs,
        };
      }

      if (outcome.status === "completed") {
        return {
          taskId: input.taskId,
          success: true,
          output: outcome.summary ?? `Task '${input.name}' completed successfully`,
          durationMs,
        };
      }

      return {
        taskId: input.taskId,
        success: false,
        error: outcome.error ?? `Task '${input.name}' failed`,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        taskId: input.taskId,
        success: false,
        error: `Unexpected task executor error: ${errorMsg}`,
        durationMs,
      };
    }
  }

  private isToolActionInput(input: unknown): boolean {
    return (
      typeof input === "object" &&
      input !== null &&
      "tool" in input &&
      typeof (input as { tool: unknown }).tool === "string"
    );
  }

  private createDefaultAgentRuntime(input: TaskExecutionInput): AgentRuntime {
    const planner = new DeterministicPlanner((_state: AgentState) => {
      // Deterministic single-turn task synthesis
      const depSummary =
        Object.keys(input.dependencyOutputs).length > 0
          ? ` with dependencies [${Object.keys(input.dependencyOutputs).join(", ")}]`
          : "";

      const fullOutput = `Task '${input.name}' completed${depSummary}. Input: ${JSON.stringify(input.staticInput ?? null)}.`;

      return {
        ok: true,
        value: {
          type: "complete",
          summary: `Task '${input.name}' executed${depSummary}`,
          output: fullOutput,
        },
      };
    });

    // If actionExecutor exists, use it; otherwise create minimal no-op
    const executor: IActionExecutor = this.actionExecutor ?? {
      execute: async () => ({
        ok: true,
        value: {
          actionName: "noop",
          success: true,
          data: "noop",
          durationMs: 0,
          timestamp: new Date().toISOString(),
        },
      }),
    };

    return new AgentRuntime(planner, executor, this.policy);
  }
}
