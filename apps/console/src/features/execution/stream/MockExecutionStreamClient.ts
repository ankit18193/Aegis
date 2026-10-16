import type { Run, RunEvent } from "@aegis/contracts";
import { eventId, runId as toRunId, taskId as toTaskId, workerId as toWorkerId } from "@aegis/types";

import type {
  ConnectionState,
  ExecutionStreamError,
  ExecutionStreamEvent,
  ExecutionStreamListener,
  StreamSubscribeOptions,
  StreamSubscription,
} from "./executionStream.types";
import type { IExecutionStreamClient } from "./IExecutionStreamClient";

export interface MockStreamClientOptions {
  /**
   * Initial connection state when client is instantiated. Defaults to 'connected'.
   */
  readonly initialConnectionState?: ConnectionState;
}

/**
 * Deterministic mock implementation of `IExecutionStreamClient` designed for
 * frontend development, UI prototyping, and unit/integration testing without
 * requiring a live backend, Kafka cluster, or Server-Sent Events connection.
 */
export class MockExecutionStreamClient implements IExecutionStreamClient {
  private connectionState: ConnectionState;
  private readonly subscribers = new Map<string, Set<ExecutionStreamListener>>();
  private disposed = false;

  constructor(options?: MockStreamClientOptions) {
    this.connectionState = options?.initialConnectionState ?? "connected";
  }

  /**
   * Returns current connection state.
   */
  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Subscribes to real-time events for a specific execution run.
   */
  public subscribe(
    runIdStr: string,
    listener: ExecutionStreamListener,
    _options?: StreamSubscribeOptions,
  ): StreamSubscription {
    if (this.disposed) {
      throw new Error("Cannot subscribe to a disposed MockExecutionStreamClient");
    }

    let listenersForRun = this.subscribers.get(runIdStr);
    if (!listenersForRun) {
      listenersForRun = new Set();
      this.subscribers.set(runIdStr, listenersForRun);
    }
    listenersForRun.add(listener);

    // Notify listener of current connection state upon subscribing
    listener.onStateChange?.(this.connectionState);

    let closed = false;

    return {
      runId: runIdStr,
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        listenersForRun.delete(listener);
        if (listenersForRun.size === 0) {
          this.subscribers.delete(runIdStr);
        }
      },
      isClosed: () => closed,
    };
  }

  /**
   * Disposes all active subscriptions and sets client to 'disconnected'.
   */
  public dispose(): void {
    this.disposed = true;
    this.connectionState = "disconnected";
    for (const listenerSet of this.subscribers.values()) {
      for (const listener of listenerSet) {
        listener.onStateChange?.("disconnected");
      }
    }
    this.subscribers.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Explicit Test Controls & Simulation APIs
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Manually emits an execution event to all active subscribers for the given run ID.
   */
  public emitEvent(runIdStr: string, event: ExecutionStreamEvent): void {
    if (this.disposed) return;
    const listeners = this.subscribers.get(runIdStr);
    if (!listeners) return;

    for (const listener of listeners) {
      listener.onEvent(event);
    }
  }

  /**
   * Manually changes connection state and notifies all active listeners across all runs.
   */
  public setConnectionState(newState: ConnectionState): void {
    if (this.disposed && newState !== "disconnected") {
      throw new Error("Cannot change connection state on a disposed MockExecutionStreamClient");
    }

    this.connectionState = newState;
    for (const listenerSet of this.subscribers.values()) {
      for (const listener of listenerSet) {
        listener.onStateChange?.(newState);
      }
    }
  }

  /**
   * Manually emits an error to all active subscribers for the given run ID.
   */
  public emitError(runIdStr: string, error: ExecutionStreamError): void {
    if (this.disposed) return;
    const listeners = this.subscribers.get(runIdStr);
    if (!listeners) return;

    for (const listener of listeners) {
      listener.onError?.(error);
    }
  }

  /**
   * Deterministically emits a sequence of events for a run in exact order.
   */
  public emitSequence(runIdStr: string, events: readonly ExecutionStreamEvent[]): void {
    for (const event of events) {
      this.emitEvent(runIdStr, event);
    }
  }

  /**
   * Generates and emits a canonical lifecycle sequence for a Run from start to finish.
   * Useful for UI tests and local development simulations.
   */
  public emitFullRunLifecycle(run: Run, workerName = "worker-mock-1"): ExecutionStreamEvent[] {
    const runIdStr = run.id;
    const events: ExecutionStreamEvent[] = [];
    let step = 1;

    const baseTime = new Date("2026-10-15T00:00:00.000Z").getTime();
    const tick = (): string => new Date(baseTime + step++ * 1000).toISOString();

    // 1. Workflow started
    const wfStarted: RunEvent = {
      id: eventId(`evt-sim-${runIdStr}-${String(step)}`),
      runId: toRunId(runIdStr),
      type: "workflow_started",
      severity: "info",
      timestamp: tick(),
      message: `Execution workflow started for goal: '${run.goal}'`,
    };
    events.push(wfStarted);
    this.emitEvent(runIdStr, wfStarted);

    // 2. Iterate each task
    for (const task of run.tasks) {
      const scheduledEvt: RunEvent = {
        id: eventId(`evt-sim-${runIdStr}-${String(step)}`),
        runId: toRunId(runIdStr),
        type: "task_scheduled",
        severity: "info",
        timestamp: tick(),
        taskId: toTaskId(task.id),
        taskName: task.name,
        message: `Task '${task.name}' scheduled for execution`,
      };
      events.push(scheduledEvt);
      this.emitEvent(runIdStr, scheduledEvt);

      const startedEvt: RunEvent = {
        id: eventId(`evt-sim-${runIdStr}-${String(step)}`),
        runId: toRunId(runIdStr),
        type: "task_started",
        severity: "info",
        timestamp: tick(),
        taskId: toTaskId(task.id),
        taskName: task.name,
        worker: toWorkerId(workerName),
        message: `Worker '${workerName}' began executing task '${task.name}'`,
      };
      events.push(startedEvt);
      this.emitEvent(runIdStr, startedEvt);

      const toolEvt: RunEvent = {
        id: eventId(`evt-sim-${runIdStr}-${String(step)}`),
        runId: toRunId(runIdStr),
        type: "tool_invoked",
        severity: "info",
        timestamp: tick(),
        taskId: toTaskId(task.id),
        taskName: task.name,
        message: `Tool execution verified for task '${task.name}'`,
      };
      events.push(toolEvt);
      this.emitEvent(runIdStr, toolEvt);

      const completedEvt: RunEvent = {
        id: eventId(`evt-sim-${runIdStr}-${String(step)}`),
        runId: toRunId(runIdStr),
        type: "task_completed",
        severity: "success",
        timestamp: tick(),
        taskId: toTaskId(task.id),
        taskName: task.name,
        message: `Task '${task.name}' completed successfully`,
        metadata: {
          output: `Output verified for '${task.name}'.`,
        },
      };
      events.push(completedEvt);
      this.emitEvent(runIdStr, completedEvt);
    }

    // 3. Run completed
    const runCompleted: RunEvent = {
      id: eventId(`evt-sim-${runIdStr}-${String(step)}`),
      runId: toRunId(runIdStr),
      type: "run_completed",
      severity: "success",
      timestamp: tick(),
      message: `Execution run completed successfully. All ${String(run.tasks.length)} tasks finished.`,
      metadata: {
        result: {
          summary: `Successfully completed execution run for goal '${run.goal}'.`,
        },
      },
    };
    events.push(runCompleted);
    this.emitEvent(runIdStr, runCompleted);

    return events;
  }

  /**
   * Inspection helper returning the number of active subscribers for a given runId or all runs.
   */
  public getSubscriberCount(runIdStr?: string): number {
    if (runIdStr) {
      return this.subscribers.get(runIdStr)?.size ?? 0;
    }
    let total = 0;
    for (const set of this.subscribers.values()) {
      total += set.size;
    }
    return total;
  }

  /**
   * Inspection helper checking whether any subscribers are active.
   */
  public hasActiveSubscriptions(runIdStr?: string): boolean {
    return this.getSubscriberCount(runIdStr) > 0;
  }
}
