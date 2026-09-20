import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpClient } from "./client.js";
import { assertSafeCommand, McpProcessRegistry } from "./lifecycle.js";
import type { IMcpClient, McpServerConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_SERVER_PATH = path.resolve(__dirname, "fixtures", "stdio_mock_server.mjs");

describe("MCP Stdio Process Lifecycle & Isolation", () => {
  beforeEach(() => {
    McpProcessRegistry.resetInstance();
  });

  afterEach(async () => {
    await McpProcessRegistry.getInstance().terminateAll();
    McpProcessRegistry.resetInstance();
  });

  it("validates command safety and prohibits dangerous shell characters", () => {
    expect(() => { assertSafeCommand("node"); }).not.toThrow();
    expect(() => { assertSafeCommand("/usr/local/bin/git"); }).not.toThrow();
    expect(() => { assertSafeCommand("C:\\Program Files\\nodejs\\node.exe"); }).not.toThrow();

    expect(() => { assertSafeCommand("node; rm -rf /"); }).toThrow(/forbidden shell metacharacters/);
    expect(() => { assertSafeCommand("cat | grep secret"); }).toThrow(/forbidden shell metacharacters/);
    expect(() => { assertSafeCommand("node && evil"); }).toThrow(/forbidden shell metacharacters/);
    expect(() => { assertSafeCommand("echo $VAR"); }).toThrow(/forbidden shell metacharacters/);
    expect(() => { assertSafeCommand("run > out.txt"); }).toThrow(/forbidden shell metacharacters/);
  });

  it("tracks active clients in McpProcessRegistry and terminates them gracefully", () => {
    const registry = McpProcessRegistry.getInstance();
    expect(registry.trackedCount).toBe(0);

    const mockClient: IMcpClient = {
      serverId: "mock-1",
      status: "connected",
      timeoutMs: 1000,
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({ content: [] }),
    };

    const unregister = registry.register(mockClient);
    expect(registry.trackedCount).toBe(1);

    unregister();
    expect(registry.trackedCount).toBe(0);
  });

  it("manages live stdio child process lifecycle (spawn, execution, graceful termination)", async () => {
    const config: McpServerConfig = {
      id: "stdio_test",
      name: "Stdio Mock Server",
      transport: "stdio",
      command: "node",
      args: [FIXTURE_SERVER_PATH],
      timeoutMs: 10000,
    };

    const client = new McpClient(config);
    expect(client.status).toBe("disconnected");
    expect(client.pid).toBeNull();

    await client.connect();
    expect(client.status).toBe("connected");
    expect(client.pid).toBeTypeOf("number");
    expect(client.pid).toBeGreaterThan(0);

    // Verify registry tracked the live client
    const registry = McpProcessRegistry.getInstance();
    expect(registry.trackedCount).toBe(1);

    // List tools and invoke
    const tools = await client.listTools();
    expect(tools.some((t) => t.name === "ping")).toBe(true);

    const res = await client.callTool("ping", { message: "lifecycle test" });
    expect(res.content[0]).toEqual({ type: "text", text: "pong: lifecycle test" });

    // Disconnect and verify termination
    await client.disconnect();
    expect(client.status).toBe("disconnected");
    expect(registry.trackedCount).toBe(0);
  });

  it("contains stdio process crash and transitions client to disconnected", async () => {
    const config: McpServerConfig = {
      id: "crash_test",
      name: "Crash Mock Server",
      transport: "stdio",
      command: "node",
      args: [FIXTURE_SERVER_PATH],
      timeoutMs: 5000,
    };

    const client = new McpClient(config);
    await client.connect();
    expect(client.status).toBe("connected");

    // Call crash tool which triggers process.exit(1)
    await client.callTool("crash", {});

    // Wait for process exit to register on transport
    for (let i = 0; i < 20; i++) {
      if (client.status === "disconnected") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(client.status).toBe("disconnected");

    // Subsequent calls fail with disconnected error
    await expect(client.callTool("ping", {})).rejects.toThrowError(/not connected/);
  });
});
