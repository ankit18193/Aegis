/**
 * Integration test suite for PostgresRunEventReplayRepository.
 * Tests real PostgreSQL persistence, cursor resolution, compound ordering,
 * multi-page pagination, and run isolation against PostgreSQL.
 */

import * as net from "node:net";

import { eventId, runId, type RunId } from "@aegis/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseContext, type DatabaseContext } from "../../db/client.js";
import { runMigrations } from "../../db/migrator.js";
import { PostgresRunEventReplayRepository } from "../postgresRunEventReplayRepository.js";
import { PostgresRunRepository } from "../postgresRunRepository.js";

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

const dbAvailable = await isDatabaseReachable();

describe.runIf(dbAvailable)(
  "PostgresRunEventReplayRepository Integration Tests (Real PostgreSQL)",
  () => {
    let ctx: DatabaseContext;
    let runRepo: PostgresRunRepository;
    let replayRepo: PostgresRunEventReplayRepository;

    const RUN_1: RunId = runId("run-001");
    const RUN_2: RunId = runId("run-002");

    beforeAll(async () => {
      ctx = createDatabaseContext({
        url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5433/aegis",
        poolMin: 1,
        poolMax: 3,
      });
      await runMigrations(ctx.db);
      runRepo = new PostgresRunRepository(ctx);
      replayRepo = new PostgresRunEventReplayRepository(ctx);
    }, 30000);

    beforeEach(async () => {
      await runRepo.resetToDefaults();
    });

    afterAll(async () => {
      await ctx.close();
    });

    describe("Run Existence and Initial Replay", () => {
      it("returns RUN_NOT_FOUND when querying a non-existent run ID", async () => {
        const result = await replayRepo.replayEvents({
          runId: runId("run-non-existent-999"),
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("RUN_NOT_FOUND");
        }
      });

      it("replays seeded events in chronological order from the beginning", async () => {
        const result = await replayRepo.replayEvents({
          runId: RUN_1,
          limit: 50,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.events.length).toBeGreaterThanOrEqual(10);
          expect(result.value.events[0]?.id).toBe(eventId("ev-001"));
          expect(result.value.status).toBe("complete");
          expect(result.value.hasMore).toBe(false);
          expect(result.value.reconcileRequired).toBe(false);
          expect(result.value.isCatchUpComplete).toBe(true);
        }
      });
    });

    describe("Cursor Resumption & Bounded Pagination", () => {
      it("resumes replay strictly after a valid anchor cursor", async () => {
        const result = await replayRepo.replayEvents({
          runId: RUN_1,
          cursor: "ev-003",
          limit: 50,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          const ids = result.value.events.map((e) => e.id);
          expect(ids[0]).toBe("ev-004");
          expect(ids).not.toContain("ev-001");
          expect(ids).not.toContain("ev-002");
          expect(ids).not.toContain("ev-003");
        }
      });

      it("iterates across multiple pages until catch-up is complete", async () => {
        // Page 1
        const page1Res = await replayRepo.replayEvents({
          runId: RUN_1,
          limit: 3,
        });

        expect(page1Res.ok).toBe(true);
        if (!page1Res.ok) return;

        expect(page1Res.value.events).toHaveLength(3);
        expect(page1Res.value.hasMore).toBe(true);
        expect(page1Res.value.status).toBe("has_more");
        expect(page1Res.value.isCatchUpComplete).toBe(false);
        expect(page1Res.value.nextCursor).toBe(page1Res.value.events[2]?.id);

        // Page 2
        const page2Res = await replayRepo.replayEvents({
          runId: RUN_1,
          cursor: page1Res.value.nextCursor ?? undefined,
          limit: 3,
        });

        expect(page2Res.ok).toBe(true);
        if (!page2Res.ok) return;

        expect(page2Res.value.events).toHaveLength(3);
        expect(page2Res.value.events[0]?.id).not.toBe(page1Res.value.nextCursor);
      });
    });

    describe("Run Isolation & Error Handling", () => {
      it("rejects cross-run cursor from run-002 when querying run-001", async () => {
        // 'ev-201' is a seeded event belonging to run-002
        const result = await replayRepo.replayEvents({
          runId: RUN_1,
          cursor: "ev-201",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("CROSS_RUN_CURSOR");
          expect(result.error.runId).toBe(RUN_1);
          expect(result.error.cursor).toBe("ev-201");
          expect(result.error.details?.["cursorRun"]).toBe(RUN_2);
        }
      });

      it("returns gap_detected with reconcileRequired: true for non-existent cursor", async () => {
        const result = await replayRepo.replayEvents({
          runId: RUN_1,
          cursor: "ev-ghost-99999",
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe("gap_detected");
          expect(result.value.reconcileRequired).toBe(true);
          expect(result.value.events).toHaveLength(0);
        }
      });
    });

    describe("Earliest and Latest Event Probes", () => {
      it("retrieves the earliest and latest seeded events", async () => {
        const earliest = await replayRepo.getEarliestEvent(RUN_1);
        expect(earliest.ok).toBe(true);
        if (earliest.ok) {
          expect(earliest.value?.id).toBe("ev-001");
        }

        const latest = await replayRepo.getLatestEvent(RUN_1);
        expect(latest.ok).toBe(true);
        if (latest.ok) {
          expect(latest.value?.id).toBe("ev-010");
        }
      });
    });
  },
);
