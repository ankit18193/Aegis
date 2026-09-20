/**
 * Canonical Tool Definition and Execution Context for the Aegis Tool System.
 */

import type { Result, RunId, TaskId } from "@aegis/types";
import type { z } from "zod";

import type { ToolError } from "./errors.js";

/**
 * Deterministic tool naming regex.
 * Must start with a lowercase letter, followed by lowercase letters, numbers, underscores, or hyphens (max 64 chars).
 */
export const TOOL_NAME_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidToolName(name: string): boolean {
  return typeof name === "string" && TOOL_NAME_REGEX.test(name);
}

export interface ToolExecutionContext {
  readonly runId?: RunId | undefined;
  readonly taskId?: TaskId | undefined;
  readonly toolName: string;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface ToolResult<T = unknown> {
  readonly toolName: string;
  readonly success: boolean;
  readonly data?: T | undefined;
  readonly error?: ToolError | undefined;
  readonly durationMs: number;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Canonical Tool definition contract.
 * Every tool defines deterministic metadata, Zod input schema, optional Zod output schema,
 * and an isolated execution function.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema?: z.ZodType<TOutput> | undefined;
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<Result<TOutput, ToolError>>;
}
