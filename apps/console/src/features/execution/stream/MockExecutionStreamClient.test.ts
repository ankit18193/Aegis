import type { Run, Task } from "@aegis/contracts";
import { eventId, runId, taskId, workflowId } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import type {
  ConnectionState,
  ExecutionStreamError,
  ExecutionStreamEvent,
} from "./executionStream.types";
import { MockExecutionStreamClient } from "./MockExecutionStreamClient";

function createMockRun(rId = "run-mock-1"): Run {
  const t1: Task = {
    id: taskId("task-m1"),
    runId: runId(rId),
    name: "Step 1: Ingestion",
    status: "pending",
    description: "Ingest data",
    attemptCount: 0,
    version: 1,
  };

  const t2: Task = {
    id: taskId("task-m2"),
    runId: runId(rId),
    name: "Step 2: Processing",
    status: "pending",
    description: "Process data",
    attemptCount: 0,
    version: 1,
  };

  return {
    id: runId(rId),
    status: "pending",
    goal: "Mock execution testing",
    tasks: [t1, t2],
    workflow: {
      id: workflowId(`wf-${rId}`),
      name: "Mock Workflow",
      tasks: [t1, t2],
    },
    progress: 0,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

describe("MockExecutionStreamClient", () => {
  it("initializes with default or custom connection state", () => {
    const defaultClient = new MockExecutionStreamClient();
    expect(defaultClient.getConnectionState()).toBe("connected");
    expect(defaultClient.hasActiveSubscriptions()).toBe(false);

    const customClient = new MockExecutionStreamClient({
      initialConnectionState: "connecting",
    });
    expect(customClient.getConnectionState()).toBe("connecting");
  });

  it("subscribes to a run and immediately notifies listener of current connection state", () => {
    const client = new MockExecutionStreamClient();
    const stateTransitions: ConnectionState[] = [];

    const sub = client.subscribe("run-1", {
      onEvent: vi.fn(),
      onStateChange: (s) => stateTransitions.push(s),
    });

    expect(stateTransitions).toEqual(["connected"]);
    expect(sub.runId).toBe("run-1");
    expect(sub.isClosed()).toBe(false);
    expect(client.getSubscriberCount("run-1")).toBe(1);
  });

  it("delivers events to the matching run subscriber with complete run isolation", () => {
    const client = new MockExecutionStreamClient();
    const run1Events: ExecutionStreamEvent[] = [];
    const run2Events: ExecutionStreamEvent[] = [];

    client.subscribe("run-1", { onEvent: (e) => run1Events.push(e) });
    client.subscribe("run-2", { onEvent: (e) => run2Events.push(e) });

    const event1: ExecutionStreamEvent = {
      id: eventId("evt-1"),
      runId: runId("run-1"),
      type: "task_started",
      severity: "info",
      timestamp: "2026-10-15T00:00:01.000Z",
      message: "Task 1 started",
      taskId: taskId("task-1"),
    };

    client.emitEvent("run-1", event1);

    expect(run1Events).toHaveLength(1);
    expect(run1Events[0]?.id).toBe("evt-1");
    expect(run2Events).toHaveLength(0); // Run 2 receives nothing
  });

  it("stops event delivery immediately upon unsubscribe() and handles repeat unsubscriptions cleanly", () => {
    const client = new MockExecutionStreamClient();
    const received: ExecutionStreamEvent[] = [];

    const sub = client.subscribe("run-1", {
      onEvent: (e) => received.push(e),
    });

    client.emitEvent("run-1", {
      id: eventId("evt-1"),
      runId: runId("run-1"),
      type: "task_started",
      severity: "info",
      timestamp: "2026-10-15T00:00:01.000Z",
      message: "Event 1",
    });

    expect(received).toHaveLength(1);

    sub.unsubscribe();
    expect(sub.isClosed()).toBe(true);
    expect(client.getSubscriberCount("run-1")).toBe(0);

    // Idempotent repeat unsubscription
    expect(() => {
      sub.unsubscribe();
      sub.unsubscribe();
    }).not.toThrow();

    client.emitEvent("run-1", {
      id: eventId("evt-2"),
      runId: runId("run-1"),
      type: "task_completed",
      severity: "success",
      timestamp: "2026-10-15T00:00:02.000Z",
      message: "Event 2",
    });

    expect(received).toHaveLength(1); // No new event delivered
  });

  it("simulates connection state changes across all active subscriptions", () => {
    const client = new MockExecutionStreamClient();
    const sub1States: ConnectionState[] = [];
    const sub2States: ConnectionState[] = [];

    client.subscribe("run-1", {
      onEvent: vi.fn(),
      onStateChange: (s) => sub1States.push(s),
    });
    client.subscribe("run-2", {
      onEvent: vi.fn(),
      onStateChange: (s) => sub2States.push(s),
    });

    client.setConnectionState("disconnected");
    client.setConnectionState("connecting");
    client.setConnectionState("connected");

    expect(sub1States).toEqual(["connected", "disconnected", "connecting", "connected"]);
    expect(sub2States).toEqual(["connected", "disconnected", "connecting", "connected"]);
    expect(client.getConnectionState()).toBe("connected");
  });

  it("simulates stream errors to registered onError handlers", () => {
    const client = new MockExecutionStreamClient();
    const errors: ExecutionStreamError[] = [];

    client.subscribe("run-err", {
      onEvent: vi.fn(),
      onError: (err) => errors.push(err),
    });

    const streamError: ExecutionStreamError = {
      code: "SSE_CONNECTION_DROPPED",
      message: "Network connection dropped unexpectedly",
      retryable: true,
    };

    client.emitError("run-err", streamError);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("SSE_CONNECTION_DROPPED");
    expect(errors[0]?.retryable).toBe(true);
  });

  it("emits a sequence of events synchronously and deterministically", () => {
    const client = new MockExecutionStreamClient();
    const delivered: string[] = [];

    client.subscribe("run-seq", {
      onEvent: (e) => delivered.push(e.id),
    });

    const events: ExecutionStreamEvent[] = [
      {
        id: eventId("seq-1"),
        runId: runId("run-seq"),
        type: "workflow_started",
        severity: "info",
        timestamp: "2026-10-15T00:00:01.000Z",
        message: "Started",
      },
      {
        id: eventId("seq-2"),
        runId: runId("run-seq"),
        type: "task_started",
        severity: "info",
        timestamp: "2026-10-15T00:00:02.000Z",
        message: "Task started",
        taskId: taskId("task-1"),
      },
      {
        id: eventId("seq-3"),
        runId: runId("run-seq"),
        type: "task_completed",
        severity: "success",
        timestamp: "2026-10-15T00:00:03.000Z",
        message: "Task finished",
        taskId: taskId("task-1"),
      },
    ];

    client.emitSequence("run-seq", events);

    expect(delivered).toEqual(["seq-1", "seq-2", "seq-3"]);
  });

  it("simulates full run execution lifecycle through emitFullRunLifecycle", () => {
    const client = new MockExecutionStreamClient();
    const run = createMockRun("run-sim");
    const receivedEvents: ExecutionStreamEvent[] = [];

    client.subscribe("run-sim", {
      onEvent: (e) => receivedEvents.push(e),
    });

    const generated = client.emitFullRunLifecycle(run, "worker-node-1");

    expect(generated.length).toBeGreaterThanOrEqual(5); // workflow_started, 2x(scheduled, started, tool, completed), run_completed
    expect(receivedEvents).toEqual(generated);

    // Verify event progression
    const types = receivedEvents.map((e) => e.type);
    expect(types[0]).toBe("workflow_started");
    expect(types).toContain("task_started");
    expect(types).toContain("tool_invoked");
    expect(types).toContain("task_completed");
    expect(types[types.length - 1]).toBe("run_completed");
  });

  it("disposes client cleanly: closes active subscriptions, transitions to disconnected, rejects new subscriptions", () => {
    const client = new MockExecutionStreamClient();
    const states: ConnectionState[] = [];
    const received: ExecutionStreamEvent[] = [];

    client.subscribe("run-1", {
      onEvent: (e) => received.push(e),
      onStateChange: (s) => states.push(s),
    });

    expect(client.hasActiveSubscriptions()).toBe(true);

    client.dispose();

    expect(client.getConnectionState()).toBe("disconnected");
    expect(client.hasActiveSubscriptions()).toBe(false);
    expect(states[states.length - 1]).toBe("disconnected");

    // Events after dispose are dropped
    client.emitEvent("run-1", {
      id: eventId("evt-dead"),
      runId: runId("run-1"),
      type: "task_started",
      severity: "info",
      timestamp: "2026-10-15T00:00:01.000Z",
      message: "After dispose",
    });

    expect(received).toHaveLength(0);

    // New subscriptions throw
    expect(() => {
      client.subscribe("run-2", { onEvent: vi.fn() });
    }).toThrow(/disposed/);
  });
});
