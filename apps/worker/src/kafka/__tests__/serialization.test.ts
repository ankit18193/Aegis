import type { TaskAssignmentEnvelope } from "@aegis/contracts";
import { assignmentId, eventId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { deserializeAssignmentEnvelope } from "../serialization.js";

describe("deserializeAssignmentEnvelope (Phase 11B — Commit 3)", () => {
  const validEnvelope: TaskAssignmentEnvelope = {
    id: eventId("assign-evt-1"),
    source: "aegis.workflow.engine",
    type: "task_assigned",
    specVersion: "1.0",
    time: "2026-10-02T00:00:00.000Z",
    aggregateType: "TaskAssignment",
    aggregateId: taskId("task-123"),
    correlationId: "corr-123",
    data: {
      assignmentId: assignmentId("asgn-01J9K0ABCD"),
      taskId: taskId("task-123"),
      runId: runId("run-456"),
      workerId: workerId("worker-test-1"),
      task: {
        id: taskId("task-123"),
        name: "test_task",
        status: "queued",
        description: "",
        attemptCount: 0,
        version: 1,
        input: { key: "value" },
      },
      assignedAt: "2026-10-02T00:00:00.000Z",
    },
  };

  it("deserializes a valid TaskAssignmentEnvelope from JSON string", () => {
    const raw = JSON.stringify(validEnvelope);
    const result = deserializeAssignmentEnvelope(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe("assign-evt-1");
    expect(result.value.aggregateType).toBe("TaskAssignment");
    expect(result.value.data.assignmentId).toBe(assignmentId("asgn-01J9K0ABCD"));
    expect(result.value.data.task.name).toBe("test_task");
  });

  it("deserializes a valid TaskAssignmentEnvelope from Buffer", () => {
    const rawBuffer = Buffer.from(JSON.stringify(validEnvelope), "utf8");
    const result = deserializeAssignmentEnvelope(rawBuffer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe("assign-evt-1");
    expect(result.value.data.taskId).toBe(taskId("task-123"));
  });

  it("returns INVALID_ASSIGNMENT_ENVELOPE when raw is null or undefined", () => {
    const nullResult = deserializeAssignmentEnvelope(null);
    expect(nullResult.ok).toBe(false);
    if (nullResult.ok) return;
    expect(nullResult.error.code).toBe("INVALID_ASSIGNMENT_ENVELOPE");

    const undefResult = deserializeAssignmentEnvelope(undefined);
    expect(undefResult.ok).toBe(false);
    if (undefResult.ok) return;
    expect(undefResult.error.code).toBe("INVALID_ASSIGNMENT_ENVELOPE");
  });

  it("returns INVALID_ASSIGNMENT_ENVELOPE when payload is empty or whitespace", () => {
    const result = deserializeAssignmentEnvelope("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ASSIGNMENT_ENVELOPE");
  });

  it("returns INVALID_ASSIGNMENT_ENVELOPE when payload is malformed JSON", () => {
    const result = deserializeAssignmentEnvelope("{ broken json ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ASSIGNMENT_ENVELOPE");
    expect(result.error.message).toContain("invalid JSON");
  });

  it("returns INVALID_ASSIGNMENT_ENVELOPE when payload does not conform to schema", () => {
    const invalidEnvelope = {
      id: "assign-evt-1",
      aggregateType: "NotTaskAssignment", // incorrect aggregateType
      data: { foo: "bar" },
    };

    const result = deserializeAssignmentEnvelope(JSON.stringify(invalidEnvelope));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ASSIGNMENT_ENVELOPE");
    expect(result.error.message).toContain("schema validation");
  });
});
