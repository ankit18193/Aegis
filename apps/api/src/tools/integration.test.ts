import { ok, runId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { type ActionDecision, DeterministicPlanner } from "../agent/planner.js";
import { AgentRuntime } from "../agent/runtime.js";
import { AgentState } from "../agent/state.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";
import { AgentRunService } from "../services/agentRunService.js";

import { ToolActionExecutor } from "./adapter.js";
import { ConfigurableAuthorizationPolicy } from "./authorization.js";
import { registerBuiltinTools } from "./builtins/index.js";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./tool.js";

describe("Tool System & Agent Runtime End-to-End Integration", () => {
  it("coordinates Reason -> Action -> Observation -> Reason across multiple registered tools", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const toolExecutor = new ToolExecutor(registry);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    // Dynamic state-driven planner that sequences: calculate -> echo -> complete
    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "calculate",
            payload: { expression: "(20 + 4) / 2" },
          },
        });
      }

      if (state.iteration === 1) {
        const lastTurn = state.history[state.history.length - 1];
        const calcData = lastTurn?.observation.data as { result: number } | undefined;
        const resultVal = calcData?.result ?? 0;

        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "echo",
            payload: { text: `Calculation complete. Result is ${resultVal.toString()}` },
          },
        });
      }

      return ok<ActionDecision>({
        type: "complete",
        summary: "All calculation and notification tools executed successfully.",
        output: "Result: 12",
      });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 10 });
    const state = AgentState.init(runId("run-test-e2e"), "Calculate (20 + 4) / 2 and announce");

    const execResult = await runtime.run(state);

    expect(execResult.ok).toBe(true);
    expect(state.status).toBe("completed");
    expect(state.iteration).toBe(2);
    expect(state.history).toHaveLength(2);

    // Turn 1: calculate
    expect(state.history[0]?.action.name).toBe("calculate");
    expect(state.history[0]?.observation.success).toBe(true);
    expect(state.history[0]?.observation.data).toEqual({ result: 12 });

    // Turn 2: echo
    expect(state.history[1]?.action.name).toBe("echo");
    expect(state.history[1]?.observation.success).toBe(true);
    expect(state.history[1]?.observation.data).toEqual({
      text: "Calculation complete. Result is 12",
    });
  });

  it("handles unknown tool requests safely without throwing and allows planner to adapt", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const toolExecutor = new ToolExecutor(registry);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "non_existent_tool",
            payload: {},
          },
        });
      }

      // Planner observes failure and fails gracefully with explanation
      const lastObservation = state.history[0]?.observation;
      return ok<ActionDecision>({
        type: "fail",
        reason: `Planner aborted: ${lastObservation?.error ?? "Unknown failure"}`,
      });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 10 });
    const state = AgentState.init(runId("run-unknown-tool"), "Test missing tool");

    const execResult = await runtime.run(state);

    expect(execResult.ok).toBe(true);
    expect(state.status).toBe("failed");
    expect(state.termination?.reason).toContain("Tool 'non_existent_tool' was not found in registry.");
    expect(state.history[0]?.observation.success).toBe(false);
  });

  it("halts execution on invalid tool input and provides structured error to planner", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const toolExecutor = new ToolExecutor(registry);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "calculate",
            payload: { expression: 9999 }, // Invalid type: must be string
          },
        });
      }
      return ok<ActionDecision>({
        type: "complete",
        summary: "Checked input validation",
      });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 10 });
    const state = AgentState.init(runId("run-invalid-input"), "Test invalid input schema");

    await runtime.run(state);

    expect(state.history[0]?.observation.success).toBe(false);
    expect(state.history[0]?.observation.error).toContain("Input validation failed for tool 'calculate'");
  });

  it("halts execution when tool is denied by authorization policy", async () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    const policy = new ConfigurableAuthorizationPolicy({
      deniedTools: ["echo"],
    });
    const toolExecutor = new ToolExecutor(registry, policy);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "echo",
            payload: { text: "forbidden" },
          },
        });
      }
      return ok<ActionDecision>({
        type: "complete",
        summary: "Done",
      });
    });

    const runtime = new AgentRuntime(planner, actionExecutor, { maxIterations: 10 });
    const state = AgentState.init(runId("run-unauthorized"), "Test policy boundary");

    await runtime.run(state);

    expect(state.history[0]?.observation.success).toBe(false);
    expect(state.history[0]?.observation.error).toContain("Execution of tool 'echo' is not authorized");
  });

  it("integrates with AgentRunService, sanitizes sensitive tokens, and persists tool_invoked events", async () => {
    const repository = new InMemoryRunRepository(false);
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);

    // Register a custom mock tool that receives sensitive credentials and returns a token
    const mockAuthTool: Tool = {
      name: "auth_service",
      description: "Mock authentication service",
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true as const, data: input }),
      } as unknown as Tool["inputSchema"],
      execute: async () => {
        await Promise.resolve();
        return ok({
          status: "authenticated",
          token: "secret-session-token-xyz",
          userId: "user-42",
        });
      },
    };
    registry.register(mockAuthTool);

    const toolExecutor = new ToolExecutor(registry);
    const actionExecutor = new ToolActionExecutor(toolExecutor);

    const planner = new DeterministicPlanner((state: AgentState) => {
      if (state.iteration === 0) {
        return ok<ActionDecision>({
          type: "execute",
          action: {
            name: "auth_service",
            payload: {
              username: "admin",
              password: "super-secret-password-123",
              apiKey: "key-999-secret",
            },
          },
        });
      }
      return ok<ActionDecision>({
        type: "complete",
        summary: "Session created",
      });
    });

    const service = new AgentRunService(repository, undefined, {
      planner,
      executor: actionExecutor,
      stepDelayMs: 1,
    });

    const createRes = await service.createRun({ goal: "Authenticate session" });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;

    const testRunId = createRes.value.run.id;
    await service.awaitRunCompletion(testRunId, 5000);

    const run = await repository.findById(testRunId);
    expect(run?.status).toBe("completed");

    // Verify timeline events
    const events = await repository.findEvents(testRunId);
    const toolEvent = events.find((e) => e.type === "tool_invoked");
    expect(toolEvent).toBeDefined();

    // Verify payload hygiene: password, apiKey, and returned token are [REDACTED]
    const metadata = toolEvent?.metadata as {
      actionName: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    };

    expect(metadata.actionName).toBe("auth_service");
    expect(metadata.input["username"]).toBe("admin");
    expect(metadata.input["password"]).toBe("[REDACTED]");
    expect(metadata.input["apiKey"]).toBe("[REDACTED]");
    expect(metadata.output["status"]).toBe("authenticated");
    expect(metadata.output["userId"]).toBe("user-42");
    expect(metadata.output["token"]).toBe("[REDACTED]");
  });
});
