import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildIsolatedEnv, McpClient } from "./client.js";
import type { McpServerConfig } from "./types.js";

function setupInMemoryTestServer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new McpServer(
    { name: "test-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "echo",
    {
      description: "Echoes back input text",
      inputSchema: { message: z.string() },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async ({ message }) => {
      return {
        content: [{ type: "text", text: `echo: ${message}` }],
      };
    },
  );

  server.registerTool(
    "slow_op",
    {
      description: "Simulates a slow operation",
      inputSchema: { delayMs: z.number().int().optional() },
    },
    async ({ delayMs }) => {
      const delay = delayMs ?? 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return {
        content: [{ type: "text", text: "slow done" }],
      };
    },
  );

  return { clientTransport, serverTransport, server };
}

describe("McpClient Transport & Operations", () => {
  it("connects, lists tools, calls a tool, and disconnects via in-memory transport", async () => {
    const { clientTransport, serverTransport, server } = setupInMemoryTestServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "test_mem",
      name: "Test In-Memory Server",
      transport: "memory",
      timeoutMs: 5000,
    };

    const client = new McpClient(config, { transport: clientTransport });
    expect(client.status).toBe("disconnected");

    await client.connect();
    expect(client.status).toBe("connected");

    const tools = await client.listTools();
    expect(tools.length).toBe(2);
    expect(tools[0]?.name).toBe("echo");
    expect(tools[0]?.description).toBe("Echoes back input text");

    const callRes = await client.callTool("echo", { message: "hello mcp" });
    expect(callRes.isError).toBeUndefined();
    expect(callRes.content.length).toBe(1);
    expect(callRes.content[0]).toEqual({ type: "text", text: "echo: hello mcp" });

    await client.disconnect();
    expect(client.status).toBe("disconnected");
    await server.close();
  });

  it("enforces environment isolation and excludes sensitive parent variables", () => {
    const origDbUrl = process.env["DATABASE_URL"];
    const origJwt = process.env["JWT_SECRET"];
    try {
      process.env["DATABASE_URL"] = "postgres://secret:pwd@localhost/db";
      process.env["JWT_SECRET"] = "super-confidential-key";

      const isolated = buildIsolatedEnv({
        CUSTOM_VAR: "custom_value",
      });

      // System default PATH should be present
      expect(isolated["PATH"] ?? isolated["Path"]).toBeDefined();

      // Explicitly passed var should be present
      expect(isolated["CUSTOM_VAR"]).toBe("custom_value");

      // Critical secrets must NOT be present
      expect(isolated["DATABASE_URL"]).toBeUndefined();
      expect(isolated["JWT_SECRET"]).toBeUndefined();
    } finally {
      if (origDbUrl !== undefined) {
        process.env["DATABASE_URL"] = origDbUrl;
      } else {
        delete process.env["DATABASE_URL"];
      }
      if (origJwt !== undefined) {
        process.env["JWT_SECRET"] = origJwt;
      } else {
        delete process.env["JWT_SECRET"];
      }
    }
  });

  it("throws McpError with code MCP_DISCONNECTED when called before connecting", async () => {
    const config: McpServerConfig = {
      id: "unconnected",
      name: "Unconnected",
      transport: "memory",
    };
    const client = new McpClient(config);

    await expect(client.listTools()).rejects.toThrowError(/not connected/);
    await expect(client.callTool("echo", {})).rejects.toThrowError(/not connected/);
  });

  it("enforces invocation timeout and throws MCP_TIMEOUT", async () => {
    const { clientTransport, serverTransport, server } = setupInMemoryTestServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "timeout_srv",
      name: "Timeout Server",
      transport: "memory",
      timeoutMs: 50, // 50ms timeout
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    // Call slow_op which takes 200ms with a 50ms timeout
    await expect(
      client.callTool("slow_op", { delayMs: 200 }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({
      code: "MCP_TIMEOUT",
    });

    await client.disconnect();
    await server.close();
  });

  it("propagates AbortSignal and rejects cancelled requests", async () => {
    const { clientTransport, serverTransport, server } = setupInMemoryTestServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "abort_srv",
      name: "Abort Server",
      transport: "memory",
      timeoutMs: 5000,
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    const controller = new AbortController();
    controller.abort(new Error("User cancelled run"));

    await expect(
      client.callTool("slow_op", { delayMs: 100 }, { abortSignal: controller.signal }),
    ).rejects.toMatchObject({
      code: "MCP_PROTOCOL_ERROR",
    });

    await client.disconnect();
    await server.close();
  });
});
