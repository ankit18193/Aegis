import type { WorkerHeartbeatEnvelope } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import type { Consumer } from "kafkajs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WorkerPresenceConsumer } from "../presenceConsumer.js";
import { InMemoryWorkerRegistry } from "../workerRegistry.js";

describe("WorkerPresenceConsumer", () => {
  const currentWorkerId = workerId("worker-cons-1");
  let mockConsumer: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
  let registry: InMemoryWorkerRegistry;

  const sampleEnvelope: WorkerHeartbeatEnvelope = {
    id: heartbeatId("hb-cons-1"),
    type: "worker_heartbeat",
    source: `aegis.worker.${currentWorkerId}`,
    specVersion: "1.0",
    time: "2026-10-02T12:00:00.000Z",
    aggregateId: currentWorkerId,
    aggregateType: "Worker",
    correlationId: "corr-cons-1",
    data: {
      heartbeatId: heartbeatId("hb-cons-1"),
      workerId: currentWorkerId,
      occurredAt: "2026-10-02T12:00:00.000Z",
      lifecycleState: "ready",
      activeTaskCount: 1,
      maxConcurrentTasks: 5,
      capabilities: { taskTypes: ["*"], tools: ["agent"], maxConcurrency: 5 },
    },
  };

  beforeEach(() => {
    mockConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
    };
    registry = new InMemoryWorkerRegistry();
  });

  it("subscribes and connects to the heartbeat topic", async () => {
    const consumer = new WorkerPresenceConsumer({
      consumer: mockConsumer as unknown as Consumer,
      registry,
      topic: "aegis.workers.heartbeat",
    });

    expect(consumer.running).toBe(false);
    await consumer.start();
    expect(consumer.running).toBe(true);

    expect(mockConsumer.connect).toHaveBeenCalledTimes(1);
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topic: "aegis.workers.heartbeat",
      fromBeginning: false,
    });
    expect(mockConsumer.run).toHaveBeenCalledTimes(1);

    await consumer.stop();
    expect(consumer.running).toBe(false);
    expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
  });

  it("processes valid heartbeat message and updates presence registry", async () => {
    const consumer = new WorkerPresenceConsumer({
      consumer: mockConsumer as unknown as Consumer,
      registry,
    });

    const rawJson = JSON.stringify(sampleEnvelope);
    const success = await consumer.handleMessage(rawJson);
    expect(success).toBe(true);
    expect(consumer.messagesProcessed).toBe(1);

    const worker = registry.get(currentWorkerId);
    expect(worker).toBeDefined();
    expect(worker?.workerId).toBe(currentWorkerId);
    expect(worker?.lifecycleState).toBe("ready");
    expect(worker?.activeTaskCount).toBe(1);
    expect(worker?.presenceState).toBe("HEALTHY");
  });

  it("handles malformed JSON and invalid schema without throwing", async () => {
    const consumer = new WorkerPresenceConsumer({
      consumer: mockConsumer as unknown as Consumer,
      registry,
    });

    // Malformed JSON
    const malformedSuccess = await consumer.handleMessage("{ invalid json");
    expect(malformedSuccess).toBe(false);
    expect(registry.size()).toBe(0);

    // Invalid schema
    const invalidSchemaSuccess = await consumer.handleMessage(JSON.stringify({ not: "a valid envelope" }));
    expect(invalidSchemaSuccess).toBe(false);
    expect(registry.size()).toBe(0);

    expect(consumer.messagesProcessed).toBe(2);
  });
});
