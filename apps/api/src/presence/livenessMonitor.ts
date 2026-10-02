import type { IWorkerRegistry } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { WorkerId } from "@aegis/types";

import type { WorkerLivenessMonitorOptions } from "./types.js";

/**
 * WorkerLivenessMonitor — Periodic liveness evaluation for registered workers.
 *
 * Runs as a background timer loop within the API / control plane process.
 * Periodically calls IWorkerRegistry.markStale() to transition missing workers from HEALTHY to STALE.
 */
export class WorkerLivenessMonitor {
  private readonly registry: IWorkerRegistry;
  private readonly intervalMs: number;
  private readonly logger?: Logger | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(
    registry: IWorkerRegistry,
    options?: WorkerLivenessMonitorOptions,
  ) {
    this.registry = registry;
    this.intervalMs = options?.intervalMs ?? 5000;
    this.logger = options?.logger;
  }

  public get running(): boolean {
    return this._running;
  }

  public start(): void {
    if (this._running) {
      return;
    }

    this._running = true;
    this.logger?.info("Starting WorkerLivenessMonitor", {
      intervalMs: this.intervalMs,
    });

    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);

    // Ensure timer does not prevent process exit if running in node CLI
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  public stop(): void {
    if (!this._running) {
      return;
    }

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this._running = false;
    this.logger?.info("Stopped WorkerLivenessMonitor");
  }

  /**
   * Executes a single evaluation tick. Can be called manually in unit tests.
   */
  public tick(now: Date = new Date()): WorkerId[] {
    const transitioned = this.registry.markStale(now);
    if (transitioned.length > 0) {
      this.logger?.warn("Liveness evaluation marked workers as STALE", {
        staleWorkerIds: transitioned,
        count: transitioned.length,
      });
    }
    return transitioned;
  }
}
