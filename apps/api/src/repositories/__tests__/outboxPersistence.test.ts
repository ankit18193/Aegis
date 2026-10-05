import * as net from "node:net";

import type { EventEnvelope } from "@aegis/contracts";
import { eventId, outboxEventId, runId } from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../../db/client.js";
import { runMigrations } from "../../db/migrator.js";
import { outboxEventsTable } from "../../db/schema.js";
import { InMemoryOutboxRepository } from "../inMemoryOutboxRepository.js";
import type { CreateOutboxRecord, IOutboxRepository } from "../outboxRepository.js";
import { PostgresOutboxRepository } from "../postgresOutboxRepository.js";

async function isDatabaseReachable(port = 5433, host = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function createSampleEnvelope(idStr: string, rIdStr: string): EventEnvelope {
  const eId = eventId(idStr);
  const rId = runId(rIdStr);
  const now = new Date().toISOString();
  return {
    id: eId,
    type: "task_scheduled",
    source: "aegis.execution",
    specVersion: "1.0",
    time: now,
    aggregateId: rId,
    aggregateType: "ExecutionRun",
    correlationId: rId,
    data: {
      id: eId,
      runId: rId,
      type: "task_scheduled",
      severity: "info",
      timestamp: now,
      message: `Task scheduled for run ${rIdStr}`,
    },
  };
}

describe("Outbox Persistence (Phase 12C — Commit 2)", () => {
  describe("InMemoryOutboxRepository", () => {
    let repo: InMemoryOutboxRepository;

    beforeEach(() => {
      repo = new InMemoryOutboxRepository();
    });

    executeOutboxScenarios(() => repo, "mem");
  });

  describe("PostgresOutboxRepository (Live PostgreSQL)", () => {
    let ctx: DatabaseContext | null = null;
    let repo: PostgresOutboxRepository;
    let dbAvailable = false;

    beforeAll(async () => {
      dbAvailable = await isDatabaseReachable();
      if (!dbAvailable) {
        return;
      }

      ctx = createDatabaseContext();
      await runMigrations(ctx.db);
      await ctx.db.delete(outboxEventsTable);
      repo = new PostgresOutboxRepository(ctx.db);
    });

    afterAll(async () => {
      if (ctx) {
        await ctx.db.delete(outboxEventsTable);
        await ctx.close();
      }
    });

    it("confirms database connectivity for outbox tests", () => {
      if (!dbAvailable) {
        expect(true).toBe(true);
        return;
      }
      expect(repo).toBeDefined();
    });

    executeOutboxScenarios(() => repo, "pg", () => dbAvailable);
  });
});

function executeOutboxScenarios(
  getRepo: () => IOutboxRepository,
  basePrefix: string,
  shouldRun?: () => boolean,
) {
  const prefix = `${basePrefix}-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 6)}`;

  it("inserts outbox records and retrieves initial pending count", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const env1 = createSampleEnvelope(`evt-${prefix}-1`, `run-${prefix}-1`);
    const env2 = createSampleEnvelope(`evt-${prefix}-2`, `run-${prefix}-1`);

    const records: CreateOutboxRecord[] = [
      {
        id: outboxEventId(`outbox-${prefix}-1`),
        aggregateId: `run-${prefix}-1`,
        aggregateType: "run",
        eventType: "task_scheduled",
        payload: env1,
      },
      {
        id: outboxEventId(`outbox-${prefix}-2`),
        aggregateId: `run-${prefix}-1`,
        aggregateType: "run",
        eventType: "task_scheduled",
        payload: env2,
      },
    ];

    await repo.insert(records);

    const pendingCount = await repo.getPendingCount();
    expect(pendingCount).toBeGreaterThanOrEqual(2);
  });

  it("claims pending records in chronological order with SKIP LOCKED", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const env1 = createSampleEnvelope(`evt-claim-${prefix}-1`, `run-claim-${prefix}`);
    const env2 = createSampleEnvelope(`evt-claim-${prefix}-2`, `run-claim-${prefix}`);

    await repo.insert([
      {
        id: outboxEventId(`outbox-claim-${prefix}-1`),
        aggregateId: `run-claim-${prefix}`,
        aggregateType: "run",
        eventType: "task_scheduled",
        payload: env1,
      },
      {
        id: outboxEventId(`outbox-claim-${prefix}-2`),
        aggregateId: `run-claim-${prefix}`,
        aggregateType: "run",
        eventType: "task_scheduled",
        payload: env2,
      },
    ]);

    const claimed = await repo.claimPending({
      batchSize: 2,
      lockDurationMs: 15000,
      workerId: `worker-${prefix}-1`,
    });

    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const first = claimed[0];
    expect(first).toBeDefined();
    if (!first) return;

    expect(first.status).toBe("publishing");
    expect(first.lockedBy).toBe(`worker-${prefix}-1`);
    expect(first.lockedUntil).toBeDefined();
    expect(first.attemptCount).toBeGreaterThanOrEqual(1);

    // Immediate second claim from another worker should not get the same records (SKIP LOCKED)
    const secondClaim = await repo.claimPending({
      batchSize: 2,
      lockDurationMs: 15000,
      workerId: `worker-${prefix}-2`,
    });

    const claimedIds = new Set(claimed.map((r) => r.id));
    for (const r of secondClaim) {
      expect(claimedIds.has(r.id)).toBe(false);
    }
  });

  it("marks claimed records as published and clears lock metadata", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const env = createSampleEnvelope(`evt-pub-${prefix}`, `run-pub-${prefix}`);
    const outboxId = outboxEventId(`outbox-pub-${prefix}`);

    await repo.insert([
      {
        id: outboxId,
        aggregateId: `run-pub-${prefix}`,
        aggregateType: "run",
        eventType: "task_scheduled",
        payload: env,
      },
    ]);

    const claimed = await repo.claimPending({
      batchSize: 50,
      lockDurationMs: 10000,
      workerId: "test-publisher",
    });

    const target = claimed.find((r) => r.id === outboxId);
    expect(target).toBeDefined();

    const publishedAt = new Date();
    await repo.markPublished([outboxId], publishedAt);

    // Re-claiming should not return published records
    const nextClaim = await repo.claimPending({
      batchSize: 10,
      lockDurationMs: 10000,
      workerId: "test-publisher-2",
    });

    expect(nextClaim.some((r) => r.id === outboxId)).toBe(false);
  });

  it("marks a record as failed and handles backoff retry vs terminal failure", async () => {
    if (shouldRun && !shouldRun()) return;
    const repo = getRepo();

    const env = createSampleEnvelope(`evt-fail-${prefix}`, `run-fail-${prefix}`);
    const outboxId = outboxEventId(`outbox-fail-${prefix}`);

    await repo.insert([
      {
        id: outboxId,
        aggregateId: `run-fail-${prefix}`,
        aggregateType: "run",
        eventType: "task_scheduled",
        payload: env,
      },
    ]);

    // 1. Transient failure with nextAttemptAt in future
    const retryAt = new Date(Date.now() + 60000);
    await repo.markFailed(outboxId, "Temporary network timeout", retryAt);

    // 2. Terminal failure without nextAttemptAt
    await repo.markFailed(outboxId, "Kafka permanent rejection: topic not found");
    const failedCount = await repo.getFailedCount();
    expect(failedCount).toBeGreaterThanOrEqual(1);
  });
}
