import type {
  IWorkerRegistry,
  WorkerDescriptor,
  WorkerHeartbeat,
  WorkerPresenceState,
} from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { WorkerId } from "@aegis/types";

import type { InMemoryWorkerRegistryOptions } from "./types.js";

/**
 * InMemoryWorkerRegistry — Thread-safe in-memory presence and telemetry directory.
 *
 * Implements Phase 11D presence tracking:
 * 1. Tracks process instances, capability advertisements, and heartbeat timestamps
 * 2. In-memory only: ZERO database or Redis dependencies (LOCK 6)
 * 3. Evaluates liveness and transitions HEALTHY -> STALE on timeout (LOCK 8)
 * 4. Stale recovery: If STALE worker sends heartbeat, recovers to HEALTHY
 * 5. Observation only: ZERO task scheduling or routing (LOCK 1)
 */
export class InMemoryWorkerRegistry implements IWorkerRegistry {
  private readonly workers = new Map<WorkerId, WorkerDescriptor>();
  private readonly heartbeatTimeoutMs: number;
  private readonly logger?: Logger | undefined;

  constructor(options?: InMemoryWorkerRegistryOptions) {
    this.heartbeatTimeoutMs = options?.heartbeatTimeoutMs ?? 30000;
    this.logger = options?.logger;
  }

  public register(worker: WorkerDescriptor): void {
    this.workers.set(worker.workerId, { ...worker });
    this.logger?.debug("Worker registered in presence registry", {
      workerId: worker.workerId,
      presenceState: worker.presenceState,
      lifecycleState: worker.lifecycleState,
    });
  }

  public updateHeartbeat(heartbeat: WorkerHeartbeat): void {
    const existing = this.workers.get(heartbeat.workerId);

    const isStopped = heartbeat.lifecycleState === "stopped";
    const presenceState: WorkerPresenceState = isStopped ? "OFFLINE" : "HEALTHY";

    if (existing) {
      const updated: WorkerDescriptor = {
        ...existing,
        lifecycleState: heartbeat.lifecycleState,
        presenceState,
        capabilities: heartbeat.capabilities,
        activeTaskCount: heartbeat.activeTaskCount,
        maxConcurrentTasks: heartbeat.maxConcurrentTasks,
        lastHeartbeatAt: heartbeat.occurredAt,
      };
      this.workers.set(heartbeat.workerId, updated);
      this.logger?.debug("Worker heartbeat updated in presence registry", {
        workerId: heartbeat.workerId,
        presenceState,
        lifecycleState: heartbeat.lifecycleState,
        activeTaskCount: heartbeat.activeTaskCount,
      });
    } else {
      // First heartbeat seen from this worker instance -> auto-register
      const newDescriptor: WorkerDescriptor = {
        workerId: heartbeat.workerId,
        lifecycleState: heartbeat.lifecycleState,
        presenceState,
        capabilities: heartbeat.capabilities,
        activeTaskCount: heartbeat.activeTaskCount,
        maxConcurrentTasks: heartbeat.maxConcurrentTasks,
        registeredAt: heartbeat.occurredAt,
        lastHeartbeatAt: heartbeat.occurredAt,
      };
      this.workers.set(heartbeat.workerId, newDescriptor);
      this.logger?.info("Discovered and registered new worker from heartbeat", {
        workerId: heartbeat.workerId,
        presenceState,
        lifecycleState: heartbeat.lifecycleState,
      });
    }
  }

  public get(workerId: WorkerId): WorkerDescriptor | undefined {
    const worker = this.workers.get(workerId);
    return worker ? { ...worker } : undefined;
  }

  public list(): WorkerDescriptor[] {
    return Array.from(this.workers.values()).map((w) => ({ ...w }));
  }

  public markStale(now: Date): WorkerId[] {
    const nowTime = now.getTime();
    const transitionedToStale: WorkerId[] = [];

    for (const [workerId, descriptor] of this.workers.entries()) {
      // Only HEALTHY workers can transition to STALE
      if (descriptor.presenceState !== "HEALTHY") {
        continue;
      }

      const lastHeartbeatTime = new Date(descriptor.lastHeartbeatAt).getTime();
      const elapsedMs = nowTime - lastHeartbeatTime;

      if (elapsedMs > this.heartbeatTimeoutMs) {
        const updated: WorkerDescriptor = {
          ...descriptor,
          presenceState: "STALE",
        };
        this.workers.set(workerId, updated);
        transitionedToStale.push(workerId);

        this.logger?.warn("Worker marked STALE in presence registry (heartbeat missed)", {
          workerId,
          elapsedMs,
          timeoutMs: this.heartbeatTimeoutMs,
          lastHeartbeatAt: descriptor.lastHeartbeatAt,
        });
      }
    }

    return transitionedToStale;
  }

  public deregister(workerId: WorkerId): void {
    const existed = this.workers.delete(workerId);
    if (existed) {
      this.logger?.info("Worker deregistered from presence registry", { workerId });
    }
  }

  public clear(): void {
    this.workers.clear();
  }

  public size(): number {
    return this.workers.size;
  }

  public getHealthyWorkers(): WorkerDescriptor[] {
    return this.list().filter((w) => w.presenceState === "HEALTHY");
  }

  public getStaleWorkers(): WorkerDescriptor[] {
    return this.list().filter((w) => w.presenceState === "STALE");
  }

  public getOfflineWorkers(): WorkerDescriptor[] {
    return this.list().filter((w) => w.presenceState === "OFFLINE");
  }
}
