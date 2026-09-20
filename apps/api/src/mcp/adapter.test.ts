import { describe, expect, it } from "vitest";

import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

import { formatMcpContent, generateMcpToolName, McpToolAdapter } from "./adapter.js";
import { McpError } from "./errors.js";
import type { IMcpClient, McpToolDefinition } from "./types.js";

function createMockClient(overrides: Partial<IMcpClient> = {}): IMcpClient {
  return {
    serverId: "fs",
    status: "connected",
    timeoutMs: 5000,
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    listTools: () => Promise.resolve([]),
    callTool: () =>
      Promise.resolve({
        content: [{ type: "text", text: "success" }],
      }),
    ...overrides,
  };
}

describe("McpToolAdapter", () => {
  it("enforces canonical naming convention mcp_${serverId}_${toolName}", () => {
    expect(generateMcpToolName("fs", "read_file")).toBe("mcp_fs_read_file");
    expect(generateMcpToolName("git", "status")).toBe("mcp_git_status");
    expect(generateMcpToolName("db", "query")).toBe("mcp_db_query");
  });

  it("creates McpToolAdapter and validates canonical tool name with TOOL_NAME_REGEX", () => {
    const client = createMockClient({ serverId: "fs" });
    const def: McpToolDefinition = {
      name: "read_file",
      description: "Reads file content",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    };

    const res = McpToolAdapter.create("fs", def, client);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const adapter = res.value;
    expect(adapter.name).toBe("mcp_fs_read_file");
    expect(adapter.description).toBe("Reads file content");
    expect(adapter.serverId).toBe("fs");
    expect(adapter.rawToolName).toBe("read_file");
  });

  it("rejects adapter creation when generated tool name is invalid or too long", () => {
    const client = createMockClient({ serverId: "invalid" });
    const badDef: McpToolDefinition = {
      name: "tool_with_a_super_long_name_that_will_definitely_exceed_the_sixty_four_character_regex_limit",
      inputSchema: {},
    };

    const res = McpToolAdapter.create("tool_server", badDef, client);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_INVALID_CONFIG");
    expect(res.error.message).toContain("violates TOOL_NAME_REGEX");
  });

  it("rejects adapter creation when tool schema contains unsupported constructs", () => {
    const client = createMockClient({ serverId: "complex" });
    const badDef: McpToolDefinition = {
      name: "anyof_tool",
      inputSchema: {
        type: "object",
        anyOf: [{ properties: { a: { type: "string" } } }],
      },
    };

    const res = McpToolAdapter.create("complex", badDef, client);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("MCP_UNSUPPORTED_SCHEMA");
  });

  it("executes successfully through Phase 7 ToolRegistry and ToolExecutor", async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    const client = createMockClient({
      serverId: "math",
      callTool: (_name, args) => {
        capturedArgs = args;
        return Promise.resolve({
          content: [{ type: "text", text: "42" }],
        });
      },
    });

    const def: McpToolDefinition = {
      name: "add",
      description: "Adds numbers",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["x", "y"],
      },
    };

    const adapterRes = McpToolAdapter.create("math", def, client);
    expect(adapterRes.ok).toBe(true);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    const regRes = registry.register(adapterRes.value);
    expect(regRes.ok).toBe(true);

    const executor = new ToolExecutor(registry);
    const execResult = await executor.execute("mcp_math_add", { x: 20, y: 22 });

    expect(execResult.success).toBe(true);
    expect(execResult.toolName).toBe("mcp_math_add");
    expect(capturedArgs).toEqual({ x: 20, y: 22 });
    expect(execResult.data).toEqual({
      text: "42",
      content: [{ type: "text", text: "42" }],
    });
  });

  it("normalizes multi-part MCP content with formatMcpContent", () => {
    const formatted = formatMcpContent([
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ]);
    expect(formatted.text).toBe("line 1\nline 2");
    expect(formatted.content.length).toBe(2);
  });

  it("maps MCP tool error results and client exceptions into canonical ToolError", async () => {
    const client = createMockClient({
      serverId: "failing",
      callTool: () =>
        Promise.resolve({
          content: [{ type: "text", text: "Permission denied on server" }],
          isError: true,
        }),
    });

    const def: McpToolDefinition = {
      name: "fail",
      inputSchema: {},
    };

    const adapterRes = McpToolAdapter.create("failing", def, client);
    expect(adapterRes.ok).toBe(true);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);
    const executor = new ToolExecutor(registry);

    const execResult = await executor.execute("mcp_failing_fail", {});
    expect(execResult.success).toBe(false);
    expect(execResult.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(execResult.error?.message).toContain("Permission denied on server");
  });

  it("maps MCP client timeout exception into TOOL_EXECUTION_FAILED", async () => {
    const client = createMockClient({
      serverId: "timeout_srv",
      callTool: () => Promise.reject(McpError.timeout("timeout_srv", "slow", 3000)),
    });

    const def: McpToolDefinition = {
      name: "slow",
      inputSchema: {},
    };

    const adapterRes = McpToolAdapter.create("timeout_srv", def, client);
    expect(adapterRes.ok).toBe(true);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);
    const executor = new ToolExecutor(registry);

    const execResult = await executor.execute("mcp_timeout_srv_slow", {});
    expect(execResult.success).toBe(false);
    expect(execResult.error?.code).toBe("TOOL_EXECUTION_FAILED");
    expect(execResult.error?.message).toContain("timed out after 3000ms");
  });
});
