import type { TaskExecutionResult } from "@aegis/contracts";
import { createTaskExecutionError, TaskResultStatusValue } from "@aegis/contracts";
import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  createTaskResultEnvelope,
  deserializeTaskResultEnvelope,
  serializeTaskResultEnvelope,
} from "../resultMapper.js";

describe("Task Result Mapper & Envelope Serialization (Phase 11C — Commit 3)", () => {
  const currentWorkerId = workerId("worker-alpha");
  const currentTaskId = taskId("task-calc-10");
  const currentRunId = runId("run-exec-55");
  const currentAssignmentId = assignmentId("assign-slot-99");

  const successResult: TaskExecutionResult = {
    taskId: currentTaskId,
    runId: currentRunId,
    assignmentId: currentAssignmentId,
    workerId: currentWorkerId,
    status: TaskResultStatusValue.SUCCEEDED,
    startedAt: "2026-10-01T15:00:00.000Z",
    completedAt: "2026-10-01T15:00:05.000Z",
    output: { answer: 100, verified: true },
  };

  const failedResult: TaskExecutionResult = {
    taskId: currentTaskId,
    runId: currentRunId,
    assignmentId: currentAssignmentId,
    workerId: currentWorkerId,
    status: TaskResultStatusValue.FAILED,
    startedAt: "2026-10-01T15:00:00.000Z",
    completedAt: "2026-10-01T15:00:02.000Z",
    error: createTaskExecutionError("TASK_EXECUTION_FAILED", "Timeout during execution", {
      timeoutMs: 5000,
    }),
  };

  it("creates valid canonical TaskResultEnvelope with CloudEvents specification", () => {
    const envelope = createTaskResultEnvelope(successResult);

    expect(envelope.id).toMatch(/^evt-res-/);
    expect(envelope.type).toBe("task_result");
    expect(envelope.source).toBe("aegis.worker.worker-alpha");
    expect(envelope.specVersion).toBe("1.0");
    expect(envelope.aggregateId).toBe("task-calc-10");
    expect(envelope.aggregateType).toBe("TaskResult");
    expect(envelope.correlationId).toBe("corr-run-exec-55");
    expect(envelope.causationId).toBe("assign-slot-99");
    expect(envelope.data.status).toBe("SUCCEEDED");
  });

  it("preserves custom correlationId and causationId when provided", () => {
    const envelope = createTaskResultEnvelope(failedResult, {
      correlationId: "custom-corr-trace-999",
      causationId: "upstream-cause-888",
    });

    expect(envelope.correlationId).toBe("custom-corr-trace-999");
    expect(envelope.causationId).toBe("upstream-cause-888");
    expect(envelope.data.status).toBe("FAILED");
    expect(envelope.data.error?.code).toBe("TASK_EXECUTION_FAILED");
  });

  it("serializes and deserializes TaskResultEnvelope losslessly", () => {
    const original = createTaskResultEnvelope(successResult);
    const serializeRes = serializeTaskResultEnvelope(original);

    expect(serializeRes.ok).toBe(true);
    if (!serializeRes.ok) return;

    const deserializeRes = deserializeTaskResultEnvelope(serializeRes.value);
    expect(deserializeRes.ok).toBe(true);
    if (!deserializeRes.ok) return;

    expect(deserializeRes.value.id).toBe(original.id);
    expect(deserializeRes.value.aggregateId).toBe(original.aggregateId);
    expect(deserializeRes.value.data.output).toEqual(original.data.output);
  });

  it("returns structured serialization error when deserializing invalid JSON payload", () => {
    const invalidJson = "{ not-json }";
    const res = deserializeTaskResultEnvelope(invalidJson);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("TASK_RESULT_SERIALIZATION_FAILED");
      expect(res.error.message).toContain("Failed to deserialize");
    }
  });

  it("returns structured serialization error when envelope schema validation fails", () => {
    const invalidEnvelopeJson = JSON.stringify({
      id: "evt-1",
      type: "invalid_type",
      source: "aegis",
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: "task-1",
      aggregateType: "TaskResult",
      correlationId: "corr-1",
      data: {},
    });

    const res = deserializeTaskResultEnvelope(invalidEnvelopeJson);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("TASK_RESULT_SERIALIZATION_FAILED");
    }
  });
});
