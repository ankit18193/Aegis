/**
 * In-process asynchronous execution dispatcher for Aegis Agent Runtime.
 * Manages background execution dispatch, cancellation tracking (AbortController),
 * and test synchronization (awaitCompletion).
 */

import type { RunId } from "@aegis/types";

export interface IExecutionDispatcher {
  /**
   * Dispatches an asynchronous execution task for a run.
   */
  dispatch(runId: RunId, executeFn: (signal: AbortSignal) => Promise<void>): void;

  /**
   * Signals cancellation for an in-flight run execution.
   * Returns true if an active execution was found and signalled; false otherwise.
   */
  cancel(runId: RunId, reason?: string): boolean;

  /**
   * Awaits completion of an active execution. Useful for deterministic tests and synchronization.
   */
  awaitCompletion(runId: RunId, timeoutMs?: number): Promise<void>;

  /**
   * Checks whether a run is currently executing.
   */
  isRunning(runId: RunId): boolean;

  /**
   * Returns all currently active run IDs.
   */
  getActiveRunIds(): readonly RunId[];
}

interface ActiveExecution {
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
}

export class InProcessExecutionDispatcher implements IExecutionDispatcher {
  private readonly activeExecutions = new Map<string, ActiveExecution>();

  dispatch(runId: RunId, executeFn: (signal: AbortSignal) => Promise<void>): void {
    // If already running, do not re-dispatch
    if (this.activeExecutions.has(runId)) {
      return;
    }

    const abortController = new AbortController();

    // Wrap execution in a tracked promise
    const executionPromise = (async () => {
      // Yield to event loop to allow caller (e.g. POST /runs route) to return 201 first
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await executeFn(abortController.signal);
      } catch (err) {
        // Unhandled execution errors are caught to avoid uncaught promise rejections
        console.error(`[InProcessExecutionDispatcher] Unhandled execution error for run ${runId}:`, err);
      } finally {
        this.activeExecutions.delete(runId);
      }
    })();

    this.activeExecutions.set(runId, {
      abortController,
      promise: executionPromise,
    });
  }

  cancel(runId: RunId, reason = "Execution cancelled by operator"): boolean {
    const active = this.activeExecutions.get(runId);
    if (!active) {
      return false;
    }

    active.abortController.abort(reason);
    return true;
  }

  async awaitCompletion(runId: RunId, timeoutMs = 30000): Promise<void> {
    const active = this.activeExecutions.get(runId);
    if (!active) {
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for run '${runId}' completion after ${timeoutMs.toString()}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([active.promise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  isRunning(runId: RunId): boolean {
    return this.activeExecutions.has(runId);
  }

  getActiveRunIds(): readonly RunId[] {
    return Array.from(this.activeExecutions.keys()) as unknown as readonly RunId[];
  }
}
