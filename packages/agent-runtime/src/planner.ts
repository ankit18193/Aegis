/**
 * Planner abstractions for the Aegis Agent Runtime.
 * Decouples action decision logic from the runtime loop and infrastructure.
 */

import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import type { AgentAction } from "./action.js";
import type { IModelProvider } from "./model.js";
import type { AgentState } from "./state.js";

export type ActionDecision =
  | {
      readonly type: "execute";
      readonly action: AgentAction;
      readonly rationale?: string | undefined;
    }
  | {
      readonly type: "complete";
      readonly summary: string;
      readonly output?: string | undefined;
    }
  | {
      readonly type: "fail";
      readonly reason: string;
    };

export interface PlannerError {
  readonly code: "PLANNER_ERROR" | "PARSE_ERROR" | "MODEL_ERROR";
  readonly message: string;
}

export interface IPlanner {
  plan(state: AgentState): Promise<Result<ActionDecision, PlannerError>>;
}

/**
 * Deterministic test planner.
 * Yields a pre-configured sequence of decisions or delegates to a custom rule.
 */
export class DeterministicPlanner implements IPlanner {
  private readonly decisions: ActionDecision[];
  private readonly customHandler?: ((state: AgentState) => Result<ActionDecision, PlannerError>) | undefined;
  private stepIndex = 0;

  constructor(
    decisions: ActionDecision[] | ((state: AgentState) => Result<ActionDecision, PlannerError>) = [],
  ) {
    if (typeof decisions === "function") {
      this.decisions = [];
      this.customHandler = decisions;
    } else {
      this.decisions = [...decisions];
    }
  }

  async plan(state: AgentState): Promise<Result<ActionDecision, PlannerError>> {
    await Promise.resolve();

    if (this.customHandler) {
      return this.customHandler(state);
    }

    if (this.stepIndex >= this.decisions.length) {
      return err({
        code: "PLANNER_ERROR",
        message: `DeterministicPlanner exhausted all ${this.decisions.length.toString()} planned decisions for iteration ${state.iteration.toString()}.`,
      });
    }

    const decision = this.decisions[this.stepIndex];
    this.stepIndex += 1;

    if (!decision) {
      return err({
        code: "PLANNER_ERROR",
        message: "Encountered undefined decision in DeterministicPlanner sequence.",
      });
    }

    return ok(decision);
  }

  getStepIndex(): number {
    return this.stepIndex;
  }

  reset(): void {
    this.stepIndex = 0;
  }
}

/**
 * Model-driven planner that bridges IPlanner to IModelProvider.
 * Prompts the model with current goal, context, and turn history, and parses structured ActionDecision JSON.
 */
export class ModelPlanner implements IPlanner {
  constructor(
    private readonly modelProvider: IModelProvider,
    private readonly systemPrompt =
      "You are an autonomous agent planner. Respond with valid JSON representing an ActionDecision (type: 'execute' | 'complete' | 'fail').",
  ) {}

  async plan(state: AgentState): Promise<Result<ActionDecision, PlannerError>> {
    const userPrompt = JSON.stringify({
      goal: state.goal,
      iteration: state.iteration,
      context: state.context,
      history: state.history.slice(-5).map((turn) => ({
        iteration: turn.iteration,
        action: turn.action,
        observation: {
          success: turn.observation.success,
          data: turn.observation.data,
          error: turn.observation.error,
        },
      })),
    });

    const modelResult = await this.modelProvider.generate({
      systemPrompt: this.systemPrompt,
      userPrompt,
      context: state.context,
    });

    if (!modelResult.ok) {
      return err({
        code: "MODEL_ERROR",
        message: modelResult.error.message,
      });
    }

    try {
      const parsed = JSON.parse(modelResult.value.content) as Record<string, unknown>;

      if (parsed["type"] === "execute") {
        const actionObj = parsed["action"] as Record<string, unknown> | undefined;
        if (!actionObj || typeof actionObj["name"] !== "string") {
          return err({
            code: "PARSE_ERROR",
            message: "ActionDecision of type 'execute' must contain an action object with a string 'name'.",
          });
        }
        const payload =
          typeof actionObj["payload"] === "object" && actionObj["payload"] !== null
            ? (actionObj["payload"] as Record<string, unknown>)
            : {};
        return ok({
          type: "execute",
          action: {
            name: actionObj["name"],
            payload,
          },
          rationale: typeof parsed["rationale"] === "string" ? parsed["rationale"] : undefined,
        });
      }

      if (parsed["type"] === "complete") {
        if (typeof parsed["summary"] !== "string") {
          return err({
            code: "PARSE_ERROR",
            message: "ActionDecision of type 'complete' must contain a string 'summary'.",
          });
        }
        return ok({
          type: "complete",
          summary: parsed["summary"],
          output: typeof parsed["output"] === "string" ? parsed["output"] : undefined,
        });
      }

      if (parsed["type"] === "fail") {
        if (typeof parsed["reason"] !== "string") {
          return err({
            code: "PARSE_ERROR",
            message: "ActionDecision of type 'fail' must contain a string 'reason'.",
          });
        }
        return ok({
          type: "fail",
          reason: parsed["reason"],
        });
      }

      return err({
        code: "PARSE_ERROR",
        message: `Unrecognized ActionDecision type: '${String(parsed["type"])}'. Expected 'execute', 'complete', or 'fail'.`,
      });
    } catch (parseError) {
      return err({
        code: "PARSE_ERROR",
        message: `Failed to parse model response as ActionDecision JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      });
    }
  }
}
