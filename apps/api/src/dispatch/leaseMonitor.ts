import type { Task } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import { eventId } from "@aegis/types";

import type { IRunRepository } from "../repositories/runRepository.js";

export interface TaskLeaseMonitorOptions {
  readonly repository: IRunRepository;
  readonly sweepIntervalMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly logger?: Logger | undefined;
  readonly onLeaseExpired?: ((task: Task) => void) | undefined;
}

export interface SweepResult {
  readonly checkedCandidates: number;
  readonly expiredMarked: number;
  readonly conflictsSkipped: number;
}

/**
 * TaskLeaseMonitor — Control-plane background monitor for expired task leases.
 *
 * Implements Phase 12B lease expiration monitoring:
 * 1. Read-only query: sweeps tasks where `status = 'running'` and `lease_until < now`.
 * 2. Atomic mutation: calls `markTaskLeaseExpired(taskId, expectedVersion, expiredAt)`
 *    which safely sets `lease_expired_at = expiredAt` and increments `version`
 *    guarded by `version = expectedVersion AND lease_until < expiredAt`.
 * 3. Invariant: Task remains in `status = 'running'` and preserves `worker_id`.
 *    (Recovery and reassignment are strictly deferred to Phase 12D).
 * 4. Saves audit event `task_lease_expired` to timeline.
 * 5. Handles concurrent control-plane monitors cleanly via optimistic locking.
 */
export class TaskLeaseMonitor {
  private readonly repository: IRunRepository;
  private readonly sweepIntervalMs: number;
  private readonly batchSize: number;
  private readonly logger?: Logger | undefined;
  private readonly onLeaseExpired?: ((task: Task) => void) | undefined;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private _sweepsCount = 0;
  private _expiredCount = 0;

  constructor(options: TaskLeaseMonitorOptions) {
    this.repository = options.repository;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5000;
    this.batchSize = options.batchSize ?? 100;
    this.logger = options.logger;
    this.onLeaseExpired = options.onLeaseExpired;
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get sweepsCount(): number {
    return this._sweepsCount;
  }

  public get expiredCount(): number {
    return this._expiredCount;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    this.logger?.info("Starting control-plane TaskLeaseMonitor", {
      sweepIntervalMs: this.sweepIntervalMs,
      batchSize: this.batchSize,
    });

    this.timer = setInterval(() => {
      void this.sweepOnce().catch((err: unknown) => {
        this.logger?.error("TaskLeaseMonitor sweep cycle failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.sweepIntervalMs);
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger?.info("Stopped control-plane TaskLeaseMonitor");
  }

  /**
   * Executes a single sweep cycle to detect and mark expired task leases.
   * Can be invoked directly by background timers or manually in tests.
   */
  public async sweepOnce(now: Date = new Date()): Promise<SweepResult> {
    this._sweepsCount++;

    // 1. Strict read-only query of expired lease candidates
    const candidates = await this.repository.getExpiredTaskLeases(now, this.batchSize);

    if (candidates.length === 0) {
      return {
        checkedCandidates: 0,
        expiredMarked: 0,
        conflictsSkipped: 0,
      };
    }

    let expiredMarked = 0;
    let conflictsSkipped = 0;

    for (const task of candidates) {
      // 2. Atomic optimistic mutation guarded by expectedVersion
      const marked = await this.repository.markTaskLeaseExpired(
        task.id,
        task.version,
        now,
      );

      if (marked) {
        expiredMarked++;
        this._expiredCount++;

        this.logger?.warn("Task lease marked as expired", {
          taskId: task.id,
          runId: task.runId,
          workerId: task.workerId,
          previousVersion: task.version,
          leaseUntil: task.leaseUntil,
          expiredAt: now.toISOString(),
        });

        // 3. Save audit event for timeline visibility
        if (task.runId) {
          try {
            await this.repository.saveEvent({
              id: eventId(`evt-lease-exp-${task.id}-${String(task.version + 1)}`),
              runId: task.runId,
              type: "task_lease_expired",
              severity: "warn",
              timestamp: now.toISOString(),
              message: `Task lease expired for worker '${task.workerId ?? "unknown"}'. Task remains running pending Phase 12D recovery.`,
              taskId: task.id,
              taskName: task.name,
              worker: task.workerId,
              metadata: {
                worker: task.workerId,
                expiredAt: now.toISOString(),
                previousVersion: task.version,
                leaseId: task.leaseId,
                leaseUntil: task.leaseUntil,
              },
            });
          } catch (eventErr: unknown) {
            this.logger?.warn("Failed to record task_lease_expired event", {
              taskId: task.id,
              error: eventErr instanceof Error ? eventErr.message : String(eventErr),
            });
          }
        }

        // 4. Trigger optional listener callback
        try {
          this.onLeaseExpired?.(task);
        } catch (listenerErr: unknown) {
          this.logger?.warn("TaskLeaseMonitor onLeaseExpired callback threw", {
            taskId: task.id,
            error: listenerErr instanceof Error ? listenerErr.message : String(listenerErr),
          });
        }
      } else {
        // Version conflict or concurrent renewal/completion: skip without failure
        conflictsSkipped++;
        this.logger?.debug("Skipped lease expiration due to concurrent mutation", {
          taskId: task.id,
          expectedVersion: task.version,
        });
      }
    }

    return {
      checkedCandidates: candidates.length,
      expiredMarked,
      conflictsSkipped,
    };
  }
}
