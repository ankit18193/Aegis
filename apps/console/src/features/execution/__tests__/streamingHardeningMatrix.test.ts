/**
 * Console Real-Time Execution Streaming Hardening Matrix — Phase 13E (Commit 1)
 *
 * Deterministic test matrix for client-side stream resilience:
 * - Terminal-state monotonicity under out-of-order and delayed event flooding.
 * - Failed run terminal protection against delayed task events.
 * - Authoritative state reconciliation failure and retry handling in useExecutionStream.
 * - Multi-step disconnect/reconnect deduplication chaining across multiple sessions.
 */

import type { Run, Task } from "@aegis/contracts";
import { eventId, runId, taskId, workerId, workflowId } from "@aegis/types";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useExecutionStream } from "../hooks/useExecutionStream";
import { MockExecutionStreamClient } from "../stream/MockExecutionStreamClient";

function createMatrixTestRun(rId: string, status: Run["status"] = "pending"): Run {
  const t1: Task = {
    id: taskId(`task-${rId}-1`),
    runId: runId(rId),
    name: "Task 1",
    status: status === "completed" ? "completed" : "pending",
    description: "Task description 1",
    attemptCount: 0,
    version: 1,
  };

  const t2: Task = {
    id: taskId(`task-${rId}-2`),
    runId: runId(rId),
    name: "Task 2",
    status: status === "completed" ? "completed" : "pending",
    description: "Task description 2",
    attemptCount: 0,
    version: 1,
  };

  return {
    id: runId(rId),
    status,
    goal: `Hardening matrix goal for ${rId}`,
    tasks: [t1, t2],
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Matrix Verification Workflow",
      tasks: [t1, t2],
    },
    progress: status === "completed" ? 100 : 0,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

describe("Console Real-Time Execution Streaming Hardening Matrix (Phase 13E — Commit 1)", () => {
  describe("Matrix 01: Terminal-State Monotonicity Under Out-of-Order Delayed Event Flooding", () => {
    it("locks completed run state and 100% progress against delayed, out-of-order, or conflicting events", () => {
      const client = new MockExecutionStreamClient();
      const completedRun = createMatrixTestRun("run-term-done", "completed");

      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-term-done",
          initialRun: completedRun,
          client,
        }),
      );

      expect(result.current.run?.status).toBe("completed");
      expect(result.current.run?.progress).toBe(100);

      // Flood with delayed/stale events from earlier workflow stages
      act(() => {
        // Delayed workflow_started
        client.emitEvent("run-term-done", {
          id: eventId("evt-late-wf-start"),
          runId: runId("run-term-done"),
          type: "workflow_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Delayed workflow start",
        });

        // Delayed task_started
        client.emitEvent("run-term-done", {
          id: eventId("evt-late-task-start"),
          runId: runId("run-term-done"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Delayed task start",
          taskId: taskId("task-run-term-done-1"),
        });

        // Conflicting late run_failed event
        client.emitEvent("run-term-done", {
          id: eventId("evt-conflicting-fail"),
          runId: runId("run-term-done"),
          type: "run_failed",
          severity: "error",
          timestamp: "2026-10-15T00:00:10.000Z",
          message: "Conflicting run failure",
        });
      });

      // Terminal status and progress MUST be strictly preserved
      expect(result.current.run?.status).toBe("completed");
      expect(result.current.run?.progress).toBe(100);
      expect(result.current.run?.tasks[0]?.status).toBe("completed");
      expect(result.current.events).toHaveLength(3);
    });

    it("locks failed run status against delayed task start events", () => {
      const client = new MockExecutionStreamClient();
      const failedRun = createMatrixTestRun("run-term-failed", "failed");

      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-term-failed",
          initialRun: failedRun,
          client,
        }),
      );

      expect(result.current.run?.status).toBe("failed");

      act(() => {
        // Late task_started arrives for a task
        client.emitEvent("run-term-failed", {
          id: eventId("evt-late-fail-task"),
          runId: runId("run-term-failed"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:05.000Z",
          message: "Late task start",
          taskId: taskId("task-run-term-failed-1"),
        });
      });

      // Run status MUST remain 'failed' (cannot implicitly revert to 'running')
      expect(result.current.run?.status).toBe("failed");
    });
  });

  describe("Matrix 02: Reconciliation Failure and Non-Blocking Recovery in useExecutionStream", () => {
    it("handles onReconcile rejection gracefully and recovers cleanly on subsequent reconcile invocation", async () => {
      const client = new MockExecutionStreamClient();
      const initialRun = createMatrixTestRun("run-rec-retry");

      let attempt = 0;
      let hookRef: ReturnType<typeof renderHook<ReturnType<typeof useExecutionStream>, unknown>> | null = null;

      const onReconcileMock = vi.fn().mockImplementation(() => {
        attempt += 1;
        if (attempt === 1) {
          // First attempt fails (simulated network 503)
          return Promise.reject(new Error("503 Service Unavailable"));
        }
        // Second attempt succeeds and applies authoritative state
        const authoritativeRun: Run = {
          ...initialRun,
          status: "completed",
          progress: 100,
        };
        hookRef?.result.current.reconcileState(authoritativeRun, []);
        return Promise.resolve();
      });

      hookRef = renderHook(() =>
        useExecutionStream({
          runId: "run-rec-retry",
          initialRun,
          client,
          onReconcile: onReconcileMock,
        }),
      );

      // Server emits BUFFER_OVERFLOW requiring reconciliation
      act(() => {
        client.emitError("run-rec-retry", {
          code: "BUFFER_OVERFLOW",
          message: "Live buffer capacity exceeded 500 events",
          reconcileRequired: true,
        });
      });

      expect(onReconcileMock).toHaveBeenCalledTimes(1);
      // Hook must record error without crashing component tree
      expect(hookRef.result.current.error?.code).toBe("BUFFER_OVERFLOW");
      expect(hookRef.result.current.run?.status).toBe("pending");

      // Caller triggers manual retry through exposed reconcile() method
      await act(async () => {
        await hookRef.result.current.reconcile();
      });

      expect(onReconcileMock).toHaveBeenCalledTimes(2);
      expect(hookRef.result.current.run?.status).toBe("completed");
      expect(hookRef.result.current.run?.progress).toBe(100);
    });
  });

  describe("Matrix 03: Multi-Step Disconnect/Reconnect Deduplication Chaining", () => {
    it("chains multiple disconnect and reconnect cycles without event duplication or state regression", () => {
      const client = new MockExecutionStreamClient();
      const initialRun = createMatrixTestRun("run-chain-dedup");

      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-chain-dedup",
          initialRun,
          client,
        }),
      );

      // Step 1: Initial event arrives
      act(() => {
        client.emitEvent("run-chain-dedup", {
          id: eventId("evt-chain-1"),
          runId: runId("run-chain-dedup"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started",
          taskId: taskId("task-run-chain-dedup-1"),
          worker: workerId("worker-1"),
        });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.run?.status).toBe("running");

      // Step 2: Cycle 1 Disconnect -> Reconnect (receives duplicate evt-chain-1 + replayed evt-chain-2)
      act(() => {
        client.setConnectionState("disconnected");
      });
      expect(result.current.connectionState).toBe("disconnected");

      act(() => {
        client.setConnectionState("connected");
        // Duplicate
        client.emitEvent("run-chain-dedup", {
          id: eventId("evt-chain-1"),
          runId: runId("run-chain-dedup"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started duplicate",
          taskId: taskId("task-run-chain-dedup-1"),
        });
        // New replayed event
        client.emitEvent("run-chain-dedup", {
          id: eventId("evt-chain-2"),
          runId: runId("run-chain-dedup"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Task 1 completed",
          taskId: taskId("task-run-chain-dedup-1"),
        });
      });

      expect(result.current.events).toHaveLength(2);
      expect(result.current.run?.tasks[0]?.status).toBe("completed");

      // Step 3: Cycle 2 Disconnect -> Reconnect (receives duplicate evt-chain-2 + live evt-chain-3)
      act(() => {
        client.setConnectionState("disconnected");
      });
      expect(result.current.connectionState).toBe("disconnected");

      act(() => {
        client.setConnectionState("connected");
        // Duplicate of evt-chain-2
        client.emitEvent("run-chain-dedup", {
          id: eventId("evt-chain-2"),
          runId: runId("run-chain-dedup"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Task 1 completed duplicate",
          taskId: taskId("task-run-chain-dedup-1"),
        });
        // Live event
        client.emitEvent("run-chain-dedup", {
          id: eventId("evt-chain-3"),
          runId: runId("run-chain-dedup"),
          type: "run_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:03.000Z",
          message: "Run completed successfully",
        });
      });

      expect(result.current.events).toHaveLength(3);
      expect(result.current.events.map((e) => e.id)).toEqual([
        "evt-chain-1",
        "evt-chain-2",
        "evt-chain-3",
      ]);
      expect(result.current.run?.status).toBe("completed");
      expect(result.current.run?.progress).toBe(100);
    });
  });
});
