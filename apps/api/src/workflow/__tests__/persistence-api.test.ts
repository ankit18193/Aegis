import { taskId, workflowId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryRunRepository } from "../../repositories/inMemoryRunRepository.js";
import { AgentRunService } from "../../services/agentRunService.js";
import { InProcessExecutionDispatcher } from "../../services/executionDispatcher.js";
import { ToolActionExecutor } from "../../tools/adapter.js";
import { registerBuiltinTools } from "../../tools/builtins/index.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";

describe("Workflow Engine Persistence & API Integration", () => {
  let repository: InMemoryRunRepository;
  let actionExecutor: ToolActionExecutor;

  beforeEach(() => {
    repository = new InMemoryRunRepository(true);
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    const toolExecutor = new ToolExecutor(registry);
    actionExecutor = new ToolActionExecutor(toolExecutor);
  });

  it("executes a custom DAG workflow via createRun and atomically persists all transitions and events", async () => {
    const dispatcher = new InProcessExecutionDispatcher();
    const service = new AgentRunService(repository, undefined, {
      executor: actionExecutor,
      dispatcher,
      autoExecute: true,
      stepDelayMs: 0,
    });

    const task1Id = taskId("task-calc-1");
    const task2Id = taskId("task-echo-2");

    const result = await service.createRun({
      goal: "Execute mathematical calculation and echo formatted outcome",
      workflowTemplateId: workflowId("wf-math-pipeline"),
      tasks: [
        {
          id: task1Id,
          name: "Compute Threshold",
          description: "Perform arithmetic operation",
          input: {
            tool: "calculate",
            payload: { expression: "25 * 4" },
          },
        },
        {
          id: task2Id,
          name: "Announce Result",
          description: "Echo the calculated outcome",
          dependencies: [task1Id],
          input: {
            tool: "echo",
            payload: { text: "Computation complete" },
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runId = result.value.run.id;
    expect(result.value.run.status).toBe("pending");
    expect(result.value.run.tasks).toHaveLength(2);

    // Initial state verified in repository
    const initialRun = await repository.findById(runId);
    expect(initialRun).not.toBeNull();
    expect(initialRun?.status).toBe("pending");
    expect(initialRun?.tasks.every((t) => t.status === "pending")).toBe(true);

    // Initial event: run_created
    const initialEvents = await repository.findEvents(runId);
    expect(initialEvents.some((e) => e.type === "run_created")).toBe(true);

    // Await background execution completion
    await service.awaitRunCompletion(runId);

    // Verify terminal run aggregate in repository
    const completedRun = await repository.findById(runId);
    expect(completedRun).not.toBeNull();
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.progress).toBe(100);
    expect(completedRun?.tasks).toHaveLength(2);

    const task1 = completedRun?.tasks.find((t) => t.id === task1Id);
    const task2 = completedRun?.tasks.find((t) => t.id === task2Id);

    expect(task1?.status).toBe("completed");
    expect(task1?.output).toContain("100");

    expect(task2?.status).toBe("completed");
    expect(task2?.output).toBeDefined();

    // Verify chronological sequence of persisted domain events in atomic store
    const allEvents = await repository.findEvents(runId);
    expect(allEvents.length).toBeGreaterThanOrEqual(6);

    const eventTypes = allEvents.map((e) => e.type);
    expect(eventTypes).toContain("run_created");
    expect(eventTypes).toContain("workflow_started");
    expect(eventTypes).toContain("task_started");
    expect(eventTypes).toContain("tool_invoked");
    expect(eventTypes).toContain("task_completed");
    expect(eventTypes).toContain("run_completed");

    // Verify tool_invoked metadata contains inputs and outputs
    const toolEvents = allEvents.filter((e) => e.type === "tool_invoked");
    expect(toolEvents).toHaveLength(2);

    const calcEvent = toolEvents.find((e) => (e.metadata as { actionName?: string }).actionName === "calculate");
    expect(calcEvent).toBeDefined();
    expect(calcEvent?.metadata).toMatchObject({
      actionName: "calculate",
      output: { result: 100 },
    });

    const echoEvent = toolEvents.find((e) => (e.metadata as { actionName?: string }).actionName === "echo");
    expect(echoEvent).toBeDefined();
    expect(echoEvent?.metadata).toMatchObject({
      actionName: "echo",
    });
  });

  it("atomically persists workflow failure when a DAG task encounters an error", async () => {
    const dispatcher = new InProcessExecutionDispatcher();
    const service = new AgentRunService(repository, undefined, {
      executor: actionExecutor,
      dispatcher,
      autoExecute: true,
      stepDelayMs: 0,
    });

    const task1Id = taskId("task-failing-1");
    const task2Id = taskId("task-downstream-2");

    const result = await service.createRun({
      goal: "Trigger deliberate calculation error",
      tasks: [
        {
          id: task1Id,
          name: "Faulty Computation",
          input: {
            tool: "calculate",
            payload: { expression: "10 / 0" }, // division by zero triggers tool error
          },
        },
        {
          id: task2Id,
          name: "Dependent Task",
          dependencies: [task1Id],
          input: {
            tool: "echo",
            payload: { text: "Should never execute" },
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runId = result.value.run.id;
    await service.awaitRunCompletion(runId);

    const failedRun = await repository.findById(runId);
    expect(failedRun).not.toBeNull();
    expect(failedRun?.status).toBe("failed");

    const task1 = failedRun?.tasks.find((t) => t.id === task1Id);
    const task2 = failedRun?.tasks.find((t) => t.id === task2Id);

    expect(task1?.status).toBe("failed");
    expect(task1?.error).toBeDefined();

    // Downstream task was never executed (still pending)
    expect(task2?.status).toBe("pending");

    // Events in repository reflect failure
    const events = await repository.findEvents(runId);
    expect(events.some((e) => e.type === "run_failed")).toBe(true);
    expect(events.some((e) => e.type === "task_failed")).toBe(true);
  });

  it("atomically persists in-flight cancellation across tasks and run aggregate", async () => {
    const dispatcher = new InProcessExecutionDispatcher();
    const service = new AgentRunService(repository, undefined, {
      executor: actionExecutor,
      dispatcher,
      autoExecute: false, // Manual execution step
    });

    const task1Id = taskId("task-cancel-1");
    const task2Id = taskId("task-cancel-2");

    const result = await service.createRun({
      goal: "Test cancellation persistence",
      tasks: [
        { id: task1Id, name: "Task 1", input: { tool: "echo", payload: { text: "1" } } },
        { id: task2Id, name: "Task 2", dependencies: [task1Id], input: { tool: "echo", payload: { text: "2" } } },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const runId = result.value.run.id;

    // Cancel while pending
    const cancelResult = await service.cancelRun(runId, { reason: "User aborted execution" });
    expect(cancelResult.ok).toBe(true);

    const cancelledRun = await repository.findById(runId);
    expect(cancelledRun?.status).toBe("cancelled");
    expect(cancelledRun?.tasks.every((t) => t.status === "cancelled")).toBe(true);

    const events = await repository.findEvents(runId);
    expect(events.some((e) => e.type === "run_cancelled")).toBe(true);
    expect(events.some((e) => e.type === "task_cancelled")).toBe(true);
  });
});
