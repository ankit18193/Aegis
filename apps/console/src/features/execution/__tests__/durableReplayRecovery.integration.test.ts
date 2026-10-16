/**
 * Console Durable Replay & State Recovery Integration Suite — Phase 13D (Commit 5)
 *
 * Verifies end-to-end client-side resilience when reconnecting, receiving replayed events,
 * detecting buffer overflow / replay gaps, and performing authoritative state reconciliation.
 */

import type { Run, Task } from "@aegis/contracts";
import { eventId, runId, taskId, workerId, workflowId } from "@aegis/types";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useExecutionStream } from "../hooks/useExecutionStream";
import { MockExecutionStreamClient } from "../stream/MockExecutionStreamClient";

function createTestRun(rId: string, status: Run["status"] = "pending"): Run {
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
    goal: `Integration goal for ${rId}`,
    tasks: [t1, t2],
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Test Workflow",
      tasks: [t1, t2],
    },
    progress: status === "completed" ? 100 : 0,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

describe("Console Durable Replay & State Recovery Integration Suite (Phase 13D)", () => {
  describe("Disconnect, Reconnect & Replay Catch-up", () => {
    it("tracks last seen event ID and absorbs replayed events without duplicating timeline", () => {
      const client = new MockExecutionStreamClient();
      const initialRun = createTestRun("run-conn-replay");

      const { result } = renderHook(() =>
        useExecutionStream({
          runId: "run-conn-replay",
          initialRun,
          client,
        }),
      );

      // 1. Initial live event arrives
      act(() => {
        client.emitEvent("run-conn-replay", {
          id: eventId("evt-live-1"),
          runId: runId("run-conn-replay"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started",
          taskId: taskId("task-run-conn-replay-1"),
          worker: workerId("worker-1"),
        });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.run?.status).toBe("running");

      // 2. Disconnect happens
      act(() => {
        client.setConnectionState("disconnected");
      });
      expect(result.current.connectionState).toBe("disconnected");

      // 3. Reconnect occurs: replayed events arrive (including evt-live-1 duplicate and evt-replay-2)
      act(() => {
        client.setConnectionState("connected");
        // Duplicate of evt-live-1
        client.emitEvent("run-conn-replay", {
          id: eventId("evt-live-1"),
          runId: runId("run-conn-replay"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started (replayed)",
          taskId: taskId("task-run-conn-replay-1"),
        });
        // Missed event 2
        client.emitEvent("run-conn-replay", {
          id: eventId("evt-replay-2"),
          runId: runId("run-conn-replay"),
          type: "task_completed",
          severity: "info",
          timestamp: "2026-10-15T00:00:02.000Z",
          message: "Task 1 completed (replayed)",
          taskId: taskId("task-run-conn-replay-1"),
        });
      });

      // Deduplicated: only 2 total events
      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[0]?.id).toBe("evt-live-1");
      expect(result.current.events[1]?.id).toBe("evt-replay-2");
      expect(result.current.run?.tasks[0]?.status).toBe("completed");
    });
  });

  describe("Server Buffer Overflow Recovery Flow", () => {
    it("handles BUFFER_OVERFLOW by invoking onReconcile and applying authoritative state snapshot", () => {
      const client = new MockExecutionStreamClient();
      const initialRun = createTestRun("run-overflow-rec");

      const task0 = initialRun.tasks[0];
      const task1 = initialRun.tasks[1];
      if (!task0 || !task1) {
        throw new Error("Initial tasks must exist");
      }

      // Mock authoritative REST API data
      const authoritativeRun: Run = {
        ...initialRun,
        status: "running",
        progress: 50,
        tasks: [
          {
            ...task0,
            status: "completed",
            output: "Authoritative output",
          },
          {
            ...task1,
            status: "running",
          },
        ],
      };

      const authoritativeEvents = [
        {
          id: eventId("evt-auth-1"),
          runId: runId("run-overflow-rec"),
          type: "task_started" as const,
          severity: "info" as const,
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started",
        },
        {
          id: eventId("evt-auth-2"),
          runId: runId("run-overflow-rec"),
          type: "task_completed" as const,
          severity: "info" as const,
          timestamp: "2026-10-15T00:00:05.000Z",
          message: "Task 1 completed",
        },
      ];

      let hookRef: ReturnType<typeof renderHook<ReturnType<typeof useExecutionStream>, unknown>> | null = null;

      const onReconcileMock = vi.fn().mockImplementation(() => {
        // Simulates REST fetch and dispatching reconcileState
        hookRef?.result.current.reconcileState(authoritativeRun, authoritativeEvents);
        return Promise.resolve();
      });

      hookRef = renderHook(() =>
        useExecutionStream({
          runId: "run-overflow-rec",
          initialRun,
          client,
          onReconcile: onReconcileMock,
        }),
      );

      // Server emits BUFFER_OVERFLOW
      act(() => {
        client.emitError("run-overflow-rec", {
          code: "BUFFER_OVERFLOW",
          message: "Buffer overflow: Replay buffer exceeded 500 events",
          reconcileRequired: true,
        });
      });

      expect(onReconcileMock).toHaveBeenCalledWith("run-overflow-rec");

      // State is now reconciled with authoritative data
      expect(hookRef.result.current.run?.progress).toBe(50);
      expect(hookRef.result.current.run?.tasks[0]?.status).toBe("completed");
      expect(hookRef.result.current.run?.tasks[1]?.status).toBe("running");
      expect(hookRef.result.current.events).toHaveLength(2);
      expect(hookRef.result.current.events[1]?.id).toBe("evt-auth-2");
    });
  });

  describe("Replay Gap Recovery Flow", () => {
    it("handles REPLAY_GAP_DETECTED by invoking onReconcile and recovering missing history", () => {
      const client = new MockExecutionStreamClient();
      const initialRun = createTestRun("run-gap-rec");

      const authoritativeRun: Run = {
        ...initialRun,
        status: "completed",
        progress: 100,
      };

      let hookRef: ReturnType<typeof renderHook<ReturnType<typeof useExecutionStream>, unknown>> | null = null;

      const onReconcileMock = vi.fn().mockImplementation(() => {
        hookRef?.result.current.reconcileState(authoritativeRun, []);
        return Promise.resolve();
      });

      hookRef = renderHook(() =>
        useExecutionStream({
          runId: "run-gap-rec",
          initialRun,
          client,
          onReconcile: onReconcileMock,
        }),
      );

      act(() => {
        client.emitError("run-gap-rec", {
          code: "REPLAY_GAP_DETECTED",
          message: "Replay gap detected: Unknown cursor position",
          reconcileRequired: true,
        });
      });

      expect(onReconcileMock).toHaveBeenCalledWith("run-gap-rec");
      expect(hookRef.result.current.run?.status).toBe("completed");
      expect(hookRef.result.current.run?.progress).toBe(100);
    });

    it("guards against concurrent duplicate reconciliation invocations", async () => {
      const client = new MockExecutionStreamClient();
      const initialRun = createTestRun("run-dedup-rec");

      let resolveReconcile: (() => void) | null = null;
      const reconcilePromise = new Promise<void>((res) => {
        resolveReconcile = res;
      });

      const onReconcileMock = vi.fn().mockReturnValue(reconcilePromise);

      renderHook(() =>
        useExecutionStream({
          runId: "run-dedup-rec",
          initialRun,
          client,
          onReconcile: onReconcileMock,
        }),
      );

      // Emit two rapid errors with reconcileRequired
      act(() => {
        client.emitError("run-dedup-rec", {
          code: "BUFFER_OVERFLOW",
          message: "Buffer overflow",
          reconcileRequired: true,
        });
        client.emitError("run-dedup-rec", {
          code: "REPLAY_GAP_DETECTED",
          message: "Replay gap",
          reconcileRequired: true,
        });
      });

      // Should only invoke onReconcile once due to in-flight guard
      expect(onReconcileMock).toHaveBeenCalledTimes(1);

      // Resolve the in-flight reconciliation
      await act(async () => {
        resolveReconcile?.();
        await Promise.resolve();
      });
    });

    it("resets state cleanly when switching active runId without leaking past run events", () => {
      const client = new MockExecutionStreamClient();
      const runA = createTestRun("run-switch-A");
      const runB = createTestRun("run-switch-B");

      interface SwitchProps {
        rId: string;
        rObj: Run | null;
      }
      const initialProps: SwitchProps = { rId: "run-switch-A", rObj: runA };

      const { result, rerender } = renderHook(
        (props: SwitchProps) =>
          useExecutionStream({
            runId: props.rId,
            initialRun: props.rObj,
            client,
          }),
        { initialProps },
      );

      // Emit event for run A
      act(() => {
        client.emitEvent("run-switch-A", {
          id: eventId("evt-A-1"),
          runId: runId("run-switch-A"),
          type: "task_started",
          severity: "info",
          timestamp: "2026-10-15T00:00:01.000Z",
          message: "Task 1 started on A",
          taskId: taskId("task-run-switch-A-1"),
        });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0]?.id).toBe("evt-A-1");

      // Switch to run B while its initialRun is still pending/null
      rerender({ rId: "run-switch-B", rObj: null });

      // State must be cleanly reset immediately
      expect(result.current.events).toHaveLength(0);
      expect(result.current.run).toBeNull();

      // Now initialRun for run B resolves
      rerender({ rId: "run-switch-B", rObj: runB });
      expect(result.current.run?.id).toBe("run-switch-B");
      expect(result.current.events).toHaveLength(0);
    });
  });
});

