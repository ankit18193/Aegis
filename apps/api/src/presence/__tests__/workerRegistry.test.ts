import type { WorkerDescriptor, WorkerHeartbeat } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { InMemoryWorkerRegistry } from "../workerRegistry.js";

describe("Control-Plane InMemoryWorkerRegistry (Phase 11E)", () => {
  const baseWorker: WorkerDescriptor = {
    workerId: workerId("worker-cp-1"),
    lifecycleState: "ready",
    presenceState: "HEALTHY",
    capabilities: {
      taskTypes: ["python", "bash"],
      tools: ["fs"],
      maxConcurrency: 4,
    },
    activeTaskCount: 0,
    maxConcurrentTasks: 4,
    registeredAt: "2026-10-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-10-01T00:00:00.000Z",
  };

  it("registers and retrieves a worker descriptor", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseWorker);

    const retrieved = registry.get(workerId("worker-cp-1"));
    expect(retrieved).toBeDefined();
    expect(retrieved?.workerId).toBe("worker-cp-1");
    expect(retrieved?.presenceState).toBe("HEALTHY");
  });

  it("auto-registers worker on first heartbeat observed", () => {
    const registry = new InMemoryWorkerRegistry();
    const heartbeat: WorkerHeartbeat = {
      heartbeatId: heartbeatId("hb-1"),
      workerId: workerId("worker-cp-2"),
      occurredAt: "2026-10-01T00:01:00.000Z",
      lifecycleState: "ready",
      activeTaskCount: 1,
      maxConcurrentTasks: 4,
      capabilities: {
        taskTypes: ["*"],
        tools: ["web"],
        maxConcurrency: 4,
      },
    };

    registry.updateHeartbeat(heartbeat);

    const worker = registry.get(workerId("worker-cp-2"));
    expect(worker).toBeDefined();
    expect(worker?.presenceState).toBe("HEALTHY");
    expect(worker?.activeTaskCount).toBe(1);
    expect(worker?.capabilities.taskTypes).toEqual(["*"]);
  });

  it("updates existing worker on subsequent heartbeats", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseWorker);

    const heartbeat: WorkerHeartbeat = {
      heartbeatId: heartbeatId("hb-2"),
      workerId: workerId("worker-cp-1"),
      occurredAt: "2026-10-01T00:01:00.000Z",
      lifecycleState: "busy",
      activeTaskCount: 3,
      maxConcurrentTasks: 4,
      capabilities: baseWorker.capabilities,
    };

    registry.updateHeartbeat(heartbeat);

    const updated = registry.get(workerId("worker-cp-1"));
    expect(updated?.lifecycleState).toBe("busy");
    expect(updated?.activeTaskCount).toBe(3);
    expect(updated?.lastHeartbeatAt).toBe("2026-10-01T00:01:00.000Z");
  });

  it("marks worker STALE when heartbeat is missed past timeout", () => {
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 10000 });
    registry.register(baseWorker);

    // 5 seconds elapsed -> still HEALTHY
    const time5s = new Date(new Date(baseWorker.lastHeartbeatAt).getTime() + 5000);
    const stale5s = registry.markStale(time5s);
    expect(stale5s).toHaveLength(0);
    expect(registry.get(baseWorker.workerId)?.presenceState).toBe("HEALTHY");

    // 15 seconds elapsed -> transitions to STALE
    const time15s = new Date(new Date(baseWorker.lastHeartbeatAt).getTime() + 15000);
    const stale15s = registry.markStale(time15s);
    expect(stale15s).toEqual([baseWorker.workerId]);
    expect(registry.get(baseWorker.workerId)?.presenceState).toBe("STALE");
  });

  it("recovers STALE worker to HEALTHY upon receiving a new heartbeat", () => {
    const registry = new InMemoryWorkerRegistry({ heartbeatTimeoutMs: 10000 });
    registry.register(baseWorker);

    const time15s = new Date(new Date(baseWorker.lastHeartbeatAt).getTime() + 15000);
    registry.markStale(time15s);
    expect(registry.get(baseWorker.workerId)?.presenceState).toBe("STALE");

    const recoveryHeartbeat: WorkerHeartbeat = {
      heartbeatId: heartbeatId("hb-recovery"),
      workerId: baseWorker.workerId,
      occurredAt: time15s.toISOString(),
      lifecycleState: "ready",
      activeTaskCount: 0,
      maxConcurrentTasks: 4,
      capabilities: baseWorker.capabilities,
    };

    registry.updateHeartbeat(recoveryHeartbeat);
    expect(registry.get(baseWorker.workerId)?.presenceState).toBe("HEALTHY");
  });

  it("discards out-of-order delayed heartbeats", () => {
    const registry = new InMemoryWorkerRegistry();
    registry.register(baseWorker);

    // Heartbeat with newer timestamp
    registry.updateHeartbeat({
      heartbeatId: heartbeatId("hb-new"),
      workerId: baseWorker.workerId,
      occurredAt: "2026-10-01T00:05:00.000Z",
      lifecycleState: "busy",
      activeTaskCount: 2,
      maxConcurrentTasks: 4,
      capabilities: baseWorker.capabilities,
    });

    // Delayed out-of-order heartbeat with older timestamp
    registry.updateHeartbeat({
      heartbeatId: heartbeatId("hb-delayed"),
      workerId: baseWorker.workerId,
      occurredAt: "2026-10-01T00:02:00.000Z",
      lifecycleState: "ready",
      activeTaskCount: 0,
      maxConcurrentTasks: 4,
      capabilities: baseWorker.capabilities,
    });

    const current = registry.get(baseWorker.workerId);
    expect(current?.lastHeartbeatAt).toBe("2026-10-01T00:05:00.000Z");
    expect(current?.activeTaskCount).toBe(2);
  });
});
