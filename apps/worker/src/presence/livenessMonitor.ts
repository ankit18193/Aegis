import type { IWorkerRegistry } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { WorkerId } from "@aegis/types";

import type { WorkerLivenessMonitorOptions, WorkerLivenessStatus } from "./types.js";

/**
 * WorkerLivenessMonitor — Periodic background evaluator for worker liveness.
 *
 * Implements Phase 11D liveness evaluation:
 * 1. Periodically triggers registry.markStale(now)
 * 2. Emits warnings and invokes onWorkerStale callbacks for newly stale workers
 * 3. Does NOT cancel tasks or terminate workers (LOCK 8: STALE != DEAD)
 * 4. Timer unref'd to prevent keeping Node process alive prematurely
 */
export class WorkerLivenessMonitor {
  private readonly registry: IWorkerRegistry;
  private readonly evaluationIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly onWorkerStale?: ((workerId: WorkerId) => void) | undefined;
  private readonly logger?: Logger | undefined;

  private timer: NodeJS.Timeout | null = null;
  private _isRunning = false;
  private _evaluationCount = 0;
  private _lastEvaluatedAt?: string | undefined;

  constructor(options: WorkerLivenessMonitorOptions) {
    this.registry = options.registry;
    this.evaluationIntervalMs = Math.max(100, options.evaluationIntervalMs ?? 5000);
    this.heartbeatTimeoutMs = Math.max(100, options.heartbeatTimeoutMs ?? 30000);
    this.onWorkerStale = options.onWorkerStale;
    this.logger = options.logger;
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  public get evaluationCount(): number {
    return this._evaluationCount;
  }

  public get lastEvaluatedAt(): string | undefined {
    return this._lastEvaluatedAt;
  }

  public getStatus(): WorkerLivenessStatus {
    return {
      isRunning: this._isRunning,
      evaluationIntervalMs: this.evaluationIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      evaluationCount: this._evaluationCount,
      lastEvaluatedAt: this._lastEvaluatedAt,
    };
  }

  public start(): void {
    if (this._isRunning) {
      return;
    }

    this._isRunning = true;
    this.logger?.info("Starting WorkerLivenessMonitor", {
      evaluationIntervalMs: this.evaluationIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
    });

    // Evaluate once on startup
    this.evaluate();

    this.timer = setInterval(() => {
      this.evaluate();
    }, this.evaluationIntervalMs);

    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (!this._isRunning) {
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this._isRunning = false;
    this.logger?.info("Stopped WorkerLivenessMonitor", {
      evaluationsCompleted: this._evaluationCount,
    });
  }

  public evaluate(customNow?: Date): readonly WorkerId[] {
    const now = customNow ?? new Date();
    this._lastEvaluatedAt = now.toISOString();
    this._evaluationCount++;

    const staleWorkerIds = this.registry.markStale(now);

    for (const staleId of staleWorkerIds) {
      this.logger?.warn("Worker marked STALE by liveness monitor", {
        workerId: staleId,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      });

      if (this.onWorkerStale) {
        try {
          this.onWorkerStale(staleId);
        } catch (cbError) {
          this.logger?.warn("Error executing onWorkerStale callback", {
            workerId: staleId,
            error: cbError instanceof Error ? cbError.message : String(cbError),
          });
        }
      }
    }

    return staleWorkerIds;
  }
}
