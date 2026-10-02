import { createWorkerHeartbeatError } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { InMemoryWorkerHeartbeatPublisher } from "../inMemoryHeartbeatPublisher.js";

describe("InMemoryWorkerHeartbeatPublisher", () => {
  const testWorkerId = workerId("worker-test-1");

  it("publishes heartbeat and stores envelope correctly", async () => {
    const publisher = new InMemoryWorkerHeartbeatPublisher();
    const hbId = heartbeatId("hb-12345");
    const occurredAt = new Date().toISOString();

    const result = await publisher.publish({
      heartbeatId: hbId,
      workerId: testWorkerId,
      occurredAt,
      lifecycleState: "ready",
      activeTaskCount: 0,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["*"], tools: ["bash"], maxConcurrency: 5 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe(hbId);
    expect(result.value.type).toBe("worker_heartbeat");
    expect(result.value.source).toBe(`aegis.worker.${testWorkerId}`);
    expect(result.value.aggregateId).toBe(testWorkerId);
    expect(result.value.aggregateType).toBe("Worker");
    expect(result.value.data.lifecycleState).toBe("ready");
    expect(result.value.data.maxConcurrentTasks).toBe(5);

    expect(publisher.getPublishedHeartbeats()).toHaveLength(1);
    expect(publisher.getLastHeartbeat()).toEqual(result.value);
  });

  it("simulates publishing failures when configured", async () => {
    const publisher = new InMemoryWorkerHeartbeatPublisher();
    const simError = createWorkerHeartbeatError("HEARTBEAT_PUBLICATION_FAILED", "Broker connection failed", false);
    publisher.setSimulatedFailure(simError);

    const result = await publisher.publish({
      heartbeatId: heartbeatId("hb-fail-1"),
      workerId: testWorkerId,
      occurredAt: new Date().toISOString(),
      lifecycleState: "ready",
      activeTaskCount: 0,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["*"], tools: ["bash"], maxConcurrency: 5 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("HEARTBEAT_PUBLICATION_FAILED");
    expect(publisher.getPublishedHeartbeats()).toHaveLength(0);

    // After clear, publisher should succeed again
    publisher.clear();
    const result2 = await publisher.publish({
      heartbeatId: heartbeatId("hb-succ-1"),
      workerId: testWorkerId,
      occurredAt: new Date().toISOString(),
      lifecycleState: "ready",
      activeTaskCount: 0,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["*"], tools: ["bash"], maxConcurrency: 5 },
    });
    expect(result2.ok).toBe(true);
    expect(publisher.getPublishedHeartbeats()).toHaveLength(1);
  });
});
