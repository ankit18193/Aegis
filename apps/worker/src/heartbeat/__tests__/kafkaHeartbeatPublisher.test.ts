import type { WorkerHeartbeat } from "@aegis/contracts";
import { heartbeatId, workerId } from "@aegis/types";
import type { Producer, ProducerRecord } from "kafkajs";
import { describe, expect, it, vi } from "vitest";

import { KafkaWorkerHeartbeatPublisher } from "../kafkaHeartbeatPublisher.js";

describe("KafkaWorkerHeartbeatPublisher", () => {
  const currentWorkerId = workerId("worker-kafka-test");

  const sampleHeartbeat: WorkerHeartbeat = {
    heartbeatId: heartbeatId("hb-kfk-1"),
    workerId: currentWorkerId,
    occurredAt: "2026-10-02T12:00:00.000Z",
    lifecycleState: "ready",
    activeTaskCount: 0,
    maxConcurrentTasks: 5,
    capabilities: { taskTypes: ["*"], tools: ["system"], maxConcurrency: 5 },
  };

  it("publishes serialized envelope to Kafka topic partitioned by workerId with CloudEvents headers", async () => {
    let sentPayload: ProducerRecord | undefined;

    const mockConnect = vi.fn(() => Promise.resolve());
    const mockDisconnect = vi.fn(() => Promise.resolve());
    const mockSend = vi.fn((payload: ProducerRecord) => {
      sentPayload = payload;
      return Promise.resolve([{ topicName: "aegis.workers.heartbeat", partition: 0, errorCode: 0 }]);
    });

    const mockProducer = {
      connect: mockConnect,
      disconnect: mockDisconnect,
      send: mockSend,
    } as unknown as Producer;

    const publisher = new KafkaWorkerHeartbeatPublisher({
      producer: mockProducer,
      topic: "aegis.workers.heartbeat",
    });

    await publisher.start();
    expect(mockConnect).toHaveBeenCalledTimes(1);

    const result = await publisher.publish(sampleHeartbeat);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sentPayload).toBeDefined();
    if (!sentPayload) return;

    expect(sentPayload.topic).toBe("aegis.workers.heartbeat");
    expect(sentPayload.messages).toHaveLength(1);

    const message = sentPayload.messages[0];
    expect(message?.key).toBe(currentWorkerId);

    const headers = message?.headers as Record<string, string> | undefined;
    expect(headers?.["ce-id"]).toBe(sampleHeartbeat.heartbeatId);
    expect(headers?.["ce-type"]).toBe("worker_heartbeat");
    expect(headers?.["ce-source"]).toBe(`aegis.worker.${currentWorkerId}`);

    await publisher.stop();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it("translates Kafka send rejection to HEARTBEAT_PUBLICATION_FAILED", async () => {
    const mockProducer = {
      connect: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      send: vi.fn().mockRejectedValue(new Error("Connection to broker lost")),
    } as unknown as Producer;

    const publisher = new KafkaWorkerHeartbeatPublisher({
      producer: mockProducer,
    });

    const result = await publisher.publish(sampleHeartbeat);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("HEARTBEAT_PUBLICATION_FAILED");
    expect(result.error.message).toContain("Connection to broker lost");
  });
});
