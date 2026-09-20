/**
 * Core types and interfaces for the Aegis Model Context Protocol (MCP) Integration.
 */

/**
 * Supported MCP transport types in Phase 8.
 * NOTE: Only "stdio" (child process) and "memory" (in-process test harness) are supported.
 * Remote HTTP/SSE transports are deferred to future phases.
 */
export type McpTransportType = "stdio" | "memory";

/**
 * Status of an active MCP client connection.
 */
export type McpClientStatus = "disconnected" | "connecting" | "connected" | "failed";

/**
 * Canonical configuration for an MCP server in Aegis.
 */
export interface McpServerConfig {
  readonly id: string;
  readonly name: string;
  readonly transport: McpTransportType;
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Record<string, string> | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly disabled?: boolean | undefined;
}

/**
 * Raw tool definition returned by an MCP server during capability discovery.
 */
export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Content block returned by an MCP tool invocation.
 */
export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface McpImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface McpResourceContent {
  readonly type: "resource";
  readonly resource: {
    readonly uri: string;
    readonly text?: string | undefined;
    readonly blob?: string | undefined;
    readonly mimeType?: string | undefined;
  };
}

export type McpContent = McpTextContent | McpImageContent | McpResourceContent | { readonly type: string; readonly [key: string]: unknown };

/**
 * Result returned by an MCP tool invocation from the SDK client.
 */
export interface McpCallToolResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean | undefined;
  readonly [key: string]: unknown;
}

/**
 * Options for executing an MCP tool call.
 */
export interface McpCallOptions {
  readonly timeoutMs?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

/**
 * Interface representing an isolated MCP client connection to a specific server.
 */
export interface IMcpClient {
  readonly serverId: string;
  readonly status: McpClientStatus;
  readonly timeoutMs: number;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<readonly McpToolDefinition[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpCallOptions,
  ): Promise<McpCallToolResult>;
}

/**
 * JSON Schema primitives supported by Phase 8 schema converter.
 */
export type JsonSchemaPrimitiveType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export interface JsonSchemaProperty {
  readonly type?: JsonSchemaPrimitiveType | readonly JsonSchemaPrimitiveType[] | undefined;
  readonly description?: string | undefined;
  readonly default?: unknown;
  readonly enum?: readonly unknown[] | undefined;
  readonly properties?: Record<string, JsonSchemaProperty> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly items?: JsonSchemaProperty | undefined;
  readonly additionalProperties?: boolean | JsonSchemaProperty | undefined;
  readonly [key: string]: unknown;
}
