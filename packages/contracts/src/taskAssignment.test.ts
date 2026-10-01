import { assignmentId, eventId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  assignmentErrorCodeSchema,
  assignmentIdSchema,
  assignmentStatusSchema,
  AssignmentStatusValue,
  createAssignmentError,
  taskAssignmentEnvelopeSchema,
  taskAssignmentSchema,
} from "./taskAssignment.js";

describe("Task Assignment Contracts & Schemas (Phase 11B — Commit 1)", () => {
  it("validates assignmentIdSchema with valid branded ID and rejects empty string", () => {
    const validId = assignmentId("assign-12345");
    expect(assignmentIdSchema.parse(validId)).toBe("assign-12345");
    expect(() => assignmentIdSchema.parse("")).toThrow();
  });

  it("validates all canonical assignment statuses including ignored_not_targeted", () => {
    expect(assignmentStatusSchema.parse(AssignmentStatusValue.RECEIVED)).toBe("received");
    expect(assignmentStatusSchema.parse(AssignmentStatusValue.ACCEPTED)).toBe("accepted");
    expect(assignmentStatusSchema.parse(AssignmentStatusValue.REJECTED)).toBe("rejected");
    expect(assignmentStatusSchema.parse(AssignmentStatusValue.IGNORED_NOT_TARGETED)).toBe(
      "ignored_not_targeted",
    );
    expect(() => assignmentStatusSchema.parse("completed")).toThrow();
  });

  it("validates well-formed TaskAssignment payload", () => {
    const validPayload = {
      assignmentId: assignmentId("assign-99"),
      taskId: taskId("task-42"),
      runId: runId("run-10"),
      workerId: workerId("worker-alpha"),
      task: {
        id: taskId("task-42"),
        name: "Compute summary",
        status: "pending",
        description: "Generate report summary",
        attemptCount: 0,
      },
      assignedAt: new Date().toISOString(),
    };

    const parsed = taskAssignmentSchema.parse(validPayload);
    expect(parsed.assignmentId).toBe("assign-99");
    expect(parsed.taskId).toBe("task-42");
    expect(parsed.workerId).toBe("worker-alpha");
    expect(parsed.task.name).toBe("Compute summary");
  });

  it("validates TaskAssignment with optional workerId omitted", () => {
    const payload = {
      assignmentId: assignmentId("assign-100"),
      taskId: taskId("task-43"),
      runId: runId("run-10"),
      task: {
        id: taskId("task-43"),
        name: "Generic task",
        status: "pending",
        description: "",
        attemptCount: 0,
      },
      assignedAt: new Date().toISOString(),
    };

    const parsed = taskAssignmentSchema.parse(payload);
    expect(parsed.workerId).toBeUndefined();
  });

  it("rejects TaskAssignment with invalid datetime or missing required task properties", () => {
    expect(() =>
      taskAssignmentSchema.parse({
        assignmentId: "assign-1",
        taskId: "task-1",
        runId: "run-1",
        task: {},
        assignedAt: "not-a-date",
      }),
    ).toThrow();
  });

  it("validates canonical TaskAssignmentEnvelope with CloudEvents metadata", () => {
    const envelope = {
      id: eventId("evt-assign-1"),
      type: "task_assigned",
      source: "aegis.orchestrator",
      specVersion: "1.0",
      time: new Date().toISOString(),
      aggregateId: taskId("task-42"),
      aggregateType: "TaskAssignment",
      correlationId: "corr-123",
      causationId: "cause-456",
      data: {
        assignmentId: assignmentId("assign-99"),
        taskId: taskId("task-42"),
        runId: runId("run-10"),
        workerId: workerId("worker-alpha"),
        task: {
          id: taskId("task-42"),
          name: "Compute summary",
          status: "pending",
          description: "",
          attemptCount: 0,
        },
        assignedAt: new Date().toISOString(),
      },
    };

    const parsed = taskAssignmentEnvelopeSchema.parse(envelope);
    expect(parsed.specVersion).toBe("1.0");
    expect(parsed.aggregateType).toBe("TaskAssignment");
    expect(parsed.type).toBe("task_assigned");
    expect(parsed.data.assignmentId).toBe("assign-99");
  });

  it("rejects TaskAssignmentEnvelope with invalid aggregateType or specVersion", () => {
    const invalidEnvelope = {
      id: eventId("evt-assign-1"),
      type: "task_assigned",
      source: "aegis.orchestrator",
      specVersion: "2.0", // invalid specVersion
      time: new Date().toISOString(),
      aggregateId: taskId("task-42"),
      aggregateType: "ExecutionRun", // invalid aggregateType for task assignment
      correlationId: "corr-123",
      data: {},
    };

    expect(() => taskAssignmentEnvelopeSchema.parse(invalidEnvelope)).toThrow();
  });

  it("creates structured assignment errors with valid error codes", () => {
    const err = createAssignmentError(
      "ASSIGNMENT_TARGET_MISMATCH",
      "Worker worker-2 is not targeted for assignment assign-1",
      { workerId: "worker-2" },
    );

    expect(err.code).toBe("ASSIGNMENT_TARGET_MISMATCH");
    expect(err.message).toContain("not targeted");
    expect(assignmentErrorCodeSchema.parse(err.code)).toBe("ASSIGNMENT_TARGET_MISMATCH");
  });
});
