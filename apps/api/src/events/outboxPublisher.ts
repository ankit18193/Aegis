import * as crypto from "node:crypto";

import type { EventEnvelope, IEventPublisher } from "@aegis/contracts";
import { DEFAULT_OUTBOX_CONFIG } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";

import type { IOutboxRepository, OutboxRecord } from "../repositories/outboxRepository.js";

export interface OutboxPublisherOptions {
  readonly outboxRepository: IOutboxRepository;
  readonly eventPublisher: IEventPublisher;
  readonly pollIntervalMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly lockDurationMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly backoffBaseMs?: number | undefined;
  readonly backoffMaxMs?: number | undefined;
  readonly workerId?: string | undefined;
  readonly logger?: Logger | undefined;
}

export interface OutboxSweepResult {
  readonly claimedCount: number;
  readonly publishedCount: number;
  readonly failedCount: number;
}

/**
 * OutboxPublisher — Phase 12C: Background Transactional Outbox Dispatch Service.
 *
 * Implements the transactional outbox polling publisher:
 * 1. Periodically sweeps pending outbox records using `FOR UPDATE SKIP LOCKED`.
 * 2. Dispatches claimed event envelopes as a batch to canonical `IEventPublisher`.
 * 3. On success, transitions records to `published` status and records latency metrics.
 * 4. On failure, applies exponential backoff, increments attempt counts, and marks records `failed`.
 * 5. Provides graceful shutdown by draining the in-flight publication batch on `stop()`.
 */
export class OutboxPublisher {
  private readonly outboxRepository: IOutboxRepository;
  private readonly eventPublisher: IEventPublisher;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly lockDurationMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxAttempts: number;
  readonly workerId: string;
  private readonly logger: Logger | undefined;

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private currentSweepPromise: Promise<OutboxSweepResult> | null = null;

  private _sweepsCount = 0;
  private _publishedCount = 0;
  private _failedCount = 0;

  constructor(options: OutboxPublisherOptions) {
    this.outboxRepository = options.outboxRepository;
    this.eventPublisher = options.eventPublisher;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_OUTBOX_CONFIG.pollIntervalMs;
    this.batchSize = options.batchSize ?? DEFAULT_OUTBOX_CONFIG.batchSize;
    this.lockDurationMs = options.lockDurationMs ?? DEFAULT_OUTBOX_CONFIG.lockDurationMs;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_OUTBOX_CONFIG.backoffBaseMs;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_OUTBOX_CONFIG.backoffMaxMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_OUTBOX_CONFIG.maxAttempts;
    this.workerId = options.workerId ?? `outbox-publisher-${crypto.randomUUID()}`;
    this.logger = options.logger;
  }

  public get isRunning(): boolean {
    return this.running;
  }

  public get sweepsCount(): number {
    return this._sweepsCount;
  }

  public get publishedCount(): number {
    return this._publishedCount;
  }

  public get failedCount(): number {
    return this._failedCount;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    this.logger?.info("Starting OutboxPublisher background service", {
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
      workerId: this.workerId,
    });

    const scheduleNext = (): void => {
      if (!this.running) return;
      this.timer = setTimeout(() => {
        void (async () => {
          if (!this.running) return;
          try {
            await this.sweepOnce();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger?.error("Unexpected error during outbox sweep cycle", {
              error: msg,
              workerId: this.workerId,
            });
          } finally {
            scheduleNext();
          }
        })();
      }, this.pollIntervalMs);
    };

    scheduleNext();
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.currentSweepPromise) {
      try {
        await this.currentSweepPromise;
      } catch {
        // Drain current in-flight batch gracefully
      }
    }

    this.logger?.info("Stopped OutboxPublisher background service", {
      workerId: this.workerId,
    });
  }

  /**
   * Executes a single sweep cycle to claim and dispatch pending outbox events.
   * Can be invoked directly by background timers or manually in tests.
   */
  public async sweepOnce(): Promise<OutboxSweepResult> {
    if (this.currentSweepPromise) {
      return this.currentSweepPromise;
    }

    this.currentSweepPromise = this.executeSweep();
    try {
      return await this.currentSweepPromise;
    } finally {
      this.currentSweepPromise = null;
    }
  }

  private async executeSweep(): Promise<OutboxSweepResult> {
    this._sweepsCount++;

    let claimedRecords: OutboxRecord[];
    try {
      claimedRecords = await this.outboxRepository.claimPending({
        batchSize: this.batchSize,
        lockDurationMs: this.lockDurationMs,
        workerId: this.workerId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error("Failed to claim pending outbox records", {
        error: msg,
        workerId: this.workerId,
      });
      return { claimedCount: 0, publishedCount: 0, failedCount: 0 };
    }

    if (claimedRecords.length === 0) {
      return { claimedCount: 0, publishedCount: 0, failedCount: 0 };
    }

    const envelopes: EventEnvelope[] = claimedRecords.map((r) => r.payload);

    let publishResult;
    try {
      publishResult = await this.eventPublisher.publishBatch(envelopes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      publishResult = { ok: false as const, error: { code: "BROKER_UNAVAILABLE" as const, message: msg } };
    }

    if (publishResult.ok) {
      try {
        const ids = claimedRecords.map((r) => r.id);
        const now = new Date();
        await this.outboxRepository.markPublished(ids, now);
        this._publishedCount += claimedRecords.length;

        this.logger?.info("Published outbox batch successfully", {
          count: claimedRecords.length,
          workerId: this.workerId,
        });

        return {
          claimedCount: claimedRecords.length,
          publishedCount: claimedRecords.length,
          failedCount: 0,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error("Failed to mark outbox records as published", {
          error: msg,
          count: claimedRecords.length,
        });
        return {
          claimedCount: claimedRecords.length,
          publishedCount: 0,
          failedCount: claimedRecords.length,
        };
      }
    }

    // Publication failed — apply exponential backoff per record
    const errorMsg = publishResult.error.message;
    this.logger?.warn("Batch outbox event publication failed; applying backoff", {
      count: claimedRecords.length,
      error: errorMsg,
    });

    for (const record of claimedRecords) {
      const attemptsUsed = record.attemptCount;
      const isTerminal = attemptsUsed >= this.maxAttempts;
      const delayMs = Math.min(
        this.backoffMaxMs,
        this.backoffBaseMs * Math.pow(2, Math.max(0, attemptsUsed - 1)),
      );
      const nextLockedUntil = isTerminal ? undefined : new Date(Date.now() + delayMs);

      try {
        await this.outboxRepository.markFailed(record.id, errorMsg, nextLockedUntil);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error("Failed to mark outbox record as failed", {
          id: record.id,
          error: msg,
        });
      }
    }

    this._failedCount += claimedRecords.length;

    return {
      claimedCount: claimedRecords.length,
      publishedCount: 0,
      failedCount: claimedRecords.length,
    };
  }
}
