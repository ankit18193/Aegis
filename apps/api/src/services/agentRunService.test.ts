import { runId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import { DefaultActionExecutor } from "../agent/action.js";
import { DeterministicPlanner } from "../agent/planner.js";
import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";

import { AgentRunService } from "./agentRunService.js";
import { InProcessExecutionDispatcher } from "./executionDispatcher.js";

describe("AgentRunService", () => {
  let repository: InMemoryRunRepository;

  beforeEach(() => {
    repository = new InMemoryRunRepository(true);
  });

  it("creates a run in 'pending' status and returns 201 response immediately (API contract compliance)", async () => {
    const service = new AgentRunService(repository, undefined, { autoExecute: false });

    const result = await service.createRun({
      goal: "Inspect edge network telemetry for distributed packet loss spikes",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.run.id).toMatch(/^run-/);
    expect(result.value.run.status).toBe("pending");
    expect(result.value.run.progress).toBe(0);
    expect(result.value.run.tasks).toHaveLength(4);
    expect(result.value.run.tasks.every((t) => t.status === "pending")).toBe(true);
  });

  it("dispatches background execution and completes run with tasks and tool_invoked events", async () => {
    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "calculate", payload: { expression: "12 * 4" } } },
      { type: "complete", summary: "Calculated telemetry threshold", output: "Threshold 48 confirmed" },
    ]);
    const dispatcher = new InProcessExecutionDispatcher();

    const service = new AgentRunService(repository, undefined, {
      planner,
      dispatcher,
      autoExecute: true,
    });

    const result = await service.createRun({
      goal: "Calculate dynamic throttle limit",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const createdId = result.value.run.id;
    expect(result.value.run.status).toBe("pending");

    // Await in-process execution completion
    await service.awaitRunCompletion(createdId);

    // Verify terminal run state in repository
    const completedRun = await repository.findById(createdId);
    expect(completedRun).not.toBeNull();
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.progress).toBe(100);
    expect(completedRun?.tasks).toHaveLength(4);
    expect(completedRun?.tasks.every((t) => t.status === "completed")).toBe(true);

    // Verify events including tool_invoked
    const events = await repository.findEvents(createdId);
    expect(events.some((e) => e.type === "run_created")).toBe(true);
    expect(events.some((e) => e.type === "workflow_started")).toBe(true);
    expect(events.some((e) => e.type === "tool_invoked")).toBe(true);
    expect(events.some((e) => e.type === "run_completed")).toBe(true);

    const toolEvent = events.find((e) => e.type === "tool_invoked");
    expect(toolEvent?.metadata).toEqual({
      actionName: "calculate",
      input: { expression: "12 * 4" },
      output: { result: 48 },
      error: undefined,
    });
  });

  it("handles iteration limit failure deterministically", async () => {
    // Infinite action loop
    const planner = new DeterministicPlanner(() => ({
      ok: true,
      value: { type: "execute", action: { name: "noop", payload: {} } },
    }));
    const dispatcher = new InProcessExecutionDispatcher();

    const service = new AgentRunService(repository, undefined, {
      planner,
      dispatcher,
      policy: { maxIterations: 2 },
      autoExecute: true,
    });

    const result = await service.createRun({
      goal: "Infinite action stream",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await service.awaitRunCompletion(result.value.run.id);

    const failedRun = await repository.findById(result.value.run.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.result?.summary).toContain("exceeded maximum iterations limit (2)");

    const events = await repository.findEvents(result.value.run.id);
    expect(events.some((e) => e.type === "run_failed")).toBe(true);
  });

  it("handles planner failure by marking run and task failed", async () => {
    const planner = new DeterministicPlanner(() => ({
      ok: false,
      error: { code: "PLANNER_ERROR", message: "Out of context window memory" },
    }));
    const dispatcher = new InProcessExecutionDispatcher();

    const service = new AgentRunService(repository, undefined, {
      planner,
      dispatcher,
      autoExecute: true,
    });

    const result = await service.createRun({
      goal: "Triggers planner failure",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await service.awaitRunCompletion(result.value.run.id);

    const failedRun = await repository.findById(result.value.run.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.result?.summary).toContain("Out of context window memory");
  });

  describe("Cancellation Race Invariants ('Terminal Run State Wins')", () => {
    it("cancel-before-start: cancels run in pending state before execution begins", async () => {
      const dispatcher = new InProcessExecutionDispatcher();
      const service = new AgentRunService(repository, undefined, {
        dispatcher,
        autoExecute: false, // Do not auto-execute
      });

      const createResult = await service.createRun({
        goal: "Cancel before start",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const id = createResult.value.run.id;

      // Cancel while pending
      const cancelResult = await service.cancelRun(id, { reason: "Operator cancelled early" });
      expect(cancelResult.ok).toBe(true);
      if (!cancelResult.ok) return;
      expect(cancelResult.value.run.status).toBe("cancelled");

      // Attempting to execute cancelled run should terminate immediately
      await service.executeRun(id);

      const reloaded = await repository.findById(id);
      expect(reloaded?.status).toBe("cancelled");
    });

    it("cancel-during-action: cancels an active run mid-flight and halts execution", async () => {
      let cancelPromiseResolve: () => void;
      const stepTriggered = new Promise<void>((resolve) => {
        cancelPromiseResolve = resolve;
      });

      const planner = new DeterministicPlanner([
        { type: "execute", action: { name: "echo", payload: { text: "first action" } } },
        { type: "execute", action: { name: "echo", payload: { text: "second action" } } },
        { type: "complete", summary: "Should never reach here" },
      ]);
      const dispatcher = new InProcessExecutionDispatcher();

      // Use a custom executor that pauses on first action to allow cancel
      const executor = new DefaultActionExecutor();
      const wrappedExecutor = {
        execute: async (action: Parameters<typeof executor.execute>[0]) => {
          cancelPromiseResolve();
          // Yield to let cancelRun run
          await new Promise((r) => setTimeout(r, 20));
          return executor.execute(action);
        },
      };

      const service = new AgentRunService(repository, undefined, {
        planner,
        executor: wrappedExecutor,
        dispatcher,
        autoExecute: true,
      });

      const createResult = await service.createRun({
        goal: "Cancel mid flight",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const id = createResult.value.run.id;

      // Wait until first step begins
      await stepTriggered;

      // Cancel active run
      await service.cancelRun(id, { reason: "Mid-flight cancellation" });

      // Await dispatcher completion
      await service.awaitRunCompletion(id);

      const cancelledRun = await repository.findById(id);
      expect(cancelledRun?.status).toBe("cancelled");
      expect(cancelledRun?.tasks.every((t) => t.status !== "running")).toBe(true);
    });

    it("cancel-after-completion: returns 409 CONFLICT when attempting to cancel completed run", async () => {
      const planner = new DeterministicPlanner([
        { type: "complete", summary: "Instant complete" },
      ]);
      const dispatcher = new InProcessExecutionDispatcher();

      const service = new AgentRunService(repository, undefined, {
        planner,
        dispatcher,
        autoExecute: true,
      });

      const createResult = await service.createRun({ goal: "Immediate completion" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const id = createResult.value.run.id;
      await service.awaitRunCompletion(id);

      const cancelResult = await service.cancelRun(id, { reason: "Too late" });
      expect(cancelResult.ok).toBe(false);
      if (!cancelResult.ok) {
        expect(cancelResult.error.error.code).toBe("CONFLICT");
      }
    });

    it("returns 404 NOT_FOUND when attempting to cancel non-existent run", async () => {
      const service = new AgentRunService(repository);
      const cancelResult = await service.cancelRun(runId("run-does-not-exist"));

      expect(cancelResult.ok).toBe(false);
      if (!cancelResult.ok) {
        expect(cancelResult.error.error.code).toBe("NOT_FOUND");
      }
    });
  });
});
