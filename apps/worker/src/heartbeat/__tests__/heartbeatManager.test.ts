import { createWorkerHeartbeatError } from "@aegis/contracts";
import { workerId } from "@aegis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerHeartbeatManager } from "../heartbeatManager.js";
import { InMemoryWorkerHeartbeatPublisher } from "../inMemoryHeartbeatPublisher.js";

describe("WorkerHeartbeatManager", () => {
  const currentWorkerId = workerId("worker-lifecycle-1");
  let publisher: InMemoryWorkerHeartbeatPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    publisher = new InMemoryWorkerHeartbeatPublisher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits initial heartbeat immediately upon start and runs periodically", async () => {
    let currentState: "starting" | "ready" | "draining" | "stopped" | "failed" = "ready";
    let activeTasks = 0;

    const manager = new WorkerHeartbeatManager({
      workerId: currentWorkerId,
      publisher,
      capabilities: { taskTypes: ["python", "bash"], tools: ["terminal"], maxConcurrency: 10 },
      intervalMs: 5000,
      getState: () => currentState,
      getActiveTaskCount: () => activeTasks,
      getMaxConcurrentTasks: () => 10,
    });

    expect(manager.isRunning).toBe(false);
    expect(manager.emissionCount).toBe(0);

    const startResult = await manager.start();
    expect(startResult.ok).toBe(true);
    expect(manager.isRunning).toBe(true);
    expect(manager.emissionCount).toBe(1);

    const firstHb = publisher.getLastHeartbeat();
    expect(firstHb).toBeDefined();
    expect(firstHb?.aggregateId).toBe(currentWorkerId);
    expect(firstHb?.data.workerId).toBe(currentWorkerId);
    expect(firstHb?.data.lifecycleState).toBe("ready");
    expect(firstHb?.data.activeTaskCount).toBe(0);
    expect(firstHb?.data.maxConcurrentTasks).toBe(10);
    expect(firstHb?.data.capabilities.taskTypes).toEqual(["python", "bash"]);
    // LOCK 3: Distinct heartbeatId
    expect(firstHb?.data.heartbeatId).not.toBe(currentWorkerId);
    expect(firstHb?.data.heartbeatId).toMatch(/^hb-/);

    // Fast forward 5s -> second heartbeat
    await vi.advanceTimersByTimeAsync(5000);
    expect(manager.emissionCount).toBe(2);

    const secondHb = publisher.getLastHeartbeat();
    expect(secondHb?.data.heartbeatId).not.toBe(firstHb?.data.heartbeatId);

    // Stop manager
    await manager.stop();
    expect(manager.isRunning).toBe(false);
    // Final heartbeat emitted on stop
    expect(manager.emissionCount).toBe(3);
  });

  it("dynamically computes BUSY observable state when activeTaskCount > 0", async () => {
    let currentState: "starting" | "ready" | "draining" | "stopped" | "failed" = "ready";
    let activeTasks = 0;

    const manager = new WorkerHeartbeatManager({
      workerId: currentWorkerId,
      publisher,
      capabilities: { taskTypes: ["*"], tools: ["bash"], maxConcurrency: 4 },
      intervalMs: 2000,
      getState: () => currentState,
      getActiveTaskCount: () => activeTasks,
      getMaxConcurrentTasks: () => 4,
    });

    await manager.start();
    expect(publisher.getLastHeartbeat()?.data.lifecycleState).toBe("ready");

    // Task starts executing
    activeTasks = 1;
    await vi.advanceTimersByTimeAsync(2000);
    expect(publisher.getLastHeartbeat()?.data.lifecycleState).toBe("busy");
    expect(publisher.getLastHeartbeat()?.data.activeTaskCount).toBe(1);

    // Worker enters draining state while task is still running
    currentState = "draining";
    await vi.advanceTimersByTimeAsync(2000);
    expect(publisher.getLastHeartbeat()?.data.lifecycleState).toBe("draining");

    await manager.stop();
  });

  it("handles publisher failures gracefully without throwing (LOCK 7)", async () => {
    const manager = new WorkerHeartbeatManager({
      workerId: currentWorkerId,
      publisher,
      capabilities: { taskTypes: ["*"], tools: ["bash"], maxConcurrency: 5 },
      intervalMs: 3000,
      getState: () => "ready",
      getActiveTaskCount: () => 0,
      getMaxConcurrentTasks: () => 5,
    });

    // Simulate publisher error
    publisher.setSimulatedFailure(
      createWorkerHeartbeatError("HEARTBEAT_PUBLICATION_FAILED", "Broker unreachable", true),
    );

    // Starting should not throw
    const startResult = await manager.start();
    expect(startResult.ok).toBe(true);
    expect(manager.isRunning).toBe(true);
    // Emission counter shouldn't increment on failed publish
    expect(manager.emissionCount).toBe(0);

    // Subsequent tick with unhandled throwing publisher
    const throwingPublisher = {
      publish: vi.fn().mockRejectedValue(new Error("Network connection reset")),
    };

    const resilientManager = new WorkerHeartbeatManager({
      workerId: currentWorkerId,
      publisher: throwingPublisher,
      capabilities: { taskTypes: ["*"], tools: ["bash"], maxConcurrency: 5 },
      intervalMs: 3000,
      getState: () => "ready",
      getActiveTaskCount: () => 0,
      getMaxConcurrentTasks: () => 5,
    });

    // Must not throw even if publisher rejects
    await expect(resilientManager.start()).resolves.toBeDefined();
    await vi.advanceTimersByTimeAsync(3000);
    await resilientManager.stop();
  });

  it("provides accurate status snapshots via getStatus()", async () => {
    const manager = new WorkerHeartbeatManager({
      workerId: currentWorkerId,
      publisher,
      capabilities: { taskTypes: ["*"], tools: ["bash"], maxConcurrency: 2 },
      intervalMs: 1500,
      getState: () => "ready",
      getActiveTaskCount: () => 0,
      getMaxConcurrentTasks: () => 2,
    });

    let status = manager.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.emissionCount).toBe(0);
    expect(status.lastEmittedAt).toBeUndefined();

    await manager.start();
    status = manager.getStatus();
    expect(status.isRunning).toBe(true);
    expect(status.emissionCount).toBe(1);
    expect(status.lastEmittedAt).toBeDefined();
    expect(status.lastObservableState).toBe("ready");

    await manager.stop();
    status = manager.getStatus();
    expect(status.isRunning).toBe(false);
  });
});
