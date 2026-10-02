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
 * InMemoryWorkerRegistry — Control-plane in-memory presence and telemetry registry.
 *
 * Implements centralized worker tracking inside the API/scheduler process:
 * 1. Tracks process instances, capability advertisements, and heartbeat timestamps.
 * 2. In-memory only: ZERO database or Redis dependencies (LOCK 6).
 * 3. Evaluates liveness and transitions HEALTHY -> STALE on timeout.
 * 4. Stale recovery: If STALE worker sends heartbeat, recovers to HEALTHY.
 * 5. Heartbeat monotonic timestamp check: Discards out-of-order delayed heartbeats.
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
    this.logger?.debug("Worker registered in control-plane presence registry", {
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
      const existingHeartbeatTime = new Date(existing.lastHeartbeatAt).getTime();
      const incomingHeartbeatTime = new Date(heartbeat.occurredAt).getTime();

      // Guard against out-of-order telemetry: ignore heartbeats older than latest processed
      if (incomingHeartbeatTime < existingHeartbeatTime) {
        this.logger?.warn("Discarding out-of-order worker heartbeat", {
          workerId: heartbeat.workerId,
          incomingOccurredAt: heartbeat.occurredAt,
          currentLastHeartbeatAt: existing.lastHeartbeatAt,
        });
        return;
      }

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
      this.logger?.debug("Worker heartbeat updated in control-plane presence registry", {
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

        this.logger?.warn("Worker marked STALE in control-plane presence registry", {
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
    const existing = this.workers.get(workerId);
    if (existing) {
      const updated: WorkerDescriptor = {
        ...existing,
        presenceState: "OFFLINE",
        lifecycleState: "stopped",
      };
      this.workers.set(workerId, updated);
      this.logger?.info("Worker explicitly deregistered from presence registry", {
        workerId,
      });
    }
  }

  public remove(workerId: WorkerId): boolean {
    return this.workers.delete(workerId);
  }

  public clear(): void {
    this.workers.clear();
  }

  public get size(): number {
    return this.workers.size;
  }
}
