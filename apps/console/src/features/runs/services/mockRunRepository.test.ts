import { beforeEach, describe, expect, it } from "vitest";

import { createRunInputSchema } from "../schemas/runSchemas";

import { MockRunRepository } from "./mockRunRepository";

describe("MockRunRepository & Domain Schemas", () => {
  let repository: MockRunRepository;

  beforeEach(() => {
    repository = new MockRunRepository();
  });

  describe("Validation Schemas", () => {
    it("accepts valid goal descriptions", () => {
      const valid = createRunInputSchema.safeParse({
        goal: "Analyze repository performance bottlenecks",
      });
      expect(valid.success).toBe(true);
    });

    it("rejects goals that are too short", () => {
      const invalid = createRunInputSchema.safeParse({ goal: "ab" });
      expect(invalid.success).toBe(false);
    });

    it("trims whitespace from goal input", () => {
      const parsed = createRunInputSchema.parse({
        goal: "   Analyze code quality   ",
      });
      expect(parsed.goal).toBe("Analyze code quality");
    });
  });

  describe("Repository Operations", () => {
    it("loads initial seed runs", async () => {
      const runs = await repository.getAllRuns();
      expect(runs.length).toBeGreaterThanOrEqual(3);
      expect(runs[0]).toHaveProperty("id");
      expect(runs[0]).toHaveProperty("goal");
      expect(runs[0]).toHaveProperty("status");
    });

    it("retrieves run details by ID", async () => {
      const run = await repository.getRunById("run-001");
      expect(run).not.toBeNull();
      expect(run?.id).toBe("run-001");
      expect(run?.tasks.length).toBe(5);
    });

    it("returns null for non-existent run ID", async () => {
      const run = await repository.getRunById("non-existent-id");
      expect(run).toBeNull();
    });

    it("creates a new execution run with pending tasks", async () => {
      const newRun = await repository.createRun({
        goal: "Profile memory allocation patterns across services",
      });

      expect(newRun.id).toBeDefined();
      expect(newRun.goal).toBe("Profile memory allocation patterns across services");
      expect(newRun.status).toBe("pending");
      expect(newRun.progress).toBe(0);
      expect(newRun.tasks.length).toBe(4);
      expect(newRun.tasks.every((t) => t.status === "pending")).toBe(true);

      const retrieved = await repository.getRunById(newRun.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(newRun.id);
    });

    it("updates existing run status and progress", async () => {
      const updated = await repository.updateRun("run-001", {
        progress: 75,
        status: "running",
      });

      expect(updated.progress).toBe(75);
      expect(updated.status).toBe("running");

      const fetched = await repository.getRunById("run-001");
      expect(fetched?.progress).toBe(75);
    });

    it("notifies subscribers when data changes", async () => {
      let notified = false;
      const unsubscribe = repository.subscribe(() => {
        notified = true;
      });

      await repository.createRun({ goal: "Test notification observer" });
      expect(notified).toBe(true);

      unsubscribe();
      notified = false;
      await repository.updateRun("run-001", { progress: 80 });
      expect(notified).toBe(false);
    });
  });
});
