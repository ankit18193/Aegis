/**
 * InMemoryOutboxRepository — Fast in-memory implementation of IOutboxRepository.
 * Used for hermetic unit testing without requiring an active PostgreSQL database.
 */

import type { OutboxEventId } from "@aegis/types";
import { outboxEventId } from "@aegis/types";

import type {
  CreateOutboxRecord,
  IOutboxRepository,
  OutboxClaimRequest,
  OutboxRecord,
} from "./outboxRepository.js";

export class InMemoryOutboxRepository implements IOutboxRepository {
  private readonly records = new Map<OutboxEventId, OutboxRecord>();

  insert(
    records: readonly CreateOutboxRecord[],
    _tx?: unknown,
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const r of records) {
      const id = r.id ? outboxEventId(r.id) : outboxEventId(r.payload.id || crypto.randomUUID());
      const record: OutboxRecord = {
        id,
        aggregateId: r.aggregateId,
        aggregateType: r.aggregateType,
        eventType: r.eventType,
        payload: r.payload,
        status: r.status ?? "pending",
        attemptCount: r.attemptCount ?? 0,
        lockedUntil: undefined,
        lockedBy: undefined,
        publishedAt: undefined,
        lastError: undefined,
        createdAt: r.createdAt ?? now,
      };
      this.records.set(id, record);
    }
    return Promise.resolve();
  }

  claimPending(request: OutboxClaimRequest): Promise<OutboxRecord[]> {
    const now = new Date();
    const lockedUntilIso = new Date(now.getTime() + request.lockDurationMs).toISOString();

    const candidates: OutboxRecord[] = [];
    for (const record of this.records.values()) {
      const isPending = record.status === "pending";
      const isExpiredLock =
        record.status === "publishing" &&
        record.lockedUntil !== undefined &&
        record.lockedUntil !== null &&
        new Date(record.lockedUntil) <= now;

      if (isPending || isExpiredLock) {
        candidates.push(record);
      }
    }

    candidates.sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    const toClaim = candidates.slice(0, request.batchSize);
    const claimed: OutboxRecord[] = [];

    for (const c of toClaim) {
      const updated: OutboxRecord = {
        ...c,
        status: "publishing",
        lockedUntil: lockedUntilIso,
        lockedBy: request.workerId,
        attemptCount: c.attemptCount + 1,
      };
      this.records.set(c.id, updated);
      claimed.push(updated);
    }

    return Promise.resolve(claimed);
  }

  markPublished(
    ids: readonly OutboxEventId[],
    publishedAt: Date = new Date(),
  ): Promise<void> {
    for (const id of ids) {
      const existing = this.records.get(id);
      if (existing) {
        this.records.set(id, {
          ...existing,
          status: "published",
          publishedAt: publishedAt.toISOString(),
          lockedUntil: undefined,
          lockedBy: undefined,
        });
      }
    }
    return Promise.resolve();
  }

  markFailed(
    id: OutboxEventId,
    error: string,
    nextAttemptAt?: Date,
  ): Promise<void> {
    const existing = this.records.get(id);
    if (existing) {
      this.records.set(id, {
        ...existing,
        status: nextAttemptAt ? "pending" : "failed",
        lockedUntil: nextAttemptAt ? nextAttemptAt.toISOString() : undefined,
        lockedBy: undefined,
        lastError: error,
      });
    }
    return Promise.resolve();
  }

  getPendingCount(): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "pending") {
        count++;
      }
    }
    return Promise.resolve(count);
  }

  getFailedCount(): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "failed") {
        count++;
      }
    }
    return Promise.resolve(count);
  }

  /**
   * Clears all in-memory outbox records (for test isolation).
   */
  clear(): void {
    this.records.clear();
  }

  /**
   * Helper to retrieve all records in store (for assertions).
   */
  getAll(): OutboxRecord[] {
    return Array.from(this.records.values());
  }
}
