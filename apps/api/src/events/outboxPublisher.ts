import * as crypto from "node:crypto";

import type { EventEnvelope, IEventPublisher } from "@aegis/contracts";
import { DEFAULT_OUTBOX_CONFIG } from "@aegis/contracts";
import type { Logger } from "@aegis/logger";

import type { IOutboxRepository, OutboxRecord } from "../repositories/outboxRepository.js";

export interface OutboxPublisherOptions {
  readonly outboxRepository: IOutboxRepository;
  readonly eventPublisher: IEventPublisher;
  readonly defaultTopic?: string | undefined;
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
 * OutboxPublisher — Phase 12C/12D: Background Transactional Outbox Dispatch Service.
 *
 * Implements the transactional outbox polling publisher:
 * 1. Periodically sweeps pending outbox records using `FOR UPDATE SKIP LOCKED`.
 * 2. Groups claimed records by target topic (record.topic ?? defaultTopic).
 * 3. Dispatches each topic group as a batch to canonical `IEventPublisher`.
 * 4. On success, transitions records to `published` status and records latency metrics.
 * 5. On failure, applies exponential backoff, increments attempt counts, and marks records `failed`.
 * 6. Provides graceful shutdown by draining the in-flight publication batch on `stop()`.
 */
export class OutboxPublisher {
  private readonly outboxRepository: IOutboxRepository;
  private readonly eventPublisher: IEventPublisher;
  private readonly defaultTopic: string;
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
    this.defaultTopic = options.defaultTopic ?? "aegis.events";
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

    // Group claimed records by target topic
    const topicGroups = new Map<string, OutboxRecord[]>();
    for (const record of claimedRecords) {
      const topic = record.topic ?? this.defaultTopic;
      const group = topicGroups.get(topic);
      if (group) {
        group.push(record);
      } else {
        topicGroups.set(topic, [record]);
      }
    }

    let totalPublished = 0;
    let totalFailed = 0;

    for (const [topic, groupRecords] of topicGroups.entries()) {
      // 1. Guard against crash loops: records that exhausted maxAttempts due to crashes prior to this sweep
      const executableRecords: OutboxRecord[] = [];
      for (const record of groupRecords) {
        if (record.attemptCount > this.maxAttempts) {
          this.logger?.error("Outbox record exceeded maxAttempts due to repeated process crashes; marking permanently failed", {
            id: record.id,
            attemptCount: record.attemptCount,
            maxAttempts: this.maxAttempts,
          });
          try {
            await this.outboxRepository.markFailed(
              record.id,
              `Exceeded max publication attempts (${String(this.maxAttempts)}) due to repeated worker/process crashes`,
              undefined,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger?.error("Failed to mark exhausted outbox record as failed", {
              id: record.id,
              error: msg,
            });
          }
          totalFailed++;
        } else {
          executableRecords.push(record);
        }
      }

      if (executableRecords.length === 0) {
        continue;
      }

      const envelopes: EventEnvelope[] = executableRecords.map((r) => r.payload as EventEnvelope);

      let publishResult;
      try {
        publishResult = await this.eventPublisher.publishBatch(envelopes, topic);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        publishResult = { ok: false as const, error: { code: "BROKER_UNAVAILABLE" as const, message: msg } };
      }

      if (publishResult.ok) {
        try {
          const ids = executableRecords.map((r) => r.id);
          const now = new Date();
          await this.outboxRepository.markPublished(ids, now);
          totalPublished += executableRecords.length;

          this.logger?.info("Published outbox batch successfully", {
            topic,
            count: executableRecords.length,
            workerId: this.workerId,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger?.error("Failed to mark outbox records as published", {
            topic,
            error: msg,
            count: executableRecords.length,
          });
          totalFailed += executableRecords.length;
        }
      } else {
        const errorMsg = publishResult.error.message;
        this.logger?.warn("Batch outbox event publication failed; applying backoff", {
          topic,
          count: executableRecords.length,
          error: errorMsg,
        });

        for (const record of executableRecords) {
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

        totalFailed += executableRecords.length;
      }
    }

    this._publishedCount += totalPublished;
    this._failedCount += totalFailed;

    return {
      claimedCount: claimedRecords.length,
      publishedCount: totalPublished,
      failedCount: totalFailed,
    };
  }
}
