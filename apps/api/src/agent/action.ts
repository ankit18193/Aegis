/**
 * Action and Observation primitives for the Aegis Agent Runtime.
 * Defines the execution boundary between the agent planner and internal executors.
 */

import type { Result } from "@aegis/types";
import { ok } from "@aegis/types";

export interface AgentAction {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

export interface Observation {
  readonly actionName: string;
  readonly success: boolean;
  readonly data?: Record<string, unknown> | string | number | boolean | null | undefined;
  readonly error?: string | undefined;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface ActionExecutionError {
  readonly code: "ACTION_FAILED" | "INVALID_ACTION" | "ACTION_NOT_FOUND";
  readonly message: string;
}

export interface IActionExecutor {
  execute(action: AgentAction): Promise<Result<Observation, ActionExecutionError>>;
}

/**
 * Safe, zero-eval recursive descent arithmetic parser for basic mathematical expressions.
 */
function evaluateArithmetic(expression: string): number {
  let pos = 0;
  const str = expression.replace(/\s+/g, "");

  function parsePrimary(): number {
    if (str[pos] === "(") {
      pos++; // consume '('
      const val = parseAddSub();
      if (str[pos] === ")") {
        pos++; // consume ')'
      } else {
        throw new Error("Missing closing parenthesis");
      }
      return val;
    }
    if (str[pos] === "-") {
      pos++;
      return -parsePrimary();
    }
    const start = pos;
    while (pos < str.length && /[0-9.]/.test(str[pos] ?? "")) {
      pos++;
    }
    if (start === pos) {
      throw new Error(`Unexpected character at ${pos.toString()}: '${str[pos] ?? "EOF"}'`);
    }
    const num = Number(str.slice(start, pos));
    if (Number.isNaN(num)) {
      throw new Error(`Invalid number '${str.slice(start, pos)}'`);
    }
    return num;
  }

  function parseMulDiv(): number {
    let left = parsePrimary();
    while (pos < str.length && (str[pos] === "*" || str[pos] === "/")) {
      const op = str[pos++];
      const right = parsePrimary();
      if (op === "*") {
        left *= right;
      } else {
        if (right === 0) throw new Error("Division by zero");
        left /= right;
      }
    }
    return left;
  }

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (pos < str.length && (str[pos] === "+" || str[pos] === "-")) {
      const op = str[pos++];
      const right = parseMulDiv();
      if (op === "+") {
        left += right;
      } else {
        left -= right;
      }
    }
    return left;
  }

  const result = parseAddSub();
  if (pos < str.length) {
    throw new Error(`Unexpected token at position ${pos.toString()}: '${str[pos] ?? ""}'`);
  }
  return result;
}

/**
 * Default internal action executor for Phase 6.
 * Implements minimal safe actions: echo, noop, calculate.
 * (The full Tool Registry and dynamic sandboxing belong to Phase 7).
 */
export class DefaultActionExecutor implements IActionExecutor {
  async execute(action: AgentAction): Promise<Result<Observation, ActionExecutionError>> {
    await Promise.resolve(); // Async boundary for executor interface compliance
    const started = Date.now();
    const now = new Date().toISOString();

    switch (action.name) {
      case "echo": {
        const text =
          typeof action.payload["text"] === "string"
            ? action.payload["text"]
            : JSON.stringify(action.payload);
        return ok({
          actionName: action.name,
          success: true,
          data: { echoed: text },
          durationMs: Math.max(0, Date.now() - started),
          timestamp: now,
        });
      }

      case "noop": {
        return ok({
          actionName: action.name,
          success: true,
          data: { noop: true },
          durationMs: Math.max(0, Date.now() - started),
          timestamp: now,
        });
      }

      case "calculate": {
        const expression = action.payload["expression"];
        if (typeof expression !== "string" || expression.trim().length === 0) {
          return ok({
            actionName: action.name,
            success: false,
            error: "Payload must contain a non-empty 'expression' string.",
            durationMs: Math.max(0, Date.now() - started),
            timestamp: now,
          });
        }

        const sanitized = expression.replace(/\s+/g, "");
        if (!/^[0-9+\-*/().]+$/.test(sanitized)) {
          return ok({
            actionName: action.name,
            success: false,
            error: `Unsafe characters detected in arithmetic expression: '${expression}'`,
            durationMs: Math.max(0, Date.now() - started),
            timestamp: now,
          });
        }

        try {
          const result = evaluateArithmetic(sanitized);
          return ok({
            actionName: action.name,
            success: true,
            data: { result },
            durationMs: Math.max(0, Date.now() - started),
            timestamp: now,
          });
        } catch (err) {
          return ok({
            actionName: action.name,
            success: false,
            error: `Calculation error: ${err instanceof Error ? err.message : String(err)}`,
            durationMs: Math.max(0, Date.now() - started),
            timestamp: now,
          });
        }
      }

      default: {
        return ok({
          actionName: action.name,
          success: false,
          error: `Unrecognized action '${action.name}'. Available actions: echo, noop, calculate.`,
          durationMs: Math.max(0, Date.now() - started),
          timestamp: now,
        });
      }
    }
  }
}
