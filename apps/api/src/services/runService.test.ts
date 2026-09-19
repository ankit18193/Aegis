import { runId } from "@aegis/types";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryRunRepository } from "../repositories/inMemoryRunRepository.js";

import { RunApplicationService } from "./runService.js";

describe("RunApplicationService & InMemoryRunRepository", () => {
  let repository: InMemoryRunRepository;
  let service: RunApplicationService;

  beforeEach(async () => {
    repository = new InMemoryRunRepository(true);
    await repository.resetToDefaults();
    service = new RunApplicationService(repository);
  });

  describe("listRuns", () => {
    it("returns pre-seeded runs list with total count", async () => {
      const result = await service.listRuns();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(4);
        expect(result.value.totalCount).toBe(4);
        expect(result.value.items[0]?.goal).toBeDefined();
        expect(result.value.items[0]?.completedTasks).toBeDefined();
      }
    });

    it("filters runs by status", async () => {
      const result = await service.listRuns({ status: "running", limit: 20 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.items[0]?.id).toBe("run-001");
        expect(result.value.items[0]?.status).toBe("running");
      }
    });

    it("filters runs by search query keyword", async () => {
      const result = await service.listRuns({ query: "zero-trust", limit: 20 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.items[0]?.id).toBe("run-002");
      }
    });

    it("respects pagination limit and provides nextCursor only when more items exist", async () => {
      const page1 = await service.listRuns({ limit: 2 });

      expect(page1.ok).toBe(true);
      if (page1.ok) {
        expect(page1.value.items.length).toBe(2);
        expect(page1.value.nextCursor).toBe(page1.value.items[1]?.id);

        // Second page fetches remaining 2 items (out of 4 total seeds)
        const page2 = await service.listRuns({ limit: 2, cursor: page1.value.nextCursor });
        expect(page2.ok).toBe(true);
        if (page2.ok) {
          expect(page2.value.items.length).toBe(2);
          expect(page2.value.nextCursor).toBeUndefined();
        }
      }
    });
  });

  describe("getRun", () => {
    it("returns full run details for existing run ID", async () => {
      const result = await service.getRun(runId("run-001"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.run.id).toBe("run-001");
        expect(result.value.run.status).toBe("running");
        expect(result.value.run.tasks.length).toBe(5);
        expect(result.value.run.workflow.name).toBe("Repository Performance Analysis Pipeline");
      }
    });

    it("returns NOT_FOUND error for non-existent run ID", async () => {
      const result = await service.getRun(runId("run-9999"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.code).toBe("NOT_FOUND");
        expect(result.error.error.message).toContain("run-9999");
      }
    });
  });

  describe("createRun", () => {
    it("creates run in pending status with initial tasks and event", async () => {
      const result = await service.createRun({
        goal: "Benchmark neural token throughput across distributed TPU nodes",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const created = result.value.run;
        expect(created.id).toMatch(/^run-/);
        expect(created.status).toBe("pending");
        expect(created.progress).toBe(0);
        expect(created.tasks.length).toBe(4);
        expect(created.tasks[0]?.status).toBe("pending");

        // Verify it was stored in repository
        const fetched = await service.getRun(created.id);
        expect(fetched.ok).toBe(true);

        // Verify initial event was recorded
        const eventsResult = await service.getRunEvents(created.id);
        expect(eventsResult.ok).toBe(true);
        if (eventsResult.ok) {
          expect(eventsResult.value.events.length).toBe(1);
          expect(eventsResult.value.events[0]?.type).toBe("run_created");
        }
      }
    });
  });

  describe("cancelRun", () => {
    it("cancels an active running run and cancels unfinished tasks", async () => {
      const result = await service.cancelRun(runId("run-001"), {
        reason: "User requested immediate stop",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.run.status).toBe("cancelled");
        const runningOrPending = result.value.run.tasks.filter(
          (t) => t.status === "running" || t.status === "pending" || t.status === "queued",
        );
        expect(runningOrPending.length).toBe(0);

        // Completed tasks remain completed
        const completedTasks = result.value.run.tasks.filter((t) => t.status === "completed");
        expect(completedTasks.length).toBe(2);

        // Verify cancellation event was recorded
        const eventsResult = await service.getRunEvents(runId("run-001"));
        expect(eventsResult.ok).toBe(true);
        if (eventsResult.ok) {
          const cancelEvent = eventsResult.value.events.find((e) => e.type === "run_cancelled");
          expect(cancelEvent).toBeDefined();
          expect(cancelEvent?.message).toContain("User requested immediate stop");
        }
      }
    });

    it("returns CONFLICT when attempting to cancel an already completed run", async () => {
      const result = await service.cancelRun(runId("run-002"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.code).toBe("CONFLICT");
        expect(result.error.error.message).toContain("terminal status 'completed'");
      }
    });

    it("returns NOT_FOUND when attempting to cancel non-existent run", async () => {
      const result = await service.cancelRun(runId("run-unknown"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("getRunEvents", () => {
    it("returns chronological events for existing run", async () => {
      const result = await service.getRunEvents(runId("run-001"));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.events.length).toBeGreaterThan(0);
        expect(result.value.events[0]?.type).toBe("run_created");
      }
    });

    it("returns NOT_FOUND for events on non-existent run", async () => {
      const result = await service.getRunEvents(runId("run-9999"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("InMemoryRunRepository isolation", () => {
    it("guarantees deep clone isolation so mutations outside do not corrupt repository state", async () => {
      const run = await repository.findById(runId("run-001"));
      expect(run).not.toBeNull();

      if (run) {
        // Mutate local object
        run.goal = "Mutated malicious goal";
        run.tasks.pop();

        // Verify repository state is untouched
        const fresh = await repository.findById(runId("run-001"));
        expect(fresh?.goal).not.toBe("Mutated malicious goal");
        expect(fresh?.tasks.length).toBe(5);
      }
    });
  });
});
