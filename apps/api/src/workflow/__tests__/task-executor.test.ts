import { taskId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import type { IActionExecutor } from "../../agent/action.js";
import { DeterministicPlanner } from "../../agent/planner.js";
import { AgentRuntime } from "../../agent/runtime.js";
import type { AgentState } from "../../agent/state.js";
import { WorkflowTaskExecutor } from "../task-executor.js";
import type { TaskExecutionInput } from "../types.js";

describe("WorkflowTaskExecutor", () => {
  describe("Default execution", () => {
    it("executes a basic task and produces successful output", async () => {
      const executor = new WorkflowTaskExecutor();

      const input: TaskExecutionInput = {
        taskId: taskId("task-1"),
        name: "Analyze Goal",
        description: "Parse execution scope",
        staticInput: { topic: "distributed-systems" },
        dependencyOutputs: {},
      };

      const result = await executor.execute(input);

      expect(result.taskId).toBe("task-1");
      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("incorporates dependency outputs into task execution", async () => {
      const executor = new WorkflowTaskExecutor();

      const input: TaskExecutionInput = {
        taskId: taskId("task-2"),
        name: "Synthesize Findings",
        description: "Synthesize upstream outputs",
        dependencyOutputs: {
          [taskId("task-1")]: "Analysis: 3 nodes ready",
        },
      };

      const result = await executor.execute(input);

      expect(result.success).toBe(true);
      expect(result.output).toContain("task-1");
    });
  });

  describe("Direct ToolAction execution", () => {
    it("executes declared tool action through IActionExecutor", async () => {
      const mockActionExecutor: IActionExecutor = {
        execute: async (action) => ({
          ok: true,
          value: {
            actionName: action.name,
            success: true,
            data: `Echoed: ${JSON.stringify(action.payload)}`,
            durationMs: 5,
            timestamp: new Date().toISOString(),
          },
        }),
      };

      const executor = new WorkflowTaskExecutor({
        actionExecutor: mockActionExecutor,
      });

      const input: TaskExecutionInput = {
        taskId: taskId("tool-task"),
        name: "Invoke Echo",
        description: "Run echo tool",
        staticInput: {
          tool: "echo",
          payload: { message: "Hello Aegis" },
        },
        dependencyOutputs: {
          [taskId("prev")]: "previous result",
        },
      };

      const result = await executor.execute(input);

      expect(result.success).toBe(true);
      expect(result.output).toContain("Hello Aegis");
      expect(result.output).toContain("previous result");
    });

    it("captures tool failure and returns clean error without throwing", async () => {
      const mockFailingExecutor: IActionExecutor = {
        execute: async (action) => ({
          ok: true,
          value: {
            actionName: action.name,
            success: false,
            error: "Tool parameter validation failed",
            durationMs: 2,
            timestamp: new Date().toISOString(),
          },
        }),
      };

      const executor = new WorkflowTaskExecutor({
        actionExecutor: mockFailingExecutor,
      });

      const input: TaskExecutionInput = {
        taskId: taskId("failing-task"),
        name: "Invalid Tool Call",
        description: "Call tool with bad args",
        staticInput: {
          tool: "calculate",
          payload: { expression: "divide-by-zero" },
        },
        dependencyOutputs: {},
      };

      const result = await executor.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Tool parameter validation failed");
      expect(result.output).toBeUndefined();
    });
  });

  describe("Custom AgentRuntime integration", () => {
    it("delegates to custom AgentRuntime and captures failure decision", async () => {
      const failingPlanner = new DeterministicPlanner((_state: AgentState) => ({
        ok: true,
        value: {
          type: "fail",
          reason: "Planner determined goal cannot be satisfied",
        },
      }));

      const mockActionExecutor: IActionExecutor = {
        execute: async () => ({
          ok: true,
          value: {
            actionName: "noop",
            success: true,
            durationMs: 0,
            timestamp: new Date().toISOString(),
          },
        }),
      };

      const customRuntime = new AgentRuntime(failingPlanner, mockActionExecutor, {
        maxIterations: 3,
      });

      const executor = new WorkflowTaskExecutor({
        agentRuntime: customRuntime,
      });

      const input: TaskExecutionInput = {
        taskId: taskId("agent-fail"),
        name: "Impossible Task",
        description: "Do impossible work",
        dependencyOutputs: {},
      };

      const result = await executor.execute(input);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Planner determined goal cannot be satisfied");
    });
  });

  describe("Cancellation handling", () => {
    it("returns immediate cancellation if abortSignal is already aborted", async () => {
      const executor = new WorkflowTaskExecutor();
      const controller = new AbortController();
      controller.abort("User cancelled before task start");

      const input: TaskExecutionInput = {
        taskId: taskId("aborted-task"),
        name: "Aborted Task",
        description: "Should not execute",
        dependencyOutputs: {},
      };

      const result = await executor.execute(input, controller.signal);

      expect(result.success).toBe(false);
      expect(result.error).toBe("User cancelled before task start");
    });
  });
});
