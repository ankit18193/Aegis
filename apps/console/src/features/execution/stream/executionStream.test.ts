import type { RunEvent } from "@aegis/contracts";
import { eventId, runId, taskId } from "@aegis/types";
import { describe, expect, it, vi } from "vitest";

import type {
  ConnectionState,
  ExecutionStreamError,
  ExecutionStreamListener,
  StreamSubscription,
} from "./executionStream.types";
import type { IExecutionStreamClient } from "./IExecutionStreamClient";

/**
 * Minimal in-memory test implementation of IExecutionStreamClient
 * used to verify contract specifications and lifecycle expectations.
 */
class TestExecutionStreamClient implements IExecutionStreamClient {
  private state: ConnectionState = "disconnected";
  private subscriptions = new Map<string, Set<ExecutionStreamListener>>();
  private isDisposed = false;

  public getConnectionState(): ConnectionState {
    return this.state;
  }

  public setConnectionState(newState: ConnectionState): void {
    this.state = newState;
    for (const listenerSet of this.subscriptions.values()) {
      for (const listener of listenerSet) {
        listener.onStateChange?.(newState);
      }
    }
  }

  public emitEvent(runIdStr: string, event: RunEvent): void {
    if (this.isDisposed) return;
    const listeners = this.subscriptions.get(runIdStr);
    if (!listeners) return;
    for (const listener of listeners) {
      listener.onEvent(event);
    }
  }

  public emitError(runIdStr: string, error: ExecutionStreamError): void {
    if (this.isDisposed) return;
    const listeners = this.subscriptions.get(runIdStr);
    if (!listeners) return;
    for (const listener of listeners) {
      listener.onError?.(error);
    }
  }

  public subscribe(runIdStr: string, listener: ExecutionStreamListener): StreamSubscription {
    if (this.isDisposed) {
      throw new Error("Cannot subscribe to a disposed ExecutionStreamClient");
    }

    let set = this.subscriptions.get(runIdStr);
    if (!set) {
      set = new Set();
      this.subscriptions.set(runIdStr, set);
    }
    set.add(listener);

    let closed = false;

    return {
      runId: runIdStr,
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        set.delete(listener);
        if (set.size === 0) {
          this.subscriptions.delete(runIdStr);
        }
      },
      isClosed: () => closed,
    };
  }

  public dispose(): void {
    this.isDisposed = true;
    this.state = "disconnected";
    this.subscriptions.clear();
  }

  public getActiveSubscriptionCount(runIdStr?: string): number {
    if (runIdStr) {
      return this.subscriptions.get(runIdStr)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.subscriptions.values()) {
      total += set.size;
    }
    return total;
  }
}

function createSampleEvent(runIdStr: string, eventIdStr: string, message = "Task started"): RunEvent {
  return {
    id: eventId(eventIdStr),
    runId: runId(runIdStr),
    type: "task_started",
    severity: "info",
    timestamp: new Date().toISOString(),
    message,
    taskId: taskId("task-1"),
    taskName: "Analysis Task",
  };
}

describe("ExecutionStreamClient Contract and Lifecycle", () => {
  it("subscribes to run events and receives emitted events", () => {
    const client = new TestExecutionStreamClient();
    const received: RunEvent[] = [];

    const sub = client.subscribe("run-100", {
      onEvent: (event) => received.push(event),
    });

    expect(sub.runId).toBe("run-100");
    expect(sub.isClosed()).toBe(false);
    expect(client.getActiveSubscriptionCount("run-100")).toBe(1);

    const event1 = createSampleEvent("run-100", "evt-1");
    client.emitEvent("run-100", event1);

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("evt-1");
  });

  it("enforces run-scoped isolation between distinct subscriptions", () => {
    const client = new TestExecutionStreamClient();
    const run1Events: RunEvent[] = [];
    const run2Events: RunEvent[] = [];

    client.subscribe("run-1", { onEvent: (e) => run1Events.push(e) });
    client.subscribe("run-2", { onEvent: (e) => run2Events.push(e) });

    client.emitEvent("run-1", createSampleEvent("run-1", "evt-run1"));

    expect(run1Events).toHaveLength(1);
    expect(run2Events).toHaveLength(0);

    client.emitEvent("run-2", createSampleEvent("run-2", "evt-run2"));

    expect(run1Events).toHaveLength(1);
    expect(run2Events).toHaveLength(1);
  });

  it("stops delivering events immediately after unsubscribe()", () => {
    const client = new TestExecutionStreamClient();
    const received: RunEvent[] = [];

    const sub = client.subscribe("run-100", {
      onEvent: (event) => received.push(event),
    });

    client.emitEvent("run-100", createSampleEvent("run-100", "evt-1"));
    expect(received).toHaveLength(1);

    sub.unsubscribe();
    expect(sub.isClosed()).toBe(true);
    expect(client.getActiveSubscriptionCount("run-100")).toBe(0);

    client.emitEvent("run-100", createSampleEvent("run-100", "evt-2"));
    expect(received).toHaveLength(1); // No new event delivered
  });

  it("handles multiple unsubscribe() calls idempotently without throwing", () => {
    const client = new TestExecutionStreamClient();
    const sub = client.subscribe("run-100", { onEvent: vi.fn() });

    expect(sub.isClosed()).toBe(false);
    expect(() => {
      sub.unsubscribe();
      sub.unsubscribe();
      sub.unsubscribe();
    }).not.toThrow();

    expect(sub.isClosed()).toBe(true);
    expect(client.getActiveSubscriptionCount("run-100")).toBe(0);
  });

  it("supports multiple independent subscribers for the same run", () => {
    const client = new TestExecutionStreamClient();
    const sub1Events: RunEvent[] = [];
    const sub2Events: RunEvent[] = [];

    const sub1 = client.subscribe("run-shared", { onEvent: (e) => sub1Events.push(e) });
    const sub2 = client.subscribe("run-shared", { onEvent: (e) => sub2Events.push(e) });

    expect(client.getActiveSubscriptionCount("run-shared")).toBe(2);

    client.emitEvent("run-shared", createSampleEvent("run-shared", "evt-1"));
    expect(sub1Events).toHaveLength(1);
    expect(sub2Events).toHaveLength(1);

    // Unsubscribing sub1 does not stop sub2
    sub1.unsubscribe();
    expect(sub1.isClosed()).toBe(true);
    expect(sub2.isClosed()).toBe(false);
    expect(client.getActiveSubscriptionCount("run-shared")).toBe(1);

    client.emitEvent("run-shared", createSampleEvent("run-shared", "evt-2"));
    expect(sub1Events).toHaveLength(1);
    expect(sub2Events).toHaveLength(2);
  });

  it("dispatches connection state transitions to registered listeners", () => {
    const client = new TestExecutionStreamClient();
    const stateTransitions: ConnectionState[] = [];

    client.subscribe("run-state", {
      onEvent: vi.fn(),
      onStateChange: (state) => stateTransitions.push(state),
    });

    expect(client.getConnectionState()).toBe("disconnected");

    client.setConnectionState("connecting");
    client.setConnectionState("connected");
    client.setConnectionState("error");
    client.setConnectionState("disconnected");

    expect(stateTransitions).toEqual(["connecting", "connected", "error", "disconnected"]);
  });

  it("dispatches stream errors to registered onError handlers", () => {
    const client = new TestExecutionStreamClient();
    const errors: ExecutionStreamError[] = [];

    client.subscribe("run-err", {
      onEvent: vi.fn(),
      onError: (err) => errors.push(err),
    });

    const streamError: ExecutionStreamError = {
      code: "STREAM_DROPPED",
      message: "Connection lost unexpectedly",
      retryable: true,
    };

    client.emitError("run-err", streamError);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("STREAM_DROPPED");
    expect(errors[0]?.retryable).toBe(true);
  });

  it("safely handles listeners that omit optional onStateChange or onError handlers", () => {
    const client = new TestExecutionStreamClient();

    // Listener with only required onEvent handler
    client.subscribe("run-minimal", {
      onEvent: vi.fn(),
    });

    expect(() => {
      client.setConnectionState("connected");
      client.emitError("run-minimal", { code: "TEST_ERR", message: "Non-fatal error" });
    }).not.toThrow();
  });

  it("cleans up all subscriptions and rejects new ones upon dispose()", () => {
    const client = new TestExecutionStreamClient();
    const received: RunEvent[] = [];

    client.subscribe("run-1", { onEvent: (e) => received.push(e) });
    client.subscribe("run-2", { onEvent: (e) => received.push(e) });

    expect(client.getActiveSubscriptionCount()).toBe(2);

    client.dispose();
    expect(client.getActiveSubscriptionCount()).toBe(0);
    expect(client.getConnectionState()).toBe("disconnected");

    // Events after dispose are dropped
    client.emitEvent("run-1", createSampleEvent("run-1", "evt-post-dispose"));
    expect(received).toHaveLength(0);

    // New subscription after dispose throws
    expect(() => {
      client.subscribe("run-3", { onEvent: vi.fn() });
    }).toThrow(/disposed/);
  });
});
