/**
 * Comprehensive Integration Test Suite for Aegis Phase 9 — Workflow Engine.
 * Formally verifies all 28 required behavioral scenarios:
 *
 *  1. Valid single-task workflow
 *  2. Multi-task linear workflow
 *  3. Fan-out workflow (A -> B, C)
 *  4. Fan-in workflow (B, C -> D)
 *  5. Diamond DAG (A -> B, C -> D)
 *  6. Independent tasks
 *  7. Unknown dependency
 *  8. Duplicate task ID
 *  9. Self dependency
 * 10. Direct cycle
 * 11. Indirect cycle
 * 12. Initial readiness
 * 13. Dependency completion
 * 14. Dependency failure
 * 15. Downstream blocking
 * 16. Workflow completion
 * 17. Workflow failure
 * 18. Workflow cancellation
 * 19. Active task cancellation
 * 20. Terminal-state protection
 * 21. Deterministic ready-task ordering
 * 22. Task output propagation
 * 23. Invalid task input
 * 24. Tool execution failure
 * 25. MCP-backed tool execution through existing Phase 8 pipeline
 * 26. Atomic event and state persistence in run repository
 * 27. Existing API regression (POST /runs, GET /runs/:id, POST /runs/:id/cancel)
 * 28. Existing Phase 1–8 regression
 */

import { runId, taskId, workflowId } from "@aegis/types";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DefaultActionExecutor } from "../../agent/action.js";
import { DeterministicPlanner } from "../../agent/planner.js";
import type { CreateRunProps } from "../../domain/run.js";
import { ExecutionRun } from "../../domain/run.js";
import { TaskEntity } from "../../domain/task.js";
import { McpToolAdapter } from "../../mcp/adapter.js";
import { McpClient } from "../../mcp/client.js";
import type { McpServerConfig } from "../../mcp/types.js";
import { InMemoryRunRepository } from "../../repositories/inMemoryRunRepository.js";
import { AgentRunService } from "../../services/agentRunService.js";
import { InProcessExecutionDispatcher } from "../../services/executionDispatcher.js";
import { ToolActionExecutor } from "../../tools/adapter.js";
import { registerBuiltinTools } from "../../tools/builtins/index.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { DependencyResolver } from "../dependency-resolver.js";
import { WorkflowEngine } from "../engine.js";
import { WorkflowScheduler } from "../scheduler.js";
import { WorkflowTaskExecutor } from "../task-executor.js";
import type { ITaskExecutor, WorkflowDefinition } from "../types.js";
import { validateWorkflowDefinition } from "../validation.js";

function mustCreateRun(props: CreateRunProps): ExecutionRun {
  const res = ExecutionRun.create(props);
  if (!res.ok) {
    throw new Error(res.error.message);
  }
  return res.value;
}

describe("Aegis Phase 9 — 28 Comprehensive Integration Scenarios", () => {
  const engine = new WorkflowEngine();

  // ───────────────────────────────────────────────────────────────────────────
  // Scenarios 1–11: Graph Topologies & Definition Invariants
  // ───────────────────────────────────────────────────────────────────────────

  describe("Scenarios 1-11: Graph Topologies & Definition Invariants", () => {
    it("Scenario 1: Valid single-task workflow executes to completion", async () => {
      const task = TaskEntity.create({ id: taskId("T1"), name: "Single Task" });
      const run = mustCreateRun({
        id: runId("run-sc-1"),
        goal: "Single task goal",
        workflow: { id: workflowId("wf-1"), name: "Single" },
        tasks: [task],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-1"),
        name: "Single",
        tasks: [{ id: taskId("T1"), name: "Single Task" }],
      };

      const result = await engine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(run.status).toBe("completed");
      expect(run.getTask("T1")?.status).toBe("completed");
    });

    it("Scenario 2: Multi-task linear workflow (A -> B -> C) executes in sequence", async () => {
      const executionOrder: string[] = [];
      const executor: ITaskExecutor = {
        execute: async (input) => {
          await Promise.resolve();
          executionOrder.push(input.taskId);
          return { taskId: input.taskId, success: true, durationMs: 1 };
        },
      };
      const linearEngine = new WorkflowEngine({ taskExecutor: executor });

      const tA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });
      const tC = TaskEntity.create({ id: taskId("C"), name: "Task C", dependencies: [taskId("B")] });

      const run = mustCreateRun({
        id: runId("run-sc-2"),
        goal: "Linear goal",
        workflow: { id: workflowId("wf-2"), name: "Linear" },
        tasks: [tA, tB, tC],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-2"),
        name: "Linear",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("B")] },
        ],
      };

      const result = await linearEngine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(executionOrder).toEqual(["A", "B", "C"]);
      expect(run.status).toBe("completed");
    });

    it("Scenario 3: Fan-out workflow (A -> B, C) triggers parallel dependents", async () => {
      const tA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });
      const tC = TaskEntity.create({ id: taskId("C"), name: "Task C", dependencies: [taskId("A")] });

      const run = mustCreateRun({
        id: runId("run-sc-3"),
        goal: "Fan-out goal",
        workflow: { id: workflowId("wf-3"), name: "Fan-out" },
        tasks: [tA, tB, tC],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-3"),
        name: "Fan-out",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("A")] },
        ],
      };

      const result = await engine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(run.status).toBe("completed");
      expect(run.getTask("B")?.status).toBe("completed");
      expect(run.getTask("C")?.status).toBe("completed");
    });

    it("Scenario 4: Fan-in workflow (B, C -> D) waits until all parents complete", async () => {
      const tB = TaskEntity.create({ id: taskId("B"), name: "Task B" });
      const tC = TaskEntity.create({ id: taskId("C"), name: "Task C" });
      const tD = TaskEntity.create({ id: taskId("D"), name: "Task D", dependencies: [taskId("B"), taskId("C")] });

      const run = mustCreateRun({
        id: runId("run-sc-4"),
        goal: "Fan-in goal",
        workflow: { id: workflowId("wf-4"), name: "Fan-in" },
        tasks: [tB, tC, tD],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-4"),
        name: "Fan-in",
        tasks: [
          { id: taskId("B"), name: "Task B" },
          { id: taskId("C"), name: "Task C" },
          { id: taskId("D"), name: "Task D", dependencies: [taskId("B"), taskId("C")] },
        ],
      };

      const result = await engine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(run.status).toBe("completed");
      expect(run.getTask("D")?.status).toBe("completed");
    });

    it("Scenario 5: Diamond DAG (A -> B, C -> D) executes to completion", async () => {
      const executed: string[] = [];
      const executor: ITaskExecutor = {
        execute: async (input) => {
          await Promise.resolve();
          executed.push(input.taskId);
          return { taskId: input.taskId, success: true, durationMs: 1 };
        },
      };
      const diamondEngine = new WorkflowEngine({ taskExecutor: executor });

      const tA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });
      const tC = TaskEntity.create({ id: taskId("C"), name: "Task C", dependencies: [taskId("A")] });
      const tD = TaskEntity.create({ id: taskId("D"), name: "Task D", dependencies: [taskId("B"), taskId("C")] });

      const run = mustCreateRun({
        id: runId("run-sc-5"),
        goal: "Diamond DAG",
        workflow: { id: workflowId("wf-5"), name: "Diamond" },
        tasks: [tA, tB, tC, tD],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-5"),
        name: "Diamond",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("A")] },
          { id: taskId("D"), name: "Task D", dependencies: [taskId("B"), taskId("C")] },
        ],
      };

      const result = await diamondEngine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(executed[0]).toBe("A");
      expect(executed[executed.length - 1]).toBe("D");
      expect(run.status).toBe("completed");
    });

    it("Scenario 6: Independent disconnected tasks all execute", async () => {
      const t1 = TaskEntity.create({ id: taskId("T1"), name: "T1" });
      const t2 = TaskEntity.create({ id: taskId("T2"), name: "T2" });

      const run = mustCreateRun({
        id: runId("run-sc-6"),
        goal: "Independent tasks",
        workflow: { id: workflowId("wf-6"), name: "Independent" },
        tasks: [t1, t2],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-6"),
        name: "Independent",
        tasks: [
          { id: taskId("T1"), name: "T1" },
          { id: taskId("T2"), name: "T2" },
        ],
      };

      const result = await engine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(run.status).toBe("completed");
    });

    it("Scenario 7: Rejects unknown dependency", () => {
      const def: WorkflowDefinition = {
        id: workflowId("wf-7"),
        name: "Unknown Dep",
        tasks: [
          { id: taskId("A"), name: "Task A", dependencies: [taskId("GHOST")] },
        ],
      };
      const res = validateWorkflowDefinition(def);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_DEPENDENCY");
      }
    });

    it("Scenario 8: Rejects duplicate task ID", () => {
      const def: WorkflowDefinition = {
        id: workflowId("wf-8"),
        name: "Dup ID",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("A"), name: "Task A duplicate" },
        ],
      };
      const res = validateWorkflowDefinition(def);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_WORKFLOW");
      }
    });

    it("Scenario 9: Rejects self-dependency", () => {
      const def: WorkflowDefinition = {
        id: workflowId("wf-9"),
        name: "Self Dep",
        tasks: [
          { id: taskId("A"), name: "Task A", dependencies: [taskId("A")] },
        ],
      };
      const res = validateWorkflowDefinition(def);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_DEPENDENCY");
      }
    });

    it("Scenario 10: Rejects direct cycle (A -> B -> A)", () => {
      const def: WorkflowDefinition = {
        id: workflowId("wf-10"),
        name: "Direct Cycle",
        tasks: [
          { id: taskId("A"), name: "Task A", dependencies: [taskId("B")] },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
        ],
      };
      const res = validateWorkflowDefinition(def);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("CYCLE_DETECTED");
      }
    });

    it("Scenario 11: Rejects indirect cycle (A -> B -> C -> A)", () => {
      const def: WorkflowDefinition = {
        id: workflowId("wf-11"),
        name: "Indirect Cycle",
        tasks: [
          { id: taskId("A"), name: "Task A", dependencies: [taskId("C")] },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
          { id: taskId("C"), name: "Task C", dependencies: [taskId("B")] },
        ],
      };
      const res = validateWorkflowDefinition(def);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("CYCLE_DETECTED");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenarios 12–15, 21, 22: Readiness, Ordering & Data Flow
  // ───────────────────────────────────────────────────────────────────────────

  describe("Scenarios 12-15, 21, 22: Readiness, Ordering & Data Flow", () => {
    const scheduler = new WorkflowScheduler();
    const resolver = new DependencyResolver();

    it("Scenario 12: Initial readiness marks roots ready and dependents waiting", () => {
      const tA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });

      const report = scheduler.getReadinessReport([tA, tB]);
      expect(report.readyTasks.map((t) => t.id)).toEqual(["A"]);
      expect(report.waitingTasks.map((t) => t.id)).toEqual(["B"]);
      expect(report.blockedTasks).toHaveLength(0);
    });

    it("Scenario 13: Dependency completion transitions waiting task to ready", () => {
      const tA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });

      tA.markQueued();
      tA.start();
      tA.complete("A finished");

      const report = scheduler.getReadinessReport([tA, tB]);
      expect(report.readyTasks.map((t) => t.id)).toEqual(["B"]);
      expect(report.waitingTasks).toHaveLength(0);
    });

    it("Scenario 14: Dependency failure marks downstream dependent blocked", () => {
      const tA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });

      tA.markQueued();
      tA.start();
      tA.fail("A failed");

      const report = scheduler.getReadinessReport([tA, tB]);
      expect(report.blockedTasks).toHaveLength(1);
      expect(report.blockedTasks[0]?.task.id).toBe("B");
      expect(scheduler.isWorkflowFailed([tA, tB])).toBe(true);
    });

    it("Scenario 15: Downstream blocking prevents dependent execution", async () => {
      let taskBExecuted = false;
      const executor: ITaskExecutor = {
        execute: async (input) => {
          await Promise.resolve();
          if (input.taskId === "A") {
            return { taskId: input.taskId, success: false, error: "Task A crashed", durationMs: 1 };
          }
          if (input.taskId === "B") {
            taskBExecuted = true;
          }
          return { taskId: input.taskId, success: true, durationMs: 1 };
        },
      };
      const failingEngine = new WorkflowEngine({ taskExecutor: executor });

      const tA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "B", dependencies: [taskId("A")] });

      const run = mustCreateRun({
        id: runId("run-sc-15"),
        goal: "Downstream blocking test",
        workflow: { id: workflowId("wf-15"), name: "Blocking" },
        tasks: [tA, tB],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-15"),
        name: "Blocking",
        tasks: [
          { id: taskId("A"), name: "A" },
          { id: taskId("B"), name: "B", dependencies: [taskId("A")] },
        ],
      };

      const result = await failingEngine.execute(def, run);
      expect(result.ok).toBe(false);
      expect(taskBExecuted).toBe(false);
      expect(run.status).toBe("failed");
      expect(run.getTask("B")?.status).toBe("pending");
    });

    it("Scenario 21: Deterministic ready-task ordering by TaskId tie-breaker (LOCK 3)", () => {
      // Create unsorted ready tasks: Z, M, A, B
      const tZ = TaskEntity.create({ id: taskId("Z"), name: "Z" });
      const tM = TaskEntity.create({ id: taskId("M"), name: "M" });
      const tA = TaskEntity.create({ id: taskId("A"), name: "A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "B" });

      const report = scheduler.getReadinessReport([tZ, tM, tA, tB]);
      expect(report.readyTasks.map((t) => t.id)).toEqual(["A", "B", "M", "Z"]);
    });

    it("Scenario 22: Canonical task output propagation across dependencies", () => {
      const tA = TaskEntity.create({ id: taskId("A"), name: "A" });
      tA.markQueued();
      tA.start();
      tA.complete("{\"processedRecords\": 42}");

      const tB = TaskEntity.create({
        id: taskId("B"),
        name: "B",
        dependencies: [taskId("A")],
        input: { format: "csv" },
      });

      const res = resolver.resolveExecutionInput(tB, [tA, tB]);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.dependencyOutputs[taskId("A")]).toBe("{\"processedRecords\": 42}");
        expect(res.value.staticInput).toEqual({ format: "csv" });
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenarios 16–20: Lifecycle, Cancellation & Terminal States
  // ───────────────────────────────────────────────────────────────────────────

  describe("Scenarios 16-20: Lifecycle, Cancellation & Terminal States", () => {
    it("Scenario 16: Workflow completion transitions run to completed with 100 progress", async () => {
      const task = TaskEntity.create({ id: taskId("T1"), name: "T1" });
      const run = mustCreateRun({
        id: runId("run-sc-16"),
        goal: "Completion test",
        workflow: { id: workflowId("wf-16"), name: "Complete" },
        tasks: [task],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-16"),
        name: "Complete",
        tasks: [{ id: taskId("T1"), name: "T1" }],
      };

      const result = await engine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(run.status).toBe("completed");
      expect(run.calculateProgress()).toBe(100);
    });

    it("Scenario 17: Workflow failure aborts execution and marks run failed", async () => {
      const failingExecutor: ITaskExecutor = {
        execute: async () => {
          await Promise.resolve();
          return { taskId: taskId("T1"), success: false, error: "Disk full", durationMs: 1 };
        },
      };
      const failingEngine = new WorkflowEngine({ taskExecutor: failingExecutor });

      const task = TaskEntity.create({ id: taskId("T1"), name: "T1" });
      const run = mustCreateRun({
        id: runId("run-sc-17"),
        goal: "Failure test",
        workflow: { id: workflowId("wf-17"), name: "Failure" },
        tasks: [task],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-17"),
        name: "Failure",
        tasks: [{ id: taskId("T1"), name: "T1" }],
      };

      const result = await failingEngine.execute(def, run);
      expect(result.ok).toBe(false);
      expect(run.status).toBe("failed");
      expect(run.result?.summary).toContain("Disk full");
    });

    it("Scenario 18: Workflow cancellation cancels pending/waiting tasks", async () => {
      const controller = new AbortController();
      controller.abort("User operator cancel");

      const t1 = TaskEntity.create({ id: taskId("T1"), name: "T1" });
      const run = mustCreateRun({
        id: runId("run-sc-18"),
        goal: "Cancel test",
        workflow: { id: workflowId("wf-18"), name: "Cancel" },
        tasks: [t1],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-18"),
        name: "Cancel",
        tasks: [{ id: taskId("T1"), name: "T1" }],
      };

      const result = await engine.execute(def, run, { abortSignal: controller.signal });
      expect(result.ok).toBe(false);
      expect(run.status).toBe("cancelled");
      expect(run.getTask("T1")?.status).toBe("cancelled");
    });

    it("Scenario 19: Active task cancellation stops midway and cascades", async () => {
      const controller = new AbortController();
      const pausingExecutor: ITaskExecutor = {
        execute: async (input, signal) => {
          await Promise.resolve();
          controller.abort("Aborted during task execution");
          if (signal?.aborted) {
            return { taskId: input.taskId, success: false, error: "Aborted", durationMs: 1 };
          }
          return { taskId: input.taskId, success: true, durationMs: 1 };
        },
      };
      const cancelEngine = new WorkflowEngine({ taskExecutor: pausingExecutor });

      const tA = TaskEntity.create({ id: taskId("A"), name: "Task A" });
      const tB = TaskEntity.create({ id: taskId("B"), name: "Task B", dependencies: [taskId("A")] });

      const run = mustCreateRun({
        id: runId("run-sc-19"),
        goal: "Active cancel test",
        workflow: { id: workflowId("wf-19"), name: "ActiveCancel" },
        tasks: [tA, tB],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-19"),
        name: "ActiveCancel",
        tasks: [
          { id: taskId("A"), name: "Task A" },
          { id: taskId("B"), name: "Task B", dependencies: [taskId("A")] },
        ],
      };

      const result = await cancelEngine.execute(def, run, { abortSignal: controller.signal });
      expect(result.ok).toBe(false);
      expect(run.status).toBe("cancelled");
      expect(run.getTask("B")?.status).toBe("cancelled");
    });

    it("Scenario 20: Terminal-state protection prevents mutation of completed/failed runs", async () => {
      const task = TaskEntity.create({ id: taskId("T1"), name: "T1" });
      const run = mustCreateRun({
        id: runId("run-sc-20"),
        goal: "Terminal protection",
        workflow: { id: workflowId("wf-20"), name: "Term" },
        tasks: [task],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-20"),
        name: "Term",
        tasks: [{ id: taskId("T1"), name: "T1" }],
      };

      await engine.execute(def, run);
      expect(run.status).toBe("completed");

      // Attempting to re-execute completed run fails
      const secondExec = await engine.execute(def, run);
      expect(secondExec.ok).toBe(false);

      // Attempting to cancel completed run fails
      const cancelRes = run.cancel("Late cancel");
      expect(cancelRes.ok).toBe(false);
      expect(run.status).toBe("completed");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenarios 23–25: Boundary Execution, Tool & MCP Pipeline
  // ───────────────────────────────────────────────────────────────────────────

  describe("Scenarios 23-25: Boundary Execution, Tool & MCP Pipeline", () => {
    it("Scenario 23: Invalid task input is captured cleanly without crash", async () => {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      const toolExecutor = new ToolExecutor(registry);
      const actionExecutor = new ToolActionExecutor(toolExecutor);
      const taskExecutor = new WorkflowTaskExecutor({ actionExecutor });

      const input = {
        taskId: taskId("invalid-tool-task"),
        name: "Invalid Calculate Input",
        description: "Missing required expression field",
        staticInput: {
          tool: "calculate",
          payload: {}, // Missing expression string
        },
        dependencyOutputs: {},
      };

      const out = await taskExecutor.execute(input);
      expect(out.success).toBe(false);
      expect(out.error).toBeDefined();
    });

    it("Scenario 24: Tool execution failure (division by zero) reports structured error", async () => {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      const toolExecutor = new ToolExecutor(registry);
      const actionExecutor = new ToolActionExecutor(toolExecutor);
      const taskExecutor = new WorkflowTaskExecutor({ actionExecutor });

      const input = {
        taskId: taskId("div-zero-task"),
        name: "Division by zero",
        description: "Executes 10 / 0",
        staticInput: {
          tool: "calculate",
          payload: { expression: "10 / 0" },
        },
        dependencyOutputs: {},
      };

      const out = await taskExecutor.execute(input);
      expect(out.success).toBe(false);
      expect(out.error).toContain("Division by zero");
    });

    it("Scenario 25: MCP-backed tool execution through existing Phase 8 pipeline", async () => {
      // 1. Setup in-memory MCP server with a custom tool
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new McpServer(
        { name: "phase9-mcp-server", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );

      server.registerTool(
        "compute_hash",
        {
          description: "Generates a deterministic hash for a given string",
          inputSchema: { text: z.string() },
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async ({ text }) => ({
          content: [{ type: "text", text: `HASH-${text.toUpperCase()}` }],
        }),
      );

      await server.connect(serverTransport);

      // 2. Connect client and adapt into ToolRegistry
      const mcpConfig: McpServerConfig = {
        id: "hasher",
        name: "Hash Service",
        transport: "memory",
      };
      const client = new McpClient(mcpConfig, { transport: clientTransport });
      await client.connect();

      const tools = await client.listTools();
      const hashToolDef = tools.find((t) => t.name === "compute_hash");
      expect(hashToolDef).toBeDefined();
      if (!hashToolDef) return;

      const adapterRes = McpToolAdapter.create("hasher", hashToolDef, client);
      expect(adapterRes.ok).toBe(true);
      if (!adapterRes.ok) return;

      const registry = new ToolRegistry();
      registry.register(adapterRes.value);

      const toolExecutor = new ToolExecutor(registry);
      const actionExecutor = new ToolActionExecutor(toolExecutor);
      const taskExecutor = new WorkflowTaskExecutor({ actionExecutor });
      const mcpEngine = new WorkflowEngine({ taskExecutor });

      // 3. Execute workflow task targeting the MCP tool
      const toolName = adapterRes.value.name;
      const t1 = TaskEntity.create({
        id: taskId("mcp-task-1"),
        name: "Compute Hash",
        input: {
          tool: toolName,
          payload: { text: "workflow-engine" },
        },
      });

      const run = mustCreateRun({
        id: runId("run-sc-25"),
        goal: "MCP tool execution",
        workflow: { id: workflowId("wf-25"), name: "MCP Workflow" },
        tasks: [t1],
      });
      const def: WorkflowDefinition = {
        id: workflowId("wf-25"),
        name: "MCP Workflow",
        tasks: [
          {
            id: taskId("mcp-task-1"),
            name: "Compute Hash",
            input: {
              tool: toolName,
              payload: { text: "workflow-engine" },
            },
          },
        ],
      };

      const result = await mcpEngine.execute(def, run);
      expect(result.ok).toBe(true);
      expect(run.status).toBe("completed");
      expect(run.getTask("mcp-task-1")?.output).toContain("HASH-WORKFLOW-ENGINE");

      await client.disconnect();
      await server.close();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Scenarios 26–28: Persistence, API & Phase 1–8 Regressions
  // ───────────────────────────────────────────────────────────────────────────

  describe("Scenarios 26-28: Persistence, API & Phase 1–8 Regressions", () => {
    it("Scenario 26: Atomic event and state persistence in run repository", async () => {
      const repository = new InMemoryRunRepository(true);
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      const toolExecutor = new ToolExecutor(registry);
      const actionExecutor = new ToolActionExecutor(toolExecutor);
      const dispatcher = new InProcessExecutionDispatcher();

      const service = new AgentRunService(repository, undefined, {
        executor: actionExecutor,
        dispatcher,
        autoExecute: true,
        stepDelayMs: 0,
      });

      const createRes = await service.createRun({
        goal: "Persistence verification",
        tasks: [
          {
            id: taskId("T1"),
            name: "Calculate",
            input: { tool: "calculate", payload: { expression: "7 * 7" } },
          },
        ],
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const runId = createRes.value.run.id;
      await service.awaitRunCompletion(runId);

      const savedRun = await repository.findById(runId);
      expect(savedRun?.status).toBe("completed");
      expect(savedRun?.tasks[0]?.status).toBe("completed");

      const events = await repository.findEvents(runId);
      expect(events.some((e) => e.type === "run_created")).toBe(true);
      expect(events.some((e) => e.type === "workflow_started")).toBe(true);
      expect(events.some((e) => e.type === "tool_invoked")).toBe(true);
      expect(events.some((e) => e.type === "task_completed")).toBe(true);
      expect(events.some((e) => e.type === "run_completed")).toBe(true);
    });

    it("Scenario 27: Existing API regression (POST /runs, GET /runs/:id, POST /runs/:id/cancel)", async () => {
      const repository = new InMemoryRunRepository(true);
      const service = new AgentRunService(repository, undefined, { autoExecute: false });

      // 1. POST /runs
      const createRes = await service.createRun({
        goal: "Test API CRUD contracts",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const runId = createRes.value.run.id;
      expect(createRes.value.run.status).toBe("pending");

      // 2. GET /runs/:id
      const getRes = await service.getRun(runId);
      expect(getRes.ok).toBe(true);
      if (getRes.ok) {
        expect(getRes.value.run.id).toBe(runId);
      }

      // 3. POST /runs/:id/cancel
      const cancelRes = await service.cancelRun(runId, { reason: "API cancellation" });
      expect(cancelRes.ok).toBe(true);
      if (cancelRes.ok) {
        expect(cancelRes.value.run.status).toBe("cancelled");
      }
    });

    it("Scenario 28: Existing Phase 1–8 regression: default 4-task execution with AgentRuntime", async () => {
      const repository = new InMemoryRunRepository(true);
      const planner = new DeterministicPlanner([
        { type: "execute", action: { name: "echo", payload: { text: "phase 6-8 compat" } } },
        { type: "complete", summary: "Compatible execution done" },
      ]);
      const executor = new DefaultActionExecutor();
      const dispatcher = new InProcessExecutionDispatcher();

      const service = new AgentRunService(repository, undefined, {
        planner,
        executor,
        dispatcher,
        autoExecute: true,
        stepDelayMs: 0,
      });

      const createRes = await service.createRun({
        goal: "Run autonomous 4-task plan with planner",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const runId = createRes.value.run.id;
      await service.awaitRunCompletion(runId);

      const run = await repository.findById(runId);
      expect(run?.status).toBe("completed");
      expect(run?.tasks).toHaveLength(4);
      expect(run?.tasks.every((t) => t.status === "completed")).toBe(true);

      const events = await repository.findEvents(runId);
      expect(events.some((e) => e.type === "tool_invoked")).toBe(true);
      expect(events.some((e) => e.type === "run_completed")).toBe(true);
    });
  });
});
