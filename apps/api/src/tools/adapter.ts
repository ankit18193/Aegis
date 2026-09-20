/**
 * Tool Action Executor Adapter for the Aegis Tool System.
 * Adapts ToolExecutor to the canonical IActionExecutor interface,
 * converting ToolResult into Observation while preserving payload safety.
 */

import type { Result } from "@aegis/types";
import { ok } from "@aegis/types";

import type { ActionExecutionError, AgentAction, IActionExecutor, Observation } from "../agent/action.js";

import type { IToolExecutor } from "./executor.js";
import { sanitizePayload } from "./safety.js";
import type { ToolExecutionContext } from "./tool.js";

export class ToolActionExecutor implements IActionExecutor {
  constructor(private readonly executor: IToolExecutor) {}

  async execute(
    action: AgentAction,
    context?: ToolExecutionContext,
  ): Promise<Result<Observation, ActionExecutionError>> {
    const execContext: ToolExecutionContext = context ?? { toolName: action.name };

    const toolResult = await this.executor.execute(action.name, action.payload, execContext);

    if (toolResult.success) {
      // Strictly sanitize the persisted observation copy
      const sanitizedData = sanitizePayload(toolResult.data) as
        | Record<string, unknown>
        | string
        | number
        | boolean
        | null
        | undefined;

      return ok({
        actionName: action.name,
        success: true,
        data: sanitizedData,
        durationMs: toolResult.durationMs,
        timestamp: toolResult.timestamp,
      });
    }

    const errorMessage = toolResult.error?.message ?? "Tool execution failed";

    return ok({
      actionName: action.name,
      success: false,
      error: errorMessage,
      durationMs: toolResult.durationMs,
      timestamp: toolResult.timestamp,
    });
  }
}
