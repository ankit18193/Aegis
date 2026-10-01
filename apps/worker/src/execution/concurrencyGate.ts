/**
 * ConcurrencyGate — Asynchronous bounded execution gate (Semaphore).
 * Strictly bounds concurrent active task executions on the worker without blocking event loops.
 */
export class ConcurrencyGate {
  private current = 0;
  private readonly max: number;
  private readonly queue: (() => void)[] = [];

  constructor(maxConcurrent: number) {
    this.max = Math.max(1, maxConcurrent);
  }

  public get activeCount(): number {
    return this.current;
  }

  public get waitingCount(): number {
    return this.queue.length;
  }

  public get maxConcurrency(): number {
    return this.max;
  }

  /**
   * Acquires an execution slot, waiting asynchronously if capacity is reached.
   */
  public async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  /**
   * Releases an execution slot and unblocks the next queued execution if any.
   */
  public release(): void {
    if (this.current > 0) {
      this.current--;
    }
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  /**
   * Executes an asynchronous task within the bounded concurrency boundary.
   */
  public async runBounded<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
