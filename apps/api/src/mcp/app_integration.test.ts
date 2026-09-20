import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { ToolRegistry } from "../tools/registry.js";

import { McpClientManager } from "./manager.js";
import type { IMcpClient, McpServerConfig } from "./types.js";

function createMockClient(serverId: string): IMcpClient {
  return {
    serverId,
    status: "disconnected",
    timeoutMs: 5000,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    listTools: () =>
      Promise.resolve([
        {
          name: "health_check",
          description: "Server health probe",
          inputSchema: { type: "object" },
        },
      ]),
    callTool: () => Promise.resolve({ content: [] }),
  };
}

describe("API Application MCP Wiring & Lifecycle", () => {
  it("initializes McpClientManager and registers MCP tools during buildApp", async () => {
    const registry = new ToolRegistry();

    const configs: McpServerConfig[] = [
      { id: "mock_svc", name: "Mock Service", transport: "memory" },
    ];

    const mcpClientManager = new McpClientManager({
      registry,
      configs,
      clientFactory: (cfg) => createMockClient(cfg.id),
    });

    const app = await buildApp({
      toolRegistry: registry,
      mcpClientManager,
    });

    await mcpClientManager.initialize();

    // Registry contains builtins AND the MCP tool
    expect(registry.has("echo")).toBe(true);
    expect(registry.has("calculate")).toBe(true);
    expect(registry.has("mcp_mock_svc_health_check")).toBe(true);

    const status = mcpClientManager.getServerStatus("mock_svc");
    expect(status?.status).toBe("connected");
    expect(status?.toolCount).toBe(1);

    // Fastify app.close() triggers onClose hooks and closes MCP manager
    await app.close();
    expect(mcpClientManager.initialized).toBe(false);
  });

  it("builds app cleanly with default builtins when no MCP servers are configured", async () => {
    const registry = new ToolRegistry();
    const app = await buildApp({
      toolRegistry: registry,
    });

    expect(registry.has("echo")).toBe(true);
    expect(registry.has("calculate")).toBe(true);
    expect(registry.has("noop")).toBe(true);

    await app.close();
  });
});
