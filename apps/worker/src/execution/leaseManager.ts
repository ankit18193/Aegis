import type {
  ITaskLeaseClient,
  LeaseError,
  TaskLease,
  TaskLeaseConfig,
} from "@aegis/contracts";
import { DEFAULT_TASK_LEASE_CONFIG } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";
import type { Result, TaskId, WorkerId } from "@aegis/types";
import { err, ok } from "@aegis/types";

export interface WorkerTaskLeaseManagerOptions {
  readonly leaseClient: ITaskLeaseClient;
  readonly taskId: TaskId;
  readonly workerId: WorkerId;
  readonly initialLease: TaskLease;
  readonly config?: Partial<TaskLeaseConfig> | undefined;
  readonly onLeaseLost?: ((error: LeaseError) => void) | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * WorkerTaskLeaseManager maintains task lease ownership during execution:
 * 1. Tracks active lease ID and authoritative version.
 * 2. Runs background heartbeat loop to renew lease at renewalIntervalMs.
 * 3. Gracefully retries temporary renewal failures before leaseUntil deadline.
 * 4. Detects terminal lease loss (expiration, stale lease, or ownership conflict)
 *    and triggers onLeaseLost callback to abort orphan computation.
 * 5. Explicitly releases the lease when execution terminates.
 */
export class WorkerTaskLeaseManager {
  private currentLease: TaskLease;
  private readonly leaseClient: ITaskLeaseClient;
  private readonly taskId: TaskId;
  private readonly workerId: WorkerId;
  private readonly config: TaskLeaseConfig;
  private readonly onLeaseLost?: ((error: LeaseError) => void) | undefined;
  private readonly logger?: Logger | undefined;

  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private _isLost = false;

  constructor(options: WorkerTaskLeaseManagerOptions) {
    this.leaseClient = options.leaseClient;
    this.taskId = options.taskId;
    this.workerId = options.workerId;
    this.currentLease = options.initialLease;
    this.config = {
      ...DEFAULT_TASK_LEASE_CONFIG,
      ...(options.config ?? {}),
    };
    this.onLeaseLost = options.onLeaseLost;
    this.logger = options.logger;
  }

  public get lease(): TaskLease {
    return this.currentLease;
  }

  public get isLost(): boolean {
    return this._isLost;
  }

  public get active(): boolean {
    return this.isRunning && !this._isLost;
  }

  /**
   * Checks whether the current lease is considered active and unexpired.
   */
  public isLeaseActive(now: Date = new Date()): boolean {
    if (this._isLost) return false;
    if (this.currentLease.leaseExpiredAt) return false;
    return new Date(this.currentLease.leaseUntil).getTime() > now.getTime();
  }

  /**
   * Starts periodic renewal loop.
   */
  public start(): void {
    if (this.isRunning || this._isLost) return;
    this.isRunning = true;
    this.scheduleNextRenewal(this.config.renewalIntervalMs);
  }

  private scheduleNextRenewal(delayMs: number): void {
    if (!this.isRunning || this._isLost) return;
    this.timer = setTimeout(() => {
      void this.performRenewal();
    }, delayMs);
  }

  /**
   * Explicitly attempts an immediate lease renewal.
   */
  public async renewNow(): Promise<Result<TaskLease, LeaseError>> {
    const res = await this.leaseClient.renew({
      taskId: this.taskId,
      leaseId: this.currentLease.leaseId,
      workerId: this.workerId,
      leaseDurationMs: this.config.leaseDurationMs,
      expectedVersion: this.currentLease.version,
    });

    if (res.ok) {
      this.currentLease = res.value;
      this.logger?.debug("Task lease renewed successfully", {
        taskId: this.taskId,
        leaseId: this.currentLease.leaseId,
        version: this.currentLease.version,
        leaseUntil: this.currentLease.leaseUntil,
      });
      return ok(this.currentLease);
    } else {
      this.logger?.warn("Task lease renewal failed", {
        taskId: this.taskId,
        error: res.error.message,
        code: res.error.code,
      });

      if (
        res.error.code === "LEASE_EXPIRED" ||
        res.error.code === "STALE_LEASE" ||
        res.error.code === "LEASE_OWNERSHIP_CONFLICT"
      ) {
        this.handleLeaseLost(res.error);
      }
      return err(res.error);
    }
  }

  private async performRenewal(): Promise<void> {
    if (!this.isRunning || this._isLost) return;

    const res = await this.renewNow();
    if (res.ok) {
      this.scheduleNextRenewal(this.config.renewalIntervalMs);
    } else {
      // If temporary non-terminal error and lease not yet expired, schedule rapid retry
      if (this.isLeaseActive()) {
        const retryDelay = Math.min(2000, Math.floor(this.config.renewalIntervalMs / 2));
        this.scheduleNextRenewal(retryDelay);
      }
    }
  }

  private handleLeaseLost(error: LeaseError): void {
    this._isLost = true;
    this.stopRenewalLoop();
    this.onLeaseLost?.(error);
  }

  private stopRenewalLoop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stops the lease renewal loop and optionally releases ownership.
   */
  public async stop(release = true): Promise<void> {
    this.stopRenewalLoop();
    if (release && !this._isLost) {
      try {
        await this.leaseClient.release({
          taskId: this.taskId,
          leaseId: this.currentLease.leaseId,
          workerId: this.workerId,
          expectedVersion: this.currentLease.version,
        });
      } catch (e) {
        this.logger?.warn("Error releasing task lease during stop", {
          taskId: this.taskId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}
