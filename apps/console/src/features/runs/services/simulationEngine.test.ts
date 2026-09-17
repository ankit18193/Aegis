import { beforeEach, describe, expect, it } from "vitest";

import { eventService } from "../../events/services/eventService";

import { mockRunRepository } from "./mockRunRepository";
import { simulationEngine } from "./simulationEngine";

describe("SimulationEngine Deterministic Lifecycle", () => {
  beforeEach(async () => {
    await mockRunRepository.resetToDefaults();
    await eventService.resetEvents();
  });

  it("executes deterministic run lifecycle from pending to completed", async () => {
    const run = await mockRunRepository.createRun({
      goal: "Automated regression verification pipeline",
    });

    expect(run.status).toBe("pending");
    expect(run.progress).toBe(0);

    // Run simulation with ultra-fast step duration for deterministic test speed
    await simulationEngine.startSimulation(run.id, 5);

    const completedRun = await mockRunRepository.getRunById(run.id);
    expect(completedRun).not.toBeNull();
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.progress).toBe(100);
    expect(completedRun?.tasks.every((t) => t.status === "completed")).toBe(true);
    expect(completedRun?.result).toBeDefined();
    expect(completedRun?.result?.summary).toContain("Autonomous agent run completed");

    // Verify events were emitted
    const events = await eventService.getEvents(run.id);
    expect(events.length).toBeGreaterThanOrEqual(5);
    expect(events.some((e) => e.type === "workflow_started")).toBe(true);
    expect(events.some((e) => e.type === "run_completed")).toBe(true);
  });

  it("supports cancelling an active simulation", async () => {
    const run = await mockRunRepository.createRun({
      goal: "Long running execution to cancel",
    });

    // Start simulation with moderate duration and cancel
    void simulationEngine.startSimulation(run.id, 100);
    await new Promise((resolve) => { setTimeout(resolve, 20); });

    await simulationEngine.cancelSimulation(run.id);

    const cancelledRun = await mockRunRepository.getRunById(run.id);
    expect(cancelledRun?.status).toBe("cancelled");

    const events = await eventService.getEvents(run.id);
    expect(events.some((e) => e.type === "run_cancelled")).toBe(true);
  });

  it("resets tasks to pending state upon resetRunTasks", async () => {
    const run = await mockRunRepository.getRunById("run-002"); // already completed in seeds
    expect(run?.status).toBe("completed");

    await simulationEngine.resetRunTasks("run-002");

    const resetRun = await mockRunRepository.getRunById("run-002");
    expect(resetRun?.status).toBe("pending");
    expect(resetRun?.progress).toBe(0);
    expect(resetRun?.tasks.every((t) => t.status === "pending")).toBe(true);
    expect(resetRun?.result).toBeUndefined();
  });
});
