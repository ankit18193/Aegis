import type { WorkerDescriptor, WorkerHeartbeat } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { InMemoryWorkerRegistry } from "../workerRegistry.js";

describe("InMemoryWorkerRegistry", () => {
  const worker1 = workerId("worker-1");
  const worker2 = workerId("worker-2");

  const baseDescriptor: WorkerDescriptor = {
    workerId: worker1,
    lifecycleState: "ready",
    presenceState: "HEALTHY",
    capabilities: { taskTypes: ["bash"], tools: ["terminal"], maxConcurrency: 5 },
    activeTaskCount: 0,
    maxConcurrentTasks: 5,
    registeredAt: "2026-10-02T10:00:00.000Z",
    lastHeartbeatAt: "2026-10-02T10:00:00.000Z",
  };

  it("registers and retrieves a worker descriptor", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseDescriptor);

    const retrieved = registry.get(worker1);
    expect(retrieved).toBeDefined();
    expect(retrieved?.workerId).toBe(worker1);
    expect(retrieved?.presenceState).toBe("HEALTHY");
    expect(registry.size()).toBe(1);
  });

  it("auto-registers an unknown worker upon first heartbeat", () => {
    const registry = new InMemoryWorkerRegistry();
    const hb: WorkerHeartbeat = {
      heartbeatId: heartbeatId("hb-w2-1"),
      workerId: worker2,
      occurredAt: "2026-10-02T10:05:00.000Z",
      lifecycleState: "ready",
      activeTaskCount: 1,
      maxConcurrentTasks: 4,
      capabilities: { taskTypes: ["*"], tools: ["agent"], maxConcurrency: 4 },
    };

    registry.updateHeartbeat(hb);
    const worker = registry.get(worker2);
    expect(worker).toBeDefined();
    expect(worker?.workerId).toBe(worker2);
    expect(worker?.presenceState).toBe("HEALTHY");
    expect(worker?.lifecycleState).toBe("ready");
    expect(worker?.activeTaskCount).toBe(1);
    expect(worker?.registeredAt).toBe("2026-10-02T10:05:00.000Z");
  });

  it("updates existing worker metadata on subsequent heartbeats", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseDescriptor);

    const hb: WorkerHeartbeat = {
      heartbeatId: heartbeatId("hb-w1-2"),
      workerId: worker1,
      occurredAt: "2026-10-02T10:01:00.000Z",
      lifecycleState: "busy",
      activeTaskCount: 3,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["bash"], tools: ["terminal"], maxConcurrency: 5 },
    };

    registry.updateHeartbeat(hb);
    const worker = registry.get(worker1);
    expect(worker?.lifecycleState).toBe("busy");
    expect(worker?.activeTaskCount).toBe(3);
    expect(worker?.lastHeartbeatAt).toBe("2026-10-02T10:01:00.000Z");
    expect(worker?.registeredAt).toBe("2026-10-02T10:00:00.000Z"); // unchanged
  });

  it("recovers STALE worker back to HEALTHY when new heartbeat arrives", () => {
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 10000 });
    registry.register(baseDescriptor);

    // Advance time beyond timeout
    const staleTime = new Date("2026-10-02T10:00:15.000Z");
    const staleWorkers = registry.markStale(staleTime);
    expect(staleWorkers).toEqual([worker1]);
    expect(registry.get(worker1)?.presenceState).toBe("STALE");

    // Worker emits heartbeat
    registry.updateHeartbeat({
      heartbeatId: heartbeatId("hb-w1-recovery"),
      workerId: worker1,
      occurredAt: "2026-10-02T10:00:16.000Z",
      lifecycleState: "ready",
      activeTaskCount: 0,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["bash"], tools: ["terminal"], maxConcurrency: 5 },
    });

    expect(registry.get(worker1)?.presenceState).toBe("HEALTHY");
  });

  it("discards out-of-order heartbeats with older timestamps", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseDescriptor); // lastHeartbeatAt: 2026-10-02T10:00:00.000Z

    // Incoming heartbeat with older timestamp
    registry.updateHeartbeat({
      heartbeatId: heartbeatId("hb-w1-old"),
      workerId: worker1,
      occurredAt: "2026-10-02T09:59:00.000Z", // 1 minute in the past
      lifecycleState: "failed",
      activeTaskCount: 99,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["bash"], tools: ["terminal"], maxConcurrency: 5 },
    });

    const worker = registry.get(worker1);
    expect(worker?.lifecycleState).toBe("ready"); // not overwritten by stale pulse
    expect(worker?.activeTaskCount).toBe(0);
    expect(worker?.lastHeartbeatAt).toBe("2026-10-02T10:00:00.000Z");
  });

  it("marks presence OFFLINE when worker emits stopped lifecycle state", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseDescriptor);

    registry.updateHeartbeat({
      heartbeatId: heartbeatId("hb-w1-stop"),
      workerId: worker1,
      occurredAt: "2026-10-02T10:02:00.000Z",
      lifecycleState: "stopped",
      activeTaskCount: 0,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["bash"], tools: ["terminal"], maxConcurrency: 5 },
    });

    expect(registry.get(worker1)?.presenceState).toBe("OFFLINE");
    expect(registry.get(worker1)?.lifecycleState).toBe("stopped");
    expect(registry.getOfflineWorkers()).toHaveLength(1);
  });

  it("deregisters and clears workers", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseDescriptor);
    expect(registry.size()).toBe(1);

    registry.deregister(worker1);
    expect(registry.get(worker1)).toBeUndefined();
    expect(registry.size()).toBe(0);

    registry.register(baseDescriptor);
    registry.clear();
    expect(registry.size()).toBe(0);
  });

  it("returns filtered lists of workers by presence state", () => {
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 10000 });
    registry.register(baseDescriptor); // worker1: HEALTHY
    registry.register({
      ...baseDescriptor,
      workerId: worker2,
      lastHeartbeatAt: "2026-10-02T09:00:00.000Z",
    });

    // Mark stale
    registry.markStale(new Date("2026-10-02T10:00:05.000Z"));
    // worker2 was 1 hour ago -> marked STALE
    // worker1 was 5s ago -> still HEALTHY

    expect(registry.getHealthyWorkers()).toHaveLength(1);
    expect(registry.getHealthyWorkers()[0]?.workerId).toBe(worker1);
    expect(registry.getStaleWorkers()).toHaveLength(1);
    expect(registry.getStaleWorkers()[0]?.workerId).toBe(worker2);
  });
});
