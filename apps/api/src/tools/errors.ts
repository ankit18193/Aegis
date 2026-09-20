/**
 * Canonical Tool Error Model for Aegis Tool System.
 * Defines structured, transport-agnostic error codes and classes.
 */

export type ToolErrorCode =
  | "TOOL_NOT_FOUND"
  | "INVALID_TOOL_INPUT"
  | "UNAUTHORIZED_TOOL"
  | "TOOL_EXECUTION_FAILED"
  | "INVALID_TOOL_OUTPUT"
  | "DUPLICATE_TOOL"
  | "INVALID_TOOL_DEFINITION";

export interface ToolErrorDetails {
  readonly toolName?: string | undefined;
  readonly validationIssues?: readonly unknown[] | undefined;
  readonly cause?: unknown;
  readonly [key: string]: unknown;
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly toolName?: string | undefined;
  readonly details?: ToolErrorDetails | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    options?: {
      toolName?: string | undefined;
      details?: ToolErrorDetails | undefined;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.toolName = options?.toolName;
    this.details = options?.details;
    if (options?.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, ToolError.prototype);
  }

  static notFound(name: string): ToolError {
    return new ToolError("TOOL_NOT_FOUND", `Tool '${name}' was not found in registry.`, {
      toolName: name,
    });
  }

  static invalidInput(name: string, message: string, issues?: readonly unknown[]): ToolError {
    return new ToolError("INVALID_TOOL_INPUT", message, {
      toolName: name,
      details: issues ? { validationIssues: issues } : undefined,
    });
  }

  static unauthorized(name: string, reason?: string): ToolError {
    const msg = reason
      ? `Execution of tool '${name}' was denied: ${reason}`
      : `Execution of tool '${name}' is not authorized.`;
    return new ToolError("UNAUTHORIZED_TOOL", msg, { toolName: name });
  }

  static executionFailed(name: string, message: string, cause?: unknown): ToolError {
    return new ToolError("TOOL_EXECUTION_FAILED", message, {
      toolName: name,
      cause,
    });
  }

  static invalidOutput(name: string, message: string, issues?: readonly unknown[]): ToolError {
    return new ToolError("INVALID_TOOL_OUTPUT", message, {
      toolName: name,
      details: issues ? { validationIssues: issues } : undefined,
    });
  }

  static duplicate(name: string): ToolError {
    return new ToolError("DUPLICATE_TOOL", `Tool with name '${name}' is already registered.`, {
      toolName: name,
    });
  }

  static invalidDefinition(name: string, reason: string): ToolError {
    return new ToolError("INVALID_TOOL_DEFINITION", `Invalid tool definition for '${name}': ${reason}`, {
      toolName: name,
    });
  }
}
