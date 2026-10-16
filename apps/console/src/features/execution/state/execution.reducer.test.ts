import type { Run, RunEvent, Task } from "@aegis/contracts";
import { eventId, runId, taskId, workflowId, workerId } from "@aegis/types";
import { describe, expect, it } from "vitest";

import {
  initialExecutionState,
  reduceExecutionState,
} from "./execution.reducer";

function createMockRun(rId = "run-100", initialStatus: Run["status"] = "pending"): Run {
  const t1: Task = {
    id: taskId("task-1"),
    runId: runId(rId),
    name: "Analyze Input",
    status: "pending",
    description: "Analyze goal parameters",
    attemptCount: 0,
    version: 1,
  };

  const t2: Task = {
    id: taskId("task-2"),
    runId: runId(rId),
    name: "Execute Plan",
    status: "pending",
    description: "Run execution steps",
    attemptCount: 0,
    version: 1,
  };

  return {
    id: runId(rId),
    status: initialStatus,
    goal: "Verify real-time execution state model",
    tasks: [t1, t2],
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Verification Workflow",
      tasks: [t1, t2],
    },
    progress: 0,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

function createEvent(
  idStr: string,
  type: RunEvent["type"],
  options?: {
    runIdStr?: string;
    taskIdStr?: string;
    worker?: string;
    message?: string;
    metadata?: Record<string, unknown>;
    timestamp?: string;
  },
): RunEvent {
  const rId = options?.runIdStr ?? "run-100";
  return {
    id: eventId(idStr),
    runId: runId(rId),
    type,
    severity: "info",
    timestamp: options?.timestamp ?? "2026-10-15T00:00:10.000Z",
    message: options?.message ?? `Event ${type} triggered`,
    taskId: options?.taskIdStr ? taskId(options.taskIdStr) : undefined,
    taskName: options?.taskIdStr ? `Task ${options.taskIdStr}` : undefined,
    worker: options?.worker ? workerId(options.worker) : undefined,
    metadata: options?.metadata,
  };
}

describe("Execution State Model & Event Reducer", () => {
  it("initializes run and populates initial timeline events", () => {
    const run = createMockRun("run-init");
    const initialEvt = createEvent("evt-init", "run_created");

    const state = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run, initialEvents: [initialEvt] },
    });

    expect(state.run?.id).toBe("run-init");
    expect(state.events).toHaveLength(1);
    expect(state.seenEventIds.has("evt-init")).toBe(true);
    expect(state.lastEventTimestamp).toBe(initialEvt.timestamp);
  });

  it("resets state back to clean initial state on RESET action", () => {
    const run = createMockRun();
    let state = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run },
    });

    expect(state.run).not.toBeNull();

    state = reduceExecutionState(state, { type: "RESET" });
    expect(state.run).toBeNull();
    expect(state.events).toEqual([]);
    expect(state.seenEventIds.size).toBe(0);
  });

  it("deduplicates incoming events by event ID without mutating state", () => {
    const run = createMockRun();
    let state = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run },
    });

    const evt1 = createEvent("evt-dup-1", "workflow_started");
    state = reduceExecutionState(state, { type: "STREAM_EVENT", payload: evt1 });

    expect(state.run?.status).toBe("running");
    expect(state.events).toHaveLength(1);

    // Re-dispatching the exact same event ID must be safely ignored
    const duplicateState = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: evt1,
    });

    expect(duplicateState).toBe(state); // Identical reference
    expect(duplicateState.events).toHaveLength(1);
  });

  it("handles workflow progression: pending -> running -> completed with progress computation", () => {
    const run = createMockRun();
    let state = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run },
    });

    expect(state.run?.status).toBe("pending");
    expect(state.run?.progress).toBe(0);

    // 1. Task 1 scheduled
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-1", "task_scheduled", { taskIdStr: "task-1" }),
    });
    expect(state.run?.tasks[0]?.status).toBe("queued");

    // 2. Task 1 starts
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-2", "task_started", {
        taskIdStr: "task-1",
        worker: "worker-alpha",
      }),
    });
    expect(state.run?.status).toBe("running"); // implicit transition
    expect(state.run?.tasks[0]?.status).toBe("running");
    expect(state.run?.tasks[0]?.workerId).toBe("worker-alpha");

    // 3. Task 1 completes (1/2 tasks = 50% progress)
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-3", "task_completed", {
        taskIdStr: "task-1",
        metadata: { output: "Analysis completed successfully" },
      }),
    });
    expect(state.run?.tasks[0]?.status).toBe("completed");
    expect(state.run?.tasks[0]?.output).toBe("Analysis completed successfully");
    expect(state.run?.progress).toBe(50);

    // 4. Task 2 starts & completes (2/2 tasks completed -> caps at 95% until run_completed)
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-4", "task_started", { taskIdStr: "task-2" }),
    });
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-5", "task_completed", { taskIdStr: "task-2" }),
    });
    expect(state.run?.tasks[1]?.status).toBe("completed");
    expect(state.run?.progress).toBe(95);

    // 5. Run completed event sets final 100% progress and completedAt
    const finishTime = "2026-10-15T00:01:00.000Z";
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-6", "run_completed", {
        timestamp: finishTime,
        metadata: {
          result: {
            summary: "Workflow finished cleanly",
          },
        },
      }),
    });

    expect(state.run?.status).toBe("completed");
    expect(state.run?.progress).toBe(100);
    expect(state.run?.updatedAt).toBe(finishTime);
    expect(state.run?.result?.summary).toBe("Workflow finished cleanly");
  });

  it("handles task failure, task cancellation, and lease reassignment", () => {
    const run = createMockRun();
    let state = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run },
    });

    // Task 1 fails
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-fail", "task_failed", {
        taskIdStr: "task-1",
        message: "Network connection timed out",
      }),
    });

    expect(state.run?.tasks[0]?.status).toBe("failed");
    expect(state.run?.tasks[0]?.error).toBe("Network connection timed out");

    // Task 2 cancelled
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-cancel", "task_cancelled", {
        taskIdStr: "task-2",
      }),
    });

    expect(state.run?.tasks[1]?.status).toBe("cancelled");
  });

  it("handles lease expiration and task reassignment metadata", () => {
    const run = createMockRun();
    let state = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run },
    });

    // Start task 1
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-start", "task_started", {
        taskIdStr: "task-1",
        worker: "worker-dead",
      }),
    });

    expect(state.run?.tasks[0]?.status).toBe("running");

    // Lease expires -> transitions task to retrying
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-expire", "task_lease_expired", {
        taskIdStr: "task-1",
      }),
    });

    expect(state.run?.tasks[0]?.status).toBe("retrying");
    expect(state.run?.tasks[0]?.leaseExpiredAt).toBeDefined();

    // Reassigned to new worker
    state = reduceExecutionState(state, {
      type: "STREAM_EVENT",
      payload: createEvent("evt-reassign", "task_reassigned", {
        taskIdStr: "task-1",
        metadata: {
          newWorkerId: "worker-healthy",
          newLeaseId: "lease-xyz",
          attemptCount: 2,
        },
      }),
    });

    expect(state.run?.tasks[0]?.workerId).toBe("worker-healthy");
    expect(state.run?.tasks[0]?.leaseId).toBe("lease-xyz");
    expect(state.run?.tasks[0]?.attemptCount).toBe(2);
    expect(state.run?.tasks[0]?.leaseExpiredAt).toBeUndefined();
  });

  describe("Terminal State Protection & State Regression Lockout", () => {
    it("protects terminal run status ('completed', 'failed', 'cancelled') against regressions", () => {
      // Completed run
      const completedRun = createMockRun("run-done", "completed");
      let state = reduceExecutionState(initialExecutionState, {
        type: "INIT_RUN",
        payload: { run: completedRun },
      });

      // Late workflow_started event arrives
      state = reduceExecutionState(state, {
        type: "STREAM_EVENT",
        payload: createEvent("evt-late-start", "workflow_started"),
      });

      expect(state.run?.status).toBe("completed"); // Not reverted to running

      // Late run_failed event arrives
      state = reduceExecutionState(state, {
        type: "STREAM_EVENT",
        payload: createEvent("evt-late-fail", "run_failed", { message: "Late failure" }),
      });

      expect(state.run?.status).toBe("completed"); // Not overwritten
    });

    it("protects terminal task status ('completed', 'failed', 'cancelled') against regressions", () => {
      const run = createMockRun();
      let state = reduceExecutionState(initialExecutionState, {
        type: "INIT_RUN",
        payload: { run },
      });

      // Complete task-1
      state = reduceExecutionState(state, {
        type: "STREAM_EVENT",
        payload: createEvent("evt-t1-start", "task_started", { taskIdStr: "task-1" }),
      });
      state = reduceExecutionState(state, {
        type: "STREAM_EVENT",
        payload: createEvent("evt-t1-done", "task_completed", { taskIdStr: "task-1" }),
      });

      expect(state.run?.tasks[0]?.status).toBe("completed");

      // Late task_started event arrives for task-1
      state = reduceExecutionState(state, {
        type: "STREAM_EVENT",
        payload: createEvent("evt-late-t1-start", "task_started", { taskIdStr: "task-1" }),
      });

      expect(state.run?.tasks[0]?.status).toBe("completed"); // Protected from regression

      // Late task_scheduled event arrives for task-1
      state = reduceExecutionState(state, {
        type: "STREAM_EVENT",
        payload: createEvent("evt-late-t1-sched", "task_scheduled", { taskIdStr: "task-1" }),
      });

      expect(state.run?.tasks[0]?.status).toBe("completed"); // Still protected
    });
  });

  it("is completely deterministic: identical event sequence yields identical state", () => {
    const run1 = createMockRun("run-det");
    const run2 = createMockRun("run-det");

    const events: RunEvent[] = [
      createEvent("evt-d1", "workflow_started"),
      createEvent("evt-d2", "task_scheduled", { taskIdStr: "task-1" }),
      createEvent("evt-d3", "task_started", { taskIdStr: "task-1", worker: "worker-a" }),
      createEvent("evt-d4", "tool_invoked", { taskIdStr: "task-1", message: "Step 1" }),
      createEvent("evt-d5", "task_completed", { taskIdStr: "task-1" }),
      createEvent("evt-d6", "run_completed"),
    ];

    let stateA = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run: run1 },
    });
    for (const ev of events) {
      stateA = reduceExecutionState(stateA, { type: "STREAM_EVENT", payload: ev });
    }

    let stateB = reduceExecutionState(initialExecutionState, {
      type: "INIT_RUN",
      payload: { run: run2 },
    });
    for (const ev of events) {
      stateB = reduceExecutionState(stateB, { type: "STREAM_EVENT", payload: ev });
    }

    expect(stateA.run).toEqual(stateB.run);
    expect(stateA.events).toEqual(stateB.events);
    expect(stateA.seenEventIds).toEqual(stateB.seenEventIds);
    expect(stateA.lastEventTimestamp).toEqual(stateB.lastEventTimestamp);
  });

  describe("RECONCILE_STATE Action & State Recovery", () => {
    it("merges authoritative run snapshot and deduplicates reconciled events with seen events", () => {
      const initialRun = createMockRun("run-rec", "running");
      const evt1 = createEvent("evt-1", "workflow_started", { timestamp: "2026-10-15T00:00:01.000Z" });

      let state = reduceExecutionState(initialExecutionState, {
        type: "INIT_RUN",
        payload: { run: initialRun, initialEvents: [evt1] },
      });

      const updatedRun: Run = {
        ...initialRun,
        status: "running",
        progress: 75,
      };

      // Reconciled events containing evt-1 (duplicate) and evt-2 (new)
      const evt2 = createEvent("evt-2", "task_completed", {
        taskIdStr: "task-1",
        timestamp: "2026-10-15T00:00:05.000Z",
      });

      state = reduceExecutionState(state, {
        type: "RECONCILE_STATE",
        payload: {
          run: updatedRun,
          reconciledEvents: [evt1, evt2],
        },
      });

      expect(state.run?.progress).toBe(75);
      expect(state.events).toHaveLength(2);
      expect(state.events[0]?.id).toBe("evt-1");
      expect(state.events[1]?.id).toBe("evt-2");
      expect(state.seenEventIds.has("evt-1")).toBe(true);
      expect(state.seenEventIds.has("evt-2")).toBe(true);
      expect(state.lastEventTimestamp).toBe("2026-10-15T00:00:05.000Z");
    });

    it("sorts merged events chronologically even if arrived out-of-order", () => {
      const run = createMockRun("run-rec-order");
      const evt2 = createEvent("evt-2", "task_started", { timestamp: "2026-10-15T00:00:05.000Z" });

      let state = reduceExecutionState(initialExecutionState, {
        type: "INIT_RUN",
        payload: { run, initialEvents: [evt2] },
      });

      // Older event arrived during reconciliation
      const evt1 = createEvent("evt-1", "workflow_started", { timestamp: "2026-10-15T00:00:01.000Z" });

      state = reduceExecutionState(state, {
        type: "RECONCILE_STATE",
        payload: {
          run,
          reconciledEvents: [evt1],
        },
      });

      expect(state.events).toHaveLength(2);
      expect(state.events[0]?.id).toBe("evt-1");
      expect(state.events[1]?.id).toBe("evt-2");
    });

    it("protects terminal run status from regressing during RECONCILE_STATE", () => {
      const completedRun = createMockRun("run-term", "completed");
      let state = reduceExecutionState(initialExecutionState, {
        type: "INIT_RUN",
        payload: { run: completedRun },
      });

      // Stale snapshot with "running" status arrives
      const staleSnapshot: Run = {
        ...completedRun,
        status: "running",
      };

      state = reduceExecutionState(state, {
        type: "RECONCILE_STATE",
        payload: {
          run: staleSnapshot,
        },
      });

      expect(state.run?.status).toBe("completed"); // Must remain completed
    });

    it("protects terminal task status from regressing during RECONCILE_STATE", () => {
      const run = createMockRun("run-term-task", "running");
      const firstTask = run.tasks[0];
      const secondTask = run.tasks[1];
      expect(firstTask).toBeDefined();
      expect(secondTask).toBeDefined();
      if (!firstTask || !secondTask) return;

      const completedTask = { ...firstTask, status: "completed" as const };
      const runWithCompletedTask: Run = {
        ...run,
        tasks: [completedTask, secondTask],
      };

      let state = reduceExecutionState(initialExecutionState, {
        type: "INIT_RUN",
        payload: { run: runWithCompletedTask },
      });

      // Stale snapshot with task 0 still "running"
      const staleSnapshot: Run = {
        ...runWithCompletedTask,
        tasks: [
          { ...completedTask, status: "running" as const },
          secondTask,
        ],
      };

      state = reduceExecutionState(state, {
        type: "RECONCILE_STATE",
        payload: {
          run: staleSnapshot,
        },
      });

      expect(state.run?.tasks[0]?.status).toBe("completed");
    });

    it("rejects STREAM_EVENT belonging to a different runId", () => {
      const run = createMockRun("run-alpha");
      let state = reduceExecutionState(initialExecutionState, {
        type: "INIT_RUN",
        payload: { run },
      });

      // Event for run-beta arrives
      state = reduceExecutionState(state, {
        type: "STREAM_EVENT",
        payload: createEvent("evt-cross", "task_started", {
          runIdStr: "run-beta",
          taskIdStr: "task-1",
        }),
      });

      expect(state.events).toHaveLength(0);
      expect(state.seenEventIds.has("evt-cross")).toBe(false);
      expect(state.run?.tasks[0]?.status).toBe("pending");
    });
  });
});


