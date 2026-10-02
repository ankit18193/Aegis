import { workerId } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerLivenessMonitor } from "../livenessMonitor.js";
import { InMemoryWorkerRegistry } from "../workerRegistry.js";

describe("WorkerLivenessMonitor", () => {
  const worker1 = workerId("worker-live-1");
  let registry: InMemoryWorkerRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 10000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("periodically triggers registry.markStale and executes onWorkerStale callback", async () => {
    const onStale = vi.fn();
    const monitor = new WorkerLivenessMonitor({
      registry,
      evaluationIntervalMs: 2000,
      heartbeatTimeoutMs: 10000,
      onWorkerStale: onStale,
    });

    registry.register({
      workerId: worker1,
      lifecycleState: "ready",
      presenceState: "HEALTHY",
      capabilities: { taskTypes: ["*"], tools: [], maxConcurrency: 1 },
      activeTaskCount: 0,
      maxConcurrentTasks: 1,
      registeredAt: new Date(1000).toISOString(),
      lastHeartbeatAt: new Date(1000).toISOString(),
    });

    // Start monitor (evaluates once at t=0, lastHeartbeat is at 1000ms -> not stale yet)
    vi.setSystemTime(5000);
    monitor.start();
    expect(monitor.isRunning).toBe(true);
    expect(monitor.evaluationCount).toBe(1);
    expect(onStale).not.toHaveBeenCalled();

    // Advance to t=12000 (elapsed from heartbeat is 11000ms > 10000ms timeout)
    vi.setSystemTime(12000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(monitor.evaluationCount).toBe(2);
    expect(onStale).toHaveBeenCalledWith(worker1);
    expect(registry.get(worker1)?.presenceState).toBe("STALE");

    monitor.stop();
    expect(monitor.isRunning).toBe(false);
  });

  it("safely handles exceptions thrown from onWorkerStale callback", () => {
    const throwingOnStale = vi.fn().mockImplementation(() => {
      throw new Error("Callback exploded");
    });

    const monitor = new WorkerLivenessMonitor({
      registry,
      evaluationIntervalMs: 5000,
      heartbeatTimeoutMs: 5000,
      onWorkerStale: throwingOnStale,
    });

    registry.register({
      workerId: worker1,
      lifecycleState: "ready",
      presenceState: "HEALTHY",
      capabilities: { taskTypes: ["*"], tools: [], maxConcurrency: 1 },
      activeTaskCount: 0,
      maxConcurrentTasks: 1,
      registeredAt: new Date(0).toISOString(),
      lastHeartbeatAt: new Date(0).toISOString(),
    });

    // Custom evaluate with time in the future
    expect(() => {
      monitor.evaluate(new Date(20000));
    }).not.toThrow();

    expect(throwingOnStale).toHaveBeenCalledWith(worker1);
  });

  it("provides status through getStatus()", () => {
    const monitor = new WorkerLivenessMonitor({
      registry,
      evaluationIntervalMs: 1500,
      heartbeatTimeoutMs: 15000,
    });

    let status = monitor.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.evaluationCount).toBe(0);
    expect(status.evaluationIntervalMs).toBe(1500);
    expect(status.heartbeatTimeoutMs).toBe(15000);

    monitor.start();
    status = monitor.getStatus();
    expect(status.isRunning).toBe(true);
    expect(status.evaluationCount).toBe(1);
    expect(status.lastEvaluatedAt).toBeDefined();

    monitor.stop();
    status = monitor.getStatus();
    expect(status.isRunning).toBe(false);
  });
});
