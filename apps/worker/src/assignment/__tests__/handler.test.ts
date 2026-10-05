import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { TaskAssignmentHandler } from "../handler.js";
import { AssignmentTracker } from "../tracker.js";
import { TaskAssignmentValidator } from "../validator.js";

describe("TaskAssignmentHandler (Phase 11B — Commit 2)", () => {
  const currentWorkerId = workerId("worker-1");
  const validator = new TaskAssignmentValidator({
    workerId: currentWorkerId,
    capabilities: {
      taskTypes: ["compute"],
      tools: [],
      maxConcurrency: 1,
    },
  });

  const baseTask = {
    id: taskId("task-1"),
    name: "compute",
    status: "pending" as const,
    description: "",
    attemptCount: 0,
    version: 1,
  };

  it("accepts valid targeted assignment", () => {
    const tracker = new AssignmentTracker();
    const handler = new TaskAssignmentHandler({ validator, tracker });

    const assignment = {
      assignmentId: assignmentId("assign-1"),
      taskId: taskId("task-1"),
      runId: runId("run-1"),
      workerId: currentWorkerId,
      task: baseTask,
      assignedAt: new Date().toISOString(),
    };

    const result = handler.handleAssignment(assignment);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("accepted");
      expect(result.value.assignmentId).toBe("assign-1");
    }

    expect(tracker.isDuplicate("assign-1")).toBe(true);
  });

  it("explicitly models wrong-worker assignment as ignored_not_targeted without failing", () => {
    const tracker = new AssignmentTracker();
    const handler = new TaskAssignmentHandler({ validator, tracker });

    const assignment = {
      assignmentId: assignmentId("assign-2"),
      taskId: taskId("task-1"),
      runId: runId("run-1"),
      workerId: workerId("worker-different"),
      task: baseTask,
      assignedAt: new Date().toISOString(),
    };

    const result = handler.handleAssignment(assignment);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("ignored_not_targeted");
    }

    // Should NOT be tracked as accepted work
    expect(tracker.isDuplicate("assign-2")).toBe(false);
  });

  it("suppresses duplicate assignments with structured error", () => {
    const tracker = new AssignmentTracker();
    const handler = new TaskAssignmentHandler({ validator, tracker });

    const assignment = {
      assignmentId: assignmentId("assign-3"),
      taskId: taskId("task-1"),
      runId: runId("run-1"),
      workerId: currentWorkerId,
      task: baseTask,
      assignedAt: new Date().toISOString(),
    };

    // First time
    const res1 = handler.handleAssignment(assignment);
    expect(res1.ok).toBe(true);

    // Second time (duplicate)
    const res2 = handler.handleAssignment(assignment);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error.code).toBe("DUPLICATE_ASSIGNMENT");
    }
  });

  it("records and returns rejected status when capabilities do not match", () => {
    const tracker = new AssignmentTracker();
    const handler = new TaskAssignmentHandler({ validator, tracker });

    const assignment = {
      assignmentId: assignmentId("assign-4"),
      taskId: taskId("task-1"),
      runId: runId("run-1"),
      workerId: currentWorkerId,
      task: {
        ...baseTask,
        name: "unsupported_data_pipeline",
      },
      assignedAt: new Date().toISOString(),
    };

    const result = handler.handleAssignment(assignment);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("rejected");
      expect(result.value.reason).toContain("does not support task type");
    }

    expect(tracker.isDuplicate("assign-4")).toBe(true);
    expect(tracker.get("assign-4")?.status).toBe("rejected");
  });
});

