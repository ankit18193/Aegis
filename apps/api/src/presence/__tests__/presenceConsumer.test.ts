import type { WorkerHeartbeatEnvelope } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import type { Consumer } from "kafkajs";
import { describe, expect, it, vi } from "vitest";

import { WorkerPresenceConsumer } from "../presenceConsumer.js";
import { InMemoryTopicProvisioner } from "../topicProvisioner.js";
import { InMemoryWorkerRegistry } from "../workerRegistry.js";

describe("Control-Plane WorkerPresenceConsumer (Phase 11E)", () => {
  function createMockHeartbeatEnvelope(
    id: string,
    state: "ready" | "busy" | "stopped" = "ready",
  ): WorkerHeartbeatEnvelope {
    return {
      id: heartbeatId(`evt-${id}`),
      type: "worker_heartbeat",
      source: `aegis.worker.${id}`,
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: workerId(id),
      aggregateType: "Worker",
      correlationId: `corr-${id}`,
      data: {
        heartbeatId: heartbeatId(`hb-${id}`),
        workerId: workerId(id),
        occurredAt: new Date().toISOString(),
        lifecycleState: state,
        activeTaskCount: state === "busy" ? 2 : 0,
        maxConcurrentTasks: 4,
        capabilities: {
          taskTypes: ["*"],
          tools: ["bash"],
          maxConcurrency: 4,
        },
      },
    };
  }

  it("processes valid heartbeat message and updates presence registry", async () => {
    const registry = new InMemoryWorkerRegistry();
    const topicProvisioner = new InMemoryTopicProvisioner();

    const mockConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    const consumer = new WorkerPresenceConsumer({
      consumer: mockConsumer as unknown as Consumer,
      registry,
      topicProvisioner,
      baseAssignmentTopic: "aegis.tasks.assign",
    });

    const envelope = createMockHeartbeatEnvelope("worker-cp-test-1");
    const raw = Buffer.from(JSON.stringify(envelope));

    const handled = await consumer.handleMessage(raw);
    expect(handled).toBe(true);

    const worker = registry.get(workerId("worker-cp-test-1"));
    expect(worker).toBeDefined();
    expect(worker?.presenceState).toBe("HEALTHY");

    // Verifies dedicated assignment topic provisioned on new worker discovery
    expect(topicProvisioner.hasTopic("aegis.tasks.assign.worker-cp-test-1")).toBe(true);
  });

  it("handles unparseable or invalid messages gracefully without throwing", async () => {
    const registry = new InMemoryWorkerRegistry();
    const mockConsumer = {
      connect: vi.fn(),
      subscribe: vi.fn(),
      run: vi.fn(),
      disconnect: vi.fn(),
    };

    const consumer = new WorkerPresenceConsumer({
      consumer: mockConsumer as unknown as Consumer,
      registry,
    });

    const handled = await consumer.handleMessage(Buffer.from("invalid json raw payload"));
    expect(handled).toBe(false);
    expect(registry.size).toBe(0);
  });
});
