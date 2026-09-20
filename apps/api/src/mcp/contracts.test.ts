import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { McpError, toMcpError } from "./errors.js";
import type { McpServerConfig } from "./types.js";

describe("MCP Core Contracts & Error Mapping", () => {
  it("imports and instantiates official MCP SDK Client and InMemoryTransport", () => {
    const client = new Client(
      { name: "aegis-test", version: "0.1.0" },
      { capabilities: {} },
    );
    expect(client).toBeDefined();

    const [t1, t2] = InMemoryTransport.createLinkedPair();
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
  });

  it("creates structured McpErrors with appropriate error codes", () => {
    const connErr = McpError.connectionFailed("fs", "ECONNREFUSED");
    expect(connErr.code).toBe("MCP_CONNECTION_FAILED");
    expect(connErr.serverId).toBe("fs");
    expect(connErr.message).toContain("Failed to connect to MCP server 'fs'");

    const timeoutErr = McpError.timeout("git", "status", 5000);
    expect(timeoutErr.code).toBe("MCP_TIMEOUT");
    expect(timeoutErr.toolName).toBe("status");
    expect(timeoutErr.details).toEqual({ timeoutMs: 5000 });

    const toolErr = McpError.toolError("sqlite", "query", "syntax error near SELECT", { errorDetails: 123 });
    expect(toolErr.code).toBe("MCP_TOOL_ERROR");
    expect(toolErr.details).toEqual({ content: { errorDetails: 123 } });

    const schemaErr = McpError.unsupportedSchema("calc", "oneOf construct is not supported");
    expect(schemaErr.code).toBe("MCP_UNSUPPORTED_SCHEMA");
    expect(schemaErr.toolName).toBe("calc");
  });

  it("maps McpError into canonical ToolError with correct codes", () => {
    const timeoutErr = McpError.timeout("git", "status", 5000);
    const toolTimeout = timeoutErr.toToolError();
    expect(toolTimeout.code).toBe("TOOL_EXECUTION_FAILED");
    expect(toolTimeout.toolName).toBe("status");
    expect(toolTimeout.message).toContain("timed out after 5000ms");

    const schemaErr = McpError.unsupportedSchema("calc", "unsupported");
    const toolDefErr = schemaErr.toToolError();
    expect(toolDefErr.code).toBe("INVALID_TOOL_DEFINITION");

    const execErr = McpError.toolError("fs", "read", "Permission denied");
    const toolExecErr = execErr.toToolError();
    expect(toolExecErr.code).toBe("TOOL_EXECUTION_FAILED");
  });

  it("normalizes arbitrary errors with toMcpError", () => {
    const standardErr = new Error("Connection timed out after 30000ms");
    const mcpErr1 = toMcpError(standardErr, "server-1", "tool-1");
    expect(mcpErr1.code).toBe("MCP_TIMEOUT");
    expect(mcpErr1.serverId).toBe("server-1");

    const disconnectErr = new Error("Transport stream closed unexpectedly");
    const mcpErr2 = toMcpError(disconnectErr, "server-2");
    expect(mcpErr2.code).toBe("MCP_DISCONNECTED");

    const unknownErr = "String error message";
    const mcpErr3 = toMcpError(unknownErr);
    expect(mcpErr3.code).toBe("MCP_PROTOCOL_ERROR");
    expect(mcpErr3.message).toBe("String error message");

    // Existing McpError is returned as-is
    const existing = McpError.invalidConfig("srv", "bad config");
    expect(toMcpError(existing)).toBe(existing);
  });

  it("satisfies McpServerConfig contract for stdio and memory transports", () => {
    const stdioConfig: McpServerConfig = {
      id: "filesystem",
      name: "Local Filesystem Server",
      transport: "stdio",
      command: "node",
      args: ["./servers/fs.js"],
      env: { ROOT_DIR: "/tmp" },
      cwd: "/tmp",
      timeoutMs: 10000,
      disabled: false,
    };
    expect(stdioConfig.transport).toBe("stdio");

    const memoryConfig: McpServerConfig = {
      id: "mock-test",
      name: "In-Memory Test Server",
      transport: "memory",
      timeoutMs: 5000,
    };
    expect(memoryConfig.transport).toBe("memory");
  });
});
