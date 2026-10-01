import { assignmentId, runId, taskId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import { AssignmentTracker } from "../tracker.js";

describe("AssignmentTracker (Phase 11B — Commit 2)", () => {
  it("tracks assignments and detects duplicates", () => {
    const tracker = new AssignmentTracker();
    expect(tracker.size).toBe(0);

    const id = assignmentId("assign-10");
    expect(tracker.isDuplicate(id)).toBe(false);

    tracker.record({
      status: "accepted",
      assignmentId: id,
      taskId: taskId("task-1"),
      runId: runId("run-1"),
      workerId: workerId("worker-1"),
    });

    expect(tracker.size).toBe(1);
    expect(tracker.isDuplicate(id)).toBe(true);

    const recorded = tracker.get(id);
    expect(recorded?.status).toBe("accepted");
  });

  it("evicts oldest entries when maxCapacity is exceeded", () => {
    const tracker = new AssignmentTracker({ maxCapacity: 3 });

    tracker.record({
      status: "accepted",
      assignmentId: assignmentId("assign-1"),
      taskId: taskId("task-1"),
      runId: runId("run-1"),
    });
    tracker.record({
      status: "accepted",
      assignmentId: assignmentId("assign-2"),
      taskId: taskId("task-2"),
      runId: runId("run-1"),
    });
    tracker.record({
      status: "accepted",
      assignmentId: assignmentId("assign-3"),
      taskId: taskId("task-3"),
      runId: runId("run-1"),
    });

    expect(tracker.size).toBe(3);
    expect(tracker.isDuplicate("assign-1")).toBe(true);

    // Record a 4th entry
    tracker.record({
      status: "accepted",
      assignmentId: assignmentId("assign-4"),
      taskId: taskId("task-4"),
      runId: runId("run-1"),
    });

    expect(tracker.size).toBe(3);
    // Oldest (assign-1) should have been evicted
    expect(tracker.isDuplicate("assign-1")).toBe(false);
    expect(tracker.isDuplicate("assign-4")).toBe(true);
  });

  it("clears all records upon clear()", () => {
    const tracker = new AssignmentTracker();
    tracker.record({
      status: "accepted",
      assignmentId: assignmentId("assign-1"),
      taskId: taskId("task-1"),
      runId: runId("run-1"),
    });

    expect(tracker.size).toBe(1);
    tracker.clear();
    expect(tracker.size).toBe(0);
  });
});
