import type {
  IWorkerRuntime,
  WorkerErrorContract,
  WorkerIdentity,
  WorkerState,
} from "@aegis/contracts";
import { createWorkerError } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result } from "@aegis/types";
import { err, ok } from "@aegis/types";

import { createWorkerIdentity } from "./identity.js";
import { WorkerLifecycleManager } from "./state.js";

export interface WorkerRuntimeOptions {
  readonly identity?: WorkerIdentity | undefined;
  readonly logger?: Logger | undefined;
  readonly onStart?: (() => Promise<void> | void) | undefined;
  readonly onStop?: (() => Promise<void> | void) | undefined;
}

/**
 * WorkerRuntime — Foundational local worker execution process runtime.
 * Implements canonical IWorkerRuntime contract.
 * Manages lifecycle state transitions, identity exposure, and graceful start/stop semantics.
 */
export class WorkerRuntime implements IWorkerRuntime {
  private readonly lifecycle: WorkerLifecycleManager;
  private readonly identity: WorkerIdentity;
  private readonly logger?: Logger | undefined;
  private readonly onStart?: (() => Promise<void> | void) | undefined;
  private readonly onStop?: (() => Promise<void> | void) | undefined;

  constructor(options: WorkerRuntimeOptions = {}) {
    this.lifecycle = new WorkerLifecycleManager("starting");
    this.identity = options.identity ?? createWorkerIdentity();
    this.logger = options.logger;
    this.onStart = options.onStart;
    this.onStop = options.onStop;
  }

  /**
   * Current lifecycle state of the worker runtime.
   */
  public getState(): WorkerState {
    return this.lifecycle.getState();
  }

  /**
   * Canonical identity of this worker instance.
   */
  public getIdentity(): WorkerIdentity {
    return this.identity;
  }

  /**
   * True if worker is in ready state and available.
   */
  public get isRunning(): boolean {
    return this.getState() === "ready";
  }

  /**
   * Starts the worker runtime and transitions from starting to ready.
   */
  public async start(): Promise<Result<void, WorkerErrorContract>> {
    const currentState = this.getState();

    if (currentState === "ready") {
      return err(
        createWorkerError(
          "WORKER_ALREADY_STARTED",
          `Worker '${this.identity.id}' is already started and in ready state.`,
        ),
      );
    }

    if (currentState !== "starting") {
      return err(
        createWorkerError(
          "WORKER_INVALID_STATE",
          `Cannot start worker '${this.identity.id}' from state '${currentState}'. Only 'starting' workers can start.`,
        ),
      );
    }

    try {
      if (this.onStart) {
        await this.onStart();
      }

      const transitionRes = this.lifecycle.transitionTo("ready");
      if (!transitionRes.ok) {
        return transitionRes;
      }

      this.logger?.info("Worker runtime started and ready", {
        workerId: this.identity.id,
        workerName: this.identity.name,
        capabilities: this.identity.capabilities,
      });

      return ok(undefined);
    } catch (error) {
      this.lifecycle.transitionTo("failed");
      const wrapped = createWorkerError(
        "WORKER_START_FAILED",
        `Worker '${this.identity.id}' failed during startup: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );

      this.logger?.error("Worker runtime startup failed", {
        workerId: this.identity.id,
        error: wrapped.message,
      });

      return err(wrapped);
    }
  }

  /**
   * Gracefully stops the worker runtime.
   * Transitions ready -> draining -> stopped.
   * Idempotent: safe to call multiple times.
   */
  public async stop(): Promise<Result<void, WorkerErrorContract>> {
    const currentState = this.getState();

    if (currentState === "stopped") {
      return ok(undefined);
    }

    if (currentState === "failed") {
      this.lifecycle.transitionTo("stopped");
      this.logger?.info("Failed worker runtime marked as stopped", {
        workerId: this.identity.id,
      });
      return ok(undefined);
    }

    if (currentState === "starting") {
      this.lifecycle.transitionTo("stopped");
      this.logger?.info("Starting worker runtime halted and stopped", {
        workerId: this.identity.id,
      });
      return ok(undefined);
    }

    // currentState is "ready" or "draining"
    if (currentState === "ready") {
      const drainRes = this.lifecycle.transitionTo("draining");
      if (!drainRes.ok) {
        return drainRes;
      }

      this.logger?.info("Worker runtime draining resources for shutdown", {
        workerId: this.identity.id,
      });
    }

    try {
      if (this.onStop) {
        await this.onStop();
      }

      const stopRes = this.lifecycle.transitionTo("stopped");
      if (!stopRes.ok) {
        return stopRes;
      }

      this.logger?.info("Worker runtime stopped cleanly", {
        workerId: this.identity.id,
      });

      return ok(undefined);
    } catch (error) {
      const wrapped = createWorkerError(
        "WORKER_STOP_FAILED",
        `Worker '${this.identity.id}' encountered an error during stop: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );

      this.logger?.error("Error during worker shutdown", {
        workerId: this.identity.id,
        error: wrapped.message,
      });

      // Ensure state is forced to stopped to prevent zombie draining states
      this.lifecycle.transitionTo("stopped");
      return err(wrapped);
    }
  }
}
