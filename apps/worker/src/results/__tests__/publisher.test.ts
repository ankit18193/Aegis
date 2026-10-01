import type { TaskExecutionResult } from "@aegis/contracts";
import { createTaskExecutionError, TaskResultStatusValue } from "@aegis/contracts";
import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import type { Producer, ProducerRecord } from "kafkajs";
import { describe, expect, it, vi } from "vitest";

import { InMemoryTaskResultPublisher } from "../inMemoryPublisher.js";
import { KafkaTaskResultPublisher } from "../kafkaPublisher.js";

describe("Task Result Publishers (Phase 11C — Commit 3)", () => {
  const currentWorkerId = workerId("worker-publish-1");
  const currentTaskId = taskId("task-pub-100");
  const currentRunId = runId("run-pub-200");
  const currentAssignmentId = assignmentId("assign-pub-300");

  const successResult: TaskExecutionResult = {
    taskId: currentTaskId,
    runId: currentRunId,
    assignmentId: currentAssignmentId,
    workerId: currentWorkerId,
    status: TaskResultStatusValue.SUCCEEDED,
    startedAt: "2026-10-01T15:00:00.000Z",
    completedAt: "2026-10-01T15:00:03.000Z",
    output: { summary: "Success" },
  };

  const failedResult: TaskExecutionResult = {
    taskId: currentTaskId,
    runId: currentRunId,
    assignmentId: currentAssignmentId,
    workerId: currentWorkerId,
    status: TaskResultStatusValue.FAILED,
    startedAt: "2026-10-01T15:00:00.000Z",
    completedAt: "2026-10-01T15:00:01.000Z",
    error: createTaskExecutionError("TASK_EXECUTION_FAILED", "Planner failure"),
  };

  describe("InMemoryTaskResultPublisher", () => {
    it("publishes success result and records envelope in-memory", async () => {
      const publisher = new InMemoryTaskResultPublisher();
      const res = await publisher.publish(successResult, {
        correlationId: "custom-corr",
        causationId: "custom-cause",
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.aggregateId).toBe(currentTaskId);
      expect(res.value.correlationId).toBe("custom-corr");
      expect(res.value.causationId).toBe("custom-cause");

      const envelopes = publisher.getPublishedEnvelopes();
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]?.data.status).toBe("SUCCEEDED");

      const byTask = publisher.getEnvelopesByTaskId(currentTaskId);
      expect(byTask).toHaveLength(1);
    });

    it("publishes failed result faithfully", async () => {
      const publisher = new InMemoryTaskResultPublisher();
      const res = await publisher.publish(failedResult);

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.data.status).toBe("FAILED");
      expect(res.value.data.error?.code).toBe("TASK_EXECUTION_FAILED");
    });

    it("simulates publication failure when configured", async () => {
      const publisher = new InMemoryTaskResultPublisher();
      publisher.simulateFailure(
        createTaskExecutionError("TASK_RESULT_PUBLICATION_FAILED", "Broker down"),
      );

      const res = await publisher.publish(successResult);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("TASK_RESULT_PUBLICATION_FAILED");
        expect(res.error.message).toBe("Broker down");
      }

      expect(publisher.getPublishedEnvelopes()).toHaveLength(0);
    });
  });

  describe("KafkaTaskResultPublisher", () => {
    it("publishes serialized envelope to Kafka topic with taskId partition key and CloudEvents headers", async () => {
      let sentPayload: ProducerRecord | undefined;

      const mockConnect = vi.fn(() => Promise.resolve());
      const mockDisconnect = vi.fn(() => Promise.resolve());
      const mockSend = vi.fn((payload: ProducerRecord) => {
        sentPayload = payload;
        return Promise.resolve([{ topicName: "aegis.tasks.results", partition: 0, errorCode: 0 }]);
      });

      const mockProducer = {
        connect: mockConnect,
        disconnect: mockDisconnect,
        send: mockSend,
      } as unknown as Producer;

      const publisher = new KafkaTaskResultPublisher({
        producer: mockProducer,
        topic: "aegis.tasks.results",
      });

      await publisher.start();
      expect(mockConnect).toHaveBeenCalledTimes(1);

      const res = await publisher.publish(successResult, {
        correlationId: "corr-trace-1",
        causationId: "assign-pub-300",
      });

      expect(res.ok).toBe(true);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(sentPayload).toBeDefined();
      if (!sentPayload) return;

      expect(sentPayload.topic).toBe("aegis.tasks.results");
      expect(sentPayload.messages).toHaveLength(1);
      const firstMsg = sentPayload.messages[0];
      expect(firstMsg?.key).toBe(currentTaskId);
      const headers = firstMsg?.headers as Record<string, string> | undefined;
      expect(headers?.["ce-correlationid"]).toBe("corr-trace-1");
      expect(headers?.["ce-type"]).toBe("task_result");

      await publisher.stop();
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it("translates Kafka send rejection to TASK_RESULT_PUBLICATION_FAILED", async () => {
      const mockSendFail = vi.fn(() => Promise.reject(new Error("Connection to Kafka broker lost")));
      const mockProducer = {
        connect: vi.fn(() => Promise.resolve()),
        disconnect: vi.fn(() => Promise.resolve()),
        send: mockSendFail,
      } as unknown as Producer;

      const publisher = new KafkaTaskResultPublisher({
        producer: mockProducer,
      });

      const res = await publisher.publish(successResult);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("TASK_RESULT_PUBLICATION_FAILED");
        expect(res.error.message).toContain("Connection to Kafka broker lost");
      }
    });
  });
});
