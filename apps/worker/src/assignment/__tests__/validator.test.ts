import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { TaskAssignmentValidator } from "../validator.js";

describe("TaskAssignmentValidator (Phase 11B — Commit 2)", () => {
  const currentWorkerId = workerId("worker-local-1");
  const validator = new TaskAssignmentValidator({
    workerId: currentWorkerId,
    capabilities: {
      taskTypes: ["compute", "analysis"],
      tools: ["calc"],
      maxConcurrency: 2,
    },
  });

  const baseTask = {
    id: taskId("task-10"),
    name: "compute",
    status: "pending" as const,
    description: "Run compute workload",
    attemptCount: 0,
    version: 1,
  };

  it("validates target worker matching", () => {
    // Matches
    const matching = validator.validateTarget({
      assignmentId: assignmentId("assign-1"),
      taskId: taskId("task-10"),
      runId: runId("run-1"),
      workerId: currentWorkerId,
      task: baseTask,
      assignedAt: new Date().toISOString(),
    });
    expect(matching.isTargeted).toBe(true);

    // Mismatched
    const mismatched = validator.validateTarget({
      assignmentId: assignmentId("assign-1"),
      taskId: taskId("task-10"),
      runId: runId("run-1"),
      workerId: workerId("worker-remote-2"),
      task: baseTask,
      assignedAt: new Date().toISOString(),
    });
    expect(mismatched.isTargeted).toBe(false);
    expect(mismatched.reason).toContain("worker-remote-2");

    // Missing workerId
    const missing = validator.validateTarget({
      assignmentId: assignmentId("assign-1"),
      taskId: taskId("task-10"),
      runId: runId("run-1"),
      task: baseTask,
      assignedAt: new Date().toISOString(),
    });
    expect(missing.isTargeted).toBe(false);
  });

  it("validates task capability compatibility", () => {
    // Supported capability
    const supported = validator.validateCapabilities({
      assignmentId: assignmentId("assign-1"),
      taskId: taskId("task-10"),
      runId: runId("run-1"),
      workerId: currentWorkerId,
      task: baseTask,
      assignedAt: new Date().toISOString(),
    });
    expect(supported.ok).toBe(true);

    // Unsupported capability
    const unsupported = validator.validateCapabilities({
      assignmentId: assignmentId("assign-2"),
      taskId: taskId("task-11"),
      runId: runId("run-1"),
      workerId: currentWorkerId,
      task: {
        ...baseTask,
        name: "unsupported_ml_task",
      },
      assignedAt: new Date().toISOString(),
    });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.error.code).toBe("ASSIGNMENT_CAPABILITY_MISMATCH");
    }
  });

  it("accepts all task types when worker has wildcard '*' capability", () => {
    const wildcardValidator = new TaskAssignmentValidator({
      workerId: currentWorkerId,
      capabilities: {
        taskTypes: ["*"],
        tools: [],
        maxConcurrency: 1,
      },
    });

    const result = wildcardValidator.validateCapabilities({
      assignmentId: assignmentId("assign-3"),
      taskId: taskId("task-12"),
      runId: runId("run-1"),
      workerId: currentWorkerId,
      task: {
        ...baseTask,
        name: "any_arbitrary_task_name",
      },
      assignedAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
  });
});
