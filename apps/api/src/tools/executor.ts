/**
 * Tool Executor for the Aegis Tool System.
 * Coordinates tool resolution, pre-execution input validation, authorization checks,
 * isolated capability execution, and post-execution output validation.
 */

import { AllowAllAuthorizationPolicy, type IAuthorizationPolicy } from "./authorization.js";
import { ToolError } from "./errors.js";
import type { IToolRegistry } from "./registry.js";
import type { ToolExecutionContext, ToolResult } from "./tool.js";

export interface IToolExecutor {
  execute(
    toolName: string,
    rawInput: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export class ToolExecutor implements IToolExecutor {
  private readonly policy: IAuthorizationPolicy;

  constructor(
    private readonly registry: IToolRegistry,
    policy?: IAuthorizationPolicy,
  ) {
    this.policy = policy ?? new AllowAllAuthorizationPolicy();
  }

  async execute(
    toolName: string,
    rawInput: unknown,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const started = Date.now();
    const timestamp = new Date().toISOString();
    const execContext: ToolExecutionContext = context ?? { toolName };

    // 1. Tool Resolution
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        toolName,
        success: false,
        error: ToolError.notFound(toolName),
        durationMs: Math.max(0, Date.now() - started),
        timestamp,
      };
    }

    // 2. Pre-Execution Input Validation
    const inputParseResult = tool.inputSchema.safeParse(rawInput);
    if (!inputParseResult.success) {
      const issueMessages = inputParseResult.error.issues
        .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
        .join("; ");
      return {
        toolName,
        success: false,
        error: ToolError.invalidInput(
          toolName,
          `Input validation failed for tool '${toolName}': ${issueMessages}`,
          inputParseResult.error.issues,
        ),
        durationMs: Math.max(0, Date.now() - started),
        timestamp,
      };
    }

    // 3. Authorization Boundary Check
    const isAuthorized = await this.policy.canExecute(tool, execContext);
    if (!isAuthorized) {
      return {
        toolName,
        success: false,
        error: ToolError.unauthorized(toolName),
        durationMs: Math.max(0, Date.now() - started),
        timestamp,
      };
    }

    // 4. Cancellation Check Pre-Execution
    if (execContext.abortSignal?.aborted) {
      const reason =
        typeof execContext.abortSignal.reason === "string"
          ? execContext.abortSignal.reason
          : "Execution cancelled by signal";
      return {
        toolName,
        success: false,
        error: ToolError.executionFailed(toolName, reason),
        durationMs: Math.max(0, Date.now() - started),
        timestamp,
      };
    }

    // 5. Tool Execution (Isolated Try/Catch)
    let rawOutput: unknown;
    try {
      const execResult = await tool.execute(inputParseResult.data, execContext);
      if (!execResult.ok) {
        return {
          toolName,
          success: false,
          error: execResult.error,
          durationMs: Math.max(0, Date.now() - started),
          timestamp,
        };
      }
      rawOutput = execResult.value;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        toolName,
        success: false,
        error: ToolError.executionFailed(
          toolName,
          `Unhandled exception executing tool '${toolName}': ${errorMsg}`,
          err,
        ),
        durationMs: Math.max(0, Date.now() - started),
        timestamp,
      };
    }

    // 6. Post-Execution Output Validation (if schema defined)
    if (tool.outputSchema) {
      const outputParseResult = tool.outputSchema.safeParse(rawOutput);
      if (!outputParseResult.success) {
        const issueMessages = outputParseResult.error.issues
          .map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`)
          .join("; ");
        return {
          toolName,
          success: false,
          error: ToolError.invalidOutput(
            toolName,
            `Output validation failed for tool '${toolName}': ${issueMessages}`,
            outputParseResult.error.issues,
          ),
          durationMs: Math.max(0, Date.now() - started),
          timestamp,
        };
      }
      rawOutput = outputParseResult.data;
    }

    // 7. Successful Tool Execution Result
    return {
      toolName,
      success: true,
      data: rawOutput,
      durationMs: Math.max(0, Date.now() - started),
      timestamp,
    };
  }
}
