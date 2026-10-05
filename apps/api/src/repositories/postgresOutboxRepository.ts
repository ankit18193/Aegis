/**
 * PostgresOutboxRepository — PostgreSQL implementation of IOutboxRepository using Drizzle ORM.
 * Implements durable event persistence and concurrency-safe claiming via SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * Invariant Locks:
 * - Lock 1: PostgreSQL is the single authoritative outbox store.
 * - Lock 2: Supports participating in an existing transaction via insert(records, tx).
 * - Lock 4: Preserves stable event identity across claiming and retries.
 * - Lock 5: Supports at-least-once delivery semantics.
 * - Lock 7: Zero Redis, zero external locking services.
 */

import type { Logger } from "@aegis/logger";
import type { OutboxEventId } from "@aegis/types";
import { outboxEventId } from "@aegis/types";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "../db/schema.js";
import { outboxEventsTable, type OutboxEventRecord } from "../db/schema.js";

import type {
  CreateOutboxRecord,
  IOutboxRepository,
  OutboxClaimRequest,
  OutboxRecord,
} from "./outboxRepository.js";

type DrizzleTransaction = Parameters<Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]>[0];
type DbOrTx = PostgresJsDatabase<typeof schema> | DrizzleTransaction;

function mapRowToOutboxRecord(row: OutboxEventRecord): OutboxRecord {
  return {
    id: outboxEventId(row.id),
    aggregateId: row.aggregateId,
    aggregateType: row.aggregateType,
    eventType: row.eventType,
    topic: row.topic ?? undefined,
    payload: row.payload,
    status: row.status as OutboxRecord["status"],
    attemptCount: row.attemptCount,
    lockedUntil: row.lockedUntil ?? undefined,
    lockedBy: row.lockedBy ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
  };
}

export class PostgresOutboxRepository implements IOutboxRepository {
  constructor(
    private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly logger?: Logger | undefined,
  ) {}

  /**
   * Persists outbox records. When tx is provided, executes within the caller's transaction.
   * Lock 2: State mutation + outbox insert in single transaction.
   */
  async insert(
    records: readonly CreateOutboxRecord[],
    tx?: DbOrTx,
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const rows = records.map((r) => ({
      id: r.id ? outboxEventId(r.id) : outboxEventId(r.payload.id || crypto.randomUUID()),
      aggregateId: r.aggregateId,
      aggregateType: r.aggregateType,
      eventType: r.eventType,
      topic: r.topic ?? null,
      payload: r.payload,
      status: r.status ?? "pending",
      attemptCount: r.attemptCount ?? 0,
      createdAt: r.createdAt ?? now,
      lockedUntil: null,
      lockedBy: null,
      publishedAt: null,
      lastError: null,
    }));

    const executor: DbOrTx = tx ?? this.db;
    await executor.insert(outboxEventsTable).values(rows);

    this.logger?.debug("Inserted outbox records", {
      count: rows.length,
      withinTx: Boolean(tx),
    });
  }

  /**
   * Concurrency-safe batch claiming using native SELECT ... FOR UPDATE SKIP LOCKED.
   * Lock 7: Pure PostgreSQL row-level locks, zero Redis.
   */
  async claimPending(request: OutboxClaimRequest): Promise<OutboxRecord[]> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const lockedUntilIso = new Date(now.getTime() + request.lockDurationMs).toISOString();

      // 1. Select candidate IDs with SKIP LOCKED
      const candidateRows = await tx
        .select({ id: outboxEventsTable.id })
        .from(outboxEventsTable)
        .where(
          or(
            and(
              eq(outboxEventsTable.status, "pending"),
              or(
                isNull(outboxEventsTable.lockedUntil),
                lte(outboxEventsTable.lockedUntil, nowIso),
              ),
            ),
            and(
              eq(outboxEventsTable.status, "publishing"),
              lte(outboxEventsTable.lockedUntil, nowIso),
            ),
          ),
        )
        .orderBy(asc(outboxEventsTable.createdAt))
        .limit(request.batchSize)
        .for("update", { skipLocked: true });

      if (candidateRows.length === 0) {
        return [];
      }

      const idsToClaim = candidateRows.map((r) => r.id);

      // 2. Atomically transition claimed rows to 'publishing'
      const updatedRows = await tx
        .update(outboxEventsTable)
        .set({
          status: "publishing",
          lockedUntil: lockedUntilIso,
          lockedBy: request.workerId,
          attemptCount: sql`${outboxEventsTable.attemptCount} + 1`,
        })
        .where(inArray(outboxEventsTable.id, idsToClaim))
        .returning();

      this.logger?.info("Claimed pending outbox records for publishing", {
        workerId: request.workerId,
        claimedCount: updatedRows.length,
      });

      return updatedRows.map(mapRowToOutboxRecord);
    });
  }

  /**
   * Marks outbox records as successfully published.
   */
  async markPublished(
    ids: readonly OutboxEventId[],
    publishedAt: Date = new Date(),
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const rawIds = [...ids] as string[];
    await this.db
      .update(outboxEventsTable)
      .set({
        status: "published",
        publishedAt: publishedAt.toISOString(),
        lockedUntil: null,
        lockedBy: null,
      })
      .where(inArray(outboxEventsTable.id, rawIds));

    this.logger?.info("Marked outbox records as published", {
      count: ids.length,
      publishedAt: publishedAt.toISOString(),
    });
  }

  /**
   * Records a publication failure for a record.
   * If nextAttemptAt is provided, transitions back to 'pending' with backoff lock;
   * otherwise marks as permanently 'failed'.
   */
  async markFailed(
    id: OutboxEventId,
    error: string,
    nextAttemptAt?: Date,
  ): Promise<void> {
    const rawId = id as string;
    const targetStatus = nextAttemptAt ? "pending" : "failed";
    const lockedUntil = nextAttemptAt ? nextAttemptAt.toISOString() : null;

    await this.db
      .update(outboxEventsTable)
      .set({
        status: targetStatus,
        lockedUntil,
        lockedBy: null,
        lastError: error,
      })
      .where(eq(outboxEventsTable.id, rawId));

    this.logger?.warn("Marked outbox record as failed", {
      outboxId: id,
      targetStatus,
      nextAttemptAt: lockedUntil,
      error,
    });
  }

  /**
   * Returns current count of pending outbox records.
   */
  async getPendingCount(): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxEventsTable)
      .where(eq(outboxEventsTable.status, "pending"));

    return result?.count ?? 0;
  }

  /**
   * Returns current count of failed outbox records.
   */
  async getFailedCount(): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxEventsTable)
      .where(eq(outboxEventsTable.status, "failed"));

    return result?.count ?? 0;
  }
}
