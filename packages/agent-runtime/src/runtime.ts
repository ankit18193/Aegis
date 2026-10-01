/**
 * Core Agent Runtime for Aegis.
 * Coordinates the deterministic Reason -> Action -> Observation execution loop,
 * enforces execution policy limits, handles cancellation signals, and records turns.
 */

import type { Result } from "@aegis/types";
import { ok } from "@aegis/types";

import type { AgentAction, IActionExecutor, Observation } from "./action.js";
import type { IPlanner } from "./planner.js";
import type { ExecutionPolicy } from "./policy.js";
import type { AgentRuntimeStatus, AgentState } from "./state.js";

export interface AgentRuntimeHooks {
  onStep?: (state: AgentState, action: AgentAction, observation: Observation) => Promise<void> | void;
  onComplete?: (state: AgentState) => Promise<void> | void;
  onFail?: (state: AgentState, error: string) => Promise<void> | void;
  onCancel?: (state: AgentState, reason: string) => Promise<void> | void;
}

export interface AgentExecutionResult {
  readonly state: AgentState;
  readonly status: AgentRuntimeStatus;
  readonly iterations: number;
  readonly summary?: string | undefined;
  readonly error?: string | undefined;
}

export interface RuntimeError {
  readonly code: "RUNTIME_ERROR" | "EXECUTION_ABORTED";
  readonly message: string;
}

export class AgentRuntime {
  constructor(
    private readonly planner: IPlanner,
    private readonly executor: IActionExecutor,
    private readonly policy: ExecutionPolicy,
    private readonly hooks?: AgentRuntimeHooks | undefined,
  ) {}

  async run(
    state: AgentState,
    abortSignal?: AbortSignal,
  ): Promise<Result<AgentExecutionResult, RuntimeError>> {
    while (!state.isTerminal()) {
      // 1. Check cancellation before iteration
      if (abortSignal?.aborted) {
        const reason =
          typeof abortSignal.reason === "string"
            ? abortSignal.reason
            : "Execution cancelled by signal";
        state.markCancelled(reason);
        if (this.hooks?.onCancel) {
          await this.hooks.onCancel(state, reason);
        }
        break;
      }

      // 2. Enforce iteration limits
      if (state.iteration >= this.policy.maxIterations) {
        const limitError = `Execution exceeded maximum iterations limit (${this.policy.maxIterations.toString()})`;
        state.markFailed(limitError);
        if (this.hooks?.onFail) {
          await this.hooks.onFail(state, limitError);
        }
        break;
      }

      // 3. Reason: Invoke planner
      state.setStatus("planning");
      const planResult = await this.planner.plan(state);

      if (!planResult.ok) {
        const plannerMsg = `Planner failure: ${planResult.error.message}`;
        state.markFailed(plannerMsg);
        if (this.hooks?.onFail) {
          await this.hooks.onFail(state, plannerMsg);
        }
        break;
      }

      const decision = planResult.value;

      // 4. Handle terminal planner decisions
      if (decision.type === "complete") {
        state.markCompleted(decision.summary, decision.output);
        if (this.hooks?.onComplete) {
          await this.hooks.onComplete(state);
        }
        break;
      }

      if (decision.type === "fail") {
        state.markFailed(decision.reason);
        if (this.hooks?.onFail) {
          await this.hooks.onFail(state, decision.reason);
        }
        break;
      }

      // 5. Act: Execute planned action
      state.setStatus("executing");
      state.incrementIteration();

      const execResult = await this.executor.execute(decision.action);
      const observation: Observation = execResult.ok
        ? execResult.value
        : {
            actionName: decision.action.name,
            success: false,
            error: execResult.error.message,
            durationMs: 0,
            timestamp: new Date().toISOString(),
          };

      // 6. Observe & Update State
      state.recordTurn(decision.action, observation);

      if (this.hooks?.onStep) {
        await this.hooks.onStep(state, decision.action, observation);
      }

      // 7. Check cancellation immediately post-action
      if (abortSignal?.aborted) {
        const reason =
          typeof abortSignal.reason === "string"
            ? abortSignal.reason
            : "Execution cancelled by signal";
        state.markCancelled(reason);
        if (this.hooks?.onCancel) {
          await this.hooks.onCancel(state, reason);
        }
        break;
      }
    }

    return ok({
      state,
      status: state.status,
      iterations: state.iteration,
      summary: state.termination?.output ?? state.termination?.reason,
      error: state.termination?.error,
    });
  }
}
