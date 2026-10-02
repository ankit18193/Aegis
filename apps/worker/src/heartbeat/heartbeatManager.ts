import { randomUUID } from "node:crypto";

import type {
  IWorkerHeartbeatPublisher,
  WorkerCapabilities,
  WorkerHeartbeat,
  WorkerHeartbeatEnvelope,
  WorkerHeartbeatError,
  WorkerObservableState,
  WorkerState,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result, WorkerId } from "@aegis/types";
import { heartbeatId, ok } from "@aegis/types";

import type {
  WorkerHeartbeatManagerOptions,
  WorkerHeartbeatStatus,
} from "./types.js";

/**
 * WorkerHeartbeatManager — Lifecycle-aware periodic heartbeat telemetry emitter.
 *
 * Implements Phase 11D liveness emission semantics:
 * 1. Emits periodic heartbeats to Kafka topic aegis.workers.heartbeat
 * 2. Emits distinct heartbeatId per message (heartbeatId != workerId)
 * 3. Observes runtime lifecycle and load (READY -> BUSY when activeTaskCount > 0)
 * 4. Advertises worker capabilities and concurrency capacity
 * 5. Fault-tolerant error containment: Kafka outages log warning, NEVER kill worker process
 * 6. Emits final heartbeat on shutdown and cleans up timers without leaking handles
 */
export class WorkerHeartbeatManager {
  private readonly workerId: WorkerId;
  private readonly publisher: IWorkerHeartbeatPublisher;
  private readonly capabilities: WorkerCapabilities;
  private readonly intervalMs: number;
  private readonly getState: () => WorkerState;
  private readonly getActiveTaskCount: () => number;
  private readonly getMaxConcurrentTasks: () => number;
  private readonly logger?: Logger | undefined;

  private timer: NodeJS.Timeout | null = null;
  private _isRunning = false;
  private _isStopping = false;
  private _lastEmittedAt?: string | undefined;
  private _emissionCount = 0;
  private _lastObservableState?: WorkerObservableState | undefined;

  constructor(options: WorkerHeartbeatManagerOptions) {
    this.workerId = options.workerId;
    this.publisher = options.publisher;
    this.capabilities = options.capabilities;
    this.intervalMs = Math.max(100, options.intervalMs ?? 10000);
    this.getState = options.getState;
    this.getActiveTaskCount = options.getActiveTaskCount;
    this.getMaxConcurrentTasks = options.getMaxConcurrentTasks;
    this.logger = options.logger;
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  public get activeIntervalMs(): number {
    return this.intervalMs;
  }

  public get lastEmittedAt(): string | undefined {
    return this._lastEmittedAt;
  }

  public get emissionCount(): number {
    return this._emissionCount;
  }

  public get lastObservableState(): WorkerObservableState | undefined {
    return this._lastObservableState;
  }

  public getStatus(): WorkerHeartbeatStatus {
    return {
      isRunning: this._isRunning,
      intervalMs: this.intervalMs,
      lastEmittedAt: this._lastEmittedAt,
      emissionCount: this._emissionCount,
      lastObservableState: this._lastObservableState,
    };
  }

  /**
   * Starts the periodic heartbeat emission loop.
   * Emits an initial heartbeat immediately, then continues on interval.
   */
  public async start(): Promise<Result<void, WorkerHeartbeatError>> {
    if (this._isRunning) {
      return ok(undefined);
    }

    this._isRunning = true;
    this._isStopping = false;

    this.logger?.info("Starting WorkerHeartbeatManager", {
      workerId: this.workerId,
      intervalMs: this.intervalMs,
    });

    // 1. Emit initial pulse immediately
    await this.emitHeartbeat();

    // 2. Schedule recurring pulse
    this.timer = setInterval(() => {
      void this.emitHeartbeat();
    }, this.intervalMs);

    // Unref so heartbeat timer does not block node process exit on unhandled signals
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }

    return ok(undefined);
  }

  /**
   * Stops the heartbeat emission loop and optionally publishes a final shutdown heartbeat.
   */
  public async stop(): Promise<Result<void, WorkerHeartbeatError>> {
    if (!this._isRunning && !this._isStopping) {
      return ok(undefined);
    }

    this._isStopping = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.logger?.info("Stopping WorkerHeartbeatManager; publishing final heartbeat", {
      workerId: this.workerId,
    });

    // Publish final heartbeat reflecting stopping/draining/stopped lifecycle
    try {
      await this.emitHeartbeat();
    } catch (err) {
      this.logger?.warn("Failed to publish final shutdown heartbeat", {
        workerId: this.workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this._isRunning = false;
    this._isStopping = false;
    return ok(undefined);
  }

  /**
   * Constructs and publishes a single heartbeat telemetry payload.
   * Catches all publishing exceptions to protect worker runtime stability (LOCK 7).
   */
  public async emitHeartbeat(): Promise<Result<WorkerHeartbeatEnvelope, WorkerHeartbeatError> | null> {
    const rawState = this.getState();
    const activeTasks = this.getActiveTaskCount();
    const maxTasks = this.getMaxConcurrentTasks();

    // Compute observable state: if ready and running active tasks, advertise "busy"
    let observableState: WorkerObservableState = rawState;
    if (rawState === "ready" && activeTasks > 0) {
      observableState = "busy";
    }

    const payload: WorkerHeartbeat = {
      heartbeatId: heartbeatId(`hb-${randomUUID()}`),
      workerId: this.workerId,
      occurredAt: new Date().toISOString(),
      lifecycleState: observableState,
      activeTaskCount: activeTasks,
      maxConcurrentTasks: maxTasks,
      capabilities: this.capabilities,
    };

    try {
      const publishResult = await this.publisher.publish(payload);
      if (!publishResult.ok) {
        this.logger?.warn("Worker heartbeat publish returned failure; continuing worker execution", {
          workerId: this.workerId,
          heartbeatId: payload.heartbeatId,
          error: publishResult.error.message,
        });
        return publishResult;
      }

      this._lastEmittedAt = payload.occurredAt;
      this._emissionCount++;
      this._lastObservableState = observableState;

      this.logger?.debug("Worker heartbeat published successfully", {
        workerId: this.workerId,
        heartbeatId: payload.heartbeatId,
        lifecycleState: observableState,
        activeTasks,
        emissionCount: this._emissionCount,
      });

      return publishResult;
    } catch (unhandledError) {
      // LOCK 7: Fault-tolerant error containment
      this.logger?.warn("Worker heartbeat publisher threw an unhandled error; continuing worker execution", {
        workerId: this.workerId,
        heartbeatId: payload.heartbeatId,
        error: unhandledError instanceof Error ? unhandledError.message : String(unhandledError),
      });
      return null;
    }
  }
}
