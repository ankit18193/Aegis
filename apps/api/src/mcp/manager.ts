/**
 * MCP Client Manager for Aegis.
 * Manages static configured MCP servers, tool discovery, ToolRegistry registration,
 * partial failure isolation, and graceful shutdown.
 */

import type { IToolRegistry } from "../tools/registry.js";

import { McpToolAdapter } from "./adapter.js";
import { McpClient } from "./client.js";
import type { IMcpClient, McpClientStatus, McpServerConfig } from "./types.js";

export interface McpServerStatusInfo {
  readonly serverId: string;
  readonly name: string;
  readonly transport: "stdio" | "memory";
  readonly status: McpClientStatus;
  readonly toolCount: number;
  readonly error?: string | undefined;
}

export interface McpManagerOptions {
  readonly registry: IToolRegistry;
  readonly configs?: readonly McpServerConfig[] | undefined;
  readonly clientFactory?: ((config: McpServerConfig) => IMcpClient) | undefined;
}

export class McpClientManager {
  private readonly registry: IToolRegistry;
  private readonly configs = new Map<string, McpServerConfig>();
  private readonly clients = new Map<string, IMcpClient>();
  private readonly statuses = new Map<string, McpServerStatusInfo>();
  private readonly registeredTools = new Map<string, string[]>();
  private readonly clientFactory: (config: McpServerConfig) => IMcpClient;
  private isInitialized = false;

  constructor(options: McpManagerOptions) {
    this.registry = options.registry;
    this.clientFactory = options.clientFactory ?? ((cfg) => new McpClient(cfg));

    if (options.configs) {
      for (const cfg of options.configs) {
        this.configs.set(cfg.id, cfg);
      }
    }
  }

  get initialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Initializes all configured MCP servers with partial failure isolation.
   * If a server fails to connect or discover tools, other servers still proceed.
   */
  async initialize(configs?: readonly McpServerConfig[]): Promise<void> {
    if (configs) {
      for (const cfg of configs) {
        this.configs.set(cfg.id, cfg);
      }
    }

    const serverConfigs = Array.from(this.configs.values());

    for (const config of serverConfigs) {
      if (config.disabled) {
        this.statuses.set(config.id, {
          serverId: config.id,
          name: config.name,
          transport: config.transport,
          status: "disconnected",
          toolCount: 0,
        });
        continue;
      }

      const client = this.clientFactory(config);
      this.clients.set(config.id, client);

      try {
        await client.connect();

        const toolDefs = await client.listTools();
        const serverToolNames: string[] = [];

        for (const toolDef of toolDefs) {
          const adapterRes = McpToolAdapter.create(config.id, toolDef, client);
          if (!adapterRes.ok) {
            continue;
          }

          const regRes = this.registry.register(adapterRes.value);
          if (regRes.ok) {
            serverToolNames.push(adapterRes.value.name);
          }
        }

        this.registeredTools.set(config.id, serverToolNames);
        this.statuses.set(config.id, {
          serverId: config.id,
          name: config.name,
          transport: config.transport,
          status: "connected",
          toolCount: serverToolNames.length,
        });
      } catch (err) {
        // Partial failure isolation: record failed status and keep other servers running
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.statuses.set(config.id, {
          serverId: config.id,
          name: config.name,
          transport: config.transport,
          status: "failed",
          toolCount: 0,
          error: errorMsg,
        });
      }
    }

    this.isInitialized = true;
  }

  /**
   * Gracefully shuts down all connected MCP clients and cleans up resources.
   */
  async close(): Promise<void> {
    const clientsToClose = Array.from(this.clients.values());

    await Promise.allSettled(
      clientsToClose.map(async (client) => {
        try {
          await client.disconnect();
        } catch {
          // Ignore close errors during shutdown
        }
      }),
    );

    for (const [id, status] of this.statuses.entries()) {
      this.statuses.set(id, {
        ...status,
        status: "disconnected",
      });
    }

    this.clients.clear();
    this.registeredTools.clear();
    this.isInitialized = false;
  }

  /**
   * Returns a snapshot of status across all configured MCP servers.
   */
  getStatus(): readonly McpServerStatusInfo[] {
    return Array.from(this.statuses.values());
  }

  /**
   * Returns status info for a specific server.
   */
  getServerStatus(serverId: string): McpServerStatusInfo | undefined {
    return this.statuses.get(serverId);
  }

  /**
   * Returns the active IMcpClient for a server ID if present.
   */
  getClient(serverId: string): IMcpClient | undefined {
    return this.clients.get(serverId);
  }
}
