import type { Run, Task } from "@aegis/contracts";
import { eventId, runId, taskId, workflowId } from "@aegis/types";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockExecutionStreamClient } from "../stream/MockExecutionStreamClient";

import { useExecutionStream } from "./useExecutionStream";

function createTestRun(rId: string): Run {
  const t1: Task = {
    id: taskId(`task-${rId}-1`),
    runId: runId(rId),
    name: "Task 1",
    status: "pending",
    description: "Task description",
    attemptCount: 0,
    version: 1,
  };

  return {
    id: runId(rId),
    status: "pending",
    goal: `Goal for ${rId}`,
    tasks: [t1],
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Test Workflow",
      tasks: [t1],
    },
    progress: 0,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

describe("useExecutionStream Hook", () => {
  it("initializes with initialRun and connects to the stream client", () => {
    const client = new MockExecutionStreamClient();
    const run = createTestRun("run-init");

    const { result } = renderHook(() =>
      useExecutionStream({
        runId: "run-init",
        initialRun: run,
        client,
      }),
    );

    expect(result.current.run?.id).toBe("run-init");
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.events).toEqual([]);
    expect(client.getSubscriberCount("run-init")).toBe(1);
  });

  it("updates live run and timeline when stream events arrive", () => {
    const client = new MockExecutionStreamClient();
    const run = createTestRun("run-live");

    const { result } = renderHook(() =>
      useExecutionStream({
        runId: "run-live",
        initialRun: run,
        client,
      }),
    );

    expect(result.current.run?.tasks[0]?.status).toBe("pending");

    act(() => {
      client.emitEvent("run-live", {
        id: eventId("evt-start"),
        runId: runId("run-live"),
        type: "task_started",
        severity: "info",
        timestamp: "2026-10-15T00:00:05.000Z",
        message: "Task 1 started",
        taskId: taskId("task-run-live-1"),
      });
    });

    expect(result.current.run?.tasks[0]?.status).toBe("running");
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.id).toBe("evt-start");
  });

  it("updates connectionState when stream client transitions", () => {
    const client = new MockExecutionStreamClient();
    const run = createTestRun("run-conn");

    const { result } = renderHook(() =>
      useExecutionStream({
        runId: "run-conn",
        initialRun: run,
        client,
      }),
    );

    expect(result.current.connectionState).toBe("connected");

    act(() => {
      client.setConnectionState("disconnected");
    });
    expect(result.current.connectionState).toBe("disconnected");

    act(() => {
      client.setConnectionState("connecting");
    });
    expect(result.current.connectionState).toBe("connecting");
  });

  it("captures and exposes stream errors", () => {
    const client = new MockExecutionStreamClient();
    const run = createTestRun("run-err");

    const { result } = renderHook(() =>
      useExecutionStream({
        runId: "run-err",
        initialRun: run,
        client,
      }),
    );

    expect(result.current.error).toBeNull();

    act(() => {
      client.emitError("run-err", {
        code: "STREAM_INTERRUPTED",
        message: "Socket closed unexpectedly",
        retryable: true,
      });
    });

    expect(result.current.error?.code).toBe("STREAM_INTERRUPTED");
    expect(result.current.error?.retryable).toBe(true);
  });

  it("unsubscribes cleanly when unmounted", () => {
    const client = new MockExecutionStreamClient();
    const run = createTestRun("run-unmount");

    const { unmount } = renderHook(() =>
      useExecutionStream({
        runId: "run-unmount",
        initialRun: run,
        client,
      }),
    );

    expect(client.getSubscriberCount("run-unmount")).toBe(1);

    unmount();

    expect(client.getSubscriberCount("run-unmount")).toBe(0);
  });

  it("switches subscriptions cleanly when runId changes and prevents stale events", () => {
    const client = new MockExecutionStreamClient();
    const runA = createTestRun("run-A");
    const runB = createTestRun("run-B");

    let currentRunId = "run-A";
    let currentInitialRun = runA;

    const { result, rerender } = renderHook(() =>
      useExecutionStream({
        runId: currentRunId,
        initialRun: currentInitialRun,
        client,
      }),
    );

    expect(result.current.run?.id).toBe("run-A");
    expect(client.getSubscriberCount("run-A")).toBe(1);
    expect(client.getSubscriberCount("run-B")).toBe(0);

    // Switch to run B
    currentRunId = "run-B";
    currentInitialRun = runB;
    rerender();

    expect(result.current.run?.id).toBe("run-B");
    expect(client.getSubscriberCount("run-A")).toBe(0); // Run A unsubscribed!
    expect(client.getSubscriberCount("run-B")).toBe(1); // Run B subscribed!

    // Emitting event to old run A is ignored by hook
    act(() => {
      client.emitEvent("run-A", {
        id: eventId("evt-old-A"),
        runId: runId("run-A"),
        type: "task_started",
        severity: "info",
        timestamp: "2026-10-15T00:00:10.000Z",
        message: "Old event for A",
      });
    });

    expect(result.current.events).toHaveLength(0); // No event from run A leaked into run B

    // Emitting event to active run B is delivered
    act(() => {
      client.emitEvent("run-B", {
        id: eventId("evt-new-B"),
        runId: runId("run-B"),
        type: "task_started",
        severity: "info",
        timestamp: "2026-10-15T00:00:11.000Z",
        message: "New event for B",
        taskId: taskId("task-run-B-1"),
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.id).toBe("evt-new-B");
    expect(result.current.run?.tasks[0]?.status).toBe("running");
  });
});
