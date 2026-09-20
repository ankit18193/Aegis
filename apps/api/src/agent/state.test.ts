import { runId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { AgentState } from "./state.js";

describe("AgentState Primitive", () => {
  const testRunId = runId("run-test-001");
  const testGoal = "Inspect network topology for latency anomalies";

  it("initializes with turn 0, idle status, and empty history", () => {
    const state = AgentState.init(testRunId, testGoal, { env: "staging" });

    expect(state.runId).toBe(testRunId);
    expect(state.goal).toBe(testGoal);
    expect(state.iteration).toBe(0);
    expect(state.status).toBe("idle");
    expect(state.context).toEqual({ env: "staging" });
    expect(state.history).toHaveLength(0);
    expect(state.isTerminal()).toBe(false);
    expect(state.termination).toBeUndefined();
  });

  it("increments iterations sequentially", () => {
    const state = AgentState.init(testRunId, testGoal);

    expect(state.incrementIteration()).toBe(1);
    expect(state.iteration).toBe(1);
    expect(state.incrementIteration()).toBe(2);
    expect(state.iteration).toBe(2);
  });

  it("updates context immutably", () => {
    const state = AgentState.init(testRunId, testGoal, { initialKey: 42 });
    state.updateContext({ secondaryKey: "active" });

    expect(state.context).toEqual({
      initialKey: 42,
      secondaryKey: "active",
    });
  });

  it("records execution turns in history", () => {
    const state = AgentState.init(testRunId, testGoal);
    state.incrementIteration();

    state.recordTurn(
      { name: "echo", payload: { text: "hello" } },
      {
        actionName: "echo",
        success: true,
        data: { echoed: "hello" },
        durationMs: 5,
        timestamp: "2026-09-20T12:00:00.000Z",
      },
    );

    expect(state.history).toHaveLength(1);
    expect(state.history[0]?.iteration).toBe(1);
    expect(state.history[0]?.action.name).toBe("echo");
    expect(state.history[0]?.observation.success).toBe(true);
  });

  it("transitions to completed and enforces terminal immutability", () => {
    const state = AgentState.init(testRunId, testGoal);
    state.incrementIteration();
    state.markCompleted("All tasks executed", "Report text", "2026-09-20T12:00:00.000Z");

    expect(state.status).toBe("completed");
    expect(state.isTerminal()).toBe(true);
    expect(state.termination?.reason).toBe("All tasks executed");
    expect(state.termination?.output).toBe("Report text");

    // Terminal immutability checks: mutations are ignored
    state.setStatus("planning");
    expect(state.status).toBe("completed");

    state.incrementIteration();
    expect(state.iteration).toBe(1);

    state.updateContext({ shouldNotApply: true });
    expect(state.context["shouldNotApply"]).toBeUndefined();

    state.markFailed("Should not overwrite terminal state");
    expect(state.status).toBe("completed");
  });

  it("transitions to failed with reason and error", () => {
    const state = AgentState.init(testRunId, testGoal);
    state.incrementIteration();
    state.markFailed("Timeout occurred", "Max iterations exceeded");

    expect(state.status).toBe("failed");
    expect(state.isTerminal()).toBe(true);
    expect(state.termination?.reason).toBe("Timeout occurred");
    expect(state.termination?.error).toBe("Max iterations exceeded");
  });

  it("transitions to cancelled", () => {
    const state = AgentState.init(testRunId, testGoal);
    state.markCancelled("Operator requested halt");

    expect(state.status).toBe("cancelled");
    expect(state.isTerminal()).toBe(true);
    expect(state.termination?.reason).toBe("Operator requested halt");
  });

  it("serializes to snapshot and reconstitutes faithfully", () => {
    const original = AgentState.init(testRunId, testGoal, { target: "infra" });
    original.incrementIteration();
    original.recordTurn(
      { name: "noop", payload: {} },
      {
        actionName: "noop",
        success: true,
        durationMs: 1,
        timestamp: "2026-09-20T12:00:00.000Z",
      },
    );
    original.markCompleted("Done");

    const snapshot = original.toSnapshot();
    const reconstituted = AgentState.reconstitute(snapshot);

    expect(reconstituted.runId).toBe(original.runId);
    expect(reconstituted.goal).toBe(original.goal);
    expect(reconstituted.iteration).toBe(original.iteration);
    expect(reconstituted.status).toBe(original.status);
    expect(reconstituted.context).toEqual(original.context);
    expect(reconstituted.history).toEqual(original.history);
    expect(reconstituted.termination).toEqual(original.termination);
  });
});
