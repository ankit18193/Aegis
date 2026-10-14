import type { Run, Task } from "@aegis/contracts";
import { eventId, runId, taskId, workerId, workflowId } from "@aegis/types";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MockExecutionStreamClient,
  useExecutionStream,
} from "../index";

function createMultiTaskRun(id: string, taskCount: number): Run {
  const tasks: Task[] = Array.from({ length: taskCount }, (_, i) => {
    const taskIndex = String(i + 1);
    return {
      id: taskId(`task-${id}-${taskIndex}`),
      runId: runId(id),
      name: `Task ${taskIndex}`,
      status: "pending",
      description: `Description for task ${taskIndex}`,
      attemptCount: 0,
      version: 1,
    };
  });

  return {
    id: runId(id),
    status: "pending",
    goal: `Execute distributed pipeline for ${id}`,
    tasks,
    workflow: {
      id: workflowId(`wf-${id}`),
      name: `Pipeline ${id}`,
      tasks,
    },
    progress: 0,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

describe("Real-Time Execution Foundation — End-to-End Integration Tests", () => {
  let client: MockExecutionStreamClient;

  beforeEach(() => {
    client = new MockExecutionStreamClient();
  });

  describe("Complete Multi-Task Execution Lifecycle", () => {
    it("progresses sequentially from pending through running to completed with dynamic progress", () => {
      const initialRun = createMultiTaskRun("run-e2e-1", 3);
      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-e2e-1",
          initialRun,
          client,
        }),
      );

      expect(result.current.run?.status).toBe("pending");
      expect(result.current.run?.progress).toBe(0);
      expect(result.current.events).toHaveLength(0);

      // 1. Task 1 starts
      act(() => {
        client.emitEvent("run-e2e-1", {
          id: eventId("evt-t1-start"),
          runId: runId("run-e2e-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started execution",
          taskId: taskId("task-run-e2e-1-1"),
          worker: workerId("worker-node-1"),
        });
      });

      expect(result.current.run?.status).toBe("running");
      expect(result.current.run?.tasks[0]?.status).toBe("running");
      expect(result.current.run?.tasks[0]?.worker).toBe("worker-node-1");

      // 2. Task 1 completes -> progress advances to 33%
      act(() => {
        client.emitEvent("run-e2e-1", {
          id: eventId("evt-t1-complete"),
          runId: runId("run-e2e-1"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Task 1 completed successfully",
          taskId: taskId("task-run-e2e-1-1"),
          metadata: { output: "Output dataset generated" },
        });
      });

      expect(result.current.run?.tasks[0]?.status).toBe("completed");
      expect(result.current.run?.tasks[0]?.output).toBe("Output dataset generated");
      expect(result.current.run?.progress).toBe(33);

      // 3. Task 2 starts and completes -> progress advances to 67%
      act(() => {
        client.emitEvent("run-e2e-1", {
          id: eventId("evt-t2-start"),
          runId: runId("run-e2e-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:03.000Z",
          message: "Task 2 started execution",
          taskId: taskId("task-run-e2e-1-2"),
          worker: workerId("worker-node-2"),
        });
        client.emitEvent("run-e2e-1", {
          id: eventId("evt-t2-complete"),
          runId: runId("run-e2e-1"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:04.000Z",
          message: "Task 2 completed successfully",
          taskId: taskId("task-run-e2e-1-2"),
        });
      });

      expect(result.current.run?.tasks[1]?.status).toBe("completed");
      expect(result.current.run?.progress).toBe(67);

      // 4. Task 3 starts and completes -> progress capped at 95% until run completes
      act(() => {
        client.emitEvent("run-e2e-1", {
          id: eventId("evt-t3-start"),
          runId: runId("run-e2e-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:05.000Z",
          message: "Task 3 started execution",
          taskId: taskId("task-run-e2e-1-3"),
        });
        client.emitEvent("run-e2e-1", {
          id: eventId("evt-t3-complete"),
          runId: runId("run-e2e-1"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:06.000Z",
          message: "Task 3 completed successfully",
          taskId: taskId("task-run-e2e-1-3"),
        });
      });

      expect(result.current.run?.tasks[2]?.status).toBe("completed");
      expect(result.current.run?.progress).toBe(95);

      // 5. Run completion event arrives -> progress snaps to 100% and result is captured
      act(() => {
        client.emitEvent("run-e2e-1", {
          id: eventId("evt-run-complete"),
          runId: runId("run-e2e-1"),
          type: "run_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:07.000Z",
          message: "Run finished successfully",
          metadata: {
            result: {
              summary: "Pipeline execution succeeded across all 3 nodes.",
              reportMarkdown: "# Execution Report\n\nAll tasks verified.",
            },
          },
        });
      });

      expect(result.current.run?.status).toBe("completed");
      expect(result.current.run?.progress).toBe(100);
      expect(result.current.run?.result?.summary).toBe(
        "Pipeline execution succeeded across all 3 nodes.",
      );
      expect(result.current.events).toHaveLength(7);
    });
  });

  describe("Failure and Cancellation Lifecycles", () => {
    it("handles task and run failure with detailed error preservation", () => {
      const initialRun = createMultiTaskRun("run-fail-1", 2);
      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-fail-1",
          initialRun,
          client,
        }),
      );

      act(() => {
        client.emitEvent("run-fail-1", {
          id: eventId("evt-f-start"),
          runId: runId("run-fail-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started",
          taskId: taskId("task-run-fail-1-1"),
        });
        client.emitEvent("run-fail-1", {
          id: eventId("evt-f-fail"),
          runId: runId("run-fail-1"),
          type: "task_failed",
          severity: "error",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Process OOM Killed",
          taskId: taskId("task-run-fail-1-1"),
          metadata: { error: "Fatal error: Process exceeded 2GB memory ceiling." },
        });
        client.emitEvent("run-fail-1", {
          id: eventId("evt-r-fail"),
          runId: runId("run-fail-1"),
          type: "run_failed",
          severity: "error",
          timestamp: "2026-10-15T00:00:03.000Z",
          message: "Run aborted due to unrecoverable task failure.",
        });
      });

      expect(result.current.run?.status).toBe("failed");
      expect(result.current.run?.tasks[0]?.status).toBe("failed");
      expect(result.current.run?.tasks[0]?.error).toBe(
        "Fatal error: Process exceeded 2GB memory ceiling.",
      );
      expect(result.current.run?.tasks[1]?.status).toBe("pending");
    });

    it("handles execution cancellation cleanly", () => {
      const initialRun = createMultiTaskRun("run-cancel-1", 2);
      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-cancel-1",
          initialRun,
          client,
        }),
      );

      act(() => {
        client.emitEvent("run-cancel-1", {
          id: eventId("evt-c-start"),
          runId: runId("run-cancel-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 running",
          taskId: taskId("task-run-cancel-1-1"),
        });
        client.emitEvent("run-cancel-1", {
          id: eventId("evt-c-task"),
          runId: runId("run-cancel-1"),
          type: "task_cancelled",
          severity: "warn",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Task cancelled by user",
          taskId: taskId("task-run-cancel-1-1"),
        });
        client.emitEvent("run-cancel-1", {
          id: eventId("evt-c-run"),
          runId: runId("run-cancel-1"),
          type: "run_cancelled",
          severity: "warn",
          timestamp: "2026-10-15T00:00:03.000Z",
          message: "Run cancelled by user request",
        });
      });

      expect(result.current.run?.status).toBe("cancelled");
      expect(result.current.run?.tasks[0]?.status).toBe("cancelled");
      expect(result.current.run?.tasks[0]?.completedAt).toBe("2026-10-15T00:00:02.000Z");
    });
  });

  describe("Distributed Lease Expiration and Worker Reassignment", () => {
    it("transitions task to retrying on lease expiration and updates worker on reassignment", () => {
      const initialRun = createMultiTaskRun("run-reassign-1", 1);
      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-reassign-1",
          initialRun,
          client,
        }),
      );

      // Task initially starts on worker-A
      act(() => {
        client.emitEvent("run-reassign-1", {
          id: eventId("evt-start-a"),
          runId: runId("run-reassign-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task started on worker-A",
          taskId: taskId("task-run-reassign-1-1"),
          worker: workerId("worker-A"),
        });
      });

      expect(result.current.run?.tasks[0]?.status).toBe("running");
      expect(result.current.run?.tasks[0]?.worker).toBe("worker-A");

      // Lease expires
      act(() => {
        client.emitEvent("run-reassign-1", {
          id: eventId("evt-lease-exp"),
          runId: runId("run-reassign-1"),
          type: "task_lease_expired",
          severity: "warn",
          timestamp: "2026-10-15T00:00:10.000Z",
          message: "Heartbeat missed: lease expired on worker-A",
          taskId: taskId("task-run-reassign-1-1"),
        });
      });

      expect(result.current.run?.tasks[0]?.status).toBe("retrying");
      expect(result.current.run?.tasks[0]?.leaseExpiredAt).toBe("2026-10-15T00:00:10.000Z");

      // Orchestrator reassigns to worker-B with new lease ID and attemptCount = 1
      act(() => {
        client.emitEvent("run-reassign-1", {
          id: eventId("evt-reassigned"),
          runId: runId("run-reassign-1"),
          type: "task_reassigned",
          severity: "info",
          timestamp: "2026-10-15T00:00:11.000Z",
          message: "Reassigned task to worker-B",
          taskId: taskId("task-run-reassign-1-1"),
          worker: workerId("worker-B"),
          metadata: {
            newWorkerId: "worker-B",
            newLeaseId: "lease-xyz-789",
            attemptCount: 1,
          },
        });
      });

      expect(result.current.run?.tasks[0]?.worker).toBe("worker-B");
      expect(result.current.run?.tasks[0]?.workerId).toBe("worker-B");
      expect(result.current.run?.tasks[0]?.leaseId).toBe("lease-xyz-789");
      expect(result.current.run?.tasks[0]?.attemptCount).toBe(1);
      expect(result.current.run?.tasks[0]?.leaseExpiredAt).toBeUndefined();

      // Worker B picks it up and finishes
      act(() => {
        client.emitEvent("run-reassign-1", {
          id: eventId("evt-start-b"),
          runId: runId("run-reassign-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:12.000Z",
          message: "Worker-B picked up execution",
          taskId: taskId("task-run-reassign-1-1"),
          worker: workerId("worker-B"),
        });
        client.emitEvent("run-reassign-1", {
          id: eventId("evt-finish-b"),
          runId: runId("run-reassign-1"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:15.000Z",
          message: "Worker-B completed task",
          taskId: taskId("task-run-reassign-1-1"),
        });
      });

      expect(result.current.run?.tasks[0]?.status).toBe("completed");
    });
  });

  describe("Stream Robustness: Deduplication and Terminal Protection", () => {
    it("deduplicates identical events and ignores retroactive regressions on terminal states", () => {
      const initialRun = createMultiTaskRun("run-dedup-1", 1);
      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-dedup-1",
          initialRun,
          client,
        }),
      );

      // Start and complete task
      act(() => {
        client.emitEvent("run-dedup-1", {
          id: eventId("evt-exact-1"),
          runId: runId("run-dedup-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Started",
          taskId: taskId("task-run-dedup-1-1"),
        });
        client.emitEvent("run-dedup-1", {
          id: eventId("evt-exact-2"),
          runId: runId("run-dedup-1"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Completed",
          taskId: taskId("task-run-dedup-1-1"),
        });
        client.emitEvent("run-dedup-1", {
          id: eventId("evt-exact-3"),
          runId: runId("run-dedup-1"),
          type: "run_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:03.000Z",
          message: "Run completed",
        });
      });

      expect(result.current.run?.status).toBe("completed");
      expect(result.current.run?.tasks[0]?.status).toBe("completed");
      expect(result.current.events).toHaveLength(3);

      // Re-emitting identical event ID is discarded by deduplication
      act(() => {
        client.emitEvent("run-dedup-1", {
          id: eventId("evt-exact-2"),
          runId: runId("run-dedup-1"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Duplicate Completed",
          taskId: taskId("task-run-dedup-1-1"),
        });
      });

      expect(result.current.events).toHaveLength(3);

      // Emitting a new event attempting to regress completed task to running is rejected
      act(() => {
        client.emitEvent("run-dedup-1", {
          id: eventId("evt-regression-task"),
          runId: runId("run-dedup-1"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:04.000Z",
          message: "Late start event",
          taskId: taskId("task-run-dedup-1-1"),
        });
      });

      expect(result.current.run?.tasks[0]?.status).toBe("completed"); // Protected!

      // Emitting a new event attempting to regress completed run to running is rejected
      act(() => {
        client.emitEvent("run-dedup-1", {
          id: eventId("evt-regression-run"),
          runId: runId("run-dedup-1"),
          type: "workflow_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:05.000Z",
          message: "Late workflow start event",
        });
      });

      expect(result.current.run?.status).toBe("completed"); // Protected!
      expect(result.current.events).toHaveLength(5); // Non-duplicate events still recorded in timeline
    });
  });

  describe("Subscription Isolation and Fast Navigation", () => {
    it("unsubscribes previous run cleanly and prevents crosstalk when switching runs rapidly", () => {
      const runAlpha = createMultiTaskRun("alpha", 1);
      const runBeta = createMultiTaskRun("beta", 1);

      let activeId = "alpha";
      let activeRun = runAlpha;

      const { result, rerender, unmount } = renderHook(() =>
        useExecutionStream({
          runId: activeId,
          initialRun: activeRun,
          client,
        }),
      );

      expect(result.current.run?.id).toBe("alpha");
      expect(client.getSubscriberCount("alpha")).toBe(1);
      expect(client.getSubscriberCount("beta")).toBe(0);

      // Switch to Beta
      activeId = "beta";
      activeRun = runBeta;
      rerender();

      expect(result.current.run?.id).toBe("beta");
      expect(client.getSubscriberCount("alpha")).toBe(0);
      expect(client.getSubscriberCount("beta")).toBe(1);

      // Send event to Alpha — should NOT be received by Beta hook
      act(() => {
        client.emitEvent("alpha", {
          id: eventId("evt-alpha-ghost"),
          runId: runId("alpha"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:20.000Z",
          message: "Ghost event on Alpha",
        });
      });

      expect(result.current.events).toHaveLength(0);

      // Send event to Beta — delivered properly
      act(() => {
        client.emitEvent("beta", {
          id: eventId("evt-beta-legit"),
          runId: runId("beta"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:21.000Z",
          message: "Legit event on Beta",
          taskId: taskId("task-beta-1"),
        });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.run?.tasks[0]?.status).toBe("running");

      // Unmount hook
      unmount();
      expect(client.getSubscriberCount("beta")).toBe(0);
    });
  });
});
