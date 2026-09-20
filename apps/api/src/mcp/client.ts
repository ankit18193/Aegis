/**
 * Official MCP SDK Client implementation for Aegis.
 * Supports InMemoryTransport and StdioClientTransport with strict
 * environment isolation, timeout enforcement, and AbortSignal propagation.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { DEFAULT_MCP_TIMEOUT_MS } from "./config.js";
import { McpError, toMcpError } from "./errors.js";
import type {
  IMcpClient,
  McpCallOptions,
  McpCallToolResult,
  McpClientStatus,
  McpContent,
  McpServerConfig,
  McpToolDefinition,
} from "./types.js";

/**
 * Builds an isolated environment for child processes containing only
 * safe system execution defaults plus explicitly allowlisted variables.
 * Sensitive parent environment variables (DATABASE_URL, JWT_SECRET, etc.) are strictly excluded.
 */
export function buildIsolatedEnv(configuredEnv?: Record<string, string>): Record<string, string> {
  const defaultEnv = getDefaultEnvironment();
  return {
    ...defaultEnv,
    ...(configuredEnv ?? {}),
  };
}

export interface McpClientOptions {
  readonly transport?: Transport | undefined;
}

export class McpClient implements IMcpClient {
  readonly serverId: string;
  readonly timeoutMs: number;
  private readonly config: McpServerConfig;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private readonly customTransport?: Transport | undefined;
  private _status: McpClientStatus = "disconnected";

  constructor(config: McpServerConfig, options?: McpClientOptions) {
    this.config = config;
    this.serverId = config.id;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    this.customTransport = options?.transport;
  }

  get status(): McpClientStatus {
    return this._status;
  }

  async connect(): Promise<void> {
    if (this._status === "connected") {
      return;
    }

    if (this.config.disabled) {
      this._status = "disconnected";
      return;
    }

    try {
      this.client = new Client(
        { name: "aegis-agent-platform", version: "1.0.0" },
        { capabilities: {} },
      );

      if (this.customTransport) {
        this.transport = this.customTransport;
      } else if (this.config.transport === "stdio") {
        if (!this.config.command) {
          throw McpError.invalidConfig(this.serverId, "Command is required for stdio transport");
        }

        const stdioParams: {
          command: string;
          env: Record<string, string>;
          stderr: "pipe";
          args?: string[];
          cwd?: string;
        } = {
          command: this.config.command,
          env: buildIsolatedEnv(this.config.env),
          stderr: "pipe",
        };
        if (this.config.args) {
          stdioParams.args = [...this.config.args];
        }
        if (this.config.cwd) {
          stdioParams.cwd = this.config.cwd;
        }

        this.transport = new StdioClientTransport(stdioParams);
      } else {
        throw McpError.invalidConfig(
          this.serverId,
          `Transport '${this.config.transport}' requires a provided transport instance for connection.`,
        );
      }

      this.transport.onclose = () => {
        this._status = "disconnected";
      };

      this.transport.onerror = () => {
        this._status = "failed";
      };

      await this.client.connect(this.transport);
      this._status = "connected";
    } catch (err) {
      this._status = "failed";
      if (err instanceof McpError) {
        throw err;
      }
      throw McpError.connectionFailed(
        this.serverId,
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this._status === "disconnected" && !this.client && !this.transport) {
      return;
    }

    try {
      if (this.client) {
        await this.client.close();
      }
    } catch {
      // Ignore client close errors during graceful shutdown
    } finally {
      try {
        if (this.transport) {
          await this.transport.close();
        }
      } catch {
        // Ignore transport close errors
      } finally {
        this._status = "disconnected";
        this.client = null;
        this.transport = null;
      }
    }
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    if (this._status !== "connected" || !this.client) {
      throw McpError.disconnected(this.serverId, "Cannot list tools when client is not connected");
    }

    try {
      const response = await this.client.listTools(undefined, {
        timeout: this.timeoutMs,
      });

      return response.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    } catch (err) {
      if (err instanceof McpError) {
        throw err;
      }
      throw toMcpError(err, this.serverId);
    }
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: McpCallOptions,
  ): Promise<McpCallToolResult> {
    if (this._status !== "connected" || !this.client) {
      throw McpError.disconnected(this.serverId, `Cannot call tool '${name}' when client is not connected`);
    }

    if (options?.abortSignal?.aborted) {
      throw McpError.protocolError(
        this.serverId,
        `Tool '${name}' invocation aborted by caller`,
        options.abortSignal.reason,
      );
    }

    const effectiveTimeout = options?.timeoutMs ?? this.timeoutMs;

    try {
      const requestOptions: { timeout: number; signal?: AbortSignal } = {
        timeout: effectiveTimeout,
      };
      if (options?.abortSignal) {
        requestOptions.signal = options.abortSignal;
      }

      const rawResult = await this.client.callTool(
        {
          name,
          arguments: args ?? {},
        },
        undefined,
        requestOptions,
      );

      return {
        content: rawResult.content as readonly McpContent[],
        isError: typeof rawResult.isError === "boolean" ? rawResult.isError : undefined,
      };
    } catch (err) {
      if (options?.abortSignal?.aborted) {
        throw McpError.protocolError(
          this.serverId,
          `Tool '${name}' invocation aborted: ${String(options.abortSignal.reason ?? "signal aborted")}`,
          err,
        );
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.toLowerCase().includes("timeout") || errMsg.toLowerCase().includes("timed out")) {
        throw McpError.timeout(this.serverId, name, effectiveTimeout);
      }

      throw toMcpError(err, this.serverId, name);
    }
  }
}
