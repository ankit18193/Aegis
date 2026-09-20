import { err, runId } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import { DefaultActionExecutor } from "./action.js";
import { DeterministicPlanner } from "./planner.js";
import { AgentRuntime } from "./runtime.js";
import { AgentState } from "./state.js";

describe("AgentRuntime Loop", () => {
  const createTestState = () =>
    AgentState.init(runId("run-rt-001"), "Analyze edge latency spikes");

  it("executes deterministic Reason -> Action -> Observation loop to completion", async () => {
    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "calculate", payload: { expression: "10 * 5" } } },
      { type: "execute", action: { name: "echo", payload: { text: "Latency bounded" } } },
      { type: "complete", summary: "Completed analysis in 2 steps", output: "Result verified" },
    ]);
    const executor = new DefaultActionExecutor();
    const runtime = new AgentRuntime(planner, executor, { maxIterations: 5 });

    const state = createTestState();
    const result = await runtime.run(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("completed");
    expect(result.value.iterations).toBe(2);
    expect(result.value.summary).toBe("Result verified");
    expect(state.history).toHaveLength(2);
    expect(state.history[0]?.action.name).toBe("calculate");
    expect(state.history[0]?.observation.data).toEqual({ result: 50 });
    expect(state.history[1]?.action.name).toBe("echo");
    expect(state.history[1]?.observation.data).toEqual({ echoed: "Latency bounded" });
  });

  it("halts deterministically when execution exceeds maxIterations", async () => {
    // Planner creates infinite action stream
    const planner = new DeterministicPlanner(() => ({
      ok: true,
      value: { type: "execute", action: { name: "noop", payload: {} } },
    }));
    const executor = new DefaultActionExecutor();
    const runtime = new AgentRuntime(planner, executor, { maxIterations: 3 });

    const state = createTestState();
    const result = await runtime.run(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("failed");
    expect(result.value.iterations).toBe(3);
    expect(state.termination?.reason).toContain("exceeded maximum iterations limit (3)");
  });

  it("handles planner failure cleanly by marking state as failed", async () => {
    const planner = new DeterministicPlanner(() =>
      err({ code: "PLANNER_ERROR", message: "Model inference service degraded" }),
    );
    const executor = new DefaultActionExecutor();
    const runtime = new AgentRuntime(planner, executor, { maxIterations: 5 });

    const state = createTestState();
    const result = await runtime.run(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("failed");
    expect(state.termination?.reason).toContain("Planner failure: Model inference service degraded");
  });

  it("feeds action failure observation back into state for planner course-correction", async () => {
    // Turn 1 fails invalid calculate; Turn 2 observes error and completes
    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "calculate", payload: { expression: "invalid" } } },
      { type: "complete", summary: "Recovered from arithmetic error", output: "Fallback handled" },
    ]);
    const executor = new DefaultActionExecutor();
    const runtime = new AgentRuntime(planner, executor, { maxIterations: 5 });

    const state = createTestState();
    const result = await runtime.run(state);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("completed");
    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.observation.success).toBe(false);
    expect(state.history[0]?.observation.error).toBeDefined();
  });

  it("aborts execution cleanly when AbortSignal is cancelled before start", async () => {
    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "noop", payload: {} } },
    ]);
    const executor = new DefaultActionExecutor();
    const runtime = new AgentRuntime(planner, executor, { maxIterations: 5 });

    const controller = new AbortController();
    controller.abort("Manual user stop");

    const state = createTestState();
    const result = await runtime.run(state, controller.signal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("cancelled");
    expect(state.termination?.reason).toBe("Manual user stop");
    expect(state.history).toHaveLength(0);
  });

  it("aborts execution cleanly when AbortSignal triggers between turns", async () => {
    const controller = new AbortController();
    const onStepHook = vi.fn(() => {
      // Abort during first step
      controller.abort("Operator abort midway");
    });

    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "noop", payload: {} } },
      { type: "execute", action: { name: "noop", payload: {} } },
    ]);
    const executor = new DefaultActionExecutor();
    const runtime = new AgentRuntime(
      planner,
      executor,
      { maxIterations: 5 },
      { onStep: onStepHook },
    );

    const state = createTestState();
    const result = await runtime.run(state, controller.signal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("cancelled");
    expect(state.termination?.reason).toBe("Operator abort midway");
    expect(state.history).toHaveLength(1);
    expect(onStepHook).toHaveBeenCalledTimes(1);
  });

  it("invokes runtime lifecycle hooks correctly", async () => {
    const onStep = vi.fn();
    const onComplete = vi.fn();
    const onFail = vi.fn();

    const planner = new DeterministicPlanner([
      { type: "execute", action: { name: "echo", payload: { text: "hook test" } } },
      { type: "complete", summary: "All done" },
    ]);
    const executor = new DefaultActionExecutor();
    const runtime = new AgentRuntime(
      planner,
      executor,
      { maxIterations: 5 },
      { onStep, onComplete, onFail },
    );

    const state = createTestState();
    await runtime.run(state);

    expect(onStep).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onFail).not.toHaveBeenCalled();
  });
});
