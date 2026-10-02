import type { WorkerHeartbeat, WorkerState } from "@aegis/contracts";
import { createWorkerHeartbeatError } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import type { Consumer } from "kafkajs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerHeartbeatManager } from "../heartbeat/heartbeatManager.js";
import { InMemoryWorkerHeartbeatPublisher } from "../heartbeat/inMemoryHeartbeatPublisher.js";
import { serializeWorkerHeartbeatEnvelope } from "../heartbeat/serialization.js";
import { WorkerLivenessMonitor } from "../presence/livenessMonitor.js";
import { WorkerPresenceConsumer } from "../presence/presenceConsumer.js";
import { InMemoryWorkerRegistry } from "../presence/workerRegistry.js";

describe("Worker Coordination & Presence Integration (Phase 11D)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coordinates complete heartbeat pulse, busy load reflection, stale detection, recovery, and shutdown", async () => {
    const worker1Id = workerId("worker-coord-1");
    let worker1State: WorkerState = "ready";
    let activeTasks = 0;

    const publisher = new InMemoryWorkerHeartbeatPublisher();
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 10000 });

    // Mock kafkajs consumer for WorkerPresenceConsumer
    const mockConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
    };

    const presenceConsumer = new WorkerPresenceConsumer({
      consumer: mockConsumer as unknown as Consumer,
      registry,
    });

    const staleDetectedWorkers: string[] = [];
    const livenessMonitor = new WorkerLivenessMonitor({
      registry,
      evaluationIntervalMs: 2000,
      heartbeatTimeoutMs: 10000,
      onWorkerStale: (id) => staleDetectedWorkers.push(id),
    });

    const heartbeatManager = new WorkerHeartbeatManager({
      workerId: worker1Id,
      publisher,
      capabilities: { taskTypes: ["bash", "python"], tools: ["terminal"], maxConcurrency: 5 },
      intervalMs: 3000,
      getState: () => worker1State,
      getActiveTaskCount: () => activeTasks,
      getMaxConcurrentTasks: () => 5,
    });

    // Wire publisher output to presenceConsumer to simulate Kafka bus transit
    const deliverLastPublishedHeartbeat = async (): Promise<boolean> => {
      const lastEnvelope = publisher.getLastHeartbeat();
      if (!lastEnvelope) return false;
      const serialized = serializeWorkerHeartbeatEnvelope(lastEnvelope);
      if (!serialized.ok) return false;
      return presenceConsumer.handleMessage(serialized.value);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Step 1: Start liveness monitor and heartbeat manager
    // ─────────────────────────────────────────────────────────────────────────
    livenessMonitor.start();
    await heartbeatManager.start();

    // Verify initial pulse emitted immediately upon start
    expect(heartbeatManager.emissionCount).toBe(1);
    const initialPulse = publisher.getLastHeartbeat();
    expect(initialPulse).toBeDefined();
    expect(initialPulse?.aggregateId).toBe(worker1Id);
    // LOCK 3: Distinct identity
    expect(initialPulse?.id).not.toBe(worker1Id);

    // Deliver pulse to presence consumer
    await deliverLastPublishedHeartbeat();

    // Verify worker registered in presence registry as HEALTHY & READY
    const registered = registry.get(worker1Id);
    expect(registered).toBeDefined();
    expect(registered?.workerId).toBe(worker1Id);
    expect(registered?.presenceState).toBe("HEALTHY");
    expect(registered?.lifecycleState).toBe("ready");
    expect(registered?.activeTaskCount).toBe(0);
    expect(registered?.maxConcurrentTasks).toBe(5);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 2: Simulate task load (worker executes tasks -> flips to BUSY)
    // ─────────────────────────────────────────────────────────────────────────
    activeTasks = 2;
    await vi.advanceTimersByTimeAsync(3000);
    expect(heartbeatManager.emissionCount).toBe(2);
    expect(heartbeatManager.lastObservableState).toBe("busy");

    await deliverLastPublishedHeartbeat();

    const busyWorker = registry.get(worker1Id);
    expect(busyWorker?.lifecycleState).toBe("busy");
    expect(busyWorker?.activeTaskCount).toBe(2);
    expect(busyWorker?.presenceState).toBe("HEALTHY");

    // ─────────────────────────────────────────────────────────────────────────
    // Step 3: Tasks complete -> flips back to READY
    // ─────────────────────────────────────────────────────────────────────────
    activeTasks = 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(heartbeatManager.emissionCount).toBe(3);
    expect(heartbeatManager.lastObservableState).toBe("ready");

    await deliverLastPublishedHeartbeat();

    const readyWorker = registry.get(worker1Id);
    expect(readyWorker?.lifecycleState).toBe("ready");
    expect(readyWorker?.activeTaskCount).toBe(0);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 4: Stale detection (heartbeats cease, liveness monitor detects timeout)
    // ─────────────────────────────────────────────────────────────────────────
    // Advance time by 12 seconds with no delivered heartbeats
    await vi.advanceTimersByTimeAsync(12000);

    // Registry worker should now be STALE
    const staleWorker = registry.get(worker1Id);
    expect(staleWorker?.presenceState).toBe("STALE");
    expect(staleDetectedWorkers).toContain(worker1Id);

    // LOCK 8: STALE != DEAD. Worker process is intact, tasks are not cancelled.
    expect(registry.getStaleWorkers()).toHaveLength(1);
    expect(registry.getHealthyWorkers()).toHaveLength(0);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 5: Stale Recovery (new heartbeat arrives -> transitions back to HEALTHY)
    // ─────────────────────────────────────────────────────────────────────────
    await deliverLastPublishedHeartbeat();

    const recoveredWorker = registry.get(worker1Id);
    expect(recoveredWorker?.presenceState).toBe("HEALTHY");
    expect(registry.getHealthyWorkers()).toHaveLength(1);
    expect(registry.getStaleWorkers()).toHaveLength(0);

    // ─────────────────────────────────────────────────────────────────────────
    // Step 6: Graceful Shutdown (transitions to OFFLINE)
    // ─────────────────────────────────────────────────────────────────────────
    worker1State = "stopped";
    await heartbeatManager.stop();

    await deliverLastPublishedHeartbeat();

    const stoppedWorker = registry.get(worker1Id);
    expect(stoppedWorker?.lifecycleState).toBe("stopped");
    expect(stoppedWorker?.presenceState).toBe("OFFLINE");
    expect(registry.getOfflineWorkers()).toHaveLength(1);

    // Cleanup
    livenessMonitor.stop();
  });

  it("guarantees fault tolerance when heartbeat transport fails (LOCK 7)", async () => {
    const workerIdVal = workerId("worker-resilient-1");
    const publisher = new InMemoryWorkerHeartbeatPublisher();
    publisher.setSimulatedFailure(
      createWorkerHeartbeatError("HEARTBEAT_PUBLICATION_FAILED", "Broker unreachable", true),
    );

    const manager = new WorkerHeartbeatManager({
      workerId: workerIdVal,
      publisher,
      capabilities: { taskTypes: ["*"], tools: [], maxConcurrency: 2 },
      intervalMs: 1000,
      getState: () => "ready",
      getActiveTaskCount: () => 1,
      getMaxConcurrentTasks: () => 2,
    });

    // Start must not throw even if publication fails
    const startRes = await manager.start();
    expect(startRes.ok).toBe(true);

    // Fast-forward interval
    await vi.advanceTimersByTimeAsync(3000);

    // Worker continues operating
    expect(manager.isRunning).toBe(true);

    await manager.stop();
    expect(manager.isRunning).toBe(false);
  });

  it("tracks multiple workers independently with capability isolation", () => {
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 5000 });
    const workerA = workerId("worker-py");
    const workerB = workerId("worker-node");

    const hbA: WorkerHeartbeat = {
      heartbeatId: heartbeatId("hb-a-1"),
      workerId: workerA,
      occurredAt: new Date(1000).toISOString(),
      lifecycleState: "ready",
      activeTaskCount: 0,
      maxConcurrentTasks: 4,
      capabilities: { taskTypes: ["python"], tools: ["pip"], maxConcurrency: 4 },
    };

    const hbB: WorkerHeartbeat = {
      heartbeatId: heartbeatId("hb-b-1"),
      workerId: workerB,
      occurredAt: new Date(5000).toISOString(),
      lifecycleState: "busy",
      activeTaskCount: 2,
      maxConcurrentTasks: 2,
      capabilities: { taskTypes: ["nodejs"], tools: ["npm"], maxConcurrency: 2 },
    };

    registry.updateHeartbeat(hbA);
    registry.updateHeartbeat(hbB);

    expect(registry.size()).toBe(2);

    // Evaluate liveness at t = 7000ms: workerA elapsed is 6000ms (> 5000ms) -> STALE
    // workerB elapsed is 2000ms (< 5000ms) -> HEALTHY
    const stale = registry.markStale(new Date(7000));
    expect(stale).toEqual([workerA]);

    expect(registry.get(workerA)?.presenceState).toBe("STALE");
    expect(registry.get(workerB)?.presenceState).toBe("HEALTHY");

    // Capabilities remain distinct
    expect(registry.get(workerA)?.capabilities.taskTypes).toEqual(["python"]);
    expect(registry.get(workerB)?.capabilities.taskTypes).toEqual(["nodejs"]);
  });
});
