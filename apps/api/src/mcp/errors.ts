/**
 * Canonical error definitions for the Aegis MCP Integration.
 */

import { ToolError } from "../tools/errors.js";

export type McpErrorCode =
  | "MCP_CONNECTION_FAILED"
  | "MCP_DISCONNECTED"
  | "MCP_TIMEOUT"
  | "MCP_TOOL_ERROR"
  | "MCP_PROTOCOL_ERROR"
  | "MCP_INVALID_CONFIG"
  | "MCP_UNSUPPORTED_SCHEMA";

export interface McpErrorOptions {
  readonly serverId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly cause?: unknown;
  readonly details?: Record<string, unknown> | undefined;
}

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly serverId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;

  constructor(code: McpErrorCode, message: string, options: McpErrorOptions = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.serverId = options.serverId;
    this.toolName = options.toolName;
    this.details = options.details;
    if (options.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, McpError.prototype);
  }

  /**
   * Converts this McpError into a canonical Aegis ToolError for runtime integration.
   */
  toToolError(): ToolError {
    const tool = this.toolName ?? this.serverId ?? "mcp";
    switch (this.code) {
      case "MCP_UNSUPPORTED_SCHEMA":
      case "MCP_INVALID_CONFIG":
        return ToolError.invalidDefinition(tool, this.message);
      case "MCP_TIMEOUT":
      case "MCP_TOOL_ERROR":
      case "MCP_CONNECTION_FAILED":
      case "MCP_DISCONNECTED":
      case "MCP_PROTOCOL_ERROR":
      default:
        return ToolError.executionFailed(tool, this.message, this.cause);
    }
  }

  static connectionFailed(serverId: string, message: string, cause?: unknown): McpError {
    return new McpError(
      "MCP_CONNECTION_FAILED",
      `Failed to connect to MCP server '${serverId}': ${message}`,
      { serverId, cause },
    );
  }

  static disconnected(serverId: string, message = "MCP client is disconnected"): McpError {
    return new McpError(
      "MCP_DISCONNECTED",
      `MCP server '${serverId}' is disconnected: ${message}`,
      { serverId },
    );
  }

  static timeout(serverId: string, toolName: string, timeoutMs: number): McpError {
    return new McpError(
      "MCP_TIMEOUT",
      `MCP tool '${toolName}' on server '${serverId}' timed out after ${timeoutMs.toString()}ms`,
      { serverId, toolName, details: { timeoutMs } },
    );
  }

  static toolError(
    serverId: string,
    toolName: string,
    message: string,
    content?: unknown,
  ): McpError {
    return new McpError(
      "MCP_TOOL_ERROR",
      `MCP tool '${toolName}' on server '${serverId}' failed: ${message}`,
      { serverId, toolName, details: { content } },
    );
  }

  static protocolError(serverId: string, message: string, cause?: unknown): McpError {
    return new McpError(
      "MCP_PROTOCOL_ERROR",
      `MCP protocol error on server '${serverId}': ${message}`,
      { serverId, cause },
    );
  }

  static invalidConfig(serverId: string, message: string): McpError {
    return new McpError(
      "MCP_INVALID_CONFIG",
      `Invalid configuration for MCP server '${serverId}': ${message}`,
      { serverId },
    );
  }

  static unsupportedSchema(toolName: string, reason: string, schema?: unknown): McpError {
    return new McpError(
      "MCP_UNSUPPORTED_SCHEMA",
      `Unsupported JSON Schema for tool '${toolName}': ${reason}`,
      { toolName, details: { schema } },
    );
  }
}

/**
 * Normalizes any error into a canonical McpError.
 */
export function toMcpError(err: unknown, serverId?: string, toolName?: string): McpError {
  if (err instanceof McpError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Check for common error signatures
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return new McpError("MCP_TIMEOUT", message, { serverId, toolName, cause: err });
  }

  if (lower.includes("disconnect") || lower.includes("closed")) {
    return new McpError("MCP_DISCONNECTED", message, { serverId, toolName, cause: err });
  }

  return new McpError("MCP_PROTOCOL_ERROR", message, { serverId, toolName, cause: err });
}
