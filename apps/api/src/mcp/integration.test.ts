import path from "node:path";
import { fileURLToPath } from "node:url";

import { ok, runId } from "@aegis/types";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { type ActionDecision, DeterministicPlanner } from "../agent/planner.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentState } from "../agent/state.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";
import { AgentRunService } from "../services/agentRunService.js";
import { ToolActionExecutor } from "../tools/adapter.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolRegistry } from "../tools/registry.js";

import { McpToolAdapter } from "./adapter.js";
import { McpClient } from "./client.js";
import { McpProcessRegistry } from "./lifecycle.js";
import { McpClientManager } from "./manager.js";
import type { IMcpClient, McpServerConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_SERVER_PATH = path.resolve(__dirname, "fixtures", "stdio_mock_server.mjs");

function createHermeticMcpServer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new McpServer(
    { name: "hermetic-calc-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  let lastRawPayload: Record<string, unknown> | undefined;

  server.registerTool(
    "multiply",
    {
      description: "Multiplies two numbers",
      inputSchema: {
        a: z.number(),
        b: z.number(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async ({ a, b }) => {
      return {
        content: [{ type: "text", text: (a * b).toString() }],
      };
    },
  );

  server.registerTool(
    "divide",
    {
      description: "Divides a by b",
      inputSchema: {
        a: z.number(),
        b: z.number(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async ({ a, b }) => {
      if (b === 0) {
        return {
          content: [{ type: "text", text: "Division by zero is undefined" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: (a / b).toString() }],
      };
    },
  );

  server.registerTool(
    "slow_compute",
    {
      description: "Simulates slow operation for timeout testing",
      inputSchema: {
        delayMs: z.number().int().optional(),
      },
    },
    async ({ delayMs }) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs ?? 200));
      return {
        content: [{ type: "text", text: "done" }],
      };
    },
  );

  server.registerTool(
    "login_service",
    {
      description: "Simulates authentication tool receiving credentials",
      inputSchema: {
        username: z.string(),
        password: z.string(),
        apiKey: z.string(),
      },
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async (args) => {
      lastRawPayload = args;
      return {
        content: [{ type: "text", text: "Authenticated successfully" }],
      };
    },
  );

  return {
    clientTransport,
    serverTransport,
    server,
    getLastRawPayload: () => lastRawPayload,
  };
}

describe("MCP & Agent Runtime End-to-End Execution Coverage", () => {
  beforeEach(() => {
    McpProcessRegistry.resetInstance();
  });

  afterEach(async () => {
    await McpProcessRegistry.getInstance().terminateAll();
    McpProcessRegistry.resetInstance();
  });

  it("executes successful AgentRuntime -> ToolActionExecutor -> ToolExecutor -> McpToolAdapter -> MCP transport flow", async () => {
    const { clientTransport, serverTransport, server } = createHermeticMcpServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "calc",
      name: "Calculator",
      transport: "memory",
      timeoutMs: 5000,
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    const tools = await client.listTools();
    const multDef = tools.find((t) => t.name === "multiply");
    expect(multDef).toBeDefined();
    if (!multDef) return;

    const adapterRes = McpToolAdapter.create("calc", multDef, client);
    expect(adapterRes.ok).toBe(true);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);

    const toolExecutor = new ToolExecutor(registry);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    // Planner executes mcp_calc_multiply then completes
    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "mcp_calc_multiply",
            payload: { a: 6, b: 7 },
          },
        });
      }

      const lastObs = state.history[0]?.observation;
      const dataRecord = lastObs?.data as { text?: string } | undefined;
      const textVal = dataRecord?.text ?? "unknown";
      return ok<ActionDecision>({
        type: "complete",
        summary: `Result was: ${textVal}`,
      });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 5 });
    const state = AgentState.init(runId("run-mcp-e2e-success"), "Multiply 6 by 7 using MCP");

    const runRes = await runtime.run(state);
    expect(runRes.ok).toBe(true);
    expect(state.status).toBe("completed");
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.observation.success).toBe(true);
    expect(state.history[0]?.observation.data).toEqual({
      text: "42",
      content: [{ type: "text", text: "42" }],
    });

    await client.disconnect();
    await server.close();
  });

  it("catches invalid tool input at ToolExecutor boundary without reaching MCP server", async () => {
    const { clientTransport, serverTransport, server } = createHermeticMcpServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "calc",
      name: "Calculator",
      transport: "memory",
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    const tools = await client.listTools();
    const multDef = tools.find((t) => t.name === "multiply");
    if (!multDef) return;

    const adapterRes = McpToolAdapter.create("calc", multDef, client);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);
    const actionExecutor = new ToolActionExecutor(new ToolExecutor(registry));

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "mcp_calc_multiply",
            payload: { a: "invalid-string", b: 7 }, // Invalid schema input
          },
        });
      }

      const lastObs = state.history[0]?.observation;
      const errorMsg = lastObs?.error ?? "unknown";
      return ok<ActionDecision>({
        type: "fail",
        reason: `Tool failed as expected: ${errorMsg}`,
      });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 5 });
    const state = AgentState.init(runId("run-mcp-invalid-input"), "Test invalid input");

    await runtime.run(state);
    expect(state.status).toBe("failed");
    expect(state.history[0]?.observation.success).toBe(false);
    expect(state.history[0]?.observation.error).toContain("Input validation failed for tool");

    await client.disconnect();
    await server.close();
  });

  it("handles MCP tool execution errors and maps to TOOL_EXECUTION_FAILED", async () => {
    const { clientTransport, serverTransport, server } = createHermeticMcpServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "calc",
      name: "Calculator",
      transport: "memory",
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    const tools = await client.listTools();
    const divDef = tools.find((t) => t.name === "divide");
    if (!divDef) return;

    const adapterRes = McpToolAdapter.create("calc", divDef, client);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);
    const actionExecutor = new ToolActionExecutor(new ToolExecutor(registry));

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "mcp_calc_divide",
            payload: { a: 10, b: 0 },
          },
        });
      }

      return ok<ActionDecision>({
        type: "complete",
        summary: "Execution evaluated error",
      });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 5 });
    const state = AgentState.init(runId("run-mcp-exec-error"), "Test division by zero");

    await runtime.run(state);
    expect(state.history[0]?.observation.success).toBe(false);
    expect(state.history[0]?.observation.error).toContain("Division by zero");

    await client.disconnect();
    await server.close();
  });

  it("enforces timeout on slow MCP tools and maps to TOOL_EXECUTION_FAILED", async () => {
    const { clientTransport, serverTransport, server } = createHermeticMcpServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "calc",
      name: "Calculator",
      transport: "memory",
      timeoutMs: 50, // 50ms timeout
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    const tools = await client.listTools();
    const slowDef = tools.find((t) => t.name === "slow_compute");
    if (!slowDef) return;

    const adapterRes = McpToolAdapter.create("calc", slowDef, client);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);
    const actionExecutor = new ToolActionExecutor(new ToolExecutor(registry));

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "mcp_calc_slow_compute",
            payload: { delayMs: 150 },
          },
        });
      }

      return ok<ActionDecision>({ type: "complete", summary: "done" });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 5 });
    const state = AgentState.init(runId("run-mcp-timeout"), "Test slow compute timeout");

    await runtime.run(state);
    expect(state.history[0]?.observation.success).toBe(false);
    expect(state.history[0]?.observation.error).toContain("timed out");

    await client.disconnect();
    await server.close();
  });

  it("aborts execution gracefully when AbortSignal is cancelled", async () => {
    const { clientTransport, serverTransport, server } = createHermeticMcpServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "calc",
      name: "Calculator",
      transport: "memory",
      timeoutMs: 5000,
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    const tools = await client.listTools();
    const slowDef = tools.find((t) => t.name === "slow_compute");
    if (!slowDef) return;

    const adapterRes = McpToolAdapter.create("calc", slowDef, client);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);
    const actionExecutor = new ToolActionExecutor(new ToolExecutor(registry));

    const controller = new AbortController();

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        // Abort during execution
        setTimeout(() => { controller.abort(new Error("Run aborted")); }, 10);
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "mcp_calc_slow_compute",
            payload: { delayMs: 200 },
          },
        });
      }
      return ok<ActionDecision>({ type: "complete", summary: "done" });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 5 });
    const state = AgentState.init(runId("run-mcp-abort"), "Test abort signal");

    await runtime.run(state, controller.signal);
    expect(state.status).toBe("cancelled");

    await client.disconnect();
    await server.close();
  });

  it("rejects duplicate tool registration with DUPLICATE_TOOL error", () => {
    const registry = new ToolRegistry();
    const client: IMcpClient = {
      serverId: "dup",
      status: "connected",
      timeoutMs: 1000,
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      listTools: () => Promise.resolve([]),
      callTool: () => Promise.resolve({ content: [] }),
    };

    const def = { name: "test_tool", inputSchema: {} };
    const a1 = McpToolAdapter.create("dup", def, client);
    const a2 = McpToolAdapter.create("dup", def, client);

    expect(a1.ok).toBe(true);
    expect(a2.ok).toBe(true);
    if (!a1.ok || !a2.ok) return;

    const reg1 = registry.register(a1.value);
    expect(reg1.ok).toBe(true);

    const reg2 = registry.register(a2.value);
    expect(reg2.ok).toBe(false);
    if (reg2.ok) return;
    expect(reg2.error.code).toBe("DUPLICATE_TOOL");
  });

  it("contains stdio process crash and executes hermetic mock cleanly", async () => {
    const registry = new ToolRegistry();
    const config: McpServerConfig = {
      id: "crash_srv",
      name: "Crash Server",
      transport: "stdio",
      command: "node",
      args: [FIXTURE_SERVER_PATH],
      timeoutMs: 5000,
    };

    const manager = new McpClientManager({
      registry,
      configs: [config],
    });

    await manager.initialize();
    expect(registry.has("mcp_crash_srv_crash")).toBe(true);

    const toolExecutor = new ToolExecutor(registry);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    // Call crash tool
    const obsRes = await actionExecutor.execute(
      { name: "mcp_crash_srv_crash", payload: {} },
      { runId: runId("run-crash"), toolName: "mcp_crash_srv_crash" },
    );

    expect(obsRes.ok).toBe(true);
    if (obsRes.ok) {
      expect(obsRes.value.success).toBe(true);
    }

    // Wait briefly for process to exit
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Subsequent call fails cleanly due to disconnect
    const obs2Res = await actionExecutor.execute(
      { name: "mcp_crash_srv_ping", payload: {} },
      { runId: runId("run-crash-2"), toolName: "mcp_crash_srv_ping" },
    );

    expect(obs2Res.ok).toBe(true);
    if (obs2Res.ok) {
      expect(obs2Res.value.success).toBe(false);
      expect(obs2Res.value.error).toBeDefined();
    }

    await manager.close();
  });

  it("verifies sanitized tool_invoked persistence while passing raw credentials to MCP server", async () => {
    const { clientTransport, serverTransport, server, getLastRawPayload } = createHermeticMcpServer();
    await server.connect(serverTransport);

    const config: McpServerConfig = {
      id: "auth",
      name: "Auth Service",
      transport: "memory",
      timeoutMs: 5000,
    };

    const client = new McpClient(config, { transport: clientTransport });
    await client.connect();

    const tools = await client.listTools();
    const loginDef = tools.find((t) => t.name === "login_service");
    if (!loginDef) return;

    const adapterRes = McpToolAdapter.create("auth", loginDef, client);
    if (!adapterRes.ok) return;

    const registry = new ToolRegistry();
    registry.register(adapterRes.value);

    const toolExecutor = new ToolExecutor(registry);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    const repository = new InMemoryRunRepository(true);

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "mcp_auth_login_service",
            payload: {
              username: "admin_user",
              password: "super_secret_password_123",
              apiKey: "sk-live-confidential-token",
            },
          },
        });
      }

      return ok<ActionDecision>({
        type: "complete",
        summary: "Login verified",
      });
    });

    const runService = new AgentRunService(repository, undefined, {
      planner,
      executor: actionExecutor,
      stepDelayMs: 1,
    });

    const startRes = await runService.createRun({
      goal: "Authenticate with sensitive credentials",
    });

    expect(startRes.ok).toBe(true);
    if (!startRes.ok) return;

    const currentRunId = startRes.value.run.id;
    await runService.awaitRunCompletion(currentRunId, 5000);

    const r = await repository.findById(currentRunId);
    expect(r?.status).toBe("completed");

    // 1. Verify MCP server received raw credentials intact
    const rawPayload = getLastRawPayload();
    expect(rawPayload).toBeDefined();
    expect(rawPayload?.["password"]).toBe("super_secret_password_123");
    expect(rawPayload?.["apiKey"]).toBe("sk-live-confidential-token");

    // 2. Verify persisted tool_invoked event in repository has sanitized payload
    const events = await repository.findEvents(currentRunId);
    const toolEvent = events.find((e) => e.type === "tool_invoked");
    expect(toolEvent).toBeDefined();

    const metadata = toolEvent?.metadata as {
      actionName: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };
    expect(metadata.actionName).toBe("mcp_auth_login_service");

    // Sensitive keys must be redacted in the persisted event
    expect(metadata.input["username"]).toBe("admin_user");
    expect(metadata.input["password"]).toBe("[REDACTED]");
    expect(metadata.input["apiKey"]).toBe("[REDACTED]");

    await client.disconnect();
    await server.close();
  });
});
