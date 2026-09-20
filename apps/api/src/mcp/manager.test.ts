import { describe, expect, it } from "vitest";

import { ToolRegistry } from "../tools/registry.js";

import { McpClientManager } from "./manager.js";
import type { IMcpClient, McpServerConfig, McpToolDefinition } from "./types.js";

function createMockClient(
  serverId: string,
  tools: readonly McpToolDefinition[],
  fail = false,
): IMcpClient {
  return {
    serverId,
    status: "disconnected",
    timeoutMs: 5000,
    connect: () => (fail ? Promise.reject(new Error("Connection refused")) : Promise.resolve()),
    disconnect: () => Promise.resolve(),
    listTools: () => Promise.resolve(tools),
    callTool: () => Promise.resolve({ content: [] }),
  };
}

describe("McpClientManager Multi-Server Registration & Lifecycle", () => {
  it("initializes multiple configured MCP servers and registers tools in ToolRegistry", async () => {
    const registry = new ToolRegistry();

    const configs: McpServerConfig[] = [
      { id: "fs", name: "Filesystem", transport: "memory" },
      { id: "git", name: "Git VCS", transport: "memory" },
    ];

    const clientMap: Record<string, IMcpClient> = {
      fs: createMockClient("fs", [
        { name: "read", inputSchema: { type: "object" } },
        { name: "write", inputSchema: { type: "object" } },
      ]),
      git: createMockClient("git", [
        { name: "status", inputSchema: { type: "object" } },
      ]),
    };

    const manager = new McpClientManager({
      registry,
      configs,
      clientFactory: (cfg) => clientMap[cfg.id] ?? createMockClient(cfg.id, []),
    });

    await manager.initialize();
    expect(manager.initialized).toBe(true);

    const statuses = manager.getStatus();
    expect(statuses.length).toBe(2);

    const fsStatus = manager.getServerStatus("fs");
    expect(fsStatus?.status).toBe("connected");
    expect(fsStatus?.toolCount).toBe(2);

    const gitStatus = manager.getServerStatus("git");
    expect(gitStatus?.status).toBe("connected");
    expect(gitStatus?.toolCount).toBe(1);

    // Verify registry contains all canonical tool names
    expect(registry.has("mcp_fs_read")).toBe(true);
    expect(registry.has("mcp_fs_write")).toBe(true);
    expect(registry.has("mcp_git_status")).toBe(true);

    await manager.close();
    expect(manager.initialized).toBe(false);
  });

  it("isolates partial server startup failure so healthy servers still initialize", async () => {
    const registry = new ToolRegistry();

    const configs: McpServerConfig[] = [
      { id: "healthy", name: "Healthy Server", transport: "memory" },
      { id: "broken", name: "Broken Server", transport: "memory" },
    ];

    const clientMap: Record<string, IMcpClient> = {
      healthy: createMockClient("healthy", [
        { name: "ping", inputSchema: { type: "object" } },
      ]),
      broken: createMockClient("broken", [], true), // fails to connect
    };

    const manager = new McpClientManager({
      registry,
      configs,
      clientFactory: (cfg) => clientMap[cfg.id] ?? createMockClient(cfg.id, []),
    });

    await manager.initialize();

    const healthyStatus = manager.getServerStatus("healthy");
    expect(healthyStatus?.status).toBe("connected");
    expect(healthyStatus?.toolCount).toBe(1);
    expect(registry.has("mcp_healthy_ping")).toBe(true);

    const brokenStatus = manager.getServerStatus("broken");
    expect(brokenStatus?.status).toBe("failed");
    expect(brokenStatus?.error).toContain("Connection refused");
    expect(brokenStatus?.toolCount).toBe(0);

    await manager.close();
  });

  it("handles disabled server configurations without attempting connection", async () => {
    const registry = new ToolRegistry();

    const configs: McpServerConfig[] = [
      { id: "disabled_srv", name: "Disabled Server", transport: "memory", disabled: true },
    ];

    let factoryCalled = false;
    const manager = new McpClientManager({
      registry,
      configs,
      clientFactory: (cfg) => {
        factoryCalled = true;
        return createMockClient(cfg.id, []);
      },
    });

    await manager.initialize();

    expect(factoryCalled).toBe(false);
    const status = manager.getServerStatus("disabled_srv");
    expect(status?.status).toBe("disconnected");
    expect(status?.toolCount).toBe(0);

    await manager.close();
  });
});
