import { taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { buildTaskAssignment } from "../assignmentBuilder.js";

describe("buildTaskAssignment (Phase 11E — Commit 3)", () => {
  it("builds canonical assignment and envelope conforming to Lock 9 (distinct IDs)", () => {
    const task = {
      id: taskId("task-42"),
      name: "data_clean",
      status: "pending" as const,
      description: "Clean CSV input",
      attemptCount: 0,
      version: 1,
      dependencies: [],
    };
    const targetWorkerId = workerId("worker-node-7");

    const { assignment, envelope } = buildTaskAssignment({
      task,
      workerId: targetWorkerId,
    });

    // Invariant check: TaskId ≠ AssignmentId ≠ WorkerId ≠ RunId
    expect(assignment.assignmentId).toMatch(/^asgn-[0-9a-f-]{36}$/);
    expect(envelope.id).toMatch(/^evt-[0-9a-f-]{36}$/);
    expect(assignment.runId).toMatch(/^run-[0-9a-f-]{36}$/);

    expect(String(assignment.taskId)).not.toBe(String(assignment.assignmentId));
    expect(String(assignment.assignmentId)).not.toBe(String(assignment.workerId));
    expect(String(assignment.runId)).not.toBe(String(assignment.assignmentId));

    // Payload verification
    expect(assignment.taskId).toBe("task-42");
    expect(assignment.workerId).toBe("worker-node-7");
    expect(envelope.aggregateId).toBe("task-42");
    expect(envelope.aggregateType).toBe("TaskAssignment");
    expect(envelope.type).toBe("task_assigned");
    expect(envelope.data).toEqual(assignment);
  });
});
