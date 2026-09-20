/**
 * Built-in Calculate Tool for the Aegis Tool System.
 * Safe zero-eval arithmetic calculator using a deterministic recursive-descent parser.
 */

import { err, ok } from "@aegis/types";
import { z } from "zod";

import { ToolError } from "../errors.js";
import type { Tool } from "../tool.js";

export const calculateInputSchema = z.object({
  expression: z
    .string({ required_error: "Property 'expression' is required." })
    .min(1, "Expression must be a non-empty string."),
});
export type CalculateInput = z.infer<typeof calculateInputSchema>;

export const calculateOutputSchema = z.object({
  result: z.number(),
});
export type CalculateOutput = z.infer<typeof calculateOutputSchema>;

/**
 * Pure, zero-eval recursive descent arithmetic parser for basic mathematical expressions.
 * Strictly supports numbers, decimals, unary minus, +, -, *, /, and balanced parentheses.
 */
export function evaluateArithmetic(expression: string): number {
  let pos = 0;
  const str = expression.replace(/\s+/g, "");

  if (str.length === 0) {
    throw new Error("Empty expression");
  }

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
        if (right === 0) {
          throw new Error("Division by zero");
        }
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

export const calculateTool: Tool<CalculateInput, CalculateOutput> = {
  name: "calculate",
  description: "Evaluates arithmetic expressions deterministically using a safe zero-eval parser.",
  inputSchema: calculateInputSchema,
  outputSchema: calculateOutputSchema,
  execute: async (input) => {
    await Promise.resolve();
    const raw = input.expression.trim();

    // Strict character whitelist check before parsing
    if (!/^[0-9+\-*/().\s]+$/.test(raw)) {
      return err(
        ToolError.executionFailed(
          "calculate",
          `Unsafe or invalid characters detected in arithmetic expression: '${input.expression}'`,
        ),
      );
    }

    try {
      const result = evaluateArithmetic(raw);
      if (!Number.isFinite(result)) {
        return err(
          ToolError.executionFailed("calculate", "Calculation resulted in a non-finite number."),
        );
      }
      return ok({ result });
    } catch (calcErr: unknown) {
      const msg = calcErr instanceof Error ? calcErr.message : String(calcErr);
      return err(ToolError.executionFailed("calculate", `Calculation error: ${msg}`));
    }
  },
};
